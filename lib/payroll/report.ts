import { Buffer } from 'buffer'
import { normalizeCountryCode } from '../country/supported'
import { statutoryDeductionLabels } from '../country/payroll-labels'
import { formatPdfMoney, resolvePayrollDisplayCurrency } from '../country/display-money'
import { formatDateForHonduras, formatDateTimeForHonduras } from '../timezone'
import { formatPeriodRangeForDisplay } from './period-dates'
import {
  buildPayrollPdfColumnMeta,
  collectCustomFieldsWithPdfValues,
  reportBiweeklyBaseFromMonthly,
  statutoryColumnsWithPdfValues,
  type PayrollPdfCustomFieldsConfig,
} from './payroll-pdf-columns'
import { formatVoucherCompanyName } from './voucher-pdf-options'
import type { BrandingConfig } from '../reports/report-config-schema'
import { resolveCompanyLogoBuffer } from '../reports/resolve-company-logo'
import {
  type PayrollPdfGroupBy,
  buildExecutiveBreakdownLines,
  executiveBreakdownLabel,
  groupKeyForRow,
  groupPlanillaLikeRows
} from './pdf-layout'
import { resolveReservedCustomColumnAmount } from './statutory-reserved-custom-keys'
import {
  defaultPdfPrimaryColor,
  drawBrandedReceiptHeader,
  drawLiquidPanel,
  drawLiquidSectionTitle,
  drawLiquidTableHeader,
  drawLiquidTableRowBackground,
  liquidReportFooterBrandLine,
  PDF,
  PDF_FOOTER_RESERVE,
  registerLiquidPageFooter,
  strokeLiquidTableCells,
} from '../pdf/liquid-theme'

export interface PlanillaItem {
  id: string
  name: string
  bank: string
  bank_account: string
  department: string
  /** Equipo (campo employees.team) */
  team?: string | null
  /** Puesto formal */
  position?: string | null
  /** Rol / título alternativo (respaldo para agrupar por posición) */
  role?: string | null
  monthly_salary: number
  days_worked: number
  days_absent: number
  late_days: number
  total_earnings: number
  IHSS: number
  RAP: number
  ISR: number
  total_deductions: number
  total: number
  notes_on_ingress?: string
  notes_on_deductions?: string
  metadata?: Record<string, any> // Custom fields metadata
  pay_type?: 'fixed' | 'hourly' | 'admin_floor'
  total_hours_worked?: number
  hourly_rate?: number
  septimo_dia?: number
  /** Horas extras AHC (tracking interno; no se imprime como columna de cantidad en el PDF) */
  horas_extras?: number
  /** Monto de HE pagado (incluido en total_earnings); columna del bloque ingresos */
  overtime_pay?: number
  /** Pago por feriado o descanso trabajado (incluido en total_earnings) */
  days_extra_pay?: number
}

/**
 * Custom field definition from payroll config
 */
interface CustomFieldDef {
  label: string
  type: 'number' | 'string' | 'boolean'
  category: 'earnings' | 'deductions' | 'calculation_helper'
  required: boolean
  default: any
}

/**
 * Generates a consolidated payroll PDF (3 pages: executive summary, payroll tables (fixed & hourly), bank details)
 * Returns a Buffer that can be sent as application/pdf
 * 
 * NEW: Supports separate tables for fixed and hourly employees, matching frontend display
 * NEW: Supports dynamic columns for custom fields based on payroll configuration
 */
