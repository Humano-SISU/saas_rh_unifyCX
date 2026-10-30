/**
 * Column catalog for consolidated payroll PDF tables.
 * Fixed order: identification → income → deductions → net.
 * Labels come from report config (columnLabels) with fallbacks.
 */

import { statutoryDeductionLabels } from '../country/payroll-labels'
import { normalizeCountryCode, type CountryCode } from '../country/supported'
import { resolveReservedCustomColumnAmount } from './statutory-reserved-custom-keys'
import { resolveStatutoryDeductionColumns } from './statutory-deduction-columns'

export interface PayrollPdfCustomFieldDef {
  label: string
  type: 'number' | 'string' | 'boolean'
  category: 'earnings' | 'deductions' | 'calculation_helper'
  required: boolean
  default: any
}

export type PayrollPdfCustomFieldsConfig = Record<string, PayrollPdfCustomFieldDef | string>

export interface BuildPayrollPdfColumnsInput {
  isHourly: boolean
  hasSeptimoDia: boolean
  hasOvertimePay: boolean
  /** Holiday / rest-day worked pay (metadata.days_extra_pay) present in any row */
  hasDaysExtraPay?: boolean
  visibleColumnIds?: Set<string> | null
  columnLabels?: Record<string, string>
  /** Orders custom_* within earnings / deductions blocks only. */
  columnOrder?: Record<string, number> | null
  includeCustomPayrollFields?: boolean
  customFieldsConfig?: PayrollPdfCustomFieldsConfig
  legalDeductions?: { ihss?: boolean; rap?: boolean; isr?: boolean }
  countryCode?: CountryCode | string | null
  /**
   * Custom earnings field names with at least one non-zero value in the table.
   * When a Set (including empty), earnings not in the set are omitted.
   * When null/undefined, all custom earnings print (legacy), except OT aliases.
   */
  customEarningsWithValues?: Set<string> | null
  /**
   * Custom deduction field names with at least one non-zero value in the table.
   * When a Set, deductions not in the set are omitted for this run/quincena.
   * When null/undefined, all custom deductions print (legacy).
   */
  customDeductionsWithValues?: Set<string> | null
  /**
   * When set, statutory columns with `false` are omitted even if legal_deductions
   * would include them. Used to hide IHSS/RAP/ISR when the whole table is 0.
   * When null/undefined, statutory visibility follows legal_deductions only.
   */
  statutoryWithValues?: { ihss?: boolean; rap?: boolean; isr?: boolean } | null
}

export interface PayrollPdfColumnMeta {
  id: string
  header: string
}

/** Base quincenal de reporte = mensual ÷ 2 (sin HE ni otros ingresos). */
export function reportBiweeklyBaseFromMonthly(monthly: number): number {
  return (Number(monthly) || 0) / 2
}

function colVisible(visible: Set<string> | null | undefined, id: string): boolean {
  return visible == null || visible.has(id)
}

function colLabel(labels: Record<string, string> | undefined, id: string, fallback: string): string {
  return labels?.[id]?.trim() || fallback
}

function sortCustomFieldEntries<T>(
  entries: [string, T][],
  columnOrder: Record<string, number> | null | undefined
): [string, T][] {
  if (!columnOrder) return entries
  return [...entries].sort((a, b) => {
    const ao = columnOrder[`custom_${a[0]}`]
    const bo = columnOrder[`custom_${b[0]}`]
    const aRank = ao == null ? 10_000 : ao
    const bRank = bo == null ? 10_000 : bo
    if (aRank !== bRank) return aRank - bRank
    return a[0].localeCompare(b[0])
  })
}

function normalizeCustomField(
  fieldName: string,
  fieldDef: PayrollPdfCustomFieldDef | string,
  forcedCategory: 'earnings' | 'deductions'
): PayrollPdfCustomFieldDef {
  if (typeof fieldDef === 'string') {
    return {
      label: fieldDef,
      category: forcedCategory,
      type: 'number',
      required: false,
      default: 0,
    }
  }
  return fieldDef
}

export function pdfAmountHasValue(n: unknown): boolean {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) && v !== 0
}

export type PlanillaPdfValueRow = {
  metadata?: Record<string, unknown> | null
  IHSS?: number
  RAP?: number
  ISR?: number
}

/** Same amount the PDF cell uses (reserved statutory keys → row.IHSS/RAP/ISR). */
export function customFieldHasPdfValue(fieldName: string, row: PlanillaPdfValueRow): boolean {
  const reserved = resolveReservedCustomColumnAmount(fieldName, row)
  if (reserved != null) return pdfAmountHasValue(reserved)
  return pdfAmountHasValue(row.metadata?.[fieldName])
}

export function collectCustomFieldsWithPdfValues(
  customFieldsConfig: PayrollPdfCustomFieldsConfig | undefined,
  rows: PlanillaPdfValueRow[]
): { earnings: Set<string>; deductions: Set<string> } {
  const earnings = new Set<string>()
  const deductions = new Set<string>()
  if (!customFieldsConfig) return { earnings, deductions }

  for (const [fieldName, fieldDef] of Object.entries(customFieldsConfig)) {
    const cat =
      typeof fieldDef === 'string' ? 'earnings' : fieldDef?.category || 'deductions'
    if (cat === 'calculation_helper') continue
    const hasVal = rows.some((r) => customFieldHasPdfValue(fieldName, r))
    if (!hasVal) continue
    if (cat === 'earnings') earnings.add(fieldName)
    else deductions.add(fieldName)
  }
  return { earnings, deductions }
}

