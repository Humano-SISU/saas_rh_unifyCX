import { NextApiRequest, NextApiResponse } from 'next'
import { requireCompanyAccess } from "../../../lib/auth/api-auth-fixed"
import { normalizeCountryCode } from '../../../lib/country/supported'
import { isPayrollCountryEngineEnabled } from '../../../lib/features/payroll-country-flags'
import { computePayrollEmployeeStatutoryDeductions } from '../../../lib/payroll/statutory-deductions-compute'
import {
  assertNonHndStatutoryConfigParses,
  payrollStatutoryErrorResponse,
  payrollStatutoryYearUnavailable
} from '../../../lib/payroll/statutory-api-guard'
import { isPayrollCalendarPeriodInFuture } from '../../../lib/timezone'
import { withPayrollRateLimit } from '../../../lib/security/rate-limiting'
import { secureLog, secureErrorLog } from '../../../lib/security/safe-logging'
import { getTaxEngine } from '../../../lib/tax/registry'
import { getIsrForPeriod } from '../../../lib/payroll/isr-ytd'
import { getHolidayDatesInRange } from '../../../lib/attendance/holiday-check'
import {
  resolvePayrollPeriodContext,
  computeFixedGrossFromDays,
  computeFixedLineDeductionsAndNet,
  applyDeductionPlansToMetadata,
  buildFixedLinePlanMetadata,
  type PreviewPaymentFrequency
} from '../../../lib/payroll/fixed-line-recalc'
import { calculateSeptimoDia } from '../../../lib/payroll/septimo-dia'
import { HONDURAS_LABOR_FACTOR, HORAS_PERIODO_MENSUAL, HORAS_PERIODO_QUINCENAL } from '../../../lib/payroll/constants'
import { buildAuthorizedPayrollPreviewPayload } from '../../../lib/payroll/preview-authorized-readonly'
import { calculateEmployerContributions } from '../../../lib/payroll/employer-contributions'
import { resolveEffectivePayType, parseCompanyCalculationMode, isHourBasedPayType, isFrozenPayrollRunStatus } from '../../../lib/payroll/resolve-effective-pay-type'
import {
  hasValidPayrollAttendanceRecords,
  resolveFixedDaysWorkedForPayroll,
  resolveFixedDaysWorkedCalendar,
  parseFixedDaysMode,
  shouldIncludeEmployeeInPayrollPreview,
} from '../../../lib/payroll/payroll-attendance-inclusion'
import {
  resolveCompanyPayOvertime,
  shouldPayOvertimeToEmployee,
  resolveFixedOvertimePay,
  readOvertimeOverrideFromMetadata,
  emptyOvertimeBreakdown,
  overtimeBreakdownToMetadata,
  overtimeHoursTotal,
  type OvertimeHoursBreakdown,
} from '../../../lib/payroll/overtime-pay'
import { ahcRowToOvertimeBreakdown } from '../../../lib/attendance/overtime-bands'
import {
  resolveOrdinaryHoursCap,
  sumAdminFloorPeriodHours,
} from '../../../lib/payroll/admin-floor-hours'
import { parseOrdinaryHoursOverrideInput } from '../../../lib/payroll/ordinary-hours-override'
import { ensurePeriodAhcFresh } from '../../../lib/payroll/ensure-period-ahc'
import { createEmployeeSalaryClient } from '../../../lib/security/employee-data-access'
import {
  loadEmployeeScheduleAssignments,
  resolveEffectiveWorkScheduleIdFromAssignments,
} from '../../../lib/attendance/resolve-schedule-batch'
import { isRestDayForDate } from '../../../lib/attendance/schedule-times'
import type { LegacyScheduleColumns } from '../../../lib/attendance/shift-config'
import { computeDaysExtraPay, resolvePayDaysExtra } from '../../../lib/payroll/days-extra-pay'
import {
  fetchPaidLeaveCreditsByEmployee,
  fetchFixedCalendarDayDebitsByEmployee,
  type FixedCalendarDayDebits,
} from '../../../lib/leave/paid-leave-days'
import {
  shouldPreservePayrollLineOnPreview,
  buildFixedPlanillaRowFromPersistedLine,
  buildHourlyPlanillaRowFromPersistedLine,
} from '../../../lib/payroll/preview-preserve-line'
import { findOrphanPayrollLineIds } from '../../../lib/payroll/preview-orphan-lines'
import { resolvePayrollDeductionMode } from '../../../lib/payroll/deduction-mode'

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { supabase, companyId, user, companyCountryCode, companyTimezone } = await requireCompanyAccess(req, res)
    const salaryClient = createEmployeeSalaryClient()
    
    if (!companyId) {
      return res.status(400).json({ error: 'Company ID is required' })
    }

    const countryCode = normalizeCountryCode(companyCountryCode)
    if (!isPayrollCountryEngineEnabled(countryCode)) {
      return res.status(403).json({
        error: 'Nómina no habilitada para este país',
        code: 'PAYROLL_COUNTRY_DISABLED'
      })
    }

    secureLog('Usuario autenticado para preview de nómina', { 
      companyId: companyId 
    })

    const { year, month, quincena } = req.query
    
    secureLog('Parámetros recibidos para preview', { 
      hasYear: !!year, 
      hasMonth: !!month, 
      hasQuincena: !!quincena,
    })
    
    // Validaciones
    if (!year || !month || !quincena) {
      console.error('❌ ERROR - Parámetros faltantes:', { year, month, quincena })
      return res.status(400).json({ 
        error: 'year, month, y quincena son requeridos',
        received: { year, month, quincena }
      })
    }
    
    const yearNum = parseInt(year as string)
    const monthNum = parseInt(month as string)
    const quincenaNum = parseInt(quincena as string)
    
    if (isNaN(yearNum) || isNaN(monthNum) || isNaN(quincenaNum)) {
      console.error('❌ ERROR - Parámetros inválidos (NaN):', { yearNum, monthNum, quincenaNum })
      return res.status(400).json({ 
        error: 'Parámetros numéricos inválidos',
        received: { year, month, quincena },
        parsed: { yearNum, monthNum, quincenaNum }
      })
    }

    const tz = companyTimezone || 'America/Tegucigalpa'
    if (isPayrollCalendarPeriodInFuture(yearNum, monthNum, tz)) {
      return res.status(400).json({ 
        error: 'Período inválido',
        message: 'No se puede generar nómina para períodos futuros'
      })
    }

    // Obtener configuración de payroll (Capa 2: quincena_config + metadata + calculation_mode)
    const { data: payrollConfig, error: configError } = await supabase
      .from('company_payroll_configs')
      .select('metadata, payment_frequency, quincena_config, calculation_mode, incomplete_record_default_hours')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle()
    
    if (configError) {
      console.error('Error obteniendo configuración de payroll:', configError)
    }
    
    const payrollMetadata = payrollConfig?.metadata || {}
    const qcCol = payrollConfig?.quincena_config as { first_start?: number; first_end?: number; second_start?: number; second_end?: number } | null
    const metaCutDates = payrollMetadata?.payment_cut_dates || {}
    const mapFreq = (v: string) => {
      const x = (v || '').toLowerCase()
      if (x === 'mensual' || x === 'monthly') return 'monthly'
      if (x === 'semanal' || x === 'weekly') return 'weekly'
      if (x === 'quincenal' || x === 'biweekly') return 'biweekly'
      return 'biweekly'
    }
    // Frecuencia efectiva del cálculo = config de empresa. employees.payment_frequency
    // no alimenta el preview (ficha; Enlace paga quincenal a nivel empresa).
    const paymentFrequency = mapFreq(payrollConfig?.payment_frequency || payrollMetadata.payment_frequency || 'quincenal')
    const tipoParam = resolvePayrollDeductionMode(payrollMetadata, paymentFrequency)
    const hasCustomQuincena = !!(qcCol && (qcCol.first_start != null || qcCol.first_end != null || qcCol.second_start != null || qcCol.second_end != null))
    const paymentCutDates = qcCol
      ? {
          biweekly_type: (metaCutDates.biweekly_type === 'custom' || hasCustomQuincena) ? 'custom' as const : 'standard' as const,
          biweekly_first_start: qcCol.first_start ?? metaCutDates.biweekly_first_start ?? 1,
          biweekly_first_end: qcCol.first_end ?? metaCutDates.biweekly_first_end ?? 15,
          biweekly_second_start: qcCol.second_start ?? metaCutDates.biweekly_second_start ?? 16,
          biweekly_second_end: qcCol.second_end ?? metaCutDates.biweekly_second_end ?? 30,
          monthly_type: metaCutDates.monthly_type || 'standard',
          monthly_start: metaCutDates.monthly_start ?? 1,
          monthly_end: metaCutDates.monthly_end ?? 30
        }
      : {
          biweekly_type: metaCutDates.biweekly_type || 'standard',
          biweekly_first_start: metaCutDates.biweekly_first_start ?? 1,
          biweekly_first_end: metaCutDates.biweekly_first_end ?? 15,
          biweekly_second_start: metaCutDates.biweekly_second_start ?? 16,
          biweekly_second_end: metaCutDates.biweekly_second_end ?? 30,
          monthly_type: metaCutDates.monthly_type || 'standard',
          monthly_start: metaCutDates.monthly_start ?? 1,
          monthly_end: metaCutDates.monthly_end ?? 30
        }
    const legalDeductions = payrollMetadata.legal_deductions || {
      ihss: true,
      rap: true,
      isr: true,
      infop: false
    }
    const calculationMode = (payrollConfig as any)?.calculation_mode ?? payrollMetadata?.calculation_mode ?? 'daily'
    const companyCalculationMode = parseCompanyCalculationMode(calculationMode)
    const companyPayOvertime = resolveCompanyPayOvertime(payrollMetadata as Record<string, unknown>)
    const ordinaryHoursCap = resolveOrdinaryHoursCap(
      parseOrdinaryHoursOverrideInput(
        (payrollMetadata as Record<string, unknown>)?.ordinary_hours_override
      )
    )
    const incompleteRecordDefaultHours = (payrollConfig as any)?.incomplete_record_default_hours ?? payrollMetadata?.incomplete_record_default_hours ?? null
    const semanalProration = (payrollMetadata?.semanal_proration || 'proportional') as 'proportional' | 'fixed'
    const fixedDaysMode = parseFixedDaysMode((payrollMetadata as Record<string, unknown>)?.fixed_days_mode)
    const payDaysExtra = resolvePayDaysExtra(payrollMetadata as Record<string, unknown>)

    if (paymentFrequency === 'weekly') {
      if (![1, 2, 3, 4].includes(quincenaNum)) {
        console.error('❌ ERROR - Semana inválida:', quincenaNum)
        return res.status(400).json({
          error: 'Semana inválida (debe ser 1, 2, 3 o 4 para nómina semanal)',
          received: quincenaNum
        })
      }
    } else if (![1, 2].includes(quincenaNum)) {
      console.error('❌ ERROR - Quincena inválida:', quincenaNum)
      return res.status(400).json({
        error: 'Quincena inválida (debe ser 1 o 2)',
        received: quincenaNum
      })
    }

    const { data: companyRow } = await supabase
      .from('companies')
      .select('settings')
      .eq('id', companyId)
      .single()
    const useIsrProjection = (companyRow?.settings as Record<string, unknown>)?.use_isr_projection === true
    
    const periodCtx = resolvePayrollPeriodContext(
      yearNum,
      monthNum,
      quincenaNum,
      paymentFrequency as PreviewPaymentFrequency,
      paymentCutDates
    )
    const { fechaInicio, fechaFin, diasPeriodo, ultimoDiaCalendario } = periodCtx

    if (!ultimoDiaCalendario || ultimoDiaCalendario < 1 || ultimoDiaCalendario > 31) {
      console.error(
        `❌ ERROR - ultimoDiaCalendario inválido: ${ultimoDiaCalendario} para año ${yearNum}, mes ${monthNum}`
      )
      return res.status(400).json({
        error: 'Período inválido',
        message: `No se pudo calcular el último día del mes ${monthNum} del año ${yearNum}`
      })
    }

    // Verificar si ya existe una corrida para este período
    const { data: existingRun, error: checkError } = await supabase
      .from('payroll_runs')
      .select('id, status, year, month, quincena, tipo')
      .eq('company_id', companyId)
      .eq('year', yearNum)
      .eq('month', monthNum)
      .eq('quincena', quincenaNum)
      .eq('tipo', tipoParam)
      .maybeSingle()

    if (checkError && checkError.code !== 'PGRST116') { // PGRST116 = no rows found, which is OK
      console.error('Error verificando corrida existente:', checkError)
      return res.status(500).json({ 
        error: 'Error verificando corrida existente',
        details: checkError.message 
      })
    }

    let runId: string

    if (existingRun) {
      // Corrida cerrada: devolver datos persistidos sin mutar estado ni líneas.
      // (Antes: se pasaba a draft y se borraban líneas en cada GET → contabilidad veía draft.)
      if (isFrozenPayrollRunStatus(existingRun.status)) {
        try {
          const payload = await buildAuthorizedPayrollPreviewPayload(supabase, companyId, {
            id: existingRun.id,
            year: existingRun.year,
            month: existingRun.month,
            quincena: existingRun.quincena,
            tipo: existingRun.tipo,
            status: existingRun.status
          })
          return res.status(200).json(payload)
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : 'Error leyendo planilla autorizada'
          console.error('Error en preview solo lectura (autorizada):', e)
          return res.status(500).json({ error: msg })
        }
      }

      runId = existingRun.id
    } else {
      // Crear nueva corrida
      const { data: newRun, error: createError } = await supabase
        .from('payroll_runs')
        .insert({
          company_id: companyId,
          year: yearNum,
          month: monthNum,
          quincena: quincenaNum,
          tipo: tipoParam,
          status: 'draft',
          created_by: user.id
        })
        .select('id')
        .single()

      if (createError) {
        console.error('Error creando nueva corrida:', createError)
        return res.status(500).json({ error: 'Error creando nueva corrida de planilla' })
      }

      if (!newRun || !newRun.id) {
        console.error('❌ ERROR - No se pudo obtener el ID de la nueva corrida')
        return res.status(500).json({ 
          error: 'Error creando nueva corrida de planilla',
          message: 'No se pudo obtener el ID de la corrida creada'
        })
      }

      runId = newRun.id
    }

    // Validar que runId existe antes de continuar
    if (!runId) {
      console.error('❌ ERROR - runId es null/undefined después de crear/obtener corrida')
      return res.status(500).json({ 
        error: 'Error interno: runId no disponible',
        message: 'No se pudo obtener o crear el ID de la corrida'
      })
    }

    const yearCtx = await getTaxEngine(countryCode).loadYearContext(yearNum)
    const blocked = payrollStatutoryYearUnavailable(yearCtx, countryCode, yearNum)
    if (!blocked.ok) return res.status(blocked.status).json(blocked.body)
    await assertNonHndStatutoryConfigParses(countryCode, yearNum, supabase)
    const taxConstants = yearCtx.hndTaxConstants ?? undefined

    // Obtener empleados activos con información de departamento, pay_type y horario (Capa 3: días Extra/Especial)
    const { data: employees, error: empError } = await salaryClient
      .from('employees')
      .select(`
        id, name, dni, employee_code, base_salary, bank_name, bank_account, status, department_id, pay_type, attendance_required, pay_overtime, work_schedule_id, position, role, hire_date, termination_date,
        departments:department_id(name),
        work_schedules:work_schedule_id(monday_start, tuesday_start, wednesday_start, thursday_start, friday_start, saturday_start, sunday_start)
      `)
      .eq('status', 'active')
      .eq('company_id', companyId)
      .order('name')

    if (empError) {
      console.error('Error obteniendo empleados:', empError)
      console.error('Error details:', JSON.stringify(empError, null, 2))
      return res.status(500).json({ 
        error: 'Error obteniendo empleados',
        details: empError.message || String(empError),
        code: empError.code
      })
    }

    if (!employees || employees.length === 0) {
      secureLog('No hay empleados activos para preview', { companyId })
      return res.status(400).json({ 
        error: 'No hay empleados activos',
        message: 'No se encontraron empleados activos para generar la nómina'
      })
    }
    
    secureLog('Empleados encontrados para preview', { 
      employeesCount: employees.length,
      companyId 
    })

    // Capa 3: Fechas festivas en el período (para días Extra/Especial)
    const holidayDates = await getHolidayDatesInRange(fechaInicio, fechaFin, companyId, supabase)

    // Obtener registros de asistencia del período (incluir flags para horario_no_detectado)
    // Filtrar solo por empleados de esta empresa usando los IDs ya obtenidos
    const employeeIds = employees.map((emp: any) => emp.id)
    
    let attendanceRecords: any[] = [];
    if (employeeIds.length > 0) {
      const { data: attData, error: attError } = await supabase
        .from('attendance_records')
        .select('id, employee_id, date, check_in, check_out, status, flags, updated_at')
        .in('employee_id', employeeIds)
        .gte('date', fechaInicio)
        .lte('date', fechaFin)

      if (attError) {
        console.error('Error obteniendo registros de asistencia:', attError)
        console.error('Error details:', JSON.stringify(attError, null, 2))
        return res.status(500).json({ 
          error: 'Error obteniendo registros de asistencia',
          details: attError.message || String(attError),
          code: attError.code
        })
      }
      
      attendanceRecords = attData || []
    }

    let paidLeaveCreditsByEmployee = new Map<string, number>()
    if (employeeIds.length > 0) {
      try {
        paidLeaveCreditsByEmployee = await fetchPaidLeaveCreditsByEmployee(
          supabase,
          companyId,
          fechaInicio,
          fechaFin,
          employeeIds
        )
      } catch (paidLeaveErr) {
        console.error('Error obteniendo créditos de permisos pagados:', paidLeaveErr)
        return res.status(500).json({
          error: 'Error obteniendo permisos pagados para nómina',
          details: paidLeaveErr instanceof Error ? paidLeaveErr.message : String(paidLeaveErr),
        })
      }
    }

    let calendarDebitsByEmployee = new Map<string, FixedCalendarDayDebits>()
    if (fixedDaysMode === 'calendar' && employeeIds.length > 0) {
      try {
        calendarDebitsByEmployee = await fetchFixedCalendarDayDebitsByEmployee(
          supabase,
          companyId,
          fechaInicio,
          fechaFin,
          employeeIds
        )
      } catch (debitsErr) {
        console.error('Error obteniendo ausencias y permisos sin goce:', debitsErr)
        return res.status(500).json({
          error: 'Error obteniendo ausencias y permisos sin goce para nómina',
          details: debitsErr instanceof Error ? debitsErr.message : String(debitsErr),
        })
      }
    }

    // attendance_hours_calculation:
    // (1) Tracking overtime hours — ALL employees (columna Horas extra AHC); independent of calculation_mode.
    // (2) Hour aggregates for bruto — hour-based effective types (hourly + admin_floor).
    const effectivePayTypeByEmployee: Record<string, 'fixed' | 'hourly' | 'admin_floor'> = {}
    for (const emp of employees || []) {
      effectivePayTypeByEmployee[emp.id] = resolveEffectivePayType(emp.pay_type, companyCalculationMode)
    }

    const completeAttendanceForAhc = (attendanceRecords || []).filter(
      (r: any) => r?.id && r.check_in && r.check_out
    )
    const ahcRefresh = await ensurePeriodAhcFresh({
      supabase,
      completeRecords: completeAttendanceForAhc.map((r: any) => ({
        id: r.id as string,
        updated_at: r.updated_at ?? null,
      })),
      lawYear: yearNum,
    })
    if (ahcRefresh.error) {
      console.warn('Preview AHC refresh warning:', ahcRefresh.error)
    }

    let ahcByEmployee: Record<string, { total_hours: number; normal_hours: number; by_record: Record<string, number> }> = {}
    const ahcOvertimeByEmployee: Record<string, number> = {}
    const ahcOvertimeBreakdownByEmployee: Record<string, OvertimeHoursBreakdown> = {}
    const rawClockFallbackEmployeeIds: string[] = []
    if (employeeIds.length > 0) {
      const { data: ahcData } = await supabase
        .from('attendance_hours_calculation')
        .select(`
          employee_id,
          attendance_record_id,
          total_hours,
          normal_hours,
          overtime_diurno_hours,
          overtime_nocturno_hours,
          overtime_feriado_hours,
          overtime_evening_25_hours,
          overtime_night_50_hours,
          overtime_late_75_hours,
          overtime_morning_25_hours,
          overtime_holiday_100_hours
        `)
        .in('employee_id', employeeIds)
      if (ahcData && ahcData.length > 0) {
        const arIds = [...new Set(ahcData.map((r: any) => r.attendance_record_id))]
        const { data: arDates } = await supabase
          .from('attendance_records')
          .select('id, date')
          .in('id', arIds)
          .gte('date', fechaInicio)
          .lte('date', fechaFin)
        const validArIds = new Set((arDates || []).map((r: any) => r.id))
        for (const row of ahcData) {
          if (!validArIds.has(row.attendance_record_id)) continue
          const mapped = ahcRowToOvertimeBreakdown(row)
          const ot = overtimeHoursTotal(mapped)
          const eid = row.employee_id as string
          ahcOvertimeByEmployee[eid] = (ahcOvertimeByEmployee[eid] || 0) + ot
          if (!ahcOvertimeBreakdownByEmployee[eid]) {
            ahcOvertimeBreakdownByEmployee[eid] = emptyOvertimeBreakdown()
          }
          ahcOvertimeBreakdownByEmployee[eid].evening_25 += mapped.evening_25
          ahcOvertimeBreakdownByEmployee[eid].night_50 += mapped.night_50
          ahcOvertimeBreakdownByEmployee[eid].late_75 += mapped.late_75
          ahcOvertimeBreakdownByEmployee[eid].morning_25 += mapped.morning_25
          ahcOvertimeBreakdownByEmployee[eid].holiday_100 += mapped.holiday_100
          if (!isHourBasedPayType(effectivePayTypeByEmployee[eid])) continue
          if (!ahcByEmployee[eid]) {
            ahcByEmployee[eid] = { total_hours: 0, normal_hours: 0, by_record: {} }
          }
          const h = Number(row.total_hours) || 0
          const normalH = Number(row.normal_hours) ?? Math.max(0, h - ot)
          ahcByEmployee[eid].total_hours += h
          ahcByEmployee[eid].normal_hours += normalH
          ahcByEmployee[eid].by_record[row.attendance_record_id] = h
        }
      }
    }

    // Filtrar empleados según criterio de asistencia (pay_type + attendance_required)
    let empleadosParaNomina = employees
    let noAttendanceWarning = null
    const periodHasAttendanceRecords = attendanceRecords.length > 0
    const attendanceExemptIncluded: { employee_id: string; employee_name: string }[] = []
    
    if (periodHasAttendanceRecords) {
      empleadosParaNomina = employees.filter((emp: any) => {
        const allEmpRecords = attendanceRecords.filter((record: any) => 
          record.employee_id === emp.id
        )
        const hasValidRecord = hasValidPayrollAttendanceRecords(allEmpRecords)
        const effectivePayType = resolveEffectivePayType(emp.pay_type, companyCalculationMode)
        const include = shouldIncludeEmployeeInPayrollPreview(
          emp.attendance_required,
          effectivePayType,
          hasValidRecord,
          periodHasAttendanceRecords
        )

        if (include && effectivePayType === 'fixed' && emp.attendance_required === false && !hasValidRecord) {
          attendanceExemptIncluded.push({
            employee_id: emp.id,
            employee_name: emp.name || 'Sin nombre',
          })
        }

        return include
      })
    } else {
      // Si no hay registros de asistencia, incluir todos los empleados activos
      empleadosParaNomina = employees
      noAttendanceWarning = {
        message: 'No se encontraron registros de asistencia para el período seleccionado.',
        detail: 'Se incluirán todos los empleados activos en la nómina.',
        action: 'confirm'
      }
    }

    if (empleadosParaNomina.length === 0) {
      // En lugar de retornar error 400, retornar datos vacíos (comportamiento estándar)
      // Esto permite que la UI muestre "0 empleados" en lugar de un error
      return res.status(200).json({
        message: 'No hay empleados con asistencia para el período seleccionado',
        run_id: runId,
        status: 'draft',
        year: yearNum,
        month: monthNum,
        quincena: quincenaNum,
        tipo: tipoParam,
        empleados: 0,
        empleados_fixed: 0,
        empleados_hourly: 0,
        totalBruto: 0,
        totalDeducciones: 0,
        totalNeto: 0,
        totalBrutoFixed: 0,
        totalDeduccionesFixed: 0,
        totalNetoFixed: 0,
        totalBrutoHourly: 0,
        totalDeduccionesHourly: 0,
        totalNetoHourly: 0,
        planilla_fixed: [],
        planilla_hourly: [],
        planilla: [],
        warning: attendanceRecords.length === 0 
          ? 'No se encontraron registros de asistencia para el período seleccionado'
          : 'No se encontraron empleados con asistencia válida para el período seleccionado',
        incompleteRecordsAlert: undefined,
        noAttendanceWarning: attendanceRecords.length === 0 ? {
          message: 'No se encontraron registros de asistencia para el período seleccionado.',
          detail: 'Se incluirán todos los empleados activos en la nómina.',
          action: 'confirm'
        } : null
      })
    }

    // Auto-aplicar planes de deducción activos (employee_deduction_plans)
    const empIdsForPlans = empleadosParaNomina.map((e: any) => e.id)
    let plansByEmployee: Record<string, any[]> = {}
    if (empIdsForPlans.length > 0) {
      const { data: plansData } = await supabase
        .from('employee_deduction_plans')
        .select('id, employee_id, field_key, monto_por_plazo, plazos_aplicados, plazos_totales')
        .in('employee_id', empIdsForPlans)
        .eq('company_id', companyId)
        .eq('activo', true)
      if (plansData && plansData.length > 0) {
        for (const p of plansData) {
          if (p.plazos_aplicados < p.plazos_totales) {
            if (!plansByEmployee[p.employee_id]) plansByEmployee[p.employee_id] = []
            plansByEmployee[p.employee_id].push(p)
          }
        }
      }
    }
    
    // Separar en dos arrays: fixed y hourly
    const planilla_fixed: any[] = []
    const planilla_hourly: any[] = []
    let preservedEditedLines = 0
    
    // Función auxiliar para calcular horas trabajadas desde registros
    const calculateHoursWorked = (registros: any[]): number => {
      let totalHours = 0
      for (const record of registros) {
        if (record.check_in && record.check_out) {
          const checkIn = new Date(record.check_in)
          const checkOut = new Date(record.check_out)
          const diffMs = checkOut.getTime() - checkIn.getTime()
          const hours = diffMs / (1000 * 60 * 60) // Convertir a horas
          totalHours += Math.max(0, hours) // Evitar horas negativas
        }
      }
      return totalHours
    }
    
    const incompleteRecordsAlert: { employee_id: string; employee_name: string; dates: string[] }[] = []

    const { data: existingRunLinesForSkip } = await supabase
      .from('payroll_run_lines')
      .select(
        'id, employee_id, edited, metadata, eff_hours, eff_bruto, eff_ihss, eff_rap, eff_isr, eff_neto'
      )
      .eq('run_id', runId)
      .eq('company_id', companyId)

    const existingLineByEmployee: Record<string, any> = {}
    for (const row of existingRunLinesForSkip || []) {
      if (row.employee_id) existingLineByEmployee[row.employee_id] = row
    }

    const payrollAssignmentMap = await loadEmployeeScheduleAssignments({
      supabase,
      companyId,
      employeeIds: empleadosParaNomina.map((e: any) => e.id),
      rangeFrom: fechaInicio,
      rangeTo: fechaFin,
    })

    const payrollScheduleIds = new Set<string>()
    for (const emp of empleadosParaNomina as any[]) {
      if (emp.work_schedule_id) payrollScheduleIds.add(emp.work_schedule_id)
      for (const a of payrollAssignmentMap.get(emp.id) || []) {
        if (a.work_schedule_id) payrollScheduleIds.add(a.work_schedule_id)
      }
    }

    const payrollScheduleById = new Map<string, LegacyScheduleColumns>()
    if (payrollScheduleIds.size > 0) {
      const { data: schedRows } = await supabase
        .from('work_schedules')
        .select(
          'id, monday_start, monday_end, tuesday_start, tuesday_end, wednesday_start, wednesday_end, thursday_start, thursday_end, friday_start, friday_end, saturday_start, saturday_end, sunday_start, sunday_end, shift_config, break_duration'
        )
        .in('id', [...payrollScheduleIds])
      for (const row of schedRows || []) {
        payrollScheduleById.set(row.id, row as LegacyScheduleColumns)
      }
    }

    for (const emp of empleadosParaNomina) {
      const effectivePayType = resolveEffectivePayType(emp.pay_type, companyCalculationMode)

      // Filtrar registros según tipo de pago
      let registros: any[];
      if (effectivePayType === 'fixed') {
        // Administrativos: contar días con check_in (check_out opcional)
        registros = attendanceRecords.filter((record: any) => 
          record.employee_id === emp.id && 
          record.check_in
        );
      } else {
        // Por hora: registros con check_in (completos o incompletos)
        registros = attendanceRecords.filter((record: any) => 
          record.employee_id === emp.id && record.check_in
        )
      }
      
      const base_salary = Number(emp.base_salary) || 0
      
      // Manejar el caso donde departments puede ser null, objeto o un array
      let departmentName = 'Sin Departamento'
      const dept = emp.departments
      if (dept) {
        if (Array.isArray(dept) && dept.length > 0) {
          departmentName = dept[0]?.name || 'Sin Departamento'
        } else if (!Array.isArray(dept) && typeof dept === 'object' && 'name' in dept) {
          departmentName = String((dept as { name?: string }).name || 'Sin Departamento')
        }
      }

      if (effectivePayType === 'fixed') {
        // ========== EMPLEADOS FIJOS (FIXED) ==========
        const prevLine = existingLineByEmployee[emp.id]
        if (shouldPreservePayrollLineOnPreview(prevLine, {
          currentEffectivePayType: effectivePayType,
          currentBaseSalary: base_salary,
        })) {
          preservedEditedLines += 1
          planilla_fixed.push(
            buildFixedPlanillaRowFromPersistedLine({
              emp: {
                id: emp.id,
                dni: emp.dni,
                name: emp.name,
                bank_name: emp.bank_name,
                bank_account: emp.bank_account,
                base_salary,
              },
              departmentName,
              prevLine,
              horasExtras: ahcOvertimeByEmployee[emp.id] || 0,
              diasPeriodo,
            })
          )
          continue
        }

        const paidLeaveCredits = paidLeaveCreditsByEmployee.get(emp.id) || 0
        let { daysWorked: days_worked, includedWithoutAttendance, paidLeaveDays } =
          resolveFixedDaysWorkedForPayroll(
            effectivePayType,
            emp.attendance_required,
            registros.length,
            diasPeriodo,
            paidLeaveCredits
          )
        let calendarDays: ReturnType<typeof resolveFixedDaysWorkedCalendar> | null = null
        if (fixedDaysMode === 'calendar') {
          const debits = calendarDebitsByEmployee.get(emp.id)
          calendarDays = resolveFixedDaysWorkedCalendar({
            effectivePayType,
            attendanceRequired: emp.attendance_required,
            diasPeriodo,
            periodFrom: fechaInicio,
            periodTo: fechaFin,
            hireDate: emp.hire_date,
            terminationDate: emp.termination_date,
            unjustifiedAbsenceDays: debits?.unjustifiedAbsenceDays ?? 0,
            unpaidLeaveDays: debits?.unpaidLeaveDays ?? 0,
          })
          days_worked = calendarDays.daysWorked
        }
        const days_absent = Math.max(0, diasPeriodo - days_worked)

        // Capa 3: Días Extra/Especial (festivo o descanso con asistencia)
        let days_extra = 0
        for (const r of registros) {
          const isHoliday = holidayDates.has(r.date)
          const eff = resolveEffectiveWorkScheduleIdFromAssignments({
            assignments: payrollAssignmentMap.get(emp.id) || [],
            date: r.date,
            fallbackWorkScheduleId: emp.work_schedule_id,
          })
          const sched = eff.found && eff.workScheduleId ? payrollScheduleById.get(eff.workScheduleId) : null
          const isRestDay = sched ? isRestDayForDate(sched, r.date) : false
          if (isHoliday || isRestDay) days_extra++
        }
        
        let dayGross = computeFixedGrossFromDays({
          baseSalary: base_salary,
          daysWorked: days_worked,
          paymentFrequency: paymentFrequency as PreviewPaymentFrequency,
          diasPeriodo,
          ultimoDiaCalendario: periodCtx.ultimoDiaCalendario,
          isMonthlyCalendarStandard: periodCtx.isMonthlyCalendarStandard,
          semanalProration
        })

        if (!isFinite(dayGross) || isNaN(dayGross)) {
          console.error(`❌ ERROR - dayGross inválido para empleado ${emp.name}:`, dayGross)
          dayGross = 0
        }

        const prevMeta = (existingLineByEmployee[emp.id]?.metadata || null) as
          | Record<string, unknown>
          | null
        const otResolved = resolveFixedOvertimePay({
          companyPayOvertime,
          employeePayOvertime: emp.pay_overtime,
          hourlyRate: base_salary / HONDURAS_LABOR_FACTOR,
          ahcBreakdown: ahcOvertimeBreakdownByEmployee[emp.id] || emptyOvertimeBreakdown(),
          overrideBreakdown: readOvertimeOverrideFromMetadata(prevMeta),
        })
        const days_extra_pay = payDaysExtra ? computeDaysExtraPay(days_extra, base_salary) : 0
        let total_earnings = dayGross + otResolved.pay + days_extra_pay

        if (!isFinite(total_earnings) || isNaN(total_earnings)) {
          console.error(`❌ ERROR - total_earnings inválido para empleado ${emp.name}:`, total_earnings)
          total_earnings = 0
        }

        const empPlans = plansByEmployee[emp.id] || []
        const ded = await computeFixedLineDeductionsAndNet({
          supabase,
          companyId,
          employeeId: emp.id,
          year: yearNum,
          month: monthNum,
          quincena: quincenaNum,
          paymentFrequency: paymentFrequency as PreviewPaymentFrequency,
          tipoParam: tipoParam as 'CON' | 'SIN' | '2PAGOS',
          legalDeductions,
          useIsrProjection,
          taxConstants,
          countryCode,
          totalEarnings: total_earnings,
          baseSalary: base_salary,
          empPlans
        })
        const { IHSS, RAP, ISR, totalDeductions: total_deductions, total } = ded

        // Validar que runId existe antes de insertar
        if (!runId) {
          console.error(`❌ ERROR - runId es null/undefined para empleado ${emp.name}`)
          return res.status(500).json({ 
            error: 'Error interno: runId no disponible',
            message: `No se pudo obtener el ID de la corrida para insertar la línea del empleado ${emp.name}`
          })
        }

        // Validar que todos los valores numéricos sean válidos antes de insertar
        const numericValues = {
          days_worked,
          total_earnings,
          IHSS,
          RAP,
          ISR,
          total
        }
        
        for (const [key, value] of Object.entries(numericValues)) {
          if (!isFinite(value) || isNaN(value)) {
            console.error(`❌ ERROR - Valor inválido ${key} para empleado ${emp.name}:`, value)
            return res.status(500).json({ 
              error: 'Error en cálculo de nómina',
              message: `Valor inválido ${key} para el empleado ${emp.name}: ${value}`
            })
          }
        }

        const lineMetadata = buildFixedLinePlanMetadata(yearNum, empPlans, {
          base_salary_used: base_salary,
          position_snapshot: String((emp as any).position || (emp as any).role || ''),
          horas_extras: otResolved.hoursTotal,
          overtime_pay: otResolved.pay,
          ...overtimeBreakdownToMetadata(otResolved.breakdown),
          ihss_patronal:
            countryCode === 'HND' && taxConstants
              ? calculateEmployerContributions({
                  monthlySalary: base_salary,
                  taxConstants,
                  factor2Pagos: tipoParam === '2PAGOS' ? 0.5 : 1
                }).ihssPatronal
              : 0,
          rap_patronal:
            countryCode === 'HND' && taxConstants
              ? calculateEmployerContributions({
                  monthlySalary: base_salary,
                  taxConstants,
                  factor2Pagos: tipoParam === '2PAGOS' ? 0.5 : 1
                }).rapPatronal
              : 0,
          ...(days_extra > 0
            ? {
                days_extra,
                notes_extra: `${days_extra} día(s) Extra/Especial (festivo/descanso)`
              }
            : {}),
          ...(days_extra_pay > 0 ? { days_extra_pay } : {}),
          ...(includedWithoutAttendance ? { included_without_attendance: true } : {}),
          ...(calendarDays
            ? {
                fixed_days_mode: 'calendar',
                unjustified_absence_days: calendarDays.unjustifiedAbsenceDays,
                unpaid_leave_days: calendarDays.unpaidLeaveDays,
                days_outside_contract: calendarDays.daysOutsideContract,
              }
            : {}),
          ...(paidLeaveDays > 0
            ? {
                paid_leave_days: paidLeaveDays,
                notes_paid_leave: `${paidLeaveDays} día(s) permiso con goce (sin marca)`,
              }
            : {}),
        })

        // Preserve manual OT override markers across regenerate (hours already applied above)
        if (prevMeta?.ot_adjusted_at != null) {
          lineMetadata.ot_adjusted_at = prevMeta.ot_adjusted_at
          if (prevMeta.ot_adjusted_by != null) lineMetadata.ot_adjusted_by = prevMeta.ot_adjusted_by
          if (prevMeta.ot_adjusted_reason != null) {
            lineMetadata.ot_adjusted_reason = prevMeta.ot_adjusted_reason
          }
          if (prevMeta.ot_adjust_reason != null) {
            lineMetadata.ot_adjust_reason = prevMeta.ot_adjust_reason
          }
        }

        // Insertar línea en payroll_run_lines
        const { data: insertedLine, error: lineError } = await supabase
          .from('payroll_run_lines')
          .upsert({
            run_id: runId,
            company_id: companyId,
            employee_id: emp.id,
            calc_hours: days_worked,
            calc_bruto: total_earnings,
            calc_ihss: IHSS,
            calc_rap: RAP,
            calc_isr: ISR,
            calc_neto: total,
            eff_hours: days_worked,
            eff_bruto: total_earnings,
            eff_ihss: IHSS,
            eff_rap: RAP,
            eff_isr: ISR,
            eff_neto: total,
            edited: false,
            tax_year: yearNum,
            metadata: lineMetadata,
          }, {
            onConflict: 'run_id,employee_id',
            ignoreDuplicates: false
          })
          .select('id')
          .maybeSingle()
          
        if (lineError) {
          console.error(`❌ ERROR insertando línea para empleado ${emp.name}:`, lineError)
          return res.status(500).json({ 
            error: 'Error insertando línea de nómina',
            message: `No se pudo insertar la línea para el empleado ${emp.name}: ${lineError.message}`,
            details: lineError,
            code: lineError.code
          })
        }
        
        if (!insertedLine) {
          console.error(`❌ ERROR - No se retornó línea insertada para empleado ${emp.name}`)
          return res.status(500).json({ 
            error: 'Error insertando línea de nómina',
            message: `No se pudo obtener el ID de la línea insertada para el empleado ${emp.name}`
          })
        }

        planilla_fixed.push({
          employee_id: emp.id,
          id: emp.employee_code || '',
          name: emp?.name || 'Sin nombre',
          bank: emp.bank_name || 'No especificado',
          bank_account: emp.bank_account || 'No especificado',
          department: departmentName,
          base_salary: base_salary,
          monthly_salary: base_salary,
          days_worked,
          days_absent,
          days_extra: days_extra > 0 ? days_extra : undefined,
          notes_extra: days_extra > 0 ? `${days_extra} día(s) Extra/Especial (festivo/descanso)` : undefined,
          horas_extras: otResolved.hoursTotal,
          overtime_pay: otResolved.pay > 0 ? otResolved.pay : undefined,
          days_extra_pay: days_extra_pay > 0 ? days_extra_pay : undefined,
          total_earnings: Math.round(total_earnings * 100) / 100,
          IHSS: Math.round(IHSS * 100) / 100,
          RAP: Math.round(RAP * 100) / 100,
          ISR: Math.round(ISR * 100) / 100,
          total_deducciones: Math.round(total_deductions * 100) / 100,
          total: Math.round(total * 100) / 100,
          line_id: insertedLine.id,
          pay_type: 'fixed',
          metadata: lineMetadata,
          included_without_attendance: includedWithoutAttendance || undefined,
        })
        
      } else {
        // ========== EMPLEADOS POR HORA / ADMIN PISO ==========
        const prevLineHourly = existingLineByEmployee[emp.id]
        if (shouldPreservePayrollLineOnPreview(prevLineHourly, {
          currentEffectivePayType: effectivePayType,
          currentBaseSalary: base_salary,
        })) {
          preservedEditedLines += 1
          const hourly_rate_preserved = base_salary / HONDURAS_LABOR_FACTOR
          const days_worked_preserved = registros.length
          const preservedRow = buildHourlyPlanillaRowFromPersistedLine({
              emp: {
                id: emp.id,
                dni: emp.dni,
                name: emp.name,
                bank_name: emp.bank_name,
                bank_account: emp.bank_account,
                base_salary,
              },
              departmentName,
              prevLine: prevLineHourly,
              horasExtras: ahcOvertimeByEmployee[emp.id] || 0,
              diasPeriodo,
              daysWorked: days_worked_preserved,
              hourlyRate: hourly_rate_preserved,
              payType: effectivePayType === 'admin_floor' ? 'admin_floor' : 'hourly',
            })
          planilla_hourly.push(preservedRow)
          continue
        }

        const completeRegistros = registros.filter((r: any) => r.check_in && r.check_out)
        const incompleteRegistros = registros.filter((r: any) => r.check_in && !r.check_out)

        if (incompleteRegistros.length > 0) {
          incompleteRecordsAlert.push({
            employee_id: emp.id,
            employee_name: emp.name || 'Sin nombre',
            dates: incompleteRegistros.map((r: any) => r.date)
          })
        }

        let total_hours_worked: number
        let horasExtrasDisplay = Math.round((ahcOvertimeByEmployee[emp.id] || 0) * 100) / 100
        const ahcEmp = ahcByEmployee[emp.id]
        const payOvertimeMoney = shouldPayOvertimeToEmployee(
          companyPayOvertime,
          effectivePayType,
          emp.pay_overtime
        )

        if (effectivePayType === 'admin_floor') {
          const floorDays = registros.map((r: any) => {
            const fromAhc = ahcEmp?.by_record?.[r.id]
            let total_hours = Number(fromAhc)
            if (!Number.isFinite(total_hours) || total_hours < 0) {
              total_hours =
                r.check_in && r.check_out ? calculateHoursWorked([r]) : 0
            }
            return {
              check_in: r.check_in,
              check_out: r.check_out,
              total_hours,
            }
          })
          const floor = sumAdminFloorPeriodHours(floorDays, ordinaryHoursCap)
          total_hours_worked = payOvertimeMoney ? floor.payable : floor.ordinary
          horasExtrasDisplay = floor.overtime
        } else if (ahcEmp && (ahcEmp.total_hours > 0 || ahcEmp.normal_hours > 0)) {
          // Statu quo when paying OT: all AHC hours at base rate. When off: only ordinary hours count toward bruto.
          total_hours_worked = payOvertimeMoney ? ahcEmp.total_hours : ahcEmp.normal_hours
          if (incompleteRecordDefaultHours != null && incompleteRecordDefaultHours > 0 && incompleteRegistros.length > 0) {
            total_hours_worked += incompleteRecordDefaultHours * incompleteRegistros.length
          }
        } else {
          // Last resort after ensurePeriodAhcFresh — no lunch/band logic.
          if (completeRegistros.length > 0) {
            rawClockFallbackEmployeeIds.push(emp.id)
          }
          total_hours_worked = calculateHoursWorked(completeRegistros)
          if (incompleteRecordDefaultHours != null && incompleteRecordDefaultHours > 0 && incompleteRegistros.length > 0) {
            total_hours_worked += incompleteRecordDefaultHours * incompleteRegistros.length
          }
        }

        const days_worked = registros.length
        const days_absent = diasPeriodo - days_worked

        // base_salary siempre mensual (post-migración). Tarifa horaria = base_salary / 240.
        const hourly_rate = base_salary / HONDURAS_LABOR_FACTOR

        // Calcular salario bruto del período basado en horas trabajadas
        let total_earnings = total_hours_worked * hourly_rate

        // Séptimo Día (Art. 338-340): solo para pay_type === 'hourly' (no admin_floor)
        let septimoDia = 0
        if (effectivePayType === 'hourly' && hourly_rate > 0) {
          const ordinaryHours = ahcEmp?.normal_hours ?? Math.max(0, total_hours_worked)
          septimoDia = calculateSeptimoDia({
            hourlyRate: hourly_rate,
            ordinaryHours,
            daysWorked: days_worked,
            totalHours: total_hours_worked,
            semanalProration
          })
          total_earnings += septimoDia
        }
        
        // Validar que total_earnings sea un número válido
        if (!isFinite(total_earnings) || isNaN(total_earnings)) {
          console.error(`❌ ERROR - total_earnings inválido para empleado ${emp.name}:`, total_earnings)
          total_earnings = 0
        }
        
        let IHSS = 0, RAP = 0, ISR = 0, total_deductions = 0, total = 0

        const fractionOpt =
          paymentFrequency === 'weekly' && quincenaNum >= 1 && quincenaNum <= 4
            ? quincenaNum / 4
            : undefined

        if (tipoParam === 'CON') {
          const horasPeriodo = paymentFrequency === 'monthly' ? HORAS_PERIODO_MENSUAL : HORAS_PERIODO_QUINCENAL
          const deductionFactor = horasPeriodo > 0 ? total_hours_worked / horasPeriodo : 0

          const st = await computePayrollEmployeeStatutoryDeductions({
            countryCode,
            year: yearNum,
            baseMonthlySalary: base_salary,
            factor2Pagos: 1,
            legalDeductions,
            simpleIsrMonthlyBase: total_earnings,
            useIsrProjection: countryCode === 'HND' && useIsrProjection,
            hndTaxConstants: taxConstants,
            runIsrProjection:
              countryCode === 'HND' && useIsrProjection && legalDeductions.isr && taxConstants
                ? () =>
                    getIsrForPeriod({
                      supabase,
                      employeeId: emp.id,
                      companyId,
                      year: yearNum,
                      month: monthNum,
                      quincena: quincenaNum,
                      periodIncome: total_earnings,
                      taxConstants,
                      factor2Pagos: 1,
                      useProjection: true,
                      ...(fractionOpt != null ? { fractionOfMonthElapsed: fractionOpt } : {})
                    })
                : undefined,
            supabase
          })
          IHSS = st.ihss * deductionFactor
          RAP = st.rap * deductionFactor
          ISR = st.isr * deductionFactor
          total_deductions = IHSS + RAP + ISR
          total = total_earnings - total_deductions
        } else if (tipoParam === '2PAGOS') {
          const st = await computePayrollEmployeeStatutoryDeductions({
            countryCode,
            year: yearNum,
            baseMonthlySalary: base_salary,
            factor2Pagos: 0.5,
            legalDeductions,
            simpleIsrMonthlyBase: base_salary,
            useIsrProjection: countryCode === 'HND' && useIsrProjection,
            hndTaxConstants: taxConstants,
            runIsrProjection:
              countryCode === 'HND' && useIsrProjection && legalDeductions.isr && taxConstants
                ? () =>
                    getIsrForPeriod({
                      supabase,
                      employeeId: emp.id,
                      companyId,
                      year: yearNum,
                      month: monthNum,
                      quincena: quincenaNum,
                      periodIncome: base_salary,
                      taxConstants,
                      factor2Pagos: 0.5,
                      useProjection: true,
                      ...(fractionOpt != null ? { fractionOfMonthElapsed: fractionOpt } : {})
                    })
                : undefined,
            supabase
          })
          IHSS = st.ihss
          RAP = st.rap
          ISR = st.isr
          total_deductions = IHSS + RAP + ISR
          total = total_earnings - total_deductions
        } else {
          total = total_earnings
        }

        // Sincronizar con módulo Deducciones: planes activos se aplican siempre (CON, SIN o 2PAGOS)
        const empPlansHourly = plansByEmployee[emp.id] || []
        let customDeductionsHourly = 0
        for (const plan of empPlansHourly) {
          customDeductionsHourly += Number(plan.monto_por_plazo) || 0
        }
        total_deductions += customDeductionsHourly
        total = total_earnings - total_deductions

        // Validar que runId existe antes de insertar
        if (!runId) {
          console.error(`❌ ERROR - runId es null/undefined para empleado ${emp.name}`)
          return res.status(500).json({ 
            error: 'Error interno: runId no disponible',
            message: `No se pudo obtener el ID de la corrida para insertar la línea del empleado ${emp.name}`
          })
        }

        // Validar que todos los valores numéricos sean válidos antes de insertar
        const numericValues = {
          days_worked,
          total_hours_worked,
          hourly_rate,
          total_earnings,
          IHSS,
          RAP,
          ISR,
          total
        }
        
        for (const [key, value] of Object.entries(numericValues)) {
          if (!isFinite(value) || isNaN(value)) {
            console.error(`❌ ERROR - Valor inválido ${key} para empleado ${emp.name}:`, value)
            return res.status(500).json({ 
              error: 'Error en cálculo de nómina',
              message: `Valor inválido ${key} para el empleado ${emp.name}: ${value}`
            })
          }
        }

        // Insertar línea en payroll_run_lines
        // Para hourly, guardamos horas en calc_hours. Metadata incluye septimo_dia si aplica.
        const lineMetadata: Record<string, unknown> = { tax_year: yearNum }
        lineMetadata.base_salary_used = base_salary
        lineMetadata.position_snapshot = String((emp as any).position || (emp as any).role || '')
        if (countryCode === 'HND' && taxConstants) {
          const empContr = calculateEmployerContributions({
            monthlySalary: base_salary,
            taxConstants,
            factor2Pagos: tipoParam === '2PAGOS' ? 0.5 : 1
          })
          lineMetadata.ihss_patronal = empContr.ihssPatronal
          lineMetadata.rap_patronal = empContr.rapPatronal
        }
        if (septimoDia > 0) lineMetadata.septimo_dia = septimoDia
        if (total_hours_worked > 0) lineMetadata.total_hours_worked = total_hours_worked
        lineMetadata.pay_type = effectivePayType === 'admin_floor' ? 'admin_floor' : 'hourly'
        lineMetadata.horas_extras = horasExtrasDisplay
        lineMetadata.days_worked = days_worked
        applyDeductionPlansToMetadata(lineMetadata, empPlansHourly)

        const { data: insertedLine, error: lineError } = await supabase
          .from('payroll_run_lines')
          .upsert({
            run_id: runId,
            company_id: companyId,
            employee_id: emp.id,
            calc_hours: total_hours_worked, // Horas trabajadas para hourly
            calc_bruto: total_earnings,
            calc_ihss: IHSS,
            calc_rap: RAP,
            calc_isr: ISR,
            calc_neto: total,
            eff_hours: total_hours_worked,
            eff_bruto: total_earnings,
            eff_ihss: IHSS,
            eff_rap: RAP,
            eff_isr: ISR,
            eff_neto: total,
            edited: false,
            tax_year: yearNum,
            seventh_day_pay: septimoDia,
            metadata: lineMetadata
          }, {
            onConflict: 'run_id,employee_id',
            ignoreDuplicates: false
          })
          .select('id')
          .maybeSingle()
          
        if (lineError) {
          console.error(`❌ ERROR insertando línea para empleado ${emp.name}:`, lineError)
          return res.status(500).json({ 
            error: 'Error insertando línea de nómina',
            message: `No se pudo insertar la línea para el empleado ${emp.name}: ${lineError.message}`,
            details: lineError,
            code: lineError.code
          })
        }
        
        if (!insertedLine) {
          console.error(`❌ ERROR - No se retornó línea insertada para empleado ${emp.name}`)
          return res.status(500).json({ 
            error: 'Error insertando línea de nómina',
            message: `No se pudo obtener el ID de la línea insertada para el empleado ${emp.name}`
          })
        }

        planilla_hourly.push({
          employee_id: emp.id,
          id: emp.employee_code || '',
          name: emp?.name || 'Sin nombre',
          bank: emp.bank_name || 'No especificado',
          bank_account: emp.bank_account || 'No especificado',
          department: departmentName,
          base_salary: base_salary,
          monthly_salary: base_salary,
          days_worked,
          days_absent,
          horas_extras: horasExtrasDisplay,
          total_hours_worked: Math.round(total_hours_worked * 100) / 100,
          hourly_rate: Math.round(hourly_rate * 100) / 100,
          total_earnings: Math.round(total_earnings * 100) / 100,
          IHSS: Math.round(IHSS * 100) / 100,
          RAP: Math.round(RAP * 100) / 100,
          ISR: Math.round(ISR * 100) / 100,
          total_deducciones: Math.round(total_deductions * 100) / 100,
          total: Math.round(total * 100) / 100,
          line_id: insertedLine.id,
          pay_type: effectivePayType === 'admin_floor' ? 'admin_floor' : 'hourly',
          metadata: lineMetadata
        })
      }
    }

    // Draft/edited only (authorized returns earlier): drop lines for employees no longer in calc
    // so PDF from this run matches the preview table (e.g. inactive H01878 orphans).
    const orphanLineIds = findOrphanPayrollLineIds(
      existingRunLinesForSkip || [],
      empleadosParaNomina.map((e: { id: string }) => e.id)
    )
    let orphanLinesRemoved = 0
    if (orphanLineIds.length > 0) {
      const { error: orphanDeleteError } = await supabase
        .from('payroll_run_lines')
        .delete()
        .in('id', orphanLineIds)
        .eq('run_id', runId)
        .eq('company_id', companyId)
      if (orphanDeleteError) {
        console.error('Error eliminando líneas huérfanas del preview:', orphanDeleteError)
      } else {
        orphanLinesRemoved = orphanLineIds.length
      }
    }

    const totalEmpleados = planilla_fixed.length + planilla_hourly.length

    // Obtener el estado actual de la corrida
    const { data: currentRun, error: statusError } = await supabase
      .from('payroll_runs')
      .select('status, authorized_by, authorized_at')
      .eq('id', runId)
      .maybeSingle()

    if (statusError) {
      console.error('Error obteniendo estado de corrida:', statusError)
    }

    const currentStatus = currentRun?.status || 'draft'

    // Determinar si es una regeneración
    const isRegeneration = existingRun && existingRun.status === 'authorized'
    
    // Calcular totales separados
    const totalBrutoFixed = planilla_fixed.reduce((sum: number, row: any) => sum + row.total_earnings, 0)
    const totalDeduccionesFixed = planilla_fixed.reduce((sum: number, row: any) => sum + row.total_deducciones, 0)
    const totalNetoFixed = planilla_fixed.reduce((sum: number, row: any) => sum + row.total, 0)
    
    const totalBrutoHourly = planilla_hourly.reduce((sum: number, row: any) => sum + row.total_earnings, 0)
    const totalDeduccionesHourly = planilla_hourly.reduce((sum: number, row: any) => sum + row.total_deducciones, 0)
    const totalNetoHourly = planilla_hourly.reduce((sum: number, row: any) => sum + row.total, 0)
    
    return res.status(200).json({
      message: isRegeneration 
        ? 'Preview regenerado - se actualizó el registro existente'
        : 'Preview de nómina generado exitosamente',
      run_id: runId,
      status: currentStatus,
      year: yearNum,
      month: monthNum,
      quincena: quincenaNum,
      tipo: tipoParam,
      empleados: totalEmpleados,
      empleados_fixed: planilla_fixed.length,
      empleados_hourly: planilla_hourly.length,
      // Totales generales (compatibilidad hacia atrás)
      totalBruto: totalBrutoFixed + totalBrutoHourly,
      totalDeducciones: totalDeduccionesFixed + totalDeduccionesHourly,
      totalNeto: totalNetoFixed + totalNetoHourly,
      // Totales separados por tipo
      totalBrutoFixed,
      totalDeduccionesFixed,
      totalNetoFixed,
      totalBrutoHourly,
      totalDeduccionesHourly,
      totalNetoHourly,
      // Planillas separadas
      planilla_fixed,
      planilla_hourly,
      // Compatibilidad hacia atrás: mantener planilla combinada
      planilla: [...planilla_fixed, ...planilla_hourly],
      warning: isRegeneration ? 'Ya existía un registro generado para el período seleccionado. Esta acción actualizó el registro.' : null,
      noAttendanceWarning,
      attendanceExemptSummary:
        attendanceExemptIncluded.length > 0
          ? {
              count: attendanceExemptIncluded.length,
              employees: attendanceExemptIncluded,
              message: `${attendanceExemptIncluded.length} empleado(s) administrativo(s) incluido(s) sin asistencia (exento de checada).`,
            }
          : undefined,
      incompleteRecordsAlert: incompleteRecordsAlert.length > 0 ? incompleteRecordsAlert : undefined,
      ahc_refresh: {
        complete: ahcRefresh.complete,
        missing: ahcRefresh.missing,
        stale: ahcRefresh.stale,
        refreshed: ahcRefresh.refreshed,
        error: ahcRefresh.error || null,
      },
      ahcRawClockFallbackWarning:
        rawClockFallbackEmployeeIds.length > 0
          ? {
              count: rawClockFallbackEmployeeIds.length,
              employee_ids: rawClockFallbackEmployeeIds,
              message:
                'Algunos empleados por hora usaron delta crudo check_in/out (sin AHC). Verifique asistencia o recalcule horas.',
            }
          : undefined,
      preserved_edited_lines: preservedEditedLines,
      orphan_lines_removed: orphanLinesRemoved,
      preservedEditedSummary:
        preservedEditedLines > 0
          ? {
              count: preservedEditedLines,
              message: `${preservedEditedLines} empleado(s) con edición manual conservaron sus montos. Use "Recalcular desde asistencia" en cada línea para actualizarlos.`,
            }
          : undefined,
    })

  } catch (error: any) {
    const stat = payrollStatutoryErrorResponse(error)
    if (stat) return res.status(stat.status).json(stat.body)
    console.error('Payroll Preview API error:', error)
    console.error('Error stack:', error.stack)
    console.error('Error details:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2))
    return res.status(error.message === 'UNAUTHORIZED' ? 401 : 500).json({
      error: error.message || 'Internal server error',
      details: error.stack || String(error),
      type: error.constructor?.name || typeof error
    })
  }
}

export default withPayrollRateLimit(['GET'])(handler)
