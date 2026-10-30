import { calculatePayroll } from '../payroll-client-specific'
import { getCustomFieldsFromDB } from '../payroll-calculation-engine'
import { isStatutoryReservedCustomKey } from './statutory-reserved-custom-keys'

/** Campos legacy hardcodeados (clientes antiguos sin custom_fields en BD). */
const LEGACY_DEDUCTION_FIELDS = [
  { key: 'comedor', label: 'Comedor' },
  { key: 'cooperativa_aportaciones', label: 'Coop. Aportaciones' },
  { key: 'cooperativa_retirable', label: 'Coop. Retirable' },
  { key: 'cooperativa_prestamo', label: 'Coop. Préstamo' },
  { key: 'embargo_alimentos', label: 'Embargo de Alimentos' },
  { key: 'otras_deducciones_materiales', label: 'Materiales' },
  { key: 'otras_deducciones_medicamentos', label: 'Medicamentos' },
  { key: 'otras_deducciones_efectivo', label: 'Efectivo' },
  { key: 'prestamo_banrural', label: 'Préstamo BANRURAL' },
  { key: 'prestamo_celular', label: 'Préstamo Celular' },
  { key: 'anticipo_prestamo', label: 'Anticipo/Préstamo' },
  { key: 'impuesto_vecinal', label: 'Impuesto Vecinal' },
] as const

const METADATA_SKIP_KEYS = new Set([
  'tax_year',
  'base_salary_used',
  'position_snapshot',
  'ihss_patronal',
  'rap_patronal',
  'days_extra',
  'notes_extra',
  'paid_leave_days',
  'notes_paid_leave',
  'included_without_attendance',
  'fixed_days_mode',
  'unjustified_absence_days',
  'unpaid_leave_days',
  'days_outside_contract',
  'days_adjusted_at',
  'days_adjusted_by',
  'days_adjusted_reason',
  'days_adjust_reason',
  'ot_adjusted_at',
  'ot_adjusted_by',
  'ot_adjusted_reason',
  'ot_adjust_reason',
  'ot_evening_25',
  'ot_night_50',
  'ot_late_75',
  'ot_morning_25',
  'ot_holiday_100',
  'ot_diurno',
  'ot_nocturno',
  'ot_feriado',
  'overtime_pay',
  'statutory_zeroed_at',
  'statutory_zeroed_by',
  'statutory_zeroed_reason',
  'statutory_zero_ihss',
  'statutory_zero_rap',
  'statutory_zero_isr',
  'statutory_override_ihss',
  'statutory_override_rap',
  'statutory_override_isr',
  'septimo_dia',
  '_deduction_plan_ids',
  '_deduction_plan_breakdown',
])

const LEGACY_DEDUCTION_KEYS = new Set<string>(
  LEGACY_DEDUCTION_FIELDS.map((field) => field.key)
)

/** Claves de ingresos / sistema en metadata que no deben listarse como deducción en el PDF. */
const NON_DEDUCTION_METADATA_KEYS = new Set([
  ...METADATA_SKIP_KEYS,
  'edited',
  'pay_overtime',
  'hours_worked',
  'total_hours_worked',
  'horas_extras',
  'feriado_trabajado',
  'estipendio_transporte',
  'valor_hora_extra',
  'descanso_por_turno_noche',
  'doble_turno',
  'pausa_almuerzo',
  'incapacidad',
  'dias_faltados',
])

function isDeductionMetadataKey(key: string): boolean {
  if (NON_DEDUCTION_METADATA_KEYS.has(key) || key.startsWith('_')) return false
  if (LEGACY_DEDUCTION_KEYS.has(key)) return true
  return /^[a-z][a-z0-9_]{0,63}$/.test(key)
}

function resolveDeductionAmount(calculated: number, fromMeta: number): number {
  return Math.max(calculated, fromMeta)
}

function parseAmount(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0
  if (typeof value === 'boolean') return value ? 1 : 0
  const n = parseFloat(String(value))
  return Number.isFinite(n) ? n : 0
}

function formatFieldLabel(fieldName: string, label?: string): string {
  if (label && label.trim()) return label.trim()
  return fieldName.replace(/_/g, ' ')
}

/**
 * Lista deducciones adicionales para PDF/comprobante, alineada a company_payroll_configs.custom_fields
 * y a los valores persistidos en payroll_run_lines.metadata (incl. planes por plazos).
 */
