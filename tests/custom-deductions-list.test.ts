import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { buildCustomDeductionsList } from '../lib/payroll/custom-deductions-list'

function mockSupabase(customFields: Record<string, unknown> | null) {
  return {
    from(table: string) {
      if (table === 'company_payroll_configs') {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: async () => ({
                  data: customFields
                    ? {
                        calculation_type: 'standard',
                        custom_fields: customFields,
                        calculation_config: {},
                      }
                    : null,
                  error: customFields ? null : { message: 'missing' },
                }),
              }),
            }),
          }),
        }
      }
      if (table === 'employee_deduction_plans') {
        return {
          select: () => ({
            in: () => ({
              eq: async () => ({ data: [], error: null }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              single: async () => ({ data: null, error: null }),
            }),
          }),
        }),
      }
    },
  }
}

describe('buildCustomDeductionsList', () => {
  it('ignores earnings and system keys from legacy metadata', async () => {
    const supabase = mockSupabase(null)
    const list = await buildCustomDeductionsList(
      'company-test',
      {
        edited: true,
        horas_extras: 450,
        feriado_trabajado: 200,
        comedor: 75,
        deduccion_especial: 105,
        tax_year: 2026,
      },
      7500,
      supabase
    )

    const names = list.map((item) => item.name.toLowerCase())
    assert.ok(names.includes('comedor'))
    assert.ok(names.some((n) => n.includes('deduccion especial')))
    assert.equal(names.some((n) => n.includes('horas')), false)
    assert.equal(names.some((n) => n.includes('edited')), false)
  })

  it('ignores calendar-mode day counts stored on the line', async () => {
    const list = await buildCustomDeductionsList(
      'company-test',
      {
        fixed_days_mode: 'calendar',
        unjustified_absence_days: 1,
        unpaid_leave_days: 2,
        days_outside_contract: 5,
        comedor: 75,
      },
      7500,
      mockSupabase(null)
    )

    assert.deepEqual(list.map((item) => item.name), ['Comedor'])
  })

  it('reads deduction amount from metadata when formula calc is zero', async () => {
    const supabase = mockSupabase({
      deduccion_especial: {
        label: 'Deducción especial',
        type: 'number',
        category: 'deductions',
        required: false,
        default: 0,
        formula: '0',
      },
    })

    const list = await buildCustomDeductionsList(
      'company-test',
      { deduccion_especial: 105 },
      7500,
      supabase
    )

    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'Deducción especial')
    assert.equal(list[0].amount, 105)
  })

  it('lists each same-field_key plan from _deduction_plan_breakdown', async () => {
    const supabase = mockSupabase({
      cxc_optica: {
        label: 'CXC Óptica',
        type: 'number',
        category: 'deductions',
        required: false,
        default: 0,
      },
    })

    const list = await buildCustomDeductionsList(
      'company-test',
      {
        cxc_optica: 150,
        _deduction_plan_ids: ['p1', 'p2'],
        _deduction_plan_breakdown: [
          { plan_id: 'p1', field_key: 'cxc_optica', monto: 100 },
          { plan_id: 'p2', field_key: 'cxc_optica', monto: 50 },
        ],
      },
      7500,
      supabase
    )

    assert.equal(list.length, 2)
    assert.deepEqual(
      list.map((x) => x.amount).sort((a, b) => b - a),
      [100, 50]
    )
    assert.ok(list.every((x) => x.name === 'CXC Óptica'))
  })

  it('skips statutory-reserved key isr even when labeled Impuestos', async () => {
    const supabase = mockSupabase({
      isr: {
        label: 'Impuestos',
        type: 'number',
        category: 'deductions',
        required: false,
        default: 0,
      },
      cooperativa: {
        label: 'Cooperativa Elga',
        type: 'number',
        category: 'deductions',
        required: false,
        default: 0,
      },
    })

    const list = await buildCustomDeductionsList(
      'company-test',
      { isr: 507.97, cooperativa: 400 },
      6750,
      supabase
    )

    assert.equal(list.length, 1)
    assert.equal(list[0].name, 'Cooperativa Elga')
    assert.equal(list[0].amount, 400)
  })
})
