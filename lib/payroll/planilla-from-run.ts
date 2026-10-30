import type { SupabaseClient } from '@supabase/supabase-js'
import { normalizeCountryCode, type CountryCode } from '../country/supported'
import { resolvePayrollDisplayCurrency } from '../country/display-money'
import { calculatePayroll, getCustomFields } from '../payroll-client-specific'
import {
  buildCustomDeductionsList,
  formatCustomDeductionsNotes,
} from './custom-deductions-list'
import { parsePayrollPdfGroupByQuery, type PayrollPdfGroupBy } from './pdf-layout'
import {
  getBiweeklyPeriodDates,
  getMonthlyPeriodDates,
  getWeeklyPeriodDates,
} from './period-dates'
import type { PlanillaItem } from './report'
import { readDaysExtraPay } from './days-extra-pay'
import {
  isExactHourlyPlanillaTablePayType,
  isMutablePayrollRunStatus,
  parseCompanyCalculationMode,
  PayrollNeedsRegenerateError,
  resolvePlanillaRowPayType,
} from './resolve-effective-pay-type'
import { payrollLineMasterDataDrifted, resolveSnapshotMonthlySalary } from './salary-snapshot'
import { resolveDisplayNet } from './resolve-display-net'

/** eff_hours on payroll_run_lines stores days for fixed employees and clock hours for hour-based types. */
export function resolvePlanillaDaysWorked(
  payType: 'fixed' | 'hourly' | 'admin_floor' | string,
  effHours: number,
  metadataDaysWorked?: unknown
): number {
  // Number(null) === 0 — must not treat missing metadata as zero days.
  if (metadataDaysWorked != null && metadataDaysWorked !== '') {
    const md = Number(metadataDaysWorked)
    if (Number.isFinite(md) && md >= 0) return md
  }
  // Exact hourly: clock hours → approx days. admin_floor shares detalle with fixed
  // but may still store clock hours in eff_hours when days_worked meta is absent.
  if (payType === 'hourly') return effHours / 8
  if (payType === 'admin_floor' && effHours > 31) return effHours / 8
  return effHours
}

export type PayrollRunRecord = {
  id: string
  company_id: string
  year: number
  month: number
  quincena: number
  tipo: string
  status: string
}

export type PdfCustomFieldDef = {
  label: string
  type: 'number' | 'string' | 'boolean'
  category: 'earnings' | 'deductions' | 'calculation_helper'
  required: boolean
  default: unknown
}

export type LoadedPlanillaFromRun = {
  payrollRun: PayrollRunRecord
  planillaFixed: PlanillaItem[]
  planillaHourly: PlanillaItem[]
  periodo: string
  companyName: string
  periodDates: { period_start: string; period_end: string }
  pdfPayrollConfig: {
    currency: string
    payment_frequency: string
    payment_cut_dates: Record<string, unknown>
    legal_deductions: { ihss?: boolean; rap?: boolean; isr?: boolean }
    country_code: CountryCode
  }
  pdfCustomFieldsConfig?: Record<string, PdfCustomFieldDef | string>
  defaultPdfGroupBy: PayrollPdfGroupBy
  isDraftPreview: boolean
}

/**
 * Load planilla rows for PDF / on-screen planilla preview from a payroll run.
 *
 * Amounts (eff_*) are a run-line snapshot. Pay type for table split uses immutable
 * `metadata.pay_type` when present (same contract as authorized detalle).
 * Identity fields (name, department, etc.) come from a live employee join.
 * Authorized/distributed runs keep every line — including later-inactive employees.
 * Draft/edited: throws {@link PayrollNeedsRegenerateError} if live employee pay_type
 * or base_salary drifted from the line stamp (caller must ask user to regenerate preview).
 * Draft sync removes orphans on preview regenerate (see findOrphanPayrollLineIds).
 */
