import { NextApiRequest, NextApiResponse } from 'next'
import { requireCompanyAccess } from '../../../lib/auth/api-auth-fixed'
import { createAdminClient } from '../../../lib/supabase/server'
import { parseOrdinaryHoursOverrideInput } from '../../../lib/payroll/ordinary-hours-override'
import { parseFixedDaysMode } from '../../../lib/payroll/payroll-attendance-inclusion'
import {
  resolvePayrollDeductionMode,
  validatePayrollDeductionModeForFrequency,
} from '../../../lib/payroll/deduction-mode'
import { userCanAccessFullSettings } from '../../../lib/security/settings-access'
import { normalizeCountryCode } from '../../../lib/country/supported'
import { resolvePayrollDisplayCurrency } from '../../../lib/country/display-money'

/**
 * API para gestionar configuraciones de payroll por empresa
 * 
 * Permite crear, leer y actualizar configuraciones sin necesidad de deploys
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    const { supabase, companyId, role, userProfile } = await requireCompanyAccess(req, res)

    // Para super_admin sin company_id, necesitamos obtener companyId del body o query
    let targetCompanyId = companyId
    if (!targetCompanyId && role === 'super_admin') {
      targetCompanyId = req.body?.company_id || req.query?.company_id as string
      if (!targetCompanyId) {
        return res.status(400).json({
          error: 'Company ID requerido',
          message: 'Para super_admin, debe proporcionar company_id en el body o query'
        })
      }
    }

    if (!targetCompanyId) {
      return res.status(400).json({
        error: 'Perfil de usuario incompleto',
        message: 'No se pudo obtener la informaci?n de la empresa'
      })
    }

    const fullSettings = userCanAccessFullSettings(userProfile)
    const dbClient = role === 'super_admin' ? createAdminClient() : supabase

    switch (req.method) {
      case 'GET':
        if (!fullSettings && role !== 'super_admin') {
          return res.status(403).json({
            error: 'Permisos insuficientes',
            message: 'No tiene acceso a la configuración de payroll',
          })
        }
        return await getPayrollConfig(dbClient, targetCompanyId, res)

      case 'POST':
      case 'PUT':
        // Solo admins pueden modificar configuraciones
        if (!['super_admin', 'company_admin', 'admin'].includes(role)) {
          return res.status(403).json({
            error: 'Permisos insuficientes',
            message: 'Solo administradores pueden modificar configuraciones de payroll'
          })
        }
        // Verificar que company_admin solo puede modificar su propia empresa
        if (['company_admin', 'admin'].includes(role) && companyId && companyId !== targetCompanyId) {
          return res.status(403).json({
            error: 'Permisos insuficientes',
            message: 'Solo puede modificar la configuraci?n de su propia empresa'
          })
        }
        return await upsertPayrollConfig(dbClient, targetCompanyId, req.body, res)

      case 'DELETE':
        // Solo super_admin puede desactivar configuraciones
        if (role !== 'super_admin') {
          return res.status(403).json({
            error: 'Permisos insuficientes',
            message: 'Solo super administradores pueden desactivar configuraciones'
          })
        }
        return await deactivatePayrollConfig(dbClient, targetCompanyId, res)

      default:
        return res.status(405).json({ error: 'Method not allowed' })
    }
  } catch (error: any) {
    console.error('Error in payroll config API:', error)

    if (error.message === 'UNAUTHORIZED') {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    return res.status(500).json({
      error: error.message || 'Internal server error'
    })
  }
}

/**
 * Obtener configuraci?n de payroll de una empresa
 */
