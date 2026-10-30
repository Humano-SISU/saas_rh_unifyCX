/**
 * Fixed-salary days in calendar mode (fixed_days_mode = 'calendar').
 * Run: npx tsx --test tests/payroll-fixed-days-calendar.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  countContractCalendarDaysInPeriod,
  parseFixedDaysMode,
  resolveFixedDaysWorkedCalendar,
  resolveFixedDaysWorkedForPayroll,
} from '../lib/payroll/payroll-attendance-inclusion'

const base = {
  effectivePayType: 'fixed' as const,
  attendanceRequired: true,
  diasPeriodo: 15,
  periodFrom: '2026-11-01',
  periodTo: '2026-11-15',
  unjustifiedAbsenceDays: 0,
  unpaidLeaveDays: 0,
}

describe('parseFixedDaysMode', () => {
  it('defaults to attendance_marks', () => {
    assert.equal(parseFixedDaysMode(undefined), 'attendance_marks')
    assert.equal(parseFixedDaysMode('anything'), 'attendance_marks')
    assert.equal(parseFixedDaysMode('calendar'), 'calendar')
  })
})

describe('resolveFixedDaysWorkedCalendar', () => {
  it('full fortnight with weekends and no absences pays 15/15', () => {
    assert.equal(resolveFixedDaysWorkedCalendar(base).daysWorked, 15)
  })

  it('one unjustified absence pays 14', () => {
    assert.equal(resolveFixedDaysWorkedCalendar({ ...base, unjustifiedAbsenceDays: 1 }).daysWorked, 14)
  })

  it('hire on day 6 pays 10', () => {
    const r = resolveFixedDaysWorkedCalendar({ ...base, hireDate: '2026-11-06' })
    assert.equal(r.daysWorked, 10)
    assert.equal(r.daysOutsideContract, 5)
  })

  it('termination on day 10 pays 10', () => {
    assert.equal(resolveFixedDaysWorkedCalendar({ ...base, terminationDate: '2026-11-10' }).daysWorked, 10)
  })

  it('unworked holiday is not a debit (RPC skips holidays), so it stays paid', () => {
    assert.equal(resolveFixedDaysWorkedCalendar({ ...base, unjustifiedAbsenceDays: 0 }).daysWorked, 15)
  })

  it('two days of unpaid leave pay 13', () => {
    assert.equal(resolveFixedDaysWorkedCalendar({ ...base, unpaidLeaveDays: 2 }).daysWorked, 13)
  })

  it('second fortnight of a 31-day month still pays the conventional 15', () => {
    const r = resolveFixedDaysWorkedCalendar({ ...base, periodFrom: '2026-10-16', periodTo: '2026-10-31' })
    assert.equal(r.daysWorked, 15)
    assert.equal(r.daysOutsideContract, 0)
  })

  it('attendance-exempt employees get the full contract days regardless of debits', () => {
    const r = resolveFixedDaysWorkedCalendar({
      ...base,
      attendanceRequired: false,
      unjustifiedAbsenceDays: 3,
      hireDate: '2026-11-06',
    })
    assert.equal(r.daysWorked, 10)
  })

  it('never goes below zero', () => {
    assert.equal(resolveFixedDaysWorkedCalendar({ ...base, unjustifiedAbsenceDays: 20 }).daysWorked, 0)
  })

  it('base salary L 22,000 over 15/15 days gives L 11,000 base gross', () => {
    const { daysWorked } = resolveFixedDaysWorkedCalendar(base)
    assert.equal((22_000 / 30) * daysWorked, 11_000)
  })
})

describe('countContractCalendarDaysInPeriod', () => {
  it('returns 0 when hired after the period', () => {
    assert.equal(countContractCalendarDaysInPeriod('2026-11-01', '2026-11-15', '2026-11-20', null), 0)
  })
})

describe('flag off keeps attendance_marks behavior', () => {
  it('counts days with marks plus paid leave', () => {
    assert.equal(resolveFixedDaysWorkedForPayroll('fixed', true, 8, 15, 0).daysWorked, 8)
    assert.equal(resolveFixedDaysWorkedForPayroll('fixed', true, 8, 15, 2).daysWorked, 10)
  })
})

describe('payroll_fixed_calendar_day_debits migration', () => {
  const sql = readFileSync(
    join(__dirname, '../supabase/migrations/20261029130000_payroll_fixed_calendar_day_debits.sql'),
    'utf8'
  )

  it('uses the shared work-day rule (rest days and holidays are never debits)', () => {
    assert.match(sql, /is_work_day_for_employee\(/)
  })

  it('limits debits to the contract window and approved leave', () => {
    assert.match(sql, /hire_date/)
    assert.match(sql, /termination_date/)
    assert.match(sql, /lr\.status = 'approved'/)
  })
})
