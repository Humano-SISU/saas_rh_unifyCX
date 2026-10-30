import type { NextApiRequest, NextApiResponse } from 'next'
// import { createClient } from '../../../lib/supabase/server'
import { requireUser } from '../../../lib/auth/requireUser'
import { generateConsolidatedPayrollPDF, type PlanillaItem } from '../../../lib/payroll/report'
import { readDaysExtraPay } from '../../../lib/payroll/days-extra-pay'
import { normalizeCountryCode } from '../../../lib/country/supported'
import { resolvePayrollDisplayCurrency } from '../../../lib/country/display-money'
import {
  parsePayrollPdfGroupByQuery,
  payrollPdfGroupByFilenameSuffix
} from '../../../lib/payroll/pdf-layout'
import { requirePlanAndQuota, incrementUsage } from '../../../lib/billing/enforce'
import { resolveReportConfig } from '../../../lib/reports/column-resolver'
import {
  coalescePlanillaPayType,
  isExactHourlyPlanillaTablePayType,
} from '../../../lib/payroll/resolve-effective-pay-type'

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  try {
    const { supabase, user, userProfile } = await requireUser(req, res)
    
    if (!userProfile?.company_id) {
      return res.status(400).json({ 
        error: 'Perfil de usuario incompleto',
        message: 'No se pudo obtener la información de la empresa'
      })
    }

    const { periodo, quincena, draftData, group_by } = req.body || {}
    const pdfGroupBy = parsePayrollPdfGroupByQuery(group_by)

    if (!periodo || !/^[0-9]{4}-[0-9]{2}$/.test(periodo)) {
      return res.status(400).json({ error: 'Periodo inválido (YYYY-MM)' })
    }
    if (![1, 2].includes(Number(quincena))) {
      return res.status(400).json({ error: 'Quincena inválida (1 o 2)' })
    }
    if (!draftData || !Array.isArray(draftData.rows) || draftData.rows.length === 0) {
      return res.status(400).json({ error: 'Datos del draft son requeridos' })
    }

    const companyId = userProfile.company_id

    // Check plan and quota before processing
    await requirePlanAndQuota(supabase, companyId, 'generate_payroll')

    // Obtener información de empleados para completar los datos (incluyendo pay_type)
    const employeeIds = draftData.rows.map((row: any) => row.employee_id)
    const { data: employees, error: empError } = await supabase
      .from('employees')
      .select(
        `id, name, employee_code, bank_name, bank_account, pay_type, team, role,
         departments!employees_department_id_fkey(name)`
      )
      .in('id', employeeIds)
      .eq('company_id', companyId)

    if (empError) {
      return res.status(500).json({ error: 'Error cargando información de empleados' })
    }

    if (!employees || employees.length === 0) {
      return res.status(400).json({ error: 'No se encontraron empleados válidos' })
    }

    // Mapear datos del draft a estructura de PlanillaItem
    const planilla: PlanillaItem[] = draftData.rows.map((row: any) => {
      const employee = employees.find((e: any) => e.id === row.employee_id)
      const payType = coalescePlanillaPayType(employee?.pay_type || row.pay_type || 'fixed')
      const totalHours = Number(row.total_hours_worked) || (Number(row.days_worked) || 0) * 8
      const showHourCols = isExactHourlyPlanillaTablePayType(payType)
      const hourlyRate =
        showHourCols && totalHours > 0
          ? (Number(row.gross_salary) || 0) / totalHours
          : 0
      
      return {
        id: employee?.employee_code || row.employee_code || '',
        name: employee?.name || row.name || '',
        bank: employee?.bank_name || 'No especificado',
        bank_account: employee?.bank_account || 'No especificado',
        department: (employee as { departments?: { name?: string } })?.departments?.name || 'Sin Departamento',
        team: (employee as { team?: string | null })?.team ?? null,
        position: (employee as { role?: string | null })?.role ?? null,
        role: (employee as { role?: string | null })?.role ?? null,
        monthly_salary: Number(row.base_salary) || 0,
        days_worked: Number(row.days_worked) || 0,
        days_absent: Number(row.days_absent) || 0,
        late_days: Number(row.late_days) || 0,
        total_earnings: Number(row.gross_salary) || 0,
        IHSS: Number(row.ihss) || 0,
        RAP: Number(row.rap) || 0,
        ISR: Number(row.isr) || 0,
        total_deductions: Number(row.total_deductions) || 0,
        total: Number(row.net_salary) || 0,
        notes_on_ingress: row.adj_bonus ? `Bono: ${Number(row.adj_bonus).toFixed(2)}` : '',
        notes_on_deductions: row.adj_discount ? `Descuento: ${Number(row.adj_discount).toFixed(2)}` : '',
        pay_type: payType,
        total_hours_worked: showHourCols ? totalHours : undefined,
        hourly_rate: showHourCols ? hourlyRate : undefined,
        ...(Number.isFinite(Number(row.horas_extras ?? row.metadata?.horas_extras)) &&
        Number(row.horas_extras ?? row.metadata?.horas_extras) > 0
          ? {
              horas_extras:
                Math.round(Number(row.horas_extras ?? row.metadata?.horas_extras) * 100) / 100,
            }
          : {}),
        ...(Number.isFinite(Number(row.overtime_pay ?? row.metadata?.overtime_pay)) &&
        Number(row.overtime_pay ?? row.metadata?.overtime_pay) > 0
          ? {
              overtime_pay:
                Math.round(Number(row.overtime_pay ?? row.metadata?.overtime_pay) * 100) / 100,
            }
          : {}),
        ...(readDaysExtraPay({ days_extra_pay: row.days_extra_pay ?? row.metadata?.days_extra_pay }) > 0
          ? {
              days_extra_pay: readDaysExtraPay({
                days_extra_pay: row.days_extra_pay ?? row.metadata?.days_extra_pay,
              }),
            }
          : {}),
      }
    })

    console.log(`Generando PDF desde draft: ${planilla.length} empleados para ${periodo} Q${quincena}`)

    // Obtener configuración de payroll (quincena_config como fuente primaria, metadata legacy)
    const { data: payrollConfig } = await supabase
      .from('company_payroll_configs')
      .select('metadata, payment_frequency, quincena_config, custom_fields')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .single()
    
    const payrollMetadata = payrollConfig?.metadata || {}
    const qcCol = payrollConfig?.quincena_config as { first_start?: number; first_end?: number; second_start?: number; second_end?: number } | null
    const metaCutDates = payrollMetadata?.payment_cut_dates || {}
    const hasCustomQuincena = !!(qcCol && (qcCol.first_start != null || qcCol.first_end != null || qcCol.second_start != null || qcCol.second_end != null))
    const paymentCutDates = hasCustomQuincena
      ? {
          biweekly_type: 'custom' as const,
          biweekly_first_start: qcCol?.first_start ?? metaCutDates?.biweekly_first_start ?? 1,
          biweekly_first_end: qcCol?.first_end ?? metaCutDates?.biweekly_first_end ?? 15,
          biweekly_second_start: qcCol?.second_start ?? metaCutDates?.biweekly_second_start ?? 16,
          biweekly_second_end: qcCol?.second_end ?? metaCutDates?.biweekly_second_end ?? 30,
          monthly_type: metaCutDates?.monthly_type || 'standard',
          monthly_start: metaCutDates?.monthly_start ?? 1,
          monthly_end: metaCutDates?.monthly_end ?? 30
        }
      : metaCutDates?.biweekly_first_start != null
        ? metaCutDates
        : {
            biweekly_type: 'standard' as const,
            biweekly_first_start: 1,
            biweekly_first_end: 15,
            biweekly_second_start: 16,
            biweekly_second_end: 30,
            monthly_type: 'standard' as const,
            monthly_start: 1,
            monthly_end: 30
          }
    const { data: company } = await supabase
      .from('companies')
      .select('name, country_code')
      .eq('id', companyId)
      .single()

    const country = normalizeCountryCode(company?.country_code)
    const currency = resolvePayrollDisplayCurrency(country, payrollMetadata.currency)
    const pfRaw = payrollConfig?.payment_frequency ?? payrollMetadata.payment_frequency ?? 'biweekly'
    const paymentFrequency = pfRaw === 'mensual' ? 'monthly' : pfRaw === 'quincenal' ? 'biweekly' : pfRaw === 'semanal' ? 'weekly' : pfRaw

    let pdfCustomFieldsForPdf: Record<string, any> | undefined
    if (payrollConfig?.custom_fields && typeof payrollConfig.custom_fields === 'object') {
      pdfCustomFieldsForPdf = payrollConfig.custom_fields as Record<string, any>
    }

    const legalDeductions = payrollMetadata.legal_deductions || {
      ihss: true,
      rap: country !== 'GTM',
      isr: true
    }

    const pdfPayrollConfig = {
      currency,
      payment_frequency: paymentFrequency,
      payment_cut_dates: paymentCutDates,
      legal_deductions: legalDeductions,
      country_code: country
    }

    // Separate fixed and hourly employees (detalle UI: solo exact hourly → por hora)
    const planillaFixed = planilla.filter(p => !isExactHourlyPlanillaTablePayType((p as any).pay_type))
    const planillaHourly = planilla.filter(p => isExactHourlyPlanillaTablePayType((p as any).pay_type))

    let reportVisual: { primaryColor?: string; branding?: Record<string, unknown> } | undefined
    let visibleColumnIds: string[] | undefined
    let columnLabels: Record<string, string> | undefined
    let columnOrder: Record<string, number> | undefined
    let includeCustomPayrollFields: boolean | undefined
    try {
      const resolvedConfig = await resolveReportConfig(companyId, 'payroll', supabase)
      if (resolvedConfig?.branding) {
        reportVisual = {
          primaryColor: resolvedConfig.branding.primaryColor,
          branding: resolvedConfig.branding,
        }
      }
      if (resolvedConfig?.columns?.length) {
        visibleColumnIds = resolvedConfig.columns.map((c) => c.id)
        columnLabels = Object.fromEntries(resolvedConfig.columns.map((c) => [c.id, c.label]))
        columnOrder = Object.fromEntries(
          resolvedConfig.columns.map((c, i) => [c.id, c.order ?? i])
        )
      }
      includeCustomPayrollFields = resolvedConfig?.includeCustomPayrollFields
    } catch (configErr) {
      console.warn('generate-pdf: report config skipped', configErr)
    }

    const pdf = await generateConsolidatedPayrollPDF(
      planillaFixed,
      planillaHourly,
      periodo,
      Number(quincena),
      user?.email,
      company?.name,
      pdfCustomFieldsForPdf,
      pdfPayrollConfig,
      undefined,
      reportVisual,
      { groupBy: pdfGroupBy, visibleColumnIds, columnLabels, columnOrder, includeCustomPayrollFields }
    )
    
    // Increment usage meter for PDF generation
    try {
      await incrementUsage(supabase, companyId, 'generate_payroll')
    } catch (error) {
      console.warn('Failed to increment usage meter:', error)
      // Don't fail the request if usage tracking fails
    }
    
    res.setHeader('Content-Type', 'application/pdf')
    const groupSuffix = payrollPdfGroupByFilenameSuffix(pdfGroupBy)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=planilla_${periodo}_q${quincena}${groupSuffix}.pdf`
    )
    return res.send(pdf)

  } catch (error: any) {
    console.error('Error generando PDF desde draft:', error)
    
    if (error.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Unauthorized' })
    }
    
    if (error.message === 'PROFILE_REQUIRED') {
      return res.status(403).json({ error: 'User profile required' })
    }

    if (error.message === 'PLAN_REQUIRED') {
      return res.status(402).json({ error: 'Active plan required to generate PDFs' })
    }

    if (error.message === 'PDF_LIMIT_REACHED') {
      return res.status(429).json({ error: 'PDF limit reached for this month' })
    }

    return res.status(500).json({ 
      error: error.message || 'Error interno del servidor'
    })
  }
}
