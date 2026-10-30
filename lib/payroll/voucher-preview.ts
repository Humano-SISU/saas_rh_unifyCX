import { statutoryUiLabels } from '../country/display-money'
import { formatPeriodRangeForDisplay } from './period-dates'
import { overtimePayReceiptLabel, type EmployeeReceiptInput } from './receipt'
import { formatVoucherCompanyName, type VoucherPdfOptions } from './voucher-pdf-options'
import type { VoucherFromRunLineResult } from './voucher-from-run-line'

export type VoucherPreviewPair = { label: string; value: string }
export type VoucherPreviewAmountLine = { label: string; amount: number }

export type VoucherPreviewData = {
  runLineId: string
  companyName: string
  periodTitle: string
  periodRange: string
  filename: string
  employee: VoucherPreviewPair[]
  earnings: VoucherPreviewAmountLine[]
  deductions: VoucherPreviewAmountLine[]
  totalDeductions?: number
  netSalary: number
  bank: VoucherPreviewPair[]
  transferAmount?: number
  showLegalNotes: boolean
  showSignatures: boolean
}

function sectionVisible(id: string, options?: VoucherPdfOptions): boolean {
  if (!options?.visibleSections) return true
  return options.visibleSections.has(id)
}

function fieldLabel(id: string, fallback: string, options?: VoucherPdfOptions): string {
  return options?.labels?.[id] ?? fallback
}

function shouldShowCustomDeductionLines(
  record: EmployeeReceiptInput,
  options?: VoucherPdfOptions
): boolean {
  if (!record.custom_deductions?.length) return false
  if (!options?.visibleSections) return true
  if (options.visibleSections.has('custom_deductions')) return true
  for (const id of options.visibleSections) {
    if (id.startsWith('custom_')) return true
  }
  return true
}

export function buildVoucherPreviewPayload(
  runLineId: string,
  voucher: VoucherFromRunLineResult,
  options?: VoucherPdfOptions
): VoucherPreviewData {
  const { record } = voucher
  const companyName = formatVoucherCompanyName(options?.branding, voucher.companyName)
  const periodRange = formatPeriodRangeForDisplay(record.period_start, record.period_end)
  const periodTitle = `${voucher.periodLabel}: ${periodRange}`

  const employee: VoucherPreviewPair[] = []
  if (sectionVisible('emp_code', options)) {
    employee.push({
      label: fieldLabel('emp_code', 'Código', options),
      value: record.employee_code || 'N/A',
    })
  }
  if (sectionVisible('emp_name', options)) {
    employee.push({
      label: fieldLabel('emp_name', 'Nombre', options),
      value: record.employee_name || 'N/A',
    })
  }
  if (sectionVisible('department', options)) {
    employee.push({
      label: fieldLabel('department', 'Departamento', options),
      value: record.department || 'N/A',
    })
  }
  if (sectionVisible('position', options)) {
    employee.push({
      label: fieldLabel('position', 'Posición', options),
      value: record.position || 'N/A',
    })
  }
  if (sectionVisible('period', options)) {
    employee.push({
      label: fieldLabel('period', 'Período', options),
      value: `${record.period_start} – ${record.period_end}`,
    })
  }
  if (sectionVisible('days_worked', options)) {
    employee.push({
      label: fieldLabel('days_worked', 'Días trabajados', options),
      value: String(record.days_worked),
    })
  }

  const earnings: VoucherPreviewAmountLine[] = []
  if (sectionVisible('base_salary', options)) {
    earnings.push({
      label: fieldLabel('base_salary', 'Salario base', options),
      amount: record.base_salary,
    })
  }
  if ((record.septimo_dia ?? 0) > 0 && sectionVisible('septimo_dia', options)) {
    earnings.push({
      label: fieldLabel('septimo_dia', 'Séptimo día', options),
      amount: record.septimo_dia!,
    })
  }
  if ((record.overtime_pay ?? 0) > 0 && sectionVisible('overtime_pay', options)) {
    earnings.push({
      label: overtimePayReceiptLabel(record, options),
      amount: record.overtime_pay!,
    })
  }
  if ((record.days_extra_pay ?? 0) > 0 && sectionVisible('days_extra_pay', options)) {
    earnings.push({
      label: fieldLabel('days_extra_pay', 'Feriado/descanso trabajado', options),
      amount: record.days_extra_pay!,
    })
  }

  const dedLabels = statutoryUiLabels(options?.countryCode)
  const deductions: VoucherPreviewAmountLine[] = []
  if (sectionVisible('ihss', options)) {
    deductions.push({
      label: fieldLabel('ihss', dedLabels.primarySocial, options),
      amount: record.social_security,
    })
  }
  if (sectionVisible('rap', options) && dedLabels.secondarySocial !== '—') {
    deductions.push({
      label: fieldLabel('rap', dedLabels.secondarySocial, options),
      amount: record.professional_tax,
    })
  }
  if (sectionVisible('isr', options)) {
    deductions.push({
      label: fieldLabel('isr', dedLabels.incomeTax, options),
      amount: record.income_tax,
    })
  }
  if (shouldShowCustomDeductionLines(record, options) && record.custom_deductions?.length) {
    record.custom_deductions.forEach((ded) => {
      deductions.push({ label: ded.name, amount: ded.amount })
    })
  }

  const showNet = sectionVisible('net_salary', options)
  const showBankName = sectionVisible('bank_name', options)
  const showBankAccount = sectionVisible('bank_account', options)
  const showBank = showBankName || showBankAccount

  const bank: VoucherPreviewPair[] = []
  if (showBankName) {
    bank.push({
      label: fieldLabel('bank_name', 'Banco', options),
      value: record.bank_name?.trim() || 'No especificado',
    })
  }
  if (showBankAccount) {
    bank.push({
      label: fieldLabel('bank_account', 'Cuenta bancaria', options),
      value: record.bank_account?.trim() || 'No especificado',
    })
  }

  return {
    runLineId,
    companyName,
    periodTitle,
    periodRange,
    filename: voucher.filename,
    employee,
    earnings,
    deductions,
    totalDeductions: sectionVisible('total_deductions', options) ? record.total_deductions : undefined,
    netSalary: showNet ? record.net_salary : 0,
    bank: showBank ? bank : [],
    transferAmount: showNet && showBank ? record.net_salary : undefined,
    showLegalNotes: sectionVisible('legal_notes', options),
    showSignatures: sectionVisible('signatures', options),
  }
}