export async function generateConsolidatedPayrollPDF(
  planillaFixed: PlanillaItem[],
  planillaHourly: PlanillaItem[],
  periodo: string,
  quincena: number,
  generatedByEmail?: string,
  companyName?: string,
  customFieldsConfig?: Record<string, CustomFieldDef | string>,
  payrollConfig?: {
    currency?: string
    payment_frequency?: string
    payment_cut_dates?: {
      biweekly_type?: string
      biweekly_first_start?: number
      biweekly_first_end?: number
      biweekly_second_start?: number
      biweekly_second_end?: number
      monthly_type?: string
      monthly_start?: number
      monthly_end?: number
    }
    legal_deductions?: { ihss?: boolean; rap?: boolean; isr?: boolean }
    /** ISO 3166-1 alpha-3 — etiquetas de deducciones (IHSS/ISSS/IGSS, etc.) */
    country_code?: string
  },
  periodDates?: { period_start: string; period_end: string },
  reportVisual?: { primaryColor?: string; branding?: BrandingConfig },
  layout?: {
    groupBy: PayrollPdfGroupBy
    watermarkText?: string
    /**
     * When set, only these column IDs are printed in the planilla table.
     * Matches Parámetros de Reportes → Nómina (`resolveReportConfig` visible columns).
     * Omit for legacy callers (all columns, including all custom fields).
     */
    visibleColumnIds?: string[]
    /**
     * Optional label overrides from report config
     */
    columnLabels?: Record<string, string>
    /**
     * Order for custom_* columns within their income/deduction blocks.
     * Standard PDF column order is fixed (ID → ingresos → deducciones → neto).
     */
    columnOrder?: Record<string, number>
    /**
     * When true with visibleColumnIds, custom payroll fields are filtered by visibility.
     * When false/undefined, custom fields from payroll config still print (legacy).
     */
    includeCustomPayrollFields?: boolean
    /**
     * When false, the PDF omits the bank-transfer page and its notes.
     * Omitted or true keeps the page (legacy callers).
     */
    includeBankSection?: boolean
  }
): Promise<Buffer> {
  const headerPrimary = defaultPdfPrimaryColor(
    reportVisual?.primaryColor ?? reportVisual?.branding?.primaryColor
  )
  const logoBuffer = await resolveCompanyLogoBuffer(reportVisual?.branding)
  const displayCompanyName = formatVoucherCompanyName(
    reportVisual?.branding,
    companyName || 'SISTEMA HONDUREÑO DE RECURSOS HUMANOS'
  )
  // Pass the real UTC instant. nowInHonduras() already shifts -6h; pairing it with
  // formatDateTimeForHonduras (timeZone America/Tegucigalpa) double-offsets another -6h.
  const generatedAt = formatDateTimeForHonduras(new Date())
  const footerBrandLine = liquidReportFooterBrandLine(displayCompanyName)

  return new Promise<Buffer>((resolve, reject) => {
    try {
      const PDFDocument = require('pdfkit')
      const pdfGroupBy: PayrollPdfGroupBy = layout?.groupBy ?? 'none'
      const watermarkText = layout?.watermarkText?.trim() || ''
      const visibleColumnIds = layout?.visibleColumnIds
        ? new Set(layout.visibleColumnIds)
        : null
      const columnLabels = layout?.columnLabels ?? {}
      const columnOrder = layout?.columnOrder ?? null

      // Configuración de payroll con valores por defecto
      const jurisdictionCountry = normalizeCountryCode(payrollConfig?.country_code)
      const currency = resolvePayrollDisplayCurrency(jurisdictionCountry, payrollConfig?.currency)
      const paymentFrequency = payrollConfig?.payment_frequency || 'biweekly'
      const paymentCutDates = payrollConfig?.payment_cut_dates || {
        biweekly_type: 'standard',
        biweekly_first_start: 1,
        biweekly_first_end: 15,
        biweekly_second_start: 16,
        biweekly_second_end: 30,
        monthly_type: 'standard',
        monthly_start: 1,
        monthly_end: 30
      }
      
      const pdfText = (v: unknown) => (v == null ? '' : String(v))

      const dedLabels = statutoryDeductionLabels(jurisdictionCountry)
      const formatCurrency = (n: number) => formatPdfMoney(n, currency)
      
      // Título dinámico según payment_frequency
      const payrollTitle = paymentFrequency === 'monthly' ? 'Planilla Mensual' : paymentFrequency === 'weekly' ? 'Planilla Semanal' : 'Planilla Quincenal'
      const payrollSubject = paymentFrequency === 'monthly' ? 'Nómina Mensual' : paymentFrequency === 'weekly' ? 'Nómina Semanal' : 'Nómina Quincenal'

      // Rango de fechas dinámico para header (ej: "15 de Oct al 21 de Oct")
      const periodRangeDisplay = periodDates
        ? formatPeriodRangeForDisplay(periodDates.period_start, periodDates.period_end)
        : null

      // Calcular texto de quincena/período según configuración (para sección info)
      let quincenaText = ''
      if (paymentFrequency === 'monthly') {
        const monthlyType = paymentCutDates?.monthly_type || 'standard'
        if (monthlyType === 'custom' && paymentCutDates?.monthly_start && paymentCutDates?.monthly_end) {
          quincenaText = `Mensual (${paymentCutDates.monthly_start}-${paymentCutDates.monthly_end})`
        } else {
          quincenaText = 'Mensual (1-fin de mes)'
        }
      } else if (paymentFrequency === 'weekly') {
        quincenaText = periodRangeDisplay || `Semana ${quincena}`
      } else {
        const biweeklyType = paymentCutDates?.biweekly_type || 'standard'
        if (biweeklyType === 'custom' && paymentCutDates?.biweekly_first_start && paymentCutDates?.biweekly_first_end &&
            paymentCutDates?.biweekly_second_start && paymentCutDates?.biweekly_second_end) {
          if (quincena === 1) {
            quincenaText = `Primera (${paymentCutDates.biweekly_first_start}-${paymentCutDates.biweekly_first_end})`
          } else {
            quincenaText = `Segunda (${paymentCutDates.biweekly_second_start}-${paymentCutDates.biweekly_second_end})`
          }
        } else {
          quincenaText = quincena === 1 ? 'Primera (1-15)' : 'Segunda (16-fin de mes)'
        }
      }
      
      const headerSubtitle = periodRangeDisplay ?? (paymentFrequency === 'monthly' ? periodo : `${periodo} • Quincena ${quincena}`)
      // Explicit MediaBox 14" × 8.5" (LEGAL landscape). Named size + layout can
      // silently fall back to A4 (11.69×8.26) in some PDFKit builds — do not use layout here.
      const PLANILLA_PAGE_SIZE: [number, number] = [14 * 72, 8.5 * 72]
      const doc = new PDFDocument({
        size: PLANILLA_PAGE_SIZE,
        margin: 30,
        info: {
          Title: `${payrollTitle} - ${headerSubtitle}`,
          Author: displayCompanyName,
          Subject: payrollSubject,
          Keywords: 'nómina, planilla, Honduras, Humano SISU',
          Creator: 'Humano SISU'
        }
      })

      const addPlanillaPage = () => {
        doc.addPage({ size: PLANILLA_PAGE_SIZE })
      }

      registerLiquidPageFooter(doc, { generatedAt, brandLine: footerBrandLine })

      const buffers: Buffer[] = []
      doc.on('error', (err: Error) => reject(err))
      doc.on('data', (chunk: Buffer) => buffers.push(chunk))
      doc.on('end', () => {
        try {
          const pdf = Buffer.concat(buffers)
          resolve(pdf)
        } catch (e) {
          reject(e)
        }
      })

      const drawWatermark = () => {
        if (!watermarkText) return
        try {
          const { width, height } = doc.page
          doc.save()
          doc.opacity(0.12)
          doc.fillColor('#dc2626')
          doc.fontSize(42)
          doc.rotate(-35, { origin: [width / 2, height / 2] })
          doc.text(watermarkText, 0, height / 2 - 20, {
            align: 'center',
            width,
          })
          doc.restore()
          doc.opacity(1)
        } catch (watermarkErr) {
          console.warn('payroll PDF watermark skipped:', watermarkErr)
        }
      }

      if (watermarkText) {
        doc.on('pageAdded', () => drawWatermark())
        drawWatermark()
      }

      // ===== PAGE 1: HEADER & EXEC SUMMARY =====
      const pageWidth = doc.page.width
      const margin = 30
      let bodyY = drawBrandedReceiptHeader(doc, {
        primaryColor: headerPrimary,
        companyName: displayCompanyName,
        title: payrollTitle,
        subtitle: headerSubtitle,
        logoBuffer,
      })

      drawLiquidSectionTitle(doc, 'Información del período', margin, bodyY)
      doc.font('Helvetica').fontSize(10).fillColor(PDF.bodyMuted).text(`Período: ${periodo}`, margin, bodyY + 16)
      doc.fontSize(10).text(`Rango: ${periodRangeDisplay ?? quincenaText}`, margin, bodyY + 32)
      doc.fontSize(10).text(`Fecha de generación: ${formatDateForHonduras(new Date())}`, margin, bodyY + 48)
      if (generatedByEmail) {
        doc.fontSize(10).text(`Generado por: ${generatedByEmail}`, margin, bodyY + 64)
      }

      const planillaAll = [...planillaFixed, ...planillaHourly]
      const totalGross = planillaAll.reduce((sum, row) => sum + row.total_earnings, 0)
      const totalDeductions = planillaAll.reduce((sum, row) => sum + row.total_deductions, 0)
      const totalNet = planillaAll.reduce((sum, row) => sum + row.total, 0)
      const totalEmployees = planillaAll.length
      const totalFixed = planillaFixed.length
      const totalHourly = planillaHourly.length

      const summaryTop = bodyY + 88
      // ~210 → maxDeptLines ≈ 14 (pitch 11); covers Enlace's 9 depts without "+N más".
      // Overflow still uses "+N más" if a company has more groups than fit.
      const summaryBoxH = 210
      drawLiquidPanel(doc, margin, summaryTop, pageWidth - margin * 2, summaryBoxH)
      drawLiquidSectionTitle(doc, 'Resumen ejecutivo', margin + 8, summaryTop + 8)
      doc.font('Helvetica').fontSize(9).fillColor(PDF.bodyMuted).text('Total Empleados:', margin + 14, summaryTop + 30)
      doc.fontSize(9).fillColor(PDF.bodyText).text(`${totalEmployees} (${totalFixed} fijos, ${totalHourly} por hora)`, 200, summaryTop + 30)
      doc.fontSize(9).fillColor(PDF.bodyMuted).text('Total Salario Bruto:', margin + 14, summaryTop + 46)
      doc.fontSize(9).fillColor(PDF.bodyText).text(formatCurrency(totalGross), 200, summaryTop + 46)
      doc.fontSize(9).fillColor(PDF.bodyMuted).text('Total Deducciones:', margin + 14, summaryTop + 62)
      doc.fontSize(9).fillColor(PDF.bodyText).text(formatCurrency(totalDeductions), 200, summaryTop + 62)
      doc.fontSize(9).fillColor(PDF.bodyMuted).text('Total Salario Neto:', margin + 14, summaryTop + 78)
      doc.fontSize(9).fillColor(PDF.bodyText).text(formatCurrency(totalNet), 200, summaryTop + 78)

      const deptTotals: { [key: string]: { count: number, gross: number, net: number } } = {}
      const breakdownKey = pdfGroupBy === 'none' ? 'department' : pdfGroupBy
      planillaAll.forEach((row) => {
        const key =
          breakdownKey === 'department'
            ? row.department || 'Sin Departamento'
            : groupKeyForRow(row, breakdownKey)
        if (!deptTotals[key]) {
          deptTotals[key] = { count: 0, gross: 0, net: 0 }
        }
        deptTotals[key].count++
        deptTotals[key].gross += row.total_earnings
        deptTotals[key].net += row.total
      })
      doc.fontSize(9).fillColor(PDF.bodyMuted).text(
        executiveBreakdownLabel(pdfGroupBy === 'none' ? 'department' : pdfGroupBy),
        360,
        summaryTop + 30
      )
      const deptListStartY = summaryTop + 44
      const deptListMaxY = summaryTop + summaryBoxH - 10
      const maxDeptLines = Math.max(1, Math.floor((deptListMaxY - deptListStartY) / 11))
      const breakdownLines = buildExecutiveBreakdownLines(
        Object.entries(deptTotals).map(([key, totals]) => ({
          key,
          count: totals.count,
          net: totals.net,
        })),
        { maxLines: maxDeptLines, formatNet: formatCurrency }
      )
      let deptY = deptListStartY
      for (const line of breakdownLines) {
        doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyText).text(line, 360, deptY)
        deptY += 11
      }

      // Helper to get custom field value from metadata
      const getCustomFieldNumber = (row: PlanillaItem, fieldName: string): number => {
        const reserved = resolveReservedCustomColumnAmount(fieldName, row)
        if (reserved != null) return reserved
        if (!row.metadata || row.metadata[fieldName] == null) return 0
        const value = row.metadata[fieldName]
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0
        if (typeof value === 'boolean') return value ? 1 : 0
        const n = Number(value)
        return Number.isFinite(n) ? n : 0
      }

      const getCustomFieldValue = (row: PlanillaItem, fieldName: string): string => {
        const reserved = resolveReservedCustomColumnAmount(fieldName, row)
        if (reserved != null) return formatCurrency(reserved)
        if (!row.metadata || row.metadata[fieldName] == null || row.metadata[fieldName] === '') {
          return formatCurrency(0)
        }
        const value = row.metadata[fieldName]
        if (typeof value === 'number') {
          return formatCurrency(value)
        } else if (typeof value === 'boolean') {
          return value ? 'Sí' : 'No'
        }
        const asNum = Number(value)
        if (Number.isFinite(asNum) && String(value).trim() !== '') {
          return formatCurrency(asNum)
        }
        return String(value || '')
      }

      const sectionBannerLabel = (groupBy: PayrollPdfGroupBy, gkey: string): string => {
        if (groupBy === 'department') return `Departamento: ${gkey}`
        if (groupBy === 'team') return `Equipo: ${gkey}`
        return `Posición: ${gkey}`
      }

      // Helper function to draw a payroll table (single block or grouped segments)
      const drawPayrollTable = (
        planillaData: PlanillaItem[],
        title: string,
        isHourly: boolean = false
      ) => {
        if (planillaData.length === 0) return

        const segments = groupPlanillaLikeRows(planillaData, pdfGroupBy)

        addPlanillaPage()
        const tablePageWidth = doc.page.width
        drawLiquidSectionTitle(doc, title, 30, 24)

        const hasSeptimoDia = isHourly && planillaData.some((r) => (r.septimo_dia ?? 0) > 0)
        const hasOvertimePay = planillaData.some((r) => (r.overtime_pay ?? 0) > 0)
        const hasDaysExtraPay = planillaData.some((r) => (r.days_extra_pay ?? 0) > 0)
        const customWithValues = collectCustomFieldsWithPdfValues(
          customFieldsConfig as PayrollPdfCustomFieldsConfig | undefined,
          planillaData
        )
        const customEarningsWithValues = customWithValues.earnings
        const customDeductionsWithValues = customWithValues.deductions
        const statutoryWithValues = statutoryColumnsWithPdfValues(planillaData)

        type PdfTableCol = {
          id: string
          header: string
          width: number
          isText: boolean
          totalFormat: 'days' | 'hours' | 'currency' | 'none'
          value: (row: PlanillaItem) => string
          number: (row: PlanillaItem) => number | null
        }

        const defaultWidth = (id: string): number => {
          if (id === 'emp_code') return isHourly ? 55 : 60
          if (id === 'emp_name') return isHourly ? 100 : 110
          if (id === 'department' || id === 'position') return 70
          if (id === 'days_worked') return isHourly ? 35 : 45
          if (id === 'hours') return 45
          if (id === 'hourly_rate') return 55
          if (id === 'base_salary' || id === 'biweekly_salary') return isHourly ? 65 : 70
          if (id === 'septimo_dia') return 55
          if (id === 'overtime_pay') return isHourly ? 50 : 55
          if (id === 'days_extra_pay') return 55
          if (id === 'gross_salary' || id === 'total_deductions' || id === 'net_salary') return 58
          if (id === 'ihss' || id === 'rap' || id === 'isr') return 38
          if (id.startsWith('custom_')) return 42
          return 45
        }

        const resolveColBinding = (
          id: string
        ): Pick<PdfTableCol, 'isText' | 'totalFormat' | 'value' | 'number'> | null => {
          switch (id) {
            case 'emp_code':
              return {
                isText: true,
                totalFormat: 'none',
                value: (row) => row.id || '',
                number: () => null,
              }
            case 'emp_name':
              return {
                isText: true,
                totalFormat: 'none',
                value: (row) => row.name || '',
                number: () => null,
              }
            case 'department':
              return {
                isText: true,
                totalFormat: 'none',
                value: (row) => row.department || '',
                number: () => null,
              }
            case 'position':
              return {
                isText: true,
                totalFormat: 'none',
                value: (row) => (row.position || row.role || '').trim(),
                number: () => null,
              }
            case 'days_worked':
              return {
                isText: false,
                totalFormat: 'days',
                value: (row) => row.days_worked.toFixed(1),
                number: (row) => row.days_worked,
              }
            case 'hours':
              return {
                isText: false,
                totalFormat: 'hours',
                value: (row) => (row.total_hours_worked || 0).toFixed(2),
                number: (row) => row.total_hours_worked || 0,
              }
            case 'hourly_rate':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.hourly_rate || 0),
                number: (row) => row.hourly_rate || 0,
              }
            case 'base_salary':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.monthly_salary),
                number: (row) => row.monthly_salary,
              }
            case 'biweekly_salary':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(reportBiweeklyBaseFromMonthly(row.monthly_salary)),
                number: (row) => reportBiweeklyBaseFromMonthly(row.monthly_salary),
              }
            case 'septimo_dia':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.septimo_dia ?? 0),
                number: (row) => row.septimo_dia ?? 0,
              }
            case 'overtime_pay':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.overtime_pay ?? 0),
                number: (row) => row.overtime_pay ?? 0,
              }
            case 'days_extra_pay':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.days_extra_pay ?? 0),
                number: (row) => row.days_extra_pay ?? 0,
              }
            case 'gross_salary':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.total_earnings),
                number: (row) => row.total_earnings,
              }
            case 'ihss':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.IHSS),
                number: (row) => row.IHSS,
              }
            case 'rap':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.RAP),
                number: (row) => row.RAP,
              }
            case 'isr':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.ISR),
                number: (row) => row.ISR,
              }
            case 'total_deductions':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.total_deductions),
                number: (row) => row.total_deductions,
              }
            case 'net_salary':
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => formatCurrency(row.total),
                number: (row) => row.total,
              }
            default: {
              if (!id.startsWith('custom_')) return null
              const fieldName = id.slice('custom_'.length)
              return {
                isText: false,
                totalFormat: 'currency',
                value: (row) => getCustomFieldValue(row, fieldName),
                number: (row) => getCustomFieldNumber(row, fieldName),
              }
            }
          }
        }

        const cols: PdfTableCol[] = buildPayrollPdfColumnMeta({
          isHourly,
          hasSeptimoDia,
          hasOvertimePay,
          hasDaysExtraPay,
          visibleColumnIds,
          columnLabels,
          columnOrder,
          includeCustomPayrollFields: layout?.includeCustomPayrollFields,
          customFieldsConfig: customFieldsConfig as PayrollPdfCustomFieldsConfig | undefined,
          legalDeductions: payrollConfig?.legal_deductions,
          countryCode: jurisdictionCountry,
          customEarningsWithValues,
          customDeductionsWithValues,
          statutoryWithValues,
        })
          .map((meta) => {
            const binding = resolveColBinding(meta.id)
            if (!binding) return null
            return {
              id: meta.id,
              header: meta.header,
              width: defaultWidth(meta.id),
              ...binding,
            }
          })
          .filter((c): c is PdfTableCol => c != null)

        if (cols.length === 0) {
          cols.push({
            id: 'emp_name',
            header: 'Nombre',
            width: 120,
            isText: true,
            totalFormat: 'none',
            value: (row) => row.name || '',
            number: () => null,
          })
        }

        const allHeaders = cols.map((c) => c.header)
        const colWidths = cols.map((c) => c.width)

        const totalWidth = colWidths.reduce((a, b) => a + b, 0)
        const availableWidth = tablePageWidth - 80
        if (totalWidth > availableWidth) {
          const protectedIdx = cols.findIndex((c) => c.id === 'emp_name')
          const codeIdx = cols.findIndex((c) => c.id === 'emp_code')
          const protect = [codeIdx, protectedIdx].filter((i) => i >= 0)
          const protectedSum = protect.reduce((s, i) => s + colWidths[i], 0) || colWidths[0] + (colWidths[1] || 0)
          const restSum = totalWidth - protectedSum
          const restAvailable = availableWidth - protectedSum
          if (restAvailable > 80 && restSum > 0 && protect.length > 0) {
            const restScale = restAvailable / restSum
            for (let i = 0; i < colWidths.length; i++) {
              if (protect.includes(i)) continue
              colWidths[i] = Math.max(28, Math.floor(colWidths[i] * restScale))
            }
            const after = colWidths.reduce((a, b) => a + b, 0)
            if (after > availableWidth) {
              const fix = availableWidth / after
              for (let i = 0; i < colWidths.length; i++) {
                colWidths[i] = Math.max(22, Math.floor(colWidths[i] * fix))
              }
            }
          } else {
            const scaleFactor = availableWidth / totalWidth
            for (let i = 0; i < colWidths.length; i++) {
              colWidths[i] = Math.max(22, Math.floor(colWidths[i] * scaleFactor))
            }
          }
        }

        const startX = 40
        const dataRowHeight = 14
        const headerRowHeight = 28
        const dataFontSize = 7
        const headerFontSize = 7.5
        const totalsFontSize = 7

        const buildRowValues = (row: PlanillaItem): string[] => cols.map((c) => c.value(row))

        const buildRowNumericContributions = (row: PlanillaItem): (number | null)[] =>
          cols.map((c) => c.number(row))

        const formatTotalCell = (colIndex: number, sum: number): string => {
          const fmt = cols[colIndex]?.totalFormat
          if (fmt === 'days') return sum.toFixed(1)
          if (fmt === 'hours') return sum.toFixed(2)
          return formatCurrency(sum)
        }

        const paintHeaderRow = (y: number): number => {
          drawLiquidTableHeader(doc, startX, y, colWidths, allHeaders, headerRowHeight, {
            fontSize: headerFontSize,
            align: 'center',
            padX: 1,
          })
          return y + headerRowHeight
        }

        const paintTotalsRow = (
          rows: PlanillaItem[],
          y: number,
          label: string = 'TOTALES:'
        ): number => {
          const y2 = y + 4
          const totalsWidth = colWidths.reduce((a, b) => a + b, 0)
          const sums = new Array(cols.length).fill(0) as number[]
          const isNumeric = new Array(cols.length).fill(false) as boolean[]

          for (const row of rows) {
            const contrib = buildRowNumericContributions(row)
            for (let i = 0; i < contrib.length; i++) {
              const v = contrib[i]
              if (v == null) continue
              isNumeric[i] = true
              sums[i] += v
            }
          }

          drawLiquidTableRowBackground(doc, startX, y2, totalsWidth, dataRowHeight, 0)
          strokeLiquidTableCells(doc, startX, y2, colWidths, dataRowHeight)

          for (let i = 0; i < cols.length; i++) {
            const x = startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0)
            const cellW = colWidths[i] - 2
            if (i === 0) {
              doc
                .font('Helvetica-Bold')
                .fontSize(totalsFontSize)
                .fillColor(PDF.accentDark)
                .text(label, x + 1, y2 + 3, {
                  width: cellW,
                  align: 'left',
                  lineBreak: false,
                  ellipsis: true,
                })
              continue
            }
            if (cols[i].isText || !isNumeric[i] || cols[i].totalFormat === 'none') {
              continue
            }
            doc
              .font('Helvetica-Bold')
              .fontSize(totalsFontSize)
              .fillColor(PDF.bodyText)
              .text(formatTotalCell(i, sums[i]), x + 1, y2 + 3, {
                width: cellW,
                align: 'center',
                lineBreak: false,
                ellipsis: true,
              })
          }
          return y2 + dataRowHeight
        }

        const paintDataRows = (rows: PlanillaItem[], yStart: number, continuationLabel: string): number => {
          let y = yStart
          let pageCount = 1
          let rowIndex = 0
          const bottomLimit = doc.page.height - 60 - PDF_FOOTER_RESERVE - dataRowHeight - 8
          for (const row of rows) {
            if (y > bottomLimit) {
              addPlanillaPage()
              y = 40
              pageCount++
              doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyMuted).text(`${continuationLabel} - Página ${pageCount}`, 40, 20)
              y = paintHeaderRow(y)
              rowIndex = 0
            }

            const values = buildRowValues(row)
            const cellOpts = (i: number) => ({
              width: colWidths[i] - 2,
              align: 'center' as const,
              lineBreak: false,
              ellipsis: true,
              height: dataRowHeight - 2,
            })
            const rowWidth = colWidths.reduce((a, b) => a + b, 0)
            drawLiquidTableRowBackground(doc, startX, y, rowWidth, dataRowHeight, rowIndex)
            strokeLiquidTableCells(doc, startX, y, colWidths, dataRowHeight)
            values.forEach((val, i) => {
              const x = startX + colWidths.slice(0, i).reduce((a, b) => a + b, 0)
              doc
                .font('Helvetica')
                .fontSize(dataFontSize)
                .fillColor(PDF.bodyText)
                .text(pdfText(val), x + 1, y + 3, cellOpts(i))
            })
            y += dataRowHeight
            rowIndex += 1
          }
          return y
        }

        let y = 50
        for (const [gkey, grows] of segments) {
          const sectionH = pdfGroupBy !== 'none' ? 24 : 0
          if (y + sectionH + headerRowHeight + 30 > doc.page.height - 60) {
            addPlanillaPage()
            y = 40
            doc.fontSize(8).fillColor('#475569').text(`${title} (continuación)`, 40, 20)
            y = 52
          }

          if (pdfGroupBy !== 'none' && gkey !== '') {
            drawLiquidPanel(doc, 40, y, tablePageWidth - 80, 18, { fill: PDF.panelBgAlt, radius: 6 })
            doc.fillColor(PDF.accentDark)
            doc.font('Helvetica-Bold').fontSize(9).text(sectionBannerLabel(pdfGroupBy, gkey), 48, y + 5, {
              width: tablePageWidth - 100
            })
            doc.fillColor(PDF.bodyText).font('Helvetica')
            y += 22
          }

          y = paintHeaderRow(y)
          const continuationLabel =
            pdfGroupBy !== 'none' && gkey !== '' ? `${title} — ${gkey}` : title
          y = paintDataRows(grows, y, continuationLabel)
          y = paintTotalsRow(grows, y)
          y += 12
        }

        if (segments.length > 1) {
          const totalsNeed = dataRowHeight + 12
          if (y + totalsNeed > doc.page.height - 60 - PDF_FOOTER_RESERVE) {
            addPlanillaPage()
            y = 40
            y = paintHeaderRow(y)
          }
          y = paintTotalsRow(planillaData, y, 'TOTAL GENERAL:')
        }
      }

      // Draw Fixed Employees Table
      if (planillaFixed.length > 0) {
        drawPayrollTable(planillaFixed, 'NÓMINA — EMPLEADOS FIJOS', false)
      }

      // Draw Hourly Employees Table
      if (planillaHourly.length > 0) {
        drawPayrollTable(planillaHourly, 'NÓMINA — EMPLEADOS POR HORA', true)
      }

      // ===== BANK DETAILS & NOTES (optional last page) =====
      const includeBankSection = layout?.includeBankSection !== false
      if (includeBankSection) {
        addPlanillaPage()
        drawLiquidSectionTitle(doc, 'Información bancaria y notas', 30, 24)

        drawLiquidSectionTitle(doc, 'Detalle bancario para transferencias', 30, 52)
        const bankHeaders = ['Código', 'Nombre', 'Banco', 'Cuenta', 'Monto Neto']
        const bankColWidths = [70, 210, 120, 180, 120]
        const bankStartX = 40
        let bankY = 68
        const bankRowHeight = 17

        drawLiquidTableHeader(doc, bankStartX, bankY, bankColWidths, bankHeaders, bankRowHeight)
        bankY += bankRowHeight

        let bankRowIndex = 0
        planillaAll.forEach((row) => {
          if (bankY > doc.page.height - 60 - PDF_FOOTER_RESERVE) {
            addPlanillaPage()
            bankY = 40
            bankRowIndex = 0
          }
          const bankValues = [
            row.id || '',
            row.name,
            row.bank || 'No especificado',
            row.bank_account || 'No especificado',
            formatCurrency(row.total)
          ]
          const bankTableW = bankColWidths.reduce((a, b) => a + b, 0)
          drawLiquidTableRowBackground(doc, bankStartX, bankY, bankTableW, bankRowHeight, bankRowIndex)
          strokeLiquidTableCells(doc, bankStartX, bankY, bankColWidths, bankRowHeight)
          bankValues.forEach((val, i) => {
            const x = bankStartX + bankColWidths.slice(0, i).reduce((a, b) => a + b, 0)
            doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyText).text(pdfText(val), x + 2, bankY + 4, {
              width: bankColWidths[i] - 4,
              align: 'center',
              lineBreak: false,
              ellipsis: true
            })
          })
          bankY += bankRowHeight
          bankRowIndex += 1
        })

        drawLiquidSectionTitle(doc, 'Notas importantes', 40, bankY + 22)
        doc.font('Helvetica').fontSize(8).fillColor(PDF.bodyMuted).text('• Esta planilla ha sido generada automáticamente por Humano SISU.', 40, bankY + 38)
        doc.fontSize(8).text('• Los montos están calculados según la legislación laboral de Honduras.', 40, bankY + 53)
        const dedLegend =
          dedLabels.secondarySocial === '—'
            ? `${dedLabels.primarySocial}, ${dedLabels.incomeTax}`
            : `${dedLabels.primarySocial}, ${dedLabels.secondarySocial}, ${dedLabels.incomeTax}`
        doc
          .fontSize(8)
          .text(
            `• Las deducciones incluyen las aplicables según configuración (${dedLegend} u otras).`,
            40,
            bankY + 68
          )
        doc.fontSize(8).text('• Verificar que la información bancaria sea correcta antes de procesar pagos.', 40, bankY + 83)
        doc.fontSize(8).text('• Para consultas, contactar al departamento de recursos humanos.', 40, bankY + 98)
      }

      doc.end()
    } catch (error) {
      reject(
        error instanceof Error
          ? error
          : new Error(error != null ? String(error) : 'Error generando PDF de planilla')
      )
    }
  })
}

