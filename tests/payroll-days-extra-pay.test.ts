/**
 * Holiday / rest day worked pay for fixed-salary lines (pay_days_extra flag).
 * Run: npx tsx --test tests/payroll-days-extra-pay.test.ts
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeDaysExtraPay,
  readDaysExtraPay,
  resolvePayDaysExtra,
} from '../lib/payroll/days-extra-pay'
import { buildPayrollPdfColumnMeta } from '../lib/payroll/payroll-pdf-columns'
import { buildVoucherPreviewPayload } from '../lib/payroll/voucher-preview'
import { buildCustomDeductionsList } from '../lib/payroll/custom-deductions-list'
import type { VoucherFromRunLineResult } from '../lib/payroll/voucher-from-run-line'

describe('resolvePayDaysExtra', () => {
  it('is off unless the company opts in', () => {
    assert.equal(resolvePayDaysExtra(undefined), false)
    assert.equal(resolvePayDaysExtra({}), false)
    assert.equal(resolvePayDaysExtra({ pay_days_extra: 'true' }), false)
    assert.equal(resolvePayDaysExtra({ pay_days_extra: true }), true)
  })
})

describe('computeDaysExtraPay', () => {
  it('pays one extra daily wage per holiday or rest day worked', () => {
    // Two worked days (e.g. Oct 7 and 8) at L 22,000/month
    assert.equal(computeDaysExtraPay(2, 22_000), 1466.67)
  })

  it('is zero without extra days or salary', () => {
    assert.equal(computeDaysExtraPay(0, 22_000), 0)
    assert.equal(computeDaysExtraPay(2, 0), 0)
    assert.equal(computeDaysExtraPay(-1, 22_000), 0)
  })
})

describe('readDaysExtraPay', () => {
  it('reads the stored amount and ignores invalid values', () => {
    assert.equal(readDaysExtraPay({ days_extra_pay: 733.333 }), 733.33)
    assert.equal(readDaysExtraPay({ days_extra_pay: 'x' }), 0)
    assert.equal(readDaysExtraPay(null), 0)
  })
})

describe('days_extra_pay on the receipt and planilla', () => {
  const voucher: VoucherFromRunLineResult = {
    record: {
      employee_code: 'D-06',
      employee_name: 'Test',
      department: 'Ops',
      position: 'Agente',
      period_start: '2026-10-01',
      period_end: '2026-10-15',
      days_worked: 15,
      base_salary: 11_000,
      days_extra_pay: 1466.67,
      income_tax: 0,
      professional_tax: 0,
      social_security: 0,
      total_deductions: 0,
      net_salary: 12_466.67,
    },
    periodo: '2026-10',
    quincena: 1,
    companyName: 'Test',
    periodLabel: 'Quincena 1',
    employeeCode: 'D-06',
    filename: 'recibo.pdf',
  }

  it('shows a "Feriado/descanso trabajado" earnings line', () => {
    const preview = buildVoucherPreviewPayload('line-1', voucher)
    const line = preview.earnings.find((e) => e.label === 'Feriado/descanso trabajado')
    assert.equal(line?.amount, 1466.67)
  })

  it('adds a planilla column only when some row has it', () => {
    const base = { isHourly: false, hasSeptimoDia: false, hasOvertimePay: false }
    const withPay = buildPayrollPdfColumnMeta({ ...base, hasDaysExtraPay: true }).map((c) => c.id)
    const without = buildPayrollPdfColumnMeta(base).map((c) => c.id)
    assert.ok(withPay.includes('days_extra_pay'))
    assert.equal(without.includes('days_extra_pay'), false)
    assert.ok(withPay.indexOf('days_extra_pay') < withPay.indexOf('gross_salary'))
  })

  it('is never listed as a deduction', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({ eq: () => ({ single: async () => ({ data: null, error: { message: 'none' } }) }) }),
          in: () => ({ eq: async () => ({ data: [], error: null }) }),
        }),
      }),
    }
    const list = await buildCustomDeductionsList('c', { days_extra: 2, days_extra_pay: 1466.67 }, 22_000, supabase)
    assert.deepEqual(list, [])
  })
})
