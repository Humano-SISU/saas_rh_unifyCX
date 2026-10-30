import { calculatePayroll } from '../payroll-client-specific'
import type { EmployeeReceiptInput } from './receipt'
import { buildCustomDeductionsList } from './custom-deductions-list'
import { resolveDisplayNet } from './resolve-display-net'
import { readDaysExtraPay } from './days-extra-pay'
import { loadOvertimeDailyBreakdownSheet } from './overtime-daily-breakdown'
import { resolvePlanillaDaysWorked } from './planilla-from-run'
import { resolvePlanillaRowPayType } from './resolve-effective-pay-type'

export interface VoucherFromRunLineResult {
  record: EmployeeReceiptInput
  periodo: string
  quincena: number
  companyName: string
  periodLabel: string
  employeeCode: string
  filename: string
}

export async function buildVoucherFromRunLine(
  supabase: any,
  companyId: string,
  runLineId: string
): Promise<VoucherFromRunLineResult> {
  const { data: lineData, error: lineError } = await supabase
    .from('payroll_run_lines')
    .select(`
      id,
      employee_id,
      run_id,
      eff_bruto,
      eff_ihss,
      eff_rap,
      eff_isr,
      eff_neto,
      eff_hours,
      seventh_day_pay,
      metadata,
      employees:employee_id (
        name,
        employee_code,
        base_salary,
        bank_name,
        bank_account,
        department_id,
        role,
        pay_type
      ),
      payroll_runs:run_id (
        year,
        month,
        quincena
      )
    `)
    .eq('id', runLineId)
    .eq('company_id', companyId)
    .single()

  if (lineError || !lineData) {
    throw new Error('Línea de nómina no encontrada')
  }

  const employee = lineData.employees
  const run = lineData.payroll_runs

  if (!employee || !run) {
    throw new Error('Datos incompletos para generar el recibo')
  }

  let departmentName = 'Sin Departamento'
  if (employee.department_id) {
    const { data: dept } = await supabase
      .from('departments')
      .select('name')
      .eq('id', employee.department_id)
      .single()
    if (dept) departmentName = dept.name
  }

  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', companyId)
    .single()

  const periodo = `${run.year}-${String(run.month).padStart(2, '0')}`
  const ultimoDia = new Date(run.year, run.month, 0).getDate()
  const fechaInicio = run.quincena === 1 ? `${periodo}-01` : `${periodo}-16`
  const fechaFin = run.quincena === 1 ? `${periodo}-15` : `${periodo}-${ultimoDia}`

  let customDeductions = 0
  let customDeductionsList: Array<{ name: string; amount: number }> = []

  const brutoTotal = Number(lineData.eff_bruto) || 0
  const lineMetadata = (lineData.metadata as Record<string, unknown> | null) ?? {}

  const calcResult = await calculatePayroll(companyId, brutoTotal, lineMetadata, supabase)
  customDeductions = calcResult.totalDeduccionesAdicionales
  customDeductionsList = await buildCustomDeductionsList(
    companyId,
    lineMetadata,
    brutoTotal,
    supabase
  )

  if (customDeductionsList.length === 0 && customDeductions > 0) {
    customDeductionsList = [{ name: 'Deducciones adicionales', amount: customDeductions }]
  }

  const statutoryDeductions =
    (lineData.eff_ihss || 0) + (lineData.eff_rap || 0) + (lineData.eff_isr || 0)
  const totalDeductions = statutoryDeductions + customDeductions
  const netSalary = resolveDisplayNet({
    bruto: brutoTotal,
    totalDeductions,
    customDeductions,
    storedNeto: lineData.eff_neto || 0,
  })

  const septimoDia =
    Number(lineData.seventh_day_pay) ||
    Number(lineMetadata.septimo_dia) ||
    0
  const overtimePayRaw = Number(lineMetadata.overtime_pay)
  const overtimePay =
    Number.isFinite(overtimePayRaw) && overtimePayRaw > 0
      ? Math.round(overtimePayRaw * 100) / 100
      : 0
  const daysExtraPay = readDaysExtraPay(lineMetadata)
  const horasExtrasRaw = Number(lineMetadata.horas_extras)
  const horasExtras =
    Number.isFinite(horasExtrasRaw) && horasExtrasRaw > 0
      ? Math.round(horasExtrasRaw * 100) / 100
      : 0
  const baseSalaryForReceipt = Math.max(
    0,
    Math.round((brutoTotal - (septimoDia > 0 ? septimoDia : 0) - overtimePay - daysExtraPay) * 100) / 100
  )

  const monthlyFromMeta = Number(lineMetadata.base_salary_used)
  const monthlySalary =
    Number.isFinite(monthlyFromMeta) && monthlyFromMeta > 0
      ? monthlyFromMeta
      : Number(employee.base_salary) || 0

  let overtimeDaily = null
  if (overtimePay > 0 || horasExtras > 0) {
    overtimeDaily = await loadOvertimeDailyBreakdownSheet(supabase, {
      employeeId: lineData.employee_id,
      periodStart: fechaInicio,
      periodEnd: fechaFin,
      monthlySalary,
      paidOvertimePay: overtimePay > 0 ? overtimePay : undefined,
      lineMetadata,
    })
  }

  const employeeCode = employee.employee_code || 'empleado'
  const periodLabel = `Quincena ${run.quincena}`
  const payType = resolvePlanillaRowPayType({
    employeePayType: employee.pay_type,
    metadataPayType: lineMetadata.pay_type,
  })
  const daysWorked = resolvePlanillaDaysWorked(
    payType,
    Number(lineData.eff_hours) || 0,
    lineMetadata.days_worked
  )

  return {
    record: {
      employee_code: employeeCode,
      employee_name: employee.name,
      department: departmentName,
      position: employee.role || 'N/A',
      period_start: fechaInicio,
      period_end: fechaFin,
      days_worked: daysWorked,
      base_salary: baseSalaryForReceipt,
      septimo_dia: septimoDia > 0 ? septimoDia : undefined,
      overtime_pay: overtimePay > 0 ? overtimePay : undefined,
      horas_extras: horasExtras > 0 ? horasExtras : undefined,
      days_extra_pay: daysExtraPay > 0 ? daysExtraPay : undefined,
      overtime_daily: overtimeDaily,
      income_tax: lineData.eff_isr || 0,
      professional_tax: lineData.eff_rap || 0,
      social_security: lineData.eff_ihss || 0,
      total_deductions: totalDeductions,
      net_salary: netSalary,
      bank_name: employee.bank_name || '',
      bank_account: employee.bank_account || '',
      custom_deductions: customDeductionsList,
    },
    periodo,
    quincena: run.quincena,
    companyName: company?.name || 'Empresa',
    periodLabel,
    employeeCode,
    filename: `recibo_${employeeCode}_${periodo}_q${run.quincena}.pdf`,
  }
}
