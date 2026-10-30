import { Buffer } from 'buffer'
import { formatPdfMoney, resolvePayrollDisplayCurrency, type DisplayCurrency } from '../country/display-money'
import { statutoryDeductionLabels } from '../country/payroll-labels'
import { normalizeCountryCode } from '../country/supported'
import { formatPeriodRangeForDisplay } from './period-dates'
import { formatDateTimeForHonduras, nowInHonduras } from '../timezone'
import {
  formatVoucherCompanyName,
  type VoucherPdfOptions,
} from './voucher-pdf-options'
import { resolveCompanyLogoBuffer } from '../reports/resolve-company-logo'
import {
  defaultPdfPrimaryColor,
  drawBrandedReceiptHeader,
  drawLiquidFooter,
  drawLiquidHighlightBox,
  drawLiquidPanel,
  drawLiquidSectionTitle,
  drawLiquidTableHeader,
  PDF,
} from '../pdf/liquid-theme'
import type { OvertimeDailyBreakdownSheet } from './overtime-daily-breakdown'

export type { VoucherPdfOptions }

const PAGE_WIDTH = 595.28
/** A4 height — single page avoids PDFKit auto-pagination from underestimated dynamic height */
const PAGE_HEIGHT = 841.89
const MARGIN = 30
const FOOTER_BLOCK = 36
const LAYOUT_SAFETY_PADDING = 48
const PAD = 12
const ROW_H = 14
const TABLE_HEADER_H = 20

export interface EmployeeReceiptInput {
  employee_code?: string
  employee_name?: string
  department?: string
  position?: string
  period_start: string
  period_end: string
  days_worked: number
  base_salary: number
  income_tax: number
  professional_tax: number
  social_security: number
  total_deductions: number
  net_salary: number
  bank_name?: string
  bank_account?: string
  custom_deductions?: Array<{ name: string; amount: number }>
  /** Séptimo Día (Art. 338-340) - solo para hourly */
  septimo_dia?: number
  /** Pago de horas extras incluido en el bruto de la línea */
  overtime_pay?: number
  /** Horas extras del período (AHC / ajuste) para etiqueta del comprobante */
  horas_extras?: number
  /** Pago adicional por feriado o descanso trabajado, incluido en el bruto */
  days_extra_pay?: number
  /**
   * Desglose diario HE (AHC) — hoja 2 del recibo cuando hay filas.
   * No afecta la planilla consolidada.
   */
  overtime_daily?: OvertimeDailyBreakdownSheet | null
}

function sectionVisible(id: string, options?: VoucherPdfOptions): boolean {
  if (!options?.visibleSections) return true
  return options.visibleSections.has(id)
}

/** Line items with amounts always appear on the receipt (config may hide the section label only). */
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

function fieldLabel(id: string, fallback: string, options?: VoucherPdfOptions): string {
  return options?.labels?.[id] ?? fallback
}

/** Label for overtime earnings line, optionally including hours. */
export function overtimePayReceiptLabel(
  record: Pick<EmployeeReceiptInput, 'horas_extras'>,
  options?: VoucherPdfOptions
): string {
  const base = fieldLabel('overtime_pay', 'Horas extras', options)
  const hours = Number(record.horas_extras)
  if (Number.isFinite(hours) && hours > 0) {
    return `${base} (${hours.toFixed(2)} h)`
  }
  return base
}

type ReceiptLayout = {
  headerHeight: number
  pageHeight: number
  footerY: number
  showEmployee: boolean
  employeeRowCount: number
  showEarnings: boolean
  hasSeptimoDia: boolean
  hasOvertimePay: boolean
  hasDaysExtraPay: boolean
  showBaseSalary: boolean
  showDeductions: boolean
  visibleStatutory: number
  customDeductionsCount: number
  showTotalDeductions: boolean
  showNet: boolean
  showBank: boolean
  showBankName: boolean
  showBankAccount: boolean
  showLegalNotes: boolean
  showSignatures: boolean
}