async function getPayrollConfig(
  supabase: any,
  companyId: string,
  res: NextApiResponse
) {
  try {
    const { data, error } = await supabase
      .from('company_payroll_configs')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .single()

    if (error) {
      // Si no existe configuraci?n, retornar null (no es error)
      if (error.code === 'PGRST116') {
        return res.status(200).json({
          config: null,
          message: 'No hay configuraci?n personalizada para esta empresa'
        })
      }

      throw error
    }

    // Exponer configuraci?n: columnas nuevas (Capa 2) > metadata legacy
    const metadata = data.metadata || {}
    const pfCol = data.payment_frequency
    const qcCol = data.quincena_config
    const paymentFrequency = pfCol ?? metadata.payment_frequency ?? 'biweekly'
    const mapFreqToFrontend = (v: string) =>
      v === 'mensual' ? 'monthly' : v === 'quincenal' ? 'biweekly' : v === 'semanal' ? 'weekly' : v
    const payrollDeductionMode = resolvePayrollDeductionMode(metadata, paymentFrequency)
    const fs = (qcCol as any)?.first_start ?? 1
    const fe = (qcCol as any)?.first_end ?? 15
    const ss = (qcCol as any)?.second_start ?? 16
    const se = (qcCol as any)?.second_end ?? 30
    const isStandardQuincena = fs === 1 && fe === 15 && ss === 16 && se === 30
    const paymentCutDates = qcCol
      ? {
          biweekly_type: (isStandardQuincena ? 'standard' : 'custom') as 'standard' | 'custom',
          biweekly_first_start: fs,
          biweekly_first_end: fe,
          biweekly_second_start: ss,
          biweekly_second_end: se,
          monthly_type: metadata.payment_cut_dates?.monthly_type || 'standard',
          monthly_start: metadata.payment_cut_dates?.monthly_start ?? 1,
          monthly_end: metadata.payment_cut_dates?.monthly_end ?? 30
        }
      : metadata.payment_cut_dates || {
          biweekly_type: 'standard',
          biweekly_first_start: 1,
          biweekly_first_end: 15,
          biweekly_second_start: 16,
          biweekly_second_end: 30,
          monthly_type: 'standard',
          monthly_start: 1,
          monthly_end: 30
        }
    const { data: companyRow } = await supabase
      .from('companies')
      .select('country_code')
      .eq('id', companyId)
      .maybeSingle()
    const country = normalizeCountryCode(companyRow?.country_code)

    const configResponse = {
      ...data,
      payment_frequency: mapFreqToFrontend(paymentFrequency),
      currency: resolvePayrollDisplayCurrency(country, metadata.currency),
      country_code: country,
      calculation_mode: data.calculation_mode ?? metadata.calculation_mode ?? 'daily',
      incomplete_record_default_hours: data.incomplete_record_default_hours ?? metadata.incomplete_record_default_hours ?? null,
      semanal_proration: metadata.semanal_proration || 'proportional',
      legal_deductions: metadata.legal_deductions || {
        ihss: true,
        rap: country !== 'GTM',
        isr: true,
        infop: false
      },
      payroll_deduction_mode: payrollDeductionMode,
      payment_cut_dates: paymentCutDates,
      earning_impact_rules:
        metadata.earning_impact_rules && typeof metadata.earning_impact_rules === 'object'
          ? metadata.earning_impact_rules
          : {},
      ordinary_hours_override:
        metadata.ordinary_hours_override != null && String(metadata.ordinary_hours_override).trim() !== ''
          ? Number(metadata.ordinary_hours_override)
          : null,
      pay_overtime: metadata.pay_overtime !== false,
      fixed_days_mode: parseFixedDaysMode(metadata.fixed_days_mode)
    }

    return res.status(200).json({
      config: configResponse,
      message: 'Configuraci?n obtenida exitosamente'
    })
  } catch (error: any) {
    console.error('Error getting payroll config:', error)
    return res.status(500).json({
      error: 'Error obteniendo configuraci?n',
      details: error.message
    })
  }
}

/**
 * Crear o actualizar configuraci?n de payroll
 */
