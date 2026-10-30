/**
 * Pay for holidays / rest days worked by fixed-salary employees (days_extra).
 * Opt-in per company: company_payroll_configs.metadata.pay_days_extra === true.
 * The day itself is already inside the period pay, so the extra factor 1.0 makes the total double.
 */

export const DAYS_EXTRA_PAY_FACTOR = 1

export function resolvePayDaysExtra(payrollMetadata: Record<string, unknown> | null | undefined): boolean {
  return payrollMetadata?.pay_days_extra === true
}

export function computeDaysExtraPay(daysExtra: number, baseSalary: number): number {
  const days = Math.max(0, Number(daysExtra) || 0)
  const salary = Math.max(0, Number(baseSalary) || 0)
  return Math.round(days * (salary / 30) * DAYS_EXTRA_PAY_FACTOR * 100) / 100
}

/** days_extra_pay stored on a run line; 0 when absent or invalid. */
export function readDaysExtraPay(metadata: Record<string, unknown> | null | undefined): number {
  const n = Number(metadata?.days_extra_pay)
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0
}