function buildReceiptLayout(
  record: EmployeeReceiptInput,
  options: VoucherPdfOptions | undefined,
  hasLogo: boolean
): ReceiptLayout {
  const headerHeight = hasLogo ? 78 : 74
  const showEmployee =
    sectionVisible('emp_code', options) ||
    sectionVisible('emp_name', options) ||
    sectionVisible('department', options) ||
    sectionVisible('position', options) ||
    sectionVisible('period', options) ||
    sectionVisible('days_worked', options)

  let employeeRowCount = 0
  if (sectionVisible('emp_code', options)) employeeRowCount += 1
  if (sectionVisible('emp_name', options)) employeeRowCount += 1
  if (sectionVisible('department', options)) employeeRowCount += 1
  if (sectionVisible('position', options)) employeeRowCount += 1
  if (sectionVisible('period', options)) employeeRowCount += 1
  if (sectionVisible('days_worked', options)) employeeRowCount += 1

  const hasSeptimoDia = (record.septimo_dia ?? 0) > 0 && sectionVisible('septimo_dia', options)
  const hasOvertimePay =
    (record.overtime_pay ?? 0) > 0 && sectionVisible('overtime_pay', options)
  const hasDaysExtraPay =
    (record.days_extra_pay ?? 0) > 0 && sectionVisible('days_extra_pay', options)
  const showBaseSalary = sectionVisible('base_salary', options)
  const showEarnings = showBaseSalary || hasSeptimoDia || hasOvertimePay || hasDaysExtraPay
  const showCustomDeductionLines = shouldShowCustomDeductionLines(record, options)
  const customDeductionsCount = showCustomDeductionLines ? record.custom_deductions?.length || 0 : 0
  const visibleStatutory =
    (sectionVisible('ihss', options) ? 1 : 0) +
    (sectionVisible('rap', options) ? 1 : 0) +
    (sectionVisible('isr', options) ? 1 : 0)
  const showTotalDeductions = sectionVisible('total_deductions', options)
  const showDeductions =
    visibleStatutory > 0 ||
    customDeductionsCount > 0 ||
    showTotalDeductions
  const showNet = sectionVisible('net_salary', options)
  const showBankName = sectionVisible('bank_name', options)
  const showBankAccount = sectionVisible('bank_account', options)
  const showBank = showBankName || showBankAccount
  const showLegalNotes = sectionVisible('legal_notes', options)
  const showSignatures = sectionVisible('signatures', options)

  let y = headerHeight + 18

  if (showEmployee) {
    const boxHeight = Math.max(54, PAD * 2 + employeeRowCount * ROW_H)
    y += 16 + boxHeight + 12
  }
  if (showEarnings) {
    const earningsRows =
      (showBaseSalary ? 1 : 0) +
      (hasSeptimoDia ? 1 : 0) +
      (hasOvertimePay ? 1 : 0) +
      (hasDaysExtraPay ? 1 : 0)
    const earningsHeight = TABLE_HEADER_H + PAD + earningsRows * ROW_H + PAD
    y += 14 + Math.max(earningsHeight, 36) + 12
  }
  if (showDeductions) {
    const deductionsHeight =
      TABLE_HEADER_H +
      PAD +
      visibleStatutory * ROW_H +
      customDeductionsCount * ROW_H +
      (showTotalDeductions ? ROW_H + 8 : 0) +
      PAD
    y += 14 + Math.max(deductionsHeight, 36) + 14
  }
  if (showNet) {
    y += 14 + 42 + 12
  }
  if (showBank) {
    y += 14 + 48 + 12
  }
  if (showLegalNotes) {
    y += 12 + 12 + 10 + 10 + 14
  }
  if (showSignatures) {
    y += 12 + 28 + 10
  }
  y += 14

  const contentBottom = y + LAYOUT_SAFETY_PADDING
  const pageHeight = Math.max(PAGE_HEIGHT, contentBottom + FOOTER_BLOCK + MARGIN * 2)
  const footerY = pageHeight - MARGIN - FOOTER_BLOCK

  return {
    headerHeight,
    pageHeight,
    footerY,
    showEmployee: showEmployee && employeeRowCount > 0,
    employeeRowCount,
    showEarnings,
    hasSeptimoDia,
    hasOvertimePay,
    hasDaysExtraPay,
    showBaseSalary,
    showDeductions,
    visibleStatutory,
    customDeductionsCount,
    showTotalDeductions,
    showNet,
    showBank,
    showBankName,
    showBankAccount,
    showLegalNotes,
    showSignatures,
  }
}

