import { NextApiRequest, NextApiResponse } from 'next'
import { requireCompanyAccess } from '../../../lib/auth/api-auth-fixed'
import { normalizeCountryCode } from '../../../lib/country/supported'
import { isPayrollCountryEngineEnabled } from '../../../lib/features/payroll-country-flags'
import { getTaxEngine } from '../../../lib/tax/registry'
import {
  resolvePayrollPeriodContext,
  computeFixedGrossFromDays,
  computeFixedLineDeductionsAndNet,
  buildFixedLinePlanMetadata,
  mergeRecalcMetadata,
  type PreviewPaymentFrequency,
  type PaymentCutDatesInput,
} from '../../../lib/payroll/fixed-line-recalc'
import {
  resolveEffectivePayType,
  parseCompanyCalculationMode,
} from '../../../lib/payroll/resolve-effective-pay-type'
import {
  resolveCompanyPayOvertime,
  resolveFixedOvertimePay,
  normalizeOvertimeBreakdown,
  shouldPayOvertimeToEmployee,
  emptyOvertimeBreakdown,
  overtimeBreakdownToMetadata,
} from '../../../lib/payroll/overtime-pay'
import { HONDURAS_LABOR_FACTOR } from '../../../lib/payroll/constants'
import { calculatePayroll } from '../../../lib/payroll-client-specific'
import {
  foldCustomsIntoFixedRecalcAmounts,
  metadataWithoutPlanKeys,
} from '../../../lib/payroll/apply-customs-after-fixed-recalc'
import {
  assertNonHndStatutoryConfigParses,
  payrollStatutoryErrorResponse,
  payrollStatutoryYearUnavailable,
} from '../../../lib/payroll/statutory-api-guard'
import { createEmployeeSalaryClient } from '../../../lib/security/employee-data-access'
import { readDaysExtraPay } from '../../../lib/payroll/days-extra-pay'

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isPayrollRecalcRpcMissing(err: { message?: string; code?: string } | null): boolean {
  if (!err) return false
  const msg = (err.message || '').toLowerCase()
  if (err.code === 'PGRST202') return true
  if (msg.includes('could not find the function')) return true
  if (msg.includes('schema cache')) return true
  return false
}