export async function loadPlanillaFromRun(
  supabase: SupabaseClient,
  companyId: string,
  runId: string,
  groupByOverride?: PayrollPdfGroupBy | null
): Promise<LoadedPlanillaFromRun> {
  const { data: payrollRun, error: runError } = await supabase
    .from('payroll_runs')
    .select('id, company_id, year, month, quincena, tipo, status')
    .eq('id', runId)
    .eq('company_id', companyId)
    .single()

  if (runError) {
    throw new Error(runError.message || 'Error obteniendo corrida de nómina')
  }
  if (!payrollRun) {
    throw new Error('Corrida de nómina no encontrada')
  }

  const { data: payrollLines, error: linesError } = await supabase
    .from('payroll_run_lines')
    .select(`
      *,
      employees!payroll_run_lines_employee_id_fkey(
        id, name, dni, employee_code, base_salary, bank_name, bank_account, pay_type,
        team, role,
        departments!employees_department_id_fkey(name)
      )
    `)
    .eq('run_id', runId)
    .eq('company_id', companyId)

  if (linesError) {
    throw new Error(linesError.message || 'Error obteniendo líneas de nómina')
  }
  if (!payrollLines?.length) {
    throw new Error('No hay líneas de nómina para esta corrida')
  }

  const { data: company } = await supabase
    .from('companies')
    .select('name, country_code')
    .eq('id', companyId)
    .single()

  const { data: payrollConfig } = await supabase
    .from('company_payroll_configs')
    .select('metadata, payment_frequency, quincena_config, custom_fields, calculation_mode')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .single()

  const payrollMetadata = (payrollConfig?.metadata as Record<string, unknown>) || {}
  const companyCalculationMode = parseCompanyCalculationMode(
    (payrollConfig as { calculation_mode?: unknown } | null)?.calculation_mode ??
      payrollMetadata.calculation_mode
  )

  // Draft/edited: refuse planilla/PDF when master pay_type drifted from line stamp.
  // Authorized runs keep immutable metadata (no block — historical fidelity).
  if (isMutablePayrollRunStatus(payrollRun.status)) {
    for (const line of payrollLines) {
      const employees = (line as { employees?: Record<string, unknown> | null }).employees
      const metadata = ((line as { metadata?: Record<string, unknown> | null }).metadata ||
        {}) as Record<string, unknown>
      if (
        payrollLineMasterDataDrifted({
          employeePayType: employees?.pay_type,
          metadataPayType: metadata.pay_type,
          companyCalculationMode,
          liveBaseSalary: employees?.base_salary,
          stampedBaseSalary: metadata.base_salary_used,
        })
      ) {
        throw new PayrollNeedsRegenerateError()
      }
    }
  }

  const planilla: PlanillaItem[] = await Promise.all(
    payrollLines.map(async (line: Record<string, unknown>) => {
      const employees = line.employees as Record<string, unknown> | null
      const departments = employees?.departments as { name?: string } | null
      let customDeductions = 0
      let deductionsNotes = ''
      const effBruto = Number(line.eff_bruto) || 0
      const metadata = (line.metadata as Record<string, unknown>) || {}

      if (line.metadata) {
        const calcResult = await calculatePayroll(companyId, effBruto, metadata, supabase)
        customDeductions = calcResult.totalDeduccionesAdicionales
        const deductionItems = await buildCustomDeductionsList(
          companyId,
          metadata,
          effBruto,
          supabase
        )
        if (deductionItems.length > 0) {
          deductionsNotes = formatCustomDeductionsNotes(deductionItems)
        }
      }

      const statutoryDeductions =
        (Number(line.eff_ihss) || 0) + (Number(line.eff_rap) || 0) + (Number(line.eff_isr) || 0)
      const totalDeductions = statutoryDeductions + customDeductions
      const displayNet = resolveDisplayNet({
        bruto: effBruto,
        totalDeductions,
        customDeductions,
        storedNeto: Number(line.eff_neto) || 0,
      })
      const payType = resolvePlanillaRowPayType({
        employeePayType: employees?.pay_type,
        metadataPayType: metadata.pay_type,
        companyCalculationMode,
      })
      const totalHours = Number(line.eff_hours) || 0
      const showHourCols = isExactHourlyPlanillaTablePayType(payType)
      const hourlyRate =
        showHourCols && totalHours > 0 ? (Number(line.eff_bruto) || 0) / totalHours : 0

      return {
        id: String(employees?.employee_code || ''),
        name: String(employees?.name || ''),
        bank: String(employees?.bank_name || 'No especificado'),
        bank_account: String(employees?.bank_account || 'No especificado'),
        department: departments?.name || 'Sin Departamento',
        team: (employees?.team as string | null) ?? null,
        position: (employees?.role as string | null) ?? null,
        role: (employees?.role as string | null) ?? null,
        monthly_salary: resolveSnapshotMonthlySalary(employees?.base_salary, metadata),
        days_worked: resolvePlanillaDaysWorked(payType, totalHours, metadata.days_worked),
        days_absent: 0,
        late_days: 0,
        total_earnings: Number(line.eff_bruto) || 0,
        IHSS: Number(line.eff_ihss) || 0,
        RAP: Number(line.eff_rap) || 0,
        ISR: Number(line.eff_isr) || 0,
        total_deductions: totalDeductions,
        total: displayNet,
        notes_on_ingress: line.edited ? 'Editado' : '',
        notes_on_deductions: deductionsNotes,
        metadata,
        pay_type: payType,
        total_hours_worked: showHourCols ? totalHours : undefined,
        hourly_rate: showHourCols ? hourlyRate : undefined,
        septimo_dia:
          Number(line.seventh_day_pay) ||
          Number((metadata as Record<string, unknown>)?.septimo_dia) ||
          undefined,
        ...(Number.isFinite(Number(metadata.horas_extras)) && Number(metadata.horas_extras) > 0
          ? { horas_extras: Math.round(Number(metadata.horas_extras) * 100) / 100 }
          : {}),
        ...(Number.isFinite(Number(metadata.overtime_pay)) && Number(metadata.overtime_pay) > 0
          ? { overtime_pay: Math.round(Number(metadata.overtime_pay) * 100) / 100 }
          : {}),
        ...(readDaysExtraPay(metadata) > 0 ? { days_extra_pay: readDaysExtraPay(metadata) } : {}),
      } satisfies PlanillaItem
    })
  )

  const periodo = `${payrollRun.year}-${String(payrollRun.month).padStart(2, '0')}`
  const defaultGroupFromConfig = parsePayrollPdfGroupByQuery(
    payrollMetadata.payroll_pdf_group_by
  )
  const pdfGroupBy: PayrollPdfGroupBy =
    groupByOverride && groupByOverride !== 'none' ? groupByOverride : defaultGroupFromConfig

  const qcCol = payrollConfig?.quincena_config as
    | {
        first_start?: number
        first_end?: number
        second_start?: number
        second_end?: number
      }
    | null
  const metaCutDates = (payrollMetadata.payment_cut_dates as Record<string, unknown>) || {}
  const hasCustomQuincena = !!(
    qcCol &&
    (qcCol.first_start != null ||
      qcCol.first_end != null ||
      qcCol.second_start != null ||
      qcCol.second_end != null)
  )
  const paymentCutDates = hasCustomQuincena
    ? {
        biweekly_type: 'custom' as const,
        biweekly_first_start: qcCol?.first_start ?? metaCutDates?.biweekly_first_start ?? 1,
        biweekly_first_end: qcCol?.first_end ?? metaCutDates?.biweekly_first_end ?? 15,
        biweekly_second_start: qcCol?.second_start ?? metaCutDates?.biweekly_second_start ?? 16,
        biweekly_second_end: qcCol?.second_end ?? metaCutDates?.biweekly_second_end ?? 30,
        monthly_type: metaCutDates?.monthly_type || 'standard',
        monthly_start: metaCutDates?.monthly_start ?? 1,
        monthly_end: metaCutDates?.monthly_end ?? 30,
      }
    : metaCutDates?.biweekly_first_start != null
      ? metaCutDates
      : {
          biweekly_type: 'standard' as const,
          biweekly_first_start: 1,
          biweekly_first_end: 15,
          biweekly_second_start: 16,
          biweekly_second_end: 30,
          monthly_type: 'standard' as const,
          monthly_start: 1,
          monthly_end: 30,
        }

  const currency = resolvePayrollDisplayCurrency(company?.country_code, String(payrollMetadata.currency || ''))
  const pfRaw = payrollConfig?.payment_frequency ?? payrollMetadata.payment_frequency ?? 'biweekly'
  const paymentFrequency =
    pfRaw === 'mensual'
      ? 'monthly'
      : pfRaw === 'quincenal'
        ? 'biweekly'
        : pfRaw === 'semanal'
          ? 'weekly'
          : String(pfRaw)

  const customFieldsConfig = await getCustomFields(companyId, supabase)
  let pdfCustomFieldsConfig: Record<string, PdfCustomFieldDef | string> | undefined
  if (customFieldsConfig) {
    if (payrollConfig?.custom_fields) {
      pdfCustomFieldsConfig = payrollConfig.custom_fields as Record<string, PdfCustomFieldDef | string>
    } else {
      pdfCustomFieldsConfig = {}
      for (const [fieldName, label] of Object.entries(customFieldsConfig)) {
        pdfCustomFieldsConfig[fieldName] = {
          label: typeof label === 'string' ? label : fieldName,
          type: 'number',
          category: 'earnings',
          required: false,
          default: 0,
        }
      }
    }
  }

  const legalDeductions = (payrollMetadata.legal_deductions as {
    ihss?: boolean
    rap?: boolean
    isr?: boolean
  }) || { ihss: true, rap: true, isr: true }

  const pdfPayrollConfig = {
    currency,
    payment_frequency: paymentFrequency,
    payment_cut_dates: paymentCutDates,
    legal_deductions: legalDeductions,
    country_code: normalizeCountryCode(company?.country_code),
  }

  // Mismo orden por defecto que el detalle UI (nombre A-Z); la consulta no garantiza orden.
  planilla.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'es', { sensitivity: 'base' }))

  // Match detalle UI: only exact hourly on “por hora”; fixed + admin_floor on fijos.
  const planillaFixed = planilla.filter((p) => !isExactHourlyPlanillaTablePayType(p.pay_type))
  const planillaHourly = planilla.filter((p) => isExactHourlyPlanillaTablePayType(p.pay_type))

  const [year, month] = periodo.split('-').map(Number)
  let periodDates: { period_start: string; period_end: string }
  if (paymentFrequency === 'monthly') {
    const cut = paymentCutDates as { monthly_start?: number; monthly_end?: number }
    const start = cut?.monthly_start ?? 1
    const end = cut?.monthly_end ?? new Date(year, month, 0).getDate()
    const r = getMonthlyPeriodDates(year, month, start, end)
    periodDates = { period_start: r.fechaInicio, period_end: r.fechaFin }
  } else if (paymentFrequency === 'weekly') {
    const semana = (payrollRun.quincena as 1 | 2 | 3 | 4) || 1
    const r = getWeeklyPeriodDates(
      year,
      month,
      semana <= 4 ? (semana as 1 | 2 | 3 | 4) : 1
    )
    periodDates = { period_start: r.fechaInicio, period_end: r.fechaFin }
  } else {
    const cut = paymentCutDates as {
      biweekly_first_start?: number
      biweekly_first_end?: number
      biweekly_second_start?: number
      biweekly_second_end?: number
    }
    const r = getBiweeklyPeriodDates(year, month, payrollRun.quincena as 1 | 2, {
      biweekly_first_start: cut?.biweekly_first_start ?? 1,
      biweekly_first_end: cut?.biweekly_first_end ?? 15,
      biweekly_second_start: cut?.biweekly_second_start ?? 16,
      biweekly_second_end: cut?.biweekly_second_end ?? 30,
    })
    periodDates = { period_start: r.fechaInicio, period_end: r.fechaFin }
  }

  const isDraftPreview =
    payrollRun.status === 'draft' || payrollRun.status === 'edited'

  return {
    payrollRun: payrollRun as PayrollRunRecord,
    planillaFixed,
    planillaHourly,
    periodo,
    companyName: company?.name || 'Empresa',
    periodDates,
    pdfPayrollConfig,
    pdfCustomFieldsConfig,
    defaultPdfGroupBy: pdfGroupBy,
    isDraftPreview,
  }
}