function writeAmount(
  doc: any,
  text: string,
  y: number,
  pageWidth: number,
  options?: { bold?: boolean; color?: string }
) {
  const contentWidth = pageWidth - MARGIN * 2
  if (options?.bold) doc.font('Helvetica-Bold')
  doc.fontSize(9).fillColor(options?.color ?? PDF.bodyText).text(text, MARGIN + PAD, y, {
    width: contentWidth - PAD * 2,
    align: 'right',
    lineBreak: false,
  })
  if (options?.bold) doc.font('Helvetica')
}

const formatHnlAmount = (n: number, currency: DisplayCurrency = 'HNL') => formatPdfMoney(n, currency)

function formatHrsCell(hrs: number): string {
  if (!(hrs > 0)) return '—'
  return hrs.toFixed(2)
}

/**
 * Página 2 del recibo: tabla diaria de HE (estilo Enlace).
 * Landscape A4 para caber franjas + totales.
 */
function drawOvertimeDailyBreakdownPage(
  doc: any,
  record: EmployeeReceiptInput,
  sheet: OvertimeDailyBreakdownSheet,
  primaryColor: string,
  companyName: string,
  periodDisplay: string,
  logoBuffer?: Buffer | null,
  currency: DisplayCurrency = 'HNL'
) {
  const formatHnlAmount = (n: number) => formatPdfMoney(n, currency)
  const LAND_W = 841.89
  const LAND_H = 595.28
  doc.addPage({ size: [LAND_W, LAND_H], margin: MARGIN })

  let yPos = drawBrandedReceiptHeader(doc, {
    primaryColor,
    companyName,
    subtitle: `Detalle de horas extras · ${periodDisplay}`,
    logoBuffer: logoBuffer ?? undefined,
  })

  doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyMuted)
  doc.text(
    `${record.employee_code || ''} · ${record.employee_name || ''} · Tarifa: ${formatHnlAmount(sheet.hourlyRate)}/h (base mensual ${formatHnlAmount(sheet.baseSalaryMonthly)} ÷ 240)`,
    MARGIN,
    yPos,
    { width: LAND_W - MARGIN * 2, lineBreak: false }
  )
  yPos += 16

  const showHol = sheet.showHolidayColumn
  const headers = showHol
    ? [
        'Fecha',
        'Día',
        'Base',
        'V/Hora',
        'Hrs 25%',
        'Monto 25%',
        'Hrs 50%',
        'Monto 50%',
        'Hrs 75%',
        'Monto 75%',
        'Hrs 100%',
        'Monto 100%',
        'Total',
      ]
    : [
        'Fecha',
        'Día',
        'Base',
        'V/Hora',
        'Hrs 25%',
        'Monto 25%',
        'Hrs 50%',
        'Monto 50%',
        'Hrs 75%',
        'Monto 75%',
        'Total',
      ]

  const tableW = LAND_W - MARGIN * 2
  const widths: number[] = showHol
    ? [62, 58, 58, 48, 42, 58, 42, 58, 42, 58, 42, 58, 62]
    : [70, 62, 62, 52, 48, 64, 48, 64, 48, 64, 70]
  const widthSum = widths.reduce((a, b) => a + b, 0)
  const scale = tableW / widthSum
  const colW = widths.map((w) => w * scale)

  const rowH = 13
  const headerH = 18
  drawLiquidTableHeader(doc, MARGIN, yPos, colW, headers, headerH)
  yPos += headerH

  const drawCell = (text: string, x: number, y: number, w: number, align: 'left' | 'right' = 'right') => {
    doc.font('Helvetica').fontSize(7).fillColor(PDF.bodyText).text(text, x + 2, y + 3, {
      width: w - 4,
      align,
      lineBreak: false,
      ellipsis: true,
    })
  }

  for (let i = 0; i < sheet.rows.length; i++) {
    const row = sheet.rows[i]
    if (yPos + rowH > LAND_H - 70) {
      drawLiquidFooter(doc, 'Humano SISU · Detalle de horas extras (continuación)', {
        y: LAND_H - MARGIN - 28,
        fontSize: 7,
      })
      doc.addPage({ size: [LAND_W, LAND_H], margin: MARGIN })
      yPos = drawBrandedReceiptHeader(doc, {
        primaryColor,
        companyName,
        subtitle: `Detalle de horas extras · ${periodDisplay} (continuación)`,
        logoBuffer: logoBuffer ?? undefined,
      })
      drawLiquidTableHeader(doc, MARGIN, yPos, colW, headers, headerH)
      yPos += headerH
    }

    const stripe = i % 2 === 1 ? PDF.tableStripe : PDF.white
    doc.rect(MARGIN, yPos, tableW, rowH).fill(stripe)

    const cells = showHol
      ? [
          row.date,
          row.dayName,
          formatHnlAmount(row.baseSalary),
          formatHnlAmount(row.hourlyRate),
          formatHrsCell(row.hrs25),
          row.hrs25 > 0 ? formatHnlAmount(row.pay25) : '—',
          formatHrsCell(row.hrs50),
          row.hrs50 > 0 ? formatHnlAmount(row.pay50) : '—',
          formatHrsCell(row.hrs75),
          row.hrs75 > 0 ? formatHnlAmount(row.pay75) : '—',
          formatHrsCell(row.hrs100),
          row.hrs100 > 0 ? formatHnlAmount(row.pay100) : '—',
          formatHnlAmount(row.totalPay),
        ]
      : [
          row.date,
          row.dayName,
          formatHnlAmount(row.baseSalary),
          formatHnlAmount(row.hourlyRate),
          formatHrsCell(row.hrs25),
          row.hrs25 > 0 ? formatHnlAmount(row.pay25) : '—',
          formatHrsCell(row.hrs50),
          row.hrs50 > 0 ? formatHnlAmount(row.pay50) : '—',
          formatHrsCell(row.hrs75),
          row.hrs75 > 0 ? formatHnlAmount(row.pay75) : '—',
          formatHnlAmount(row.totalPay),
        ]

    let x = MARGIN
    cells.forEach((text, ci) => {
      const align = ci <= 1 ? 'left' : 'right'
      drawCell(text, x, yPos, colW[ci], align)
      x += colW[ci]
    })
    yPos += rowH
  }

  yPos += 8
  doc.font('Helvetica-Bold').fontSize(9).fillColor(PDF.accentDark)
  doc.text(
    `Total desglose (asistencia): ${formatHnlAmount(sheet.breakdownTotalPay)}  ·  ${sheet.breakdownTotalHours.toFixed(2)} h`,
    MARGIN,
    yPos,
    { width: tableW, lineBreak: false }
  )
  yPos += 14

  if (sheet.paidDiffersFromBreakdown || sheet.hasManualOverride) {
    doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyMuted)
    doc.text(
      `Monto pagado en nómina: ${formatHnlAmount(sheet.paidOvertimePay)}. El desglose refleja asistencia; si hubo ajuste manual en la corrida, el monto del recibo (página 1) prevalece.`,
      MARGIN,
      yPos,
      { width: tableW }
    )
    yPos += 22
  }

  doc.font('Helvetica').fontSize(7).fillColor(PDF.bodyMuted)
  doc.text(
    'Franjas: 25% (5–7 pm y 5–8 am) ×1.25 · 50% (7–10 pm) ×1.50 · 75% (10 pm–5 am) ×1.75' +
      (showHol ? ' · 100% feriado ×2.00' : ''),
    MARGIN,
    Math.min(yPos, LAND_H - MARGIN - 40),
    { width: tableW }
  )

  drawLiquidFooter(doc, 'Humano SISU · Sistema Hondureño de Recursos Humanos', {
    y: LAND_H - MARGIN - 28,
    fontSize: 7,
  })
}