async function persistFixedDaysRecalcViaTables(
  supabase: any,
  params: {
    run_line_id: string
    company_id: string
    calc_hours: number
    calc_bruto: number
    calc_ihss: number
    calc_rap: number
    calc_isr: number
    calc_neto: number
    metadata: Record<string, unknown>
    tax_year: number
  }
): Promise<{ error: { message: string } | null }> {
  const p = params
  const standardFields = ['hours', 'bruto', 'ihss', 'rap', 'isr', 'neto']

  const { error: delError } = await supabase
    .from('payroll_adjustments')
    .delete()
    .eq('run_line_id', p.run_line_id)
    .eq('company_id', p.company_id)
    .in('field', standardFields)

  if (delError) return { error: delError }

  const { error: updError } = await supabase
    .from('payroll_run_lines')
    .update({
      calc_hours: p.calc_hours,
      calc_bruto: p.calc_bruto,
      calc_ihss: p.calc_ihss,
      calc_rap: p.calc_rap,
      calc_isr: p.calc_isr,
      calc_neto: p.calc_neto,
      eff_hours: p.calc_hours,
      eff_bruto: p.calc_bruto,
      eff_ihss: p.calc_ihss,
      eff_rap: p.calc_rap,
      eff_isr: p.calc_isr,
      eff_neto: p.calc_neto,
      metadata: p.metadata,
      tax_year: p.tax_year,
      edited: true,
    })
    .eq('id', p.run_line_id)
    .eq('company_id', p.company_id)

  return { error: updError }
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { supabase, companyId, role, user, companyCountryCode } = await requireCompanyAccess(req, res)
    const salaryClient = createEmployeeSalaryClient()

    if (!companyId) {
      return res.status(400).json({ error: 'Company ID is required' })
    }

    const countryCode = normalizeCountryCode(companyCountryCode)
    if (!isPayrollCountryEngineEnabled(countryCode)) {
      return res.status(403).json({
        error: 'Nómina no habilitada para este país',
        code: 'PAYROLL_COUNTRY_DISABLED',
      })
    }

    if (!['super_admin', 'company_admin', 'hr_manager'].includes(role)) {
      return res.status(403).json({
        error: 'Permisos insuficientes',
        message: 'No tiene permisos para ajustar nómina',
      })
    }

    const { run_line_id, overtime: otRaw, reason } = req.body || {}

    if (!run_line_id || !otRaw || typeof otRaw !== 'object') {
      return res.status(400).json({
        error:
          'run_line_id y overtime { evening_25, night_50, late_75, morning_25, holiday_100 } son requeridos',
      })
    }

    const overrideBreakdown = normalizeOvertimeBreakdown({
      evening_25: otRaw.evening_25,
      night_50: otRaw.night_50,
      late_75: otRaw.late_75,
      morning_25: otRaw.morning_25,
      holiday_100: otRaw.holiday_100,
    })

    for (const [k, v] of Object.entries(overrideBreakdown)) {
      if (!Number.isFinite(v) || v < 0) {
        return res.status(400).json({ error: `overtime.${k} debe ser un número >= 0` })
      }
    }

    const { data: line, error: lineError } = await supabase
      .from('payroll_run_lines')
      .select('id, company_id, run_id, employee_id, metadata, eff_hours')
      .eq('id', run_line_id)
      .eq('company_id', companyId)
      .single()

    if (lineError || !line) {
      return res.status(404).json({
        error: 'Línea no encontrada',
        message: 'La línea no existe o no pertenece a su empresa',
      })
    }

    const { data: run, error: runError } = await supabase
      .from('payroll_runs')
      .select('id, status, year, month, quincena, tipo, company_id')
      .eq('id', line.run_id)
      .single()

    if (runError || !run) {
      return res.status(404).json({ error: 'Corrida no encontrada' })
    }

    if (run.company_id !== companyId) {
      return res.status(403).json({ error: 'No autorizado' })
    }

    if (!['draft', 'edited'].includes(run.status)) {
      return res.status(400).json({
        error: 'Corrida no editable',
        message: `La corrida está en estado '${run.status}'`,
      })
    }

    const tipoParam = (run.tipo || 'CON') as string
    if (!['CON', 'SIN', '2PAGOS'].includes(tipoParam)) {
      return res.status(400).json({ error: 'Tipo de corrida no soportado' })
    }

    const { data: employee, error: empError } = await salaryClient
      .from('employees')
      .select('id, pay_type, base_salary, pay_overtime')
      .eq('id', line.employee_id)
      .eq('company_id', companyId)
      .single()

    if (empError || !employee) {
      return res.status(404).json({ error: 'Empleado no encontrado' })
    }

    const { data: payrollConfig, error: configError } = await supabase
      .from('company_payroll_configs')
      .select('metadata, payment_frequency, quincena_config, calculation_mode')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle()

    if (configError) {
      console.error('adjust-fixed-overtime: config', configError)
    }

    const payrollMetadata = payrollConfig?.metadata || {}
    const companyCalculationMode = parseCompanyCalculationMode(
      payrollConfig?.calculation_mode ?? payrollMetadata.calculation_mode
    )

    if (resolveEffectivePayType(employee.pay_type, companyCalculationMode) !== 'fixed') {
      return res.status(400).json({
        error: 'Solo aplica a empleados con salario fijo (fixed)',
      })
    }

    const companyPayOvertime = resolveCompanyPayOvertime(payrollMetadata as Record<string, unknown>)
    if (
      !shouldPayOvertimeToEmployee(
        companyPayOvertime,
        'fixed',
        (employee as { pay_overtime?: boolean | null }).pay_overtime
      )
    ) {
      return res.status(400).json({
        error: 'HE no pagable',
        message:
          'La empresa o el empleado tienen desactivado el pago de horas extras. No se puede ajustar HE en bruto.',
      })
    }

    const qcCol = payrollConfig?.quincena_config as {
      first_start?: number
      first_end?: number
      second_start?: number
      second_end?: number
    } | null
    const metaCutDates = (payrollMetadata?.payment_cut_dates || {}) as Record<string, unknown>
    const mapFreq = (v: string) => {
      const x = (v || '').toLowerCase()
      if (x === 'mensual' || x === 'monthly') return 'monthly'
      if (x === 'semanal' || x === 'weekly') return 'weekly'
      if (x === 'quincenal' || x === 'biweekly') return 'biweekly'
      return 'biweekly'
    }
    const paymentFrequency = mapFreq(
      (payrollConfig?.payment_frequency as string) ||
        (payrollMetadata.payment_frequency as string) ||
        'quincenal'
    ) as PreviewPaymentFrequency

    const hasCustomQuincena = !!(
      qcCol &&
      (qcCol.first_start != null ||
        qcCol.first_end != null ||
        qcCol.second_start != null ||
        qcCol.second_end != null)
    )
    const paymentCutDates: PaymentCutDatesInput = qcCol
      ? {
          biweekly_type:
            metaCutDates.biweekly_type === 'custom' || hasCustomQuincena ? 'custom' : 'standard',
          biweekly_first_start: qcCol.first_start ?? (metaCutDates.biweekly_first_start as number) ?? 1,
          biweekly_first_end: qcCol.first_end ?? (metaCutDates.biweekly_first_end as number) ?? 15,
          biweekly_second_start:
            qcCol.second_start ?? (metaCutDates.biweekly_second_start as number) ?? 16,
          biweekly_second_end: qcCol.second_end ?? (metaCutDates.biweekly_second_end as number) ?? 30,
          monthly_type: metaCutDates.monthly_type === 'custom' ? 'custom' : 'standard',
          monthly_start: (metaCutDates.monthly_start as number) ?? 1,
          monthly_end: (metaCutDates.monthly_end as number) ?? 30,
        }
      : {
          biweekly_type: metaCutDates.biweekly_type === 'custom' ? 'custom' : 'standard',
          biweekly_first_start: (metaCutDates.biweekly_first_start as number) ?? 1,
          biweekly_first_end: (metaCutDates.biweekly_first_end as number) ?? 15,
          biweekly_second_start: (metaCutDates.biweekly_second_start as number) ?? 16,
          biweekly_second_end: (metaCutDates.biweekly_second_end as number) ?? 30,
          monthly_type: metaCutDates.monthly_type === 'custom' ? 'custom' : 'standard',
          monthly_start: (metaCutDates.monthly_start as number) ?? 1,
          monthly_end: (metaCutDates.monthly_end as number) ?? 30,
        }

    const legalDeductions = (payrollMetadata.legal_deductions || {
      ihss: true,
      rap: true,
      isr: true,
      infop: false,
    }) as { ihss: boolean; rap: boolean; isr: boolean; infop?: boolean }

    const semanalProration = (payrollMetadata.semanal_proration || 'proportional') as
      | 'proportional'
      | 'fixed'

    const { data: companyRow } = await supabase
      .from('companies')
      .select('settings')
      .eq('id', companyId)
      .single()
    const useIsrProjection =
      (companyRow?.settings as Record<string, unknown>)?.use_isr_projection === true

    const yearNum = run.year
    const monthNum = run.month
    const quincenaNum = run.quincena

    if (paymentFrequency === 'weekly') {
      if (![1, 2, 3, 4].includes(quincenaNum)) {
        return res.status(400).json({
          error: 'Semana inválida en la corrida (se espera 1–4 para nómina semanal)',
        })
      }
    } else if (![1, 2].includes(quincenaNum)) {
      return res.status(400).json({
        error: 'Quincena inválida en la corrida (se espera 1 o 2)',
      })
    }

    const periodCtx = resolvePayrollPeriodContext(
      yearNum,
      monthNum,
      quincenaNum,
      paymentFrequency,
      paymentCutDates
    )
    const { diasPeriodo } = periodCtx

    const lineMeta = (line.metadata || {}) as Record<string, unknown>
    const metaDays = Number(lineMeta.days_worked)
    const effDays = Number(line.eff_hours)
    let daysWorked =
      Number.isFinite(metaDays) && metaDays >= 0
        ? Math.floor(metaDays)
        : Number.isFinite(effDays) && effDays >= 0
          ? Math.floor(effDays)
          : 0
    if (daysWorked > diasPeriodo) daysWorked = diasPeriodo

    const baseSalary = Number(employee.base_salary) || 0
    const yearCtx = await getTaxEngine(countryCode).loadYearContext(yearNum)
    const blocked = payrollStatutoryYearUnavailable(yearCtx, countryCode, yearNum)
    if (!blocked.ok) return res.status(blocked.status).json(blocked.body)
    await assertNonHndStatutoryConfigParses(countryCode, yearNum, supabase)
    const taxConstants = yearCtx.hndTaxConstants ?? undefined

    let dayGross = computeFixedGrossFromDays({
      baseSalary,
      daysWorked,
      paymentFrequency,
      diasPeriodo,
      ultimoDiaCalendario: periodCtx.ultimoDiaCalendario,
      isMonthlyCalendarStandard: periodCtx.isMonthlyCalendarStandard,
      semanalProration,
    })
    if (!isFinite(dayGross) || isNaN(dayGross)) dayGross = 0

    const otResolved = resolveFixedOvertimePay({
      companyPayOvertime,
      employeePayOvertime: (employee as { pay_overtime?: boolean | null }).pay_overtime,
      hourlyRate: baseSalary / HONDURAS_LABOR_FACTOR,
      ahcBreakdown: emptyOvertimeBreakdown(),
      overrideBreakdown,
    })

    // Holiday/rest-day pay was set by the preview; keep it when overtime is adjusted.
    let totalEarnings = dayGross + otResolved.pay + readDaysExtraPay(lineMeta)
    if (!isFinite(totalEarnings) || isNaN(totalEarnings)) totalEarnings = 0

    const { data: plansData } = await supabase
      .from('employee_deduction_plans')
      .select('id, employee_id, field_key, monto_por_plazo, plazos_aplicados, plazos_totales')
      .eq('employee_id', line.employee_id)
      .eq('company_id', companyId)
      .eq('activo', true)

    const empPlans = (plansData || []).filter(
      (p: { plazos_aplicados: number; plazos_totales: number }) =>
        p.plazos_aplicados < p.plazos_totales
    )

    const ded = await computeFixedLineDeductionsAndNet({
      supabase,
      companyId,
      employeeId: line.employee_id,
      year: yearNum,
      month: monthNum,
      quincena: quincenaNum,
      paymentFrequency,
      tipoParam: tipoParam as 'CON' | 'SIN' | '2PAGOS',
      legalDeductions,
      useIsrProjection,
      taxConstants,
      countryCode,
      totalEarnings,
      baseSalary,
      empPlans,
    })

    const IHSS = round2(ded.IHSS)
    const RAP = round2(ded.RAP)
    const ISR = round2(ded.ISR)
    const totalDeductions = round2(ded.totalDeductions)
    const netTotal = round2(ded.total)
    const gross = round2(totalEarnings)

    const planFieldKeys = new Set<string>()
    for (const p of empPlans as { field_key?: string }[]) {
      if (p.field_key) planFieldKeys.add(p.field_key)
    }
    const reasonStr =
      typeof reason === 'string' && reason.trim()
        ? reason.trim().slice(0, 500)
        : 'Ajuste de horas extras'

    const recalcMeta = buildFixedLinePlanMetadata(yearNum, empPlans, {
      ot_adjusted_at: new Date().toISOString(),
      ot_adjust_reason: reasonStr,
      ot_adjusted_by: user.id,
      ...overtimeBreakdownToMetadata(overrideBreakdown),
      horas_extras: otResolved.hoursTotal,
      overtime_pay: otResolved.pay,
    })

    const mergedMetadata = mergeRecalcMetadata(
      line.metadata as Record<string, unknown> | null,
      recalcMeta,
      planFieldKeys
    )

    const customsMeta = metadataWithoutPlanKeys(mergedMetadata, planFieldKeys)
    const customsCalc = await calculatePayroll(companyId, gross, customsMeta, supabase)
    const folded = foldCustomsIntoFixedRecalcAmounts({
      dayOtGross: gross,
      netAfterStatutoryAndPlans: netTotal,
      ingresosAdicionales: customsCalc.totalIngresosAdicionales,
      customDeductionsExcludingPlans: customsCalc.totalDeduccionesAdicionales,
    })
    const persistBruto = folded.bruto
    const persistNeto = folded.neto

    const { data: rpcData, error: rpcError } = await supabase.rpc('payroll_recalc_fixed_days_apply', {
      p_run_line_id: run_line_id,
      p_company_id: companyId,
      p_calc_hours: daysWorked,
      p_calc_bruto: persistBruto,
      p_calc_ihss: IHSS,
      p_calc_rap: RAP,
      p_calc_isr: ISR,
      p_calc_neto: persistNeto,
      p_metadata: mergedMetadata,
      p_tax_year: yearNum,
      p_user_id: user.id,
    })

    let rpcPayload = rpcData as { success?: boolean; error?: string } | null

    if (rpcError && isPayrollRecalcRpcMissing(rpcError)) {
      console.warn(
        'adjust-fixed-overtime: RPC missing; using table fallback. Apply payroll_recalc_fixed_days_apply migration if needed.'
      )
      const { error: fbErr } = await persistFixedDaysRecalcViaTables(supabase, {
        run_line_id,
        company_id: companyId,
        calc_hours: daysWorked,
        calc_bruto: persistBruto,
        calc_ihss: IHSS,
        calc_rap: RAP,
        calc_isr: ISR,
        calc_neto: persistNeto,
        metadata: mergedMetadata,
        tax_year: yearNum,
      })
      if (fbErr) {
        console.error('adjust-fixed-overtime fallback', fbErr)
        return res.status(500).json({
          error: 'Error persistiendo recálculo',
          message: fbErr.message,
        })
      }
      rpcPayload = { success: true }
    } else if (rpcError) {
      console.error('payroll_recalc_fixed_days_apply', rpcError)
      return res.status(500).json({
        error: 'Error persistiendo recálculo',
        message: rpcError.message,
      })
    }

    if (rpcPayload && rpcPayload.success === false) {
      return res.status(400).json({ error: rpcPayload.error || 'No se pudo aplicar el recálculo' })
    }

    const { data: updatedLine, error: fetchErr } = await supabase
      .from('payroll_run_lines')
      .select('id, eff_hours, eff_bruto, eff_ihss, eff_rap, eff_isr, eff_neto, edited, updated_at, metadata')
      .eq('id', run_line_id)
      .single()

    if (fetchErr) {
      console.error('adjust-fixed-overtime fetch line', fetchErr)
    }

    return res.status(200).json({
      success: true,
      line: updatedLine || {
        id: run_line_id,
        eff_hours: daysWorked,
        eff_bruto: persistBruto,
        eff_ihss: IHSS,
        eff_rap: RAP,
        eff_isr: ISR,
        eff_neto: persistNeto,
        edited: true,
        metadata: mergedMetadata,
      },
      overtime_pay: otResolved.pay,
      horas_extras: otResolved.hoursTotal,
      total_deductions: round2(persistBruto - persistNeto),
      custom_ingresos: customsCalc.totalIngresosAdicionales,
      custom_deducciones: customsCalc.totalDeduccionesAdicionales,
    })
  } catch (e: unknown) {
    const stat = payrollStatutoryErrorResponse(e)
    if (stat) return res.status(stat.status).json(stat.body)
    const err = e as { message?: string }
    if (err.message === 'UNAUTHORIZED') {
      if (res.headersSent) return
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Sesión inválida o expirada. Vuelve a iniciar sesión.',
      })
    }
    console.error('adjust-fixed-overtime', e)
    return res.status(500).json({ error: 'Error interno' })
  }
}
