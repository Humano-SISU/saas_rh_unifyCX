/**
 * Payroll preview inclusion rules for attendance_required (employees module).
 * Hourly / admin_floor: always included (0 hours when no marks). Fixed exempt: full period days.
 */

import {
  resolveEffectivePayType,
  type CompanyCalculationMode,
  type EffectivePayType,
  type EmployeePayType,
} from './resolve-effective-pay-type'

export function employeeRequiresAttendance(
  attendanceRequired: boolean | null | undefined
): boolean {
  return attendanceRequired !== false
}

export function isFixedAttendanceExempt(
  effectivePayType: EffectivePayType,
  attendanceRequired: boolean | null | undefined
): boolean {
  return effectivePayType === 'fixed' && attendanceRequired === false
}

export function hasValidPayrollAttendanceRecords(
  records: Array<{ check_in?: string | null; status?: string | null }>
): boolean {
  return records.some((r) => Boolean(r.check_in) && r.status !== 'absent')
}

export function shouldIncludeEmployeeInPayrollPreview(
  attendanceRequired: boolean | null | undefined,
  effectivePayType: EffectivePayType,
  hasValidRecords: boolean,
  periodHasAttendanceRecords: boolean
): boolean {
  if (!periodHasAttendanceRecords) return true
  // Hour-based (exact or admin floor): always include (0 hours if no marks)
  if (effectivePayType === 'hourly' || effectivePayType === 'admin_floor') return true
  if (isFixedAttendanceExempt(effectivePayType, attendanceRequired)) return true
  return hasValidRecords
}

export function resolveFixedDaysWorkedForPayroll(
  effectivePayType: EffectivePayType,
  attendanceRequired: boolean | null | undefined,
  registrosCount: number,
  diasPeriodo: number,
  paidLeaveCredits = 0
): {
  daysWorked: number
  includedWithoutAttendance: boolean
  paidLeaveDays: number
} {
  if (isFixedAttendanceExempt(effectivePayType, attendanceRequired)) {
    return { daysWorked: diasPeriodo, includedWithoutAttendance: true, paidLeaveDays: 0 }
  }

  const attendanceDays = registrosCount > 0 ? registrosCount : 0
  const paidLeaveDays = Math.max(0, Number(paidLeaveCredits) || 0)
  let daysWorked: number

  if (attendanceDays + paidLeaveDays > 0) {
    daysWorked = Math.min(diasPeriodo, attendanceDays + paidLeaveDays)
  } else {
    daysWorked = diasPeriodo
  }

  return { daysWorked, includedWithoutAttendance: false, paidLeaveDays }
}

/**
 * How fixed-salary days are counted (company_payroll_configs.metadata.fixed_days_mode):
 * - attendance_marks: days with check-in + paid leave credits (default, legacy).
 * - calendar: full period minus unjustified absences, unpaid leave and days outside the contract.
 */
export type FixedDaysMode = 'attendance_marks' | 'calendar'

export function parseFixedDaysMode(value: unknown): FixedDaysMode {
  return value === 'calendar' ? 'calendar' : 'attendance_marks'
}

/** Calendar days of [periodFrom, periodTo] inside [hireDate, terminationDate]; dates are YYYY-MM-DD. */
export function countContractCalendarDaysInPeriod(
  periodFrom: string,
  periodTo: string,
  hireDate: string | null | undefined,
  terminationDate: string | null | undefined
): number {
  const hire = hireDate ? hireDate.slice(0, 10) : null
  const term = terminationDate ? terminationDate.slice(0, 10) : null
  const from = hire && hire > periodFrom ? hire : periodFrom
  const to = term && term < periodTo ? term : periodTo
  if (from > to) return 0
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
  return Math.round(ms / 86_400_000) + 1
}

export function resolveFixedDaysWorkedCalendar(params: {
  effectivePayType: EffectivePayType
  attendanceRequired: boolean | null | undefined
  diasPeriodo: number
  periodFrom: string
  periodTo: string
  hireDate?: string | null
  terminationDate?: string | null
  unjustifiedAbsenceDays: number
  unpaidLeaveDays: number
}): {
  daysWorked: number
  daysOutsideContract: number
  unjustifiedAbsenceDays: number
  unpaidLeaveDays: number
} {
  const { diasPeriodo, periodFrom, periodTo } = params
  const periodCalendarDays = countContractCalendarDaysInPeriod(periodFrom, periodTo, null, null)
  const contractCalendarDays = countContractCalendarDaysInPeriod(
    periodFrom,
    periodTo,
    params.hireDate,
    params.terminationDate
  )
  // Full coverage pays the conventional period (e.g. 15 days even on 16–31 or 16–28);
  // partial coverage pays the calendar days actually under contract.
  const daysInContract =
    contractCalendarDays >= periodCalendarDays ? diasPeriodo : Math.min(diasPeriodo, contractCalendarDays)
  const daysOutsideContract = diasPeriodo - daysInContract

  if (isFixedAttendanceExempt(params.effectivePayType, params.attendanceRequired)) {
    return { daysWorked: daysInContract, daysOutsideContract, unjustifiedAbsenceDays: 0, unpaidLeaveDays: 0 }
  }

  const unjustifiedAbsenceDays = Math.max(0, Number(params.unjustifiedAbsenceDays) || 0)
  const unpaidLeaveDays = Math.max(0, Number(params.unpaidLeaveDays) || 0)
  const daysWorked = Math.max(0, daysInContract - unjustifiedAbsenceDays - unpaidLeaveDays)
  return { daysWorked, daysOutsideContract, unjustifiedAbsenceDays, unpaidLeaveDays }
}

export function parseAttendanceRequiredInput(value: unknown): boolean {
  if (value === false || value === 'false' || value === 0 || value === '0') return false
  return true
}

/** Hour-based employees always require attendance tracking; coerce on write. */
export function coerceAttendanceRequiredForPayType(
  payType: EmployeePayType,
  companyCalculationMode: CompanyCalculationMode,
  attendanceRequired: unknown
): boolean {
  const effective = resolveEffectivePayType(payType, companyCalculationMode)
  if (effective === 'hourly' || effective === 'admin_floor') return true
  return parseAttendanceRequiredInput(attendanceRequired)
}
