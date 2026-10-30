import type { SupabaseClient } from '@supabase/supabase-js'
import { enumerateCalendarDays } from './leave-attendance-summary'

export type ApprovedPaidLeaveRow = {
  employee_id: string
  start_date: string
  end_date: string
  status: string
  duration_type: 'hours' | 'days'
  is_half_day?: boolean | null
  days_requested?: number | null
  leave_type?: { is_paid?: boolean | null } | null
}

/** Días calendario de un permiso aprobado y pagado dentro de [from, to]. */
export function paidLeaveCalendarDaysInRange(
  row: ApprovedPaidLeaveRow,
  from: string,
  to: string
): string[] {
  if (row.status !== 'approved') return []
  if (row.leave_type?.is_paid === false) return []
  const start = row.start_date.slice(0, 10)
  const end = row.end_date.slice(0, 10)
  const rangeStart = from > start ? from : start
  const rangeEnd = to < end ? to : end
  if (rangeStart > rangeEnd) return []
  return enumerateCalendarDays(rangeStart, rangeEnd)
}

/** Crédito en días de nómina para un permiso en una fecha concreta. */
export function paidLeaveDayCredit(row: ApprovedPaidLeaveRow, date: string): number {
  const start = row.start_date.slice(0, 10)
  const end = row.end_date.slice(0, 10)
  if (date < start || date > end) return 0
  if (row.status !== 'approved' || row.leave_type?.is_paid === false) return 0

  const singleDay = start === end
  if (row.duration_type === 'hours') {
    if (singleDay && date === start) {
      if (row.is_half_day) return Math.min(1, Number(row.days_requested) || 0.5)
      return Math.min(1, Number(row.days_requested) || 1)
    }
    return 0
  }

  if (singleDay && date === start) {
    return Math.min(1, Number(row.days_requested) || 1)
  }
  return 1
}

/** Suma créditos de permisos pagados (solo días laborables, sin doble contar check-in). */
export function sumPaidLeaveCreditsForPayroll(input: {
  employeeId: string
  paidLeaves: ApprovedPaidLeaveRow[]
  periodFrom: string
  periodTo: string
  checkInDates: Set<string>
  isWorkDay: (date: string) => boolean
}): number {
  const byDate = new Map<string, number>()

  for (const leave of input.paidLeaves) {
    if (leave.employee_id !== input.employeeId) continue
    for (const day of paidLeaveCalendarDaysInRange(leave, input.periodFrom, input.periodTo)) {
      if (!input.isWorkDay(day)) continue
      if (input.checkInDates.has(day)) continue
      const credit = paidLeaveDayCredit(leave, day)
      if (credit <= 0) continue
      byDate.set(day, Math.min(1, (byDate.get(day) || 0) + credit))
    }
  }

  const total = [...byDate.values()].reduce((acc, n) => acc + n, 0)
  return Math.round(total * 100) / 100
}

const PAID_LEAVE_SELECT = `
  id,
  employee_id,
  start_date,
  end_date,
  status,
  duration_type,
  is_half_day,
  days_requested,
  leave_type:leave_types(is_paid)
`

export async function fetchApprovedPaidLeavesForEmployees(
  supabase: SupabaseClient,
  employeeIds: string[],
  periodFrom: string,
  periodTo: string
): Promise<ApprovedPaidLeaveRow[]> {
  if (employeeIds.length === 0) return []

  const { data, error } = await supabase
    .from('leave_requests')
    .select(PAID_LEAVE_SELECT)
    .in('employee_id', employeeIds)
    .eq('status', 'approved')
    .lte('start_date', periodTo)
    .gte('end_date', periodFrom)

  if (error) {
    throw new Error(error.message)
  }

  return ((data || []) as ApprovedPaidLeaveRow[]).filter(
    (row) => row.leave_type?.is_paid !== false
  )
}

/** Mapa employee_id → créditos de permiso pagado vía RPC (preferido en nómina). */
export async function fetchPaidLeaveCreditsByEmployee(
  supabase: SupabaseClient,
  companyId: string,
  periodFrom: string,
  periodTo: string,
  employeeIds: string[]
): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (employeeIds.length === 0) return map

  const { data, error } = await supabase.rpc('payroll_paid_leave_work_day_credits', {
    p_company_id: companyId,
    p_from: periodFrom,
    p_to: periodTo,
    p_employee_ids: employeeIds,
  })

  if (error) {
    throw new Error(error.message)
  }

  for (const row of data || []) {
    const id = row.employee_id as string
    const credits = Number(row.paid_leave_days) || 0
    if (credits > 0) map.set(id, credits)
  }
  return map
}

export type FixedCalendarDayDebits = { unpaidLeaveDays: number; unjustifiedAbsenceDays: number }

/** Mapa employee_id → días a descontar en modo calendario (fixed_days_mode = 'calendar'). */
export async function fetchFixedCalendarDayDebitsByEmployee(
  supabase: SupabaseClient,
  companyId: string,
  periodFrom: string,
  periodTo: string,
  employeeIds: string[]
): Promise<Map<string, FixedCalendarDayDebits>> {
  const map = new Map<string, FixedCalendarDayDebits>()
  if (employeeIds.length === 0) return map

  const { data, error } = await supabase.rpc('payroll_fixed_calendar_day_debits', {
    p_company_id: companyId,
    p_from: periodFrom,
    p_to: periodTo,
    p_employee_ids: employeeIds,
  })

  if (error) {
    throw new Error(error.message)
  }

  for (const row of data || []) {
    map.set(row.employee_id as string, {
      unpaidLeaveDays: Number(row.unpaid_leave_days) || 0,
      unjustifiedAbsenceDays: Number(row.unjustified_absence_days) || 0,
    })
  }
  return map
}
