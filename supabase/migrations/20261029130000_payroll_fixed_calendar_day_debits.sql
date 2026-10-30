-- Day debits for fixed-salary payroll in calendar mode (fixed_days_mode = 'calendar').
-- Calendar mode pays the full period minus these debits instead of counting days with marks.
-- Same work-day and contract rules as payroll_paid_leave_work_day_credits, so both stay consistent.

CREATE OR REPLACE FUNCTION public.payroll_fixed_calendar_day_debits(
  p_company_id UUID,
  p_from DATE,
  p_to DATE,
  p_employee_ids UUID[] DEFAULT NULL
)
RETURNS TABLE(
  employee_id UUID,
  unpaid_leave_days NUMERIC,
  unjustified_absence_days NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  WITH employees_scope AS (
    SELECT
      e.id,
      e.company_id,
      e.work_schedule_id,
      GREATEST(p_from, COALESCE(e.hire_date, p_from)) AS from_d,
      LEAST(p_to, COALESCE(e.termination_date, p_to)) AS to_d
    FROM public.employees e
    WHERE e.company_id = p_company_id
      AND e.status = 'active'
      AND (p_employee_ids IS NULL OR e.id = ANY(p_employee_ids))
  ),
  work_days AS (
    SELECT es.id AS employee_id, gs.d::date AS d
    FROM employees_scope es
    CROSS JOIN LATERAL generate_series(es.from_d, es.to_d, '1 day'::interval) AS gs(d)
    WHERE es.from_d <= es.to_d
      AND public.is_work_day_for_employee(es.company_id, es.id, gs.d::date, es.work_schedule_id)
  ),
  missing_days AS (
    SELECT wd.employee_id, wd.d
    FROM work_days wd
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.attendance_records ar
      WHERE ar.employee_id = wd.employee_id
        AND ar.date = wd.d
        AND ar.check_in IS NOT NULL
    )
  ),
  classified AS (
    SELECT
      md.employee_id,
      md.d,
      bool_or(COALESCE(lt.is_paid, true) = false) AS has_unpaid,
      bool_or(lr.id IS NOT NULL) AS has_leave
    FROM missing_days md
    LEFT JOIN public.leave_requests lr
      ON lr.employee_id = md.employee_id
      AND lr.status = 'approved'
      AND md.d BETWEEN lr.start_date AND lr.end_date
    LEFT JOIN public.leave_types lt ON lt.id = lr.leave_type_id
    GROUP BY md.employee_id, md.d
  )
  SELECT
    c.employee_id,
    COUNT(*) FILTER (WHERE c.has_unpaid)::numeric AS unpaid_leave_days,
    COUNT(*) FILTER (WHERE NOT c.has_leave)::numeric AS unjustified_absence_days
  FROM classified c
  GROUP BY c.employee_id;
END;
$$;

COMMENT ON FUNCTION public.payroll_fixed_calendar_day_debits(UUID, DATE, DATE, UUID[]) IS
  'Per employee, work days in contract without check-in: covered by approved unpaid leave, or not covered by any approved leave (unjustified).';

GRANT EXECUTE ON FUNCTION public.payroll_fixed_calendar_day_debits(UUID, DATE, DATE, UUID[]) TO authenticated;