export async function buildCustomDeductionsList(
  companyId: string,
  metadata: Record<string, unknown> | null | undefined,
  baseSalary: number,
  supabase: any
): Promise<Array<{ name: string; amount: number }>> {
  const meta = metadata || {}
  const calc = await calculatePayroll(companyId, baseSalary, meta, supabase)
  const customFields = await getCustomFieldsFromDB(companyId, supabase)
  const list: Array<{ name: string; amount: number }> = []
  const seen = new Set<string>()
  const breakdown = Array.isArray(meta._deduction_plan_breakdown)
    ? (meta._deduction_plan_breakdown as Array<{ plan_id?: string; field_key?: string; monto?: unknown }>)
    : []
  const breakdownFieldKeys = new Set(
    breakdown.map((b) => b.field_key).filter((k): k is string => typeof k === 'string' && k.length > 0)
  )

  const pushDeduction = (name: string, amount: number, dedupeId?: string) => {
    const rounded = Math.round(amount * 100) / 100
    if (rounded <= 0) return
    const dedupeKey = dedupeId ? `id:${dedupeId}` : `${name}:${rounded}`
    if (seen.has(dedupeKey)) return
    seen.add(dedupeKey)
    list.push({ name, amount: rounded })
  }

  if (customFields && Object.keys(customFields).length > 0) {
    for (const [fieldName, fieldDef] of Object.entries(customFields)) {
      if (fieldDef.category !== 'deductions') continue
      if (isStatutoryReservedCustomKey(fieldName)) continue
      if (breakdownFieldKeys.has(fieldName)) {
        for (const item of breakdown) {
          if (item.field_key !== fieldName) continue
          pushDeduction(
            formatFieldLabel(fieldName, fieldDef.label),
            parseAmount(item.monto),
            item.plan_id
          )
        }
        continue
      }
      const calculated = parseAmount(calc.calculatedFields?.[fieldName])
      const fromMeta = parseAmount(meta[fieldName])
      const amount = resolveDeductionAmount(calculated, fromMeta)
      pushDeduction(formatFieldLabel(fieldName, fieldDef.label), amount)
    }

    // Borradores editados pueden tener claves con monto que ya no están en custom_fields actuales
    for (const [key, value] of Object.entries(meta)) {
      if (!isDeductionMetadataKey(key) || customFields[key]) continue
      if (isStatutoryReservedCustomKey(key)) continue
      if (breakdownFieldKeys.has(key)) continue
      pushDeduction(formatFieldLabel(key), parseAmount(value))
    }
  } else {
    for (const field of LEGACY_DEDUCTION_FIELDS) {
      if (breakdownFieldKeys.has(field.key)) {
        for (const item of breakdown) {
          if (item.field_key !== field.key) continue
          pushDeduction(field.label, parseAmount(item.monto), item.plan_id)
        }
        continue
      }
      pushDeduction(field.label, parseAmount(meta[field.key]))
    }

    for (const [key, value] of Object.entries(meta)) {
      if (!isDeductionMetadataKey(key) || LEGACY_DEDUCTION_KEYS.has(key)) continue
      if (isStatutoryReservedCustomKey(key)) continue
      if (breakdownFieldKeys.has(key)) continue
      pushDeduction(formatFieldLabel(key), parseAmount(value))
    }
  }

  // Legacy lines without breakdown: enrich from plan ids (scalar meta may already cover amount).
  if (!breakdown.length) {
    const planIds = meta._deduction_plan_ids as string[] | undefined
    if (planIds?.length && supabase) {
      const { data: plans } = await supabase
        .from('employee_deduction_plans')
        .select('id, field_key, monto_por_plazo')
        .in('id', planIds)
        .eq('company_id', companyId)

      for (const plan of plans || []) {
        const fieldKey = plan.field_key as string
        if (isStatutoryReservedCustomKey(fieldKey)) continue
        const fieldDef = customFields?.[fieldKey]
        const amount =
          parseAmount(meta[fieldKey]) > 0
            ? parseAmount(meta[fieldKey])
            : parseAmount(plan.monto_por_plazo)
        // Dedupe by name:amount (legacy scalar); new lines use _deduction_plan_breakdown above.
        pushDeduction(formatFieldLabel(fieldKey, fieldDef?.label), amount)
      }
    }
  }

  return list
}

export function formatCustomDeductionsNotes(
  list: Array<{ name: string; amount: number }>
): string {
  return list.map((d) => `${d.name}: L. ${d.amount.toFixed(2)}`).join('; ')
}