function drawKeyValuePanel(
  doc: any,
  x: number,
  y: number,
  w: number,
  rows: Array<{ label: string; value: string; x: number }>,
  minHeight: number
): number {
  const h = Math.max(minHeight, PAD * 2 + rows.length * ROW_H)
  drawLiquidPanel(doc, x, y, w, h)
  rows.forEach((row, index) => {
    const rowY = y + PAD + index * ROW_H
    doc.font('Helvetica').fontSize(8.5).fillColor(PDF.bodyMuted).text(`${row.label}:`, row.x, rowY, {
      lineBreak: false,
    })
    doc.font('Helvetica').fontSize(9).fillColor(PDF.bodyText).text(row.value, row.x + 78, rowY, {
      lineBreak: false,
    })
  })
  return y + h
}

function drawLineItemPanel(
  doc: any,
  x: number,
  y: number,
  w: number,
  items: Array<{ label: string; amount: string; bold?: boolean }>,
  totalRow?: { label: string; amount: string }
): number {
  const bodyRows = items.length + (totalRow ? 1 : 0)
  const h = TABLE_HEADER_H + PAD + bodyRows * ROW_H + (totalRow ? 8 : PAD)
  drawLiquidPanel(doc, x, y, w, h)

  const colConcept = Math.floor(w * 0.62)
  const colAmount = w - colConcept - 2
  drawLiquidTableHeader(doc, x + 1, y + 1, [colConcept, colAmount], ['Concepto', 'Monto'], TABLE_HEADER_H - 2)

  let rowY = y + TABLE_HEADER_H + 6
  items.forEach((item, idx) => {
    const stripe = idx % 2 === 1 ? PDF.tableStripe : PDF.white
    doc.rect(x + 1, rowY - 2, w - 2, ROW_H).fill(stripe)
    doc.font(item.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor(PDF.bodyText)
    doc.text(item.label, x + PAD, rowY, { lineBreak: false })
    writeAmount(doc, item.amount, rowY, doc.page.width, { bold: item.bold })
    rowY += ROW_H
  })

  if (totalRow) {
    rowY += 2
    doc
      .moveTo(x + PAD, rowY - 4)
      .lineTo(x + w - PAD, rowY - 4)
      .strokeColor(PDF.panelBorder)
      .stroke()
    doc.font('Helvetica-Bold').fontSize(9).fillColor(PDF.accentDark)
    doc.text(totalRow.label, x + PAD, rowY, { lineBreak: false })
    writeAmount(doc, totalRow.amount, rowY, doc.page.width, { bold: true, color: PDF.accentDark })
    rowY += ROW_H
  }

  doc.font('Helvetica').fillColor(PDF.bodyText)
  return y + h
}

export async function generateEmployeeReceiptPDF(
  record: EmployeeReceiptInput,
  periodo: string,
  quincena: number,
  companyId?: string,
  companyName?: string,
  periodLabel?: string,
  options?: VoucherPdfOptions
): Promise<Buffer> {
  const primaryColor = defaultPdfPrimaryColor(options?.branding?.primaryColor)
  const displayName = formatVoucherCompanyName(options?.branding, companyName || 'SISTEMA HONDUREÑO DE RECURSOS HUMANOS')
  const logoBuffer = await resolveCompanyLogoBuffer(options?.branding)
  const layout = buildReceiptLayout(record, options, !!logoBuffer)

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit')
      const currency = resolvePayrollDisplayCurrency(options?.countryCode, options?.currency)
      const formatAmount = (n: number) => formatPdfMoney(n, currency)
      const dedLabels = statutoryDeductionLabels(normalizeCountryCode(options?.countryCode))
      const periodRangeText = formatPeriodRangeForDisplay(record.period_start, record.period_end)
      const periodDisplay = periodLabel ? `${periodLabel}: ${periodRangeText}` : periodRangeText
      const contentWidth = PAGE_WIDTH - MARGIN * 2

      const doc = new PDFDocument({
        size: [PAGE_WIDTH, layout.pageHeight],
        margin: MARGIN,
        autoFirstPage: true,
        bufferPages: true,
        info: {
          Title: `Recibo de Nómina - ${record.employee_name || 'Empleado'} - ${periodDisplay}`,
          Author: 'Humano SISU',
          Subject: 'Recibo de Nómina Individual',
          Keywords: 'recibo, nómina, empleado, Honduras, Humano SISU',
          Creator: 'Humano SISU',
        },
      })

      const buffers: Buffer[] = []
      doc.on('data', (chunk: Buffer) => buffers.push(chunk))
      doc.on('end', () => {
        try {
          resolve(Buffer.concat(buffers))
        } catch (e) {
          reject(e)
        }
      })

      const pageWidth = doc.page.width
      const { footerY } = layout

      let yPos = drawBrandedReceiptHeader(doc, {
        primaryColor,
        companyName: displayName,
        subtitle: periodDisplay,
        logoBuffer,
      })

      if (layout.showEmployee) {
        drawLiquidSectionTitle(doc, 'Información del empleado', MARGIN, yPos)
        yPos += 16

        const employeeRows: Array<{ label: string; value: string; x: number }> = []
        if (sectionVisible('emp_code', options)) {
          employeeRows.push({
            label: fieldLabel('emp_code', 'Código', options),
            value: record.employee_code || 'N/A',
            x: MARGIN + PAD,
          })
        }
        if (sectionVisible('emp_name', options)) {
          employeeRows.push({
            label: fieldLabel('emp_name', 'Nombre', options),
            value: record.employee_name || 'N/A',
            x: MARGIN + PAD,
          })
        }
        if (sectionVisible('department', options)) {
          employeeRows.push({
            label: fieldLabel('department', 'Departamento', options),
            value: record.department || 'N/A',
            x: MARGIN + PAD,
          })
        }
        if (sectionVisible('position', options)) {
          employeeRows.push({
            label: fieldLabel('position', 'Posición', options),
            value: record.position || 'N/A',
            x: 300,
          })
        }
        if (sectionVisible('period', options)) {
          employeeRows.push({
            label: fieldLabel('period', 'Período', options),
            value: `${record.period_start} - ${record.period_end}`,
            x: 300,
          })
        }
        if (sectionVisible('days_worked', options)) {
          employeeRows.push({
            label: fieldLabel('days_worked', 'Días trabajados', options),
            value: record.days_worked.toString(),
            x: 300,
          })
        }

        const boxHeight = Math.max(54, PAD * 2 + layout.employeeRowCount * ROW_H)
        yPos = drawKeyValuePanel(doc, MARGIN, yPos, contentWidth, employeeRows, boxHeight) + 12
      }

      if (layout.showEarnings) {
        drawLiquidSectionTitle(doc, 'Detalle de ingresos', MARGIN, yPos)
        yPos += 14

        const items: Array<{ label: string; amount: string }> = []
        if (layout.showBaseSalary) {
          items.push({
            label: `${fieldLabel('base_salary', 'Salario base', options)}`,
            amount: formatAmount(record.base_salary),
          })
        }
        if (layout.hasSeptimoDia) {
          items.push({
            label: `${fieldLabel('septimo_dia', 'Séptimo día', options)}`,
            amount: formatAmount(record.septimo_dia!),
          })
        }
        if (layout.hasOvertimePay) {
          items.push({
            label: overtimePayReceiptLabel(record, options),
            amount: formatAmount(record.overtime_pay!),
          })
        }
        if (layout.hasDaysExtraPay) {
          items.push({
            label: fieldLabel('days_extra_pay', 'Feriado/descanso trabajado', options),
            amount: formatAmount(record.days_extra_pay!),
          })
        }

        yPos = drawLineItemPanel(doc, MARGIN, yPos, contentWidth, items) + 12
      }

      if (layout.showDeductions) {
        drawLiquidSectionTitle(doc, 'Detalle de deducciones', MARGIN, yPos)
        yPos += 14

        const items: Array<{ label: string; amount: string }> = []
        if (sectionVisible('ihss', options)) {
          items.push({
            label: `${fieldLabel('ihss', dedLabels.primarySocial, options)}`,
            amount: formatAmount(record.social_security),
          })
        }
        if (sectionVisible('rap', options)) {
          items.push({
            label: `${fieldLabel('rap', dedLabels.secondarySocial, options)}`,
            amount: formatAmount(record.professional_tax),
          })
        }
        if (sectionVisible('isr', options)) {
          items.push({
            label: `${fieldLabel('isr', 'ISR', options)}`,
            amount: formatAmount(record.income_tax),
          })
        }
        if (shouldShowCustomDeductionLines(record, options) && record.custom_deductions?.length) {
          record.custom_deductions.forEach((ded) => {
            items.push({ label: ded.name, amount: formatAmount(ded.amount) })
          })
        }

        const totalRow = layout.showTotalDeductions
          ? {
              label: `${fieldLabel('total_deductions', 'Total deducciones', options)}`,
              amount: formatAmount(record.total_deductions),
            }
          : undefined

        yPos = drawLineItemPanel(doc, MARGIN, yPos, contentWidth, items, totalRow) + 14
      }

      if (layout.showNet) {
        drawLiquidSectionTitle(doc, 'Resumen final', MARGIN, yPos)
        yPos += 14

        const netBoxH = 40
        drawLiquidHighlightBox(doc, MARGIN, yPos, contentWidth, netBoxH, { variant: 'success' })
        doc.font('Helvetica-Bold').fontSize(10).fillColor(PDF.successText)
        doc.text(`${fieldLabel('net_salary', 'Total a recibir', options)}`, MARGIN + PAD, yPos + 10, {
          lineBreak: false,
        })
        doc.fontSize(14).fillColor(PDF.success)
        doc.text(formatAmount(record.net_salary), MARGIN + PAD, yPos + 10, {
          width: contentWidth - PAD * 2,
          align: 'right',
          lineBreak: false,
        })
        doc.font('Helvetica').fillColor(PDF.bodyText)
        yPos += netBoxH + 12
      }

      if (layout.showBank) {
        drawLiquidSectionTitle(doc, 'Información bancaria', MARGIN, yPos)
        yPos += 14

        const bankBoxH = 48
        drawLiquidPanel(doc, MARGIN, yPos, contentWidth, bankBoxH)

        if (layout.showBankName) {
          doc.font('Helvetica').fontSize(8.5).fillColor(PDF.bodyMuted)
          doc.text(`${fieldLabel('bank_name', 'Banco', options)}:`, MARGIN + PAD, yPos + 10, { lineBreak: false })
          doc.fontSize(9).fillColor(PDF.bodyText)
          doc.text(record.bank_name || 'No especificado', MARGIN + 118, yPos + 10, { lineBreak: false })
        }
        if (layout.showBankAccount) {
          doc.font('Helvetica').fontSize(8.5).fillColor(PDF.bodyMuted)
          doc.text(`${fieldLabel('bank_account', 'Cuenta bancaria', options)}:`, MARGIN + PAD, yPos + 26, {
            lineBreak: false,
          })
          doc.fontSize(9).fillColor(PDF.bodyText)
          doc.text(record.bank_account || 'No especificado', MARGIN + 118, yPos + 26, { lineBreak: false })
        }
        if (layout.showNet) {
          doc.font('Helvetica').fontSize(8.5).fillColor(PDF.bodyMuted)
          doc.text('Monto a transferir:', 300, yPos + 10, { lineBreak: false })
          doc.fontSize(10).fillColor(PDF.accentDark)
          writeAmount(doc, formatAmount(record.net_salary), yPos + 10, pageWidth, { bold: true, color: PDF.accentDark })
        }

        doc.font('Helvetica').fillColor(PDF.bodyText)
        yPos += bankBoxH + 12
      }

      if (layout.showLegalNotes) {
        drawLiquidSectionTitle(doc, 'Notas', MARGIN, yPos)
        yPos += 14
        doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyMuted)
        doc.text('• Este recibo es un documento oficial emitido por la empresa.', MARGIN + 4, yPos, {
          lineBreak: false,
        })
        yPos += 11
        doc.text('• Los montos están calculados según la legislación laboral de Honduras.', MARGIN + 4, yPos, {
          lineBreak: false,
        })
        yPos += 11
        doc.text('• ¿Preguntas? Contacte a su manager de recursos humanos.', MARGIN + 4, yPos, {
          lineBreak: false,
        })
        doc.fillColor(PDF.bodyText)
        yPos += 14
      }

      if (layout.showSignatures) {
        doc.font('Helvetica').fontSize(8.5).fillColor(PDF.bodyMuted)
        doc.text('Firma del empleado', MARGIN, yPos, { lineBreak: false })
        doc.text('Firma del autorizado', 300, yPos, { lineBreak: false })
        drawLiquidPanel(doc, MARGIN, yPos + 12, 200, 28, { fill: PDF.white, radius: 6 })
        drawLiquidPanel(doc, 300, yPos + 12, 200, 28, { fill: PDF.white, radius: 6 })
        doc.fillColor(PDF.bodyText)
      }

      doc.switchToPage(0)
      doc.fontSize(7).fillColor(PDF.footerMuted).text(
        `Fecha de generación: ${formatDateTimeForHonduras(nowInHonduras())}`,
        MARGIN,
        footerY - 14,
        { align: 'center', width: contentWidth, lineBreak: false }
      )
      drawLiquidFooter(doc, 'Humano SISU · Sistema Hondureño de Recursos Humanos', {
        y: footerY,
        fontSize: 7,
      })

      const otSheet = record.overtime_daily
      if (otSheet && otSheet.rows.length > 0) {
        drawOvertimeDailyBreakdownPage(
          doc,
          record,
          otSheet,
          primaryColor,
          displayName,
          periodDisplay,
          logoBuffer,
          currency
        )
      }

      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}