export function statutoryColumnsWithPdfValues(rows: PlanillaPdfValueRow[]): {
  ihss: boolean
  rap: boolean
  isr: boolean
} {
  return {
    ihss: rows.some((r) => pdfAmountHasValue(r.IHSS)),
    rap: rows.some((r) => pdfAmountHasValue(r.RAP)),
    isr: rows.some((r) => pdfAmountHasValue(r.ISR)),
  }
}

/** Manual/legacy HE earnings that collide with standard `overtime_pay` ("Pago HE"). */
export function isOvertimeEarningsAlias(fieldName: string): boolean {
  const n = fieldName.trim().toLowerCase()
  if (!n) return false
  if (n === 'horas_extra_manual' || n === 'horas_extras' || n === 'ingreso_he_manual') return true
  return /hora.*extra|extra.*hora|overtime/.test(n)
}

/**
 * Builds ordered column metadata for the planilla PDF table.
 * Does not include the hours-quantity column (`horas_extras`).
 */
export function buildPayrollPdfColumnMeta(input: BuildPayrollPdfColumnsInput): PayrollPdfColumnMeta[] {
  const {
    isHourly,
    hasSeptimoDia,
    hasOvertimePay,
    hasDaysExtraPay = false,
    visibleColumnIds = null,
    columnLabels = {},
    columnOrder = null,
    customFieldsConfig,
    legalDeductions,
    countryCode,
    customEarningsWithValues = null,
    customDeductionsWithValues = null,
    statutoryWithValues = null,
  } = input
  const filterCustomFields = Boolean(input.includeCustomPayrollFields && visibleColumnIds)
  const country = normalizeCountryCode(countryCode)
  const dedLabels = statutoryDeductionLabels(country)
  const statutoryCols = resolveStatutoryDeductionColumns(
    legalDeductions,
    customFieldsConfig,
    country
  )
  const statutoryUsed = (id: 'ihss' | 'rap' | 'isr') =>
    statutoryWithValues == null || statutoryWithValues[id] !== false

  const cols: PayrollPdfColumnMeta[] = []
  const push = (id: string, fallback: string) => {
    if (!colVisible(visibleColumnIds, id)) return
    cols.push({ id, header: colLabel(columnLabels, id, fallback) })
  }

  // —— Identificación ——
  push('emp_code', 'Código')
  push('emp_name', 'Nombre')
  push('department', 'Departamento')
  push('position', 'Puesto')
  push('days_worked', isHourly ? 'Días' : 'Días Trab.')
  if (isHourly) {
    push('hours', 'Horas')
    push('hourly_rate', 'Tarifa/Hora')
  }

  // —— Ingresos: mensual → quincenal → HE monto → custom earnings → total ——
  push('base_salary', 'Sueldo Mensual')
  push('biweekly_salary', 'Sueldo Quincenal')
  if (isHourly && hasSeptimoDia) {
    push('septimo_dia', 'Séptimo Día')
  }
  if (hasOvertimePay) {
    push('overtime_pay', 'Pago HE')
  }
  if (hasDaysExtraPay) {
    push('days_extra_pay', 'Feriado/descanso trab.')
  }

  if (customFieldsConfig) {
    const earningEntries = sortCustomFieldEntries(
      Object.entries(customFieldsConfig).filter(([, fieldDef]) => {
        const def = normalizeCustomField('', fieldDef, 'earnings')
        return def.category === 'earnings'
      }),
      columnOrder
    )
    for (const [fieldName, fieldDef] of earningEntries) {
      const def = normalizeCustomField(fieldName, fieldDef, 'earnings')
      const customId = `custom_${fieldName}`
      if (filterCustomFields && !visibleColumnIds!.has(customId)) continue
      // Never print OT-alias custom earnings (e.g. horas_extra_manual "Horas Extra"):
      // official money column is overtime_pay ("Pago HE").
      if (isOvertimeEarningsAlias(fieldName)) continue
      if (customEarningsWithValues != null && !customEarningsWithValues.has(fieldName)) continue
      cols.push({ id: customId, header: colLabel(columnLabels, customId, def.label || fieldName) })
    }
  }

  push('gross_salary', 'Total ingresos')

  // —— Deducciones → suma → neto ——
  if (statutoryCols.ihss && statutoryUsed('ihss')) {
    push('ihss', dedLabels.primarySocial)
  }
  if (statutoryCols.rap && dedLabels.secondarySocial !== '—' && statutoryUsed('rap')) {
    push('rap', dedLabels.secondarySocial)
  }
  if (statutoryCols.isr && statutoryUsed('isr')) {
    push('isr', dedLabels.incomeTax)
  }

  if (customFieldsConfig) {
    const deductionEntries = sortCustomFieldEntries(
      Object.entries(customFieldsConfig).filter(([, fieldDef]) => {
        const def = normalizeCustomField('', fieldDef, 'deductions')
        return def.category === 'deductions'
      }),
      columnOrder
    )
    for (const [fieldName, fieldDef] of deductionEntries) {
      const def = normalizeCustomField(fieldName, fieldDef, 'deductions')
      const customId = `custom_${fieldName}`
      if (filterCustomFields && !visibleColumnIds!.has(customId)) continue
      if (customDeductionsWithValues != null && !customDeductionsWithValues.has(fieldName)) continue
      cols.push({ id: customId, header: colLabel(columnLabels, customId, def.label || fieldName) })
    }
  }

  push('total_deductions', 'Total Deducciones')
  push('net_salary', 'Neto a Pagar')

  return cols
}