async function upsertPayrollConfig(
  supabase: any,
  companyId: string,
  body: any,
  res: NextApiResponse
) {
  try {
    const {
      calculation_type = 'standard',
      custom_fields = {},
      calculation_config = {},
      calculation_script = null,
      metadata = {},
      earning_impact_rules,
      // Extraer par?metros de configuraci?n de payroll
      payment_frequency,
      currency,
      calculation_mode = 'daily',
      incomplete_record_default_hours = null,
      ordinary_hours_override: ordinary_hours_override_body,
      legal_deductions,
      payroll_deduction_mode,
      payment_cut_dates,
      semanal_proration = 'proportional',
      pay_overtime: pay_overtime_body,
      fixed_days_mode: fixed_days_mode_body
    } = body

    // formula_based / custom are accepted as aliases; engine only uses custom_fields.
    const validTypes = ['standard', 'formula_based', 'custom']
    if (!validTypes.includes(calculation_type)) {
      return res.status(400).json({
        error: 'Tipo de cálculo inválido',
        message: `calculation_type debe ser uno de: ${validTypes.join(', ')}`
      })
    }

    // Validar estructura de custom_fields
    if (custom_fields && typeof custom_fields === 'object') {
      for (const [fieldName, fieldDef] of Object.entries(custom_fields)) {
        const def = fieldDef as any
        if (typeof def === 'object') {
          // Validar estructura del campo
          if (!def.label || !def.type || !def.category) {
            return res.status(400).json({
              error: 'Estructura de campo inv?lida',
              message: `El campo "${fieldName}" debe tener: label, type, category`
            })
          }

          const validTypes = ['number', 'string', 'boolean']
          if (!validTypes.includes(def.type)) {
            return res.status(400).json({
              error: 'Tipo de campo inv?lido',
              message: `El tipo del campo "${fieldName}" debe ser uno de: ${validTypes.join(', ')}`
            })
          }

          const validCategories = ['earnings', 'deductions', 'calculation_helper']
          if (!validCategories.includes(def.category)) {
            return res.status(400).json({
              error: 'Categor?a de campo inv?lida',
              message: `La categor?a del campo "${fieldName}" debe ser una de: ${validCategories.join(', ')}`
            })
          }
        }
      }
    }

    const cutDates = payment_cut_dates || {
      biweekly_type: 'standard',
      biweekly_first_start: 1,
      biweekly_first_end: 15,
      biweekly_second_start: 16,
      biweekly_second_end: 30,
      monthly_type: 'standard',
      monthly_start: 1,
      monthly_end: 30
    }
    const mapFreqToDb = (v: string) =>
      v === 'monthly' || v === 'mensual' ? 'mensual' : v === 'weekly' || v === 'semanal' ? 'semanal' : v === 'biweekly' || v === 'quincenal' ? 'quincenal' : (v || 'quincenal')
    const mapFreqToMeta = (v: string) =>
      v === 'monthly' || v === 'mensual' ? 'monthly' : v === 'weekly' || v === 'semanal' ? 'weekly' : v === 'biweekly' || v === 'quincenal' ? 'biweekly' : (v || 'biweekly')
    const quincenaConfig = {
      first_start: cutDates.biweekly_first_start ?? 1,
      first_end: cutDates.biweekly_first_end ?? 15,
      second_start: cutDates.biweekly_second_start ?? 16,
      second_end: cutDates.biweekly_second_end ?? 30
    }

    const { data: existingPayrollRow } = await supabase
      .from('company_payroll_configs')
      .select('metadata')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle()

    const priorMetadata =
      existingPayrollRow?.metadata && typeof existingPayrollRow.metadata === 'object' && !Array.isArray(existingPayrollRow.metadata)
        ? (existingPayrollRow.metadata as Record<string, unknown>)
        : {}
    const mergedMetaFromBody =
      metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...priorMetadata, ...metadata } : { ...priorMetadata }

    const resolvedPaymentFrequency =
      payment_frequency || (mergedMetaFromBody.payment_frequency as string) || 'biweekly'
    const metaPaymentFrequency = mapFreqToMeta(resolvedPaymentFrequency)

    const { data: companyRow } = await supabase
      .from('companies')
      .select('country_code')
      .eq('id', companyId)
      .maybeSingle()
    const country = normalizeCountryCode(companyRow?.country_code)

    const payrollMetadata: Record<string, unknown> = {
      ...mergedMetaFromBody,
      payment_frequency: metaPaymentFrequency,
      country_code: country,
      currency: resolvePayrollDisplayCurrency(country, currency),
      legal_deductions: legal_deductions || {
        ihss: true,
        rap: country !== 'GTM',
        isr: true,
        infop: false
      },
      payment_cut_dates: cutDates,
      semanal_proration: semanal_proration || 'proportional',
      ...(earning_impact_rules != null && typeof earning_impact_rules === 'object'
        ? { earning_impact_rules }
        : {})
    }

    if (Object.prototype.hasOwnProperty.call(body, 'payroll_deduction_mode')) {
      const modeValidation = validatePayrollDeductionModeForFrequency(
        payroll_deduction_mode,
        resolvedPaymentFrequency
      )
      if (!modeValidation.ok) {
        return res.status(400).json({
          error: 'Modo de deducción inválido',
          message: modeValidation.message,
        })
      }
      payrollMetadata.payroll_deduction_mode = modeValidation.mode
    } else {
      payrollMetadata.payroll_deduction_mode = resolvePayrollDeductionMode(
        payrollMetadata,
        resolvedPaymentFrequency
      )
    }

    if (Object.prototype.hasOwnProperty.call(body, 'ordinary_hours_override')) {
      if (ordinary_hours_override_body === null || ordinary_hours_override_body === '') {
        delete payrollMetadata.ordinary_hours_override
      } else {
        const parsed = parseOrdinaryHoursOverrideInput(ordinary_hours_override_body)
        if (parsed !== null) {
          payrollMetadata.ordinary_hours_override = parsed
        }
      }
    }

    if (Object.prototype.hasOwnProperty.call(body, 'pay_overtime')) {
      payrollMetadata.pay_overtime = pay_overtime_body === false ? false : true
    }

    if (Object.prototype.hasOwnProperty.call(body, 'fixed_days_mode')) {
      if (fixed_days_mode_body !== 'calendar' && fixed_days_mode_body !== 'attendance_marks') {
        return res.status(400).json({
          error: 'Modo de días inválido',
          message: 'fixed_days_mode debe ser "attendance_marks" o "calendar"'
        })
      }
      payrollMetadata.fixed_days_mode = fixed_days_mode_body
    }

    // Validar calculation_mode
    const validCalcModes = ['daily', 'hourly', 'admin_floor']
    if (calculation_mode && !validCalcModes.includes(calculation_mode)) {
      return res.status(400).json({
        error: 'Modo de cálculo inválido',
        message: `calculation_mode debe ser uno de: ${validCalcModes.join(', ')}`
      })
    }

    // Upsert: columnas nuevas (Capa 2) + metadata legacy
    const { data, error } = await supabase
      .from('company_payroll_configs')
      .upsert({
        company_id: companyId,
        calculation_type: 'standard',
        custom_fields: custom_fields || {},
        calculation_config: calculation_config || {},
        calculation_script: calculation_script || null,
        metadata: payrollMetadata,
        payment_frequency: mapFreqToDb(resolvedPaymentFrequency),
        quincena_config: quincenaConfig,
        calculation_mode: calculation_mode || 'daily',
        incomplete_record_default_hours: incomplete_record_default_hours ?? null,
        is_active: true,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'company_id',
        ignoreDuplicates: false
      })
      .select()
      .single()

    if (error) {
      throw error
    }

    // Exponer con misma l?gica que getPayrollConfig
    const meta = data.metadata || {}
    const pfCol = data.payment_frequency
    const qcCol = data.quincena_config
    const pfRes = pfCol ?? meta.payment_frequency ?? 'biweekly'
    const mapFreq = (v: string) => (v === 'mensual' ? 'monthly' : v === 'quincenal' ? 'biweekly' : v === 'semanal' ? 'weekly' : v)
    const cutDatesRes = qcCol
      ? {
          biweekly_type: 'custom' as const,
          biweekly_first_start: (qcCol as any).first_start ?? 1,
          biweekly_first_end: (qcCol as any).first_end ?? 15,
          biweekly_second_start: (qcCol as any).second_start ?? 16,
          biweekly_second_end: (qcCol as any).second_end ?? 30,
          monthly_type: meta.payment_cut_dates?.monthly_type || 'standard',
          monthly_start: meta.payment_cut_dates?.monthly_start ?? 1,
          monthly_end: meta.payment_cut_dates?.monthly_end ?? 30
        }
      : meta.payment_cut_dates || {
          biweekly_type: 'standard',
          biweekly_first_start: 1,
          biweekly_first_end: 15,
          biweekly_second_start: 16,
          biweekly_second_end: 30,
          monthly_type: 'standard',
          monthly_start: 1,
          monthly_end: 30
        }
    const configResponse = {
      ...data,
      payment_frequency: mapFreq(pfRes),
      currency: meta.currency || 'HNL',
      calculation_mode: data.calculation_mode ?? meta.calculation_mode ?? 'daily',
      incomplete_record_default_hours: data.incomplete_record_default_hours ?? meta.incomplete_record_default_hours ?? null,
      legal_deductions: meta.legal_deductions || { ihss: true, rap: true, isr: true, infop: false },
      payroll_deduction_mode: resolvePayrollDeductionMode(meta, pfRes),
      payment_cut_dates: cutDatesRes,
      semanal_proration: meta.semanal_proration || 'proportional',
      ordinary_hours_override:
        meta.ordinary_hours_override != null && String(meta.ordinary_hours_override).trim() !== ''
          ? Number(meta.ordinary_hours_override)
          : null,
      pay_overtime: meta.pay_overtime !== false,
      fixed_days_mode: parseFixedDaysMode(meta.fixed_days_mode)
    }

    return res.status(200).json({
      config: configResponse,
      message: 'Configuraci?n guardada exitosamente'
    })
  } catch (error: any) {
    console.error('Error upserting payroll config:', error)
    return res.status(500).json({
      error: 'Error guardando configuraci?n',
      details: error.message
    })
  }
}

/**
 * Desactivar configuraci?n de payroll (soft delete)
 */
async function deactivatePayrollConfig(
  supabase: any,
  companyId: string,
  res: NextApiResponse
) {
  try {
    const { data, error } = await supabase
      .from('company_payroll_configs')
      .update({
        is_active: false,
        updated_at: new Date().toISOString()
      })
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      // Si no existe, no es error
      if (error.code === 'PGRST116') {
        return res.status(200).json({
          message: 'No existe configuraci?n para desactivar'
        })
      }
      throw error
    }

    return res.status(200).json({
      config: data,
      message: 'Configuraci?n desactivada exitosamente'
    })
  } catch (error: any) {
    console.error('Error deactivating payroll config:', error)
    return res.status(500).json({
      error: 'Error desactivando configuraci?n',
      details: error.message
    })
  }
}

