-- AHC: per-company opt-in ordinary-hours cap by shift type (diurna 8 / mixta 7 / nocturna 6)
-- and minimum overtime threshold. Both read company_payroll_configs.metadata:
--   ordinary_cap_by_shift  (boolean, default false) — cap by jornada instead of legal_daily_hours
--   overtime_min_minutes   (integer, default 0)     — daily overtime below this is not counted
-- With both unset the function behaves exactly as 20260715103000_ahc_overtime_clock_bands.sql.
-- CREATE OR REPLACE only (same signature): no DROP needed.

CREATE OR REPLACE FUNCTION public.calculate_attendance_hours_batch(
  p_record_ids UUID[],
  p_law_year INTEGER DEFAULT NULL
)
RETURNS TABLE (
  attendance_record_id UUID,
  calculation_id UUID,
  total_hours DECIMAL(5,2),
  normal_hours DECIMAL(5,2),
  overtime_diurno_hours DECIMAL(5,2),
  overtime_nocturno_hours DECIMAL(5,2),
  overtime_feriado_hours DECIMAL(5,2),
  overtime_evening_25_hours DECIMAL(5,2),
  overtime_night_50_hours DECIMAL(5,2),
  overtime_late_75_hours DECIMAL(5,2),
  overtime_morning_25_hours DECIMAL(5,2),
  overtime_holiday_100_hours DECIMAL(5,2)
) AS $$
DECLARE
  v_law public.labor_laws%ROWTYPE;
  v_record RECORD;
  v_break_minutes INTEGER;
  v_lunch_minutes NUMERIC;
  v_regular_cap_hours DECIMAL(5,2);
  v_total_minutes NUMERIC;
  v_normal_hours DECIMAL(5,2);
  v_overtime_hours DECIMAL(5,2);
  v_is_holiday BOOLEAN;
  v_calc_id UUID;
  v_time_segments JSONB;
  v_country TEXT;
  v_company_tz TEXT;
  v_tz TEXT;
  v_ordinary_override NUMERIC;
  v_ws RECORD;
  v_day_key TEXT;
  v_bands RECORD;
  v_cap_by_shift BOOLEAN;
  v_overtime_min_minutes INTEGER;
  v_jornada TEXT;
  v_sched_start TIME;
  v_sched_end TIME;
  v_sched_day JSONB;
BEGIN
  IF p_record_ids IS NULL OR array_length(p_record_ids, 1) IS NULL THEN
    RETURN;
  END IF;

  FOR v_record IN
    SELECT ar.id, ar.employee_id, ar.date, ar.check_in, ar.check_out, ar.lunch_start, ar.lunch_end, ar.flags,
           e.work_schedule_id, e.company_id
    FROM public.attendance_records ar
    JOIN public.employees e ON e.id = ar.employee_id
    WHERE ar.id = ANY(p_record_ids)
      AND ar.check_in IS NOT NULL
      AND ar.check_out IS NOT NULL
  LOOP
    SELECT
      COALESCE(c.country_code, 'HND'),
      NULLIF(TRIM(COALESCE(c.timezone, c.settings->>'timezone', '')), '')
    INTO v_country, v_company_tz
    FROM public.companies c
    WHERE c.id = v_record.company_id;

    IF v_country IS NULL THEN
      v_country := 'HND';
    END IF;

    v_tz := COALESCE(
      v_company_tz,
      CASE COALESCE(v_country, 'HND')
        WHEN 'SLV' THEN 'America/El_Salvador'
        WHEN 'GTM' THEN 'America/Guatemala'
        ELSE 'America/Tegucigalpa'
      END
    );

    SELECT * INTO v_law
    FROM public.labor_laws ll
    WHERE ll.country_code = v_country
      AND ll.year = COALESCE(p_law_year, EXTRACT(YEAR FROM v_record.date)::INTEGER)
      AND ll.is_active = TRUE
    ORDER BY ll.year DESC
    LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'No labor_laws for country % year %', v_country,
        COALESCE(p_law_year, EXTRACT(YEAR FROM v_record.date)::INTEGER);
    END IF;

    v_ordinary_override := NULL;
    v_cap_by_shift := NULL;
    v_overtime_min_minutes := NULL;
    SELECT
      CASE
        WHEN NULLIF(TRIM(cpc.metadata->>'ordinary_hours_override'), '') IS NULL THEN NULL
        WHEN TRIM(cpc.metadata->>'ordinary_hours_override') !~ '^[0-9]{1,2}([.][0-9]{1,4})?$' THEN NULL
        ELSE TRIM(cpc.metadata->>'ordinary_hours_override')::NUMERIC
      END,
      LOWER(TRIM(COALESCE(cpc.metadata->>'ordinary_cap_by_shift', ''))) = 'true',
      CASE
        WHEN TRIM(COALESCE(cpc.metadata->>'overtime_min_minutes', '')) ~ '^[0-9]{1,3}$'
          THEN TRIM(cpc.metadata->>'overtime_min_minutes')::INTEGER
        ELSE NULL
      END
    INTO v_ordinary_override, v_cap_by_shift, v_overtime_min_minutes
    FROM public.company_payroll_configs cpc
    WHERE cpc.company_id = v_record.company_id
      AND cpc.is_active = TRUE
    LIMIT 1;

    IF v_ordinary_override IS NOT NULL AND (v_ordinary_override < 1 OR v_ordinary_override > 16) THEN
      v_ordinary_override := NULL;
    END IF;

    v_cap_by_shift := COALESCE(v_cap_by_shift, FALSE);
    v_overtime_min_minutes := LEAST(COALESCE(v_overtime_min_minutes, 0), 480);

    v_ws := NULL;
    IF v_record.work_schedule_id IS NOT NULL THEN
      SELECT * INTO v_ws FROM public.work_schedules WHERE id = v_record.work_schedule_id;
    END IF;

    v_day_key := public.date_to_day_key(v_record.date);

    v_regular_cap_hours := COALESCE(v_ordinary_override, v_law.legal_daily_hours, 8.00);

    IF v_ordinary_override IS NULL AND v_cap_by_shift THEN
      -- work_schedules.shift_type is 'normal'/'flex' today; honour a jornada value if one is ever
      -- stored there, otherwise classify the scheduled hours for the day (not the marks, so
      -- staying late on a night shift does not turn it into a mixed one), then the marks.
      v_jornada := NULL;
      v_sched_start := NULL;
      v_sched_end := NULL;
      IF v_record.work_schedule_id IS NOT NULL THEN
        IF v_ws.shift_type IN ('diurno', 'mixto', 'nocturno') THEN
          v_jornada := v_ws.shift_type;
        END IF;
        v_sched_day := public.resolve_shift_day_config(
          COALESCE(v_ws.shift_config, '{}'::jsonb),
          v_day_key,
          CASE v_day_key
            WHEN 'monday' THEN v_ws.monday_start
            WHEN 'tuesday' THEN v_ws.tuesday_start
            WHEN 'wednesday' THEN v_ws.wednesday_start
            WHEN 'thursday' THEN v_ws.thursday_start
            WHEN 'friday' THEN v_ws.friday_start
            WHEN 'saturday' THEN v_ws.saturday_start
            WHEN 'sunday' THEN v_ws.sunday_start
            ELSE NULL
          END,
          CASE v_day_key
            WHEN 'monday' THEN v_ws.monday_end
            WHEN 'tuesday' THEN v_ws.tuesday_end
            WHEN 'wednesday' THEN v_ws.wednesday_end
            WHEN 'thursday' THEN v_ws.thursday_end
            WHEN 'friday' THEN v_ws.friday_end
            WHEN 'saturday' THEN v_ws.saturday_end
            WHEN 'sunday' THEN v_ws.sunday_end
            ELSE NULL
          END,
          NULL
        );
        IF v_sched_day->>'type' = 'continuous' THEN
          v_sched_start := NULLIF(v_sched_day->>'start', '')::TIME;
          v_sched_end := NULLIF(v_sched_day->>'end', '')::TIME;
        ELSIF v_sched_day->>'type' = 'split' THEN
          v_sched_start := NULLIF(v_sched_day->>'m_start', '')::TIME;
          v_sched_end := NULLIF(v_sched_day->>'a_end', '')::TIME;
        END IF;
      END IF;

      IF v_jornada IS NULL AND v_sched_start IS NOT NULL AND v_sched_end IS NOT NULL THEN
        v_jornada := public.determine_shift_type(
          (v_record.date + v_sched_start) AT TIME ZONE v_tz,
          (v_record.date + v_sched_end) AT TIME ZONE v_tz,
          v_tz
        );
      END IF;

      IF v_jornada IS NULL THEN
        v_jornada := public.determine_shift_type(v_record.check_in, v_record.check_out, v_tz);
      END IF;

      v_regular_cap_hours := CASE v_jornada
        WHEN 'nocturno' THEN 6
        WHEN 'mixto' THEN 7
        ELSE 8
      END;
    END IF;

    IF v_record.lunch_start IS NOT NULL AND v_record.lunch_end IS NOT NULL THEN
      v_lunch_minutes := EXTRACT(EPOCH FROM (v_record.lunch_end - v_record.lunch_start)) / 60.0;
      v_break_minutes := GREATEST(0, v_lunch_minutes)::INTEGER;
    ELSIF v_ws IS NOT NULL THEN
      v_break_minutes := public.work_schedule_implicit_break_minutes(
        COALESCE(v_ws.shift_config, '{}'::jsonb),
        v_day_key,
        CASE v_day_key
          WHEN 'monday' THEN v_ws.monday_start
          WHEN 'tuesday' THEN v_ws.tuesday_start
          WHEN 'wednesday' THEN v_ws.wednesday_start
          WHEN 'thursday' THEN v_ws.thursday_start
          WHEN 'friday' THEN v_ws.friday_start
          WHEN 'saturday' THEN v_ws.saturday_start
          WHEN 'sunday' THEN v_ws.sunday_start
          ELSE NULL
        END,
        CASE v_day_key
          WHEN 'monday' THEN v_ws.monday_end
          WHEN 'tuesday' THEN v_ws.tuesday_end
          WHEN 'wednesday' THEN v_ws.wednesday_end
          WHEN 'thursday' THEN v_ws.thursday_end
          WHEN 'friday' THEN v_ws.friday_end
          WHEN 'saturday' THEN v_ws.saturday_end
          WHEN 'sunday' THEN v_ws.sunday_end
          ELSE NULL
        END,
        COALESCE(v_ws.break_duration, v_law.mandatory_break_minutes, 60)
      );
    ELSE
      v_break_minutes := COALESCE(v_law.mandatory_break_minutes, 60);
    END IF;

    v_total_minutes := EXTRACT(EPOCH FROM (v_record.check_out - v_record.check_in)) / 60.0;
    v_total_minutes := v_total_minutes - v_break_minutes;

    IF v_total_minutes / 60.0 <= v_regular_cap_hours THEN
      v_normal_hours := v_total_minutes / 60.0;
      v_overtime_hours := 0;
    ELSE
      v_normal_hours := v_regular_cap_hours;
      v_overtime_hours := (v_total_minutes / 60.0) - v_regular_cap_hours;
    END IF;

    v_is_holiday := public.is_holiday_date(v_record.date, v_record.company_id);

    SELECT * INTO v_bands
    FROM public.allocate_overtime_by_clock_bands(
      v_record.check_in,
      v_record.check_out,
      v_record.lunch_start,
      v_record.lunch_end,
      v_regular_cap_hours,
      v_is_holiday,
      v_tz
    );

    -- Si no hubo HE por timeline (edge), forzar total OT en evening_25 / holiday
    IF v_overtime_hours > 0
       AND COALESCE(v_bands.evening_25, 0) + COALESCE(v_bands.night_50, 0)
         + COALESCE(v_bands.late_75, 0) + COALESCE(v_bands.morning_25, 0)
         + COALESCE(v_bands.holiday_100, 0) = 0 THEN
      IF v_is_holiday THEN
        v_bands.holiday_100 := ROUND(v_overtime_hours::NUMERIC, 2);
      ELSE
        v_bands.evening_25 := ROUND(v_overtime_hours::NUMERIC, 2);
      END IF;
    END IF;

    -- A few minutes after clock-out are not overtime when the company sets a minimum;
    -- once the threshold is reached the whole overtime counts.
    IF v_overtime_min_minutes > 0 AND v_overtime_hours * 60 < v_overtime_min_minutes THEN
      v_overtime_hours := 0;
      v_bands.evening_25 := 0;
      v_bands.night_50 := 0;
      v_bands.late_75 := 0;
      v_bands.morning_25 := 0;
      v_bands.holiday_100 := 0;
    END IF;

    v_time_segments := '[]'::jsonb;
    IF v_record.work_schedule_id IS NULL THEN
      v_time_segments := jsonb_build_object(
        'horario_no_detectado', true,
        'razon', 'sin_horario_asignado'
      );
    ELSIF v_record.flags IS NOT NULL AND (v_record.flags->>'horario_no_detectado') = 'true' THEN
      v_time_segments := jsonb_build_object(
        'horario_no_detectado', true,
        'razon', COALESCE(v_record.flags->>'razon', 'distancia_horario_excedida'),
        'gap_minutos', (v_record.flags->>'gap_minutos')::INTEGER
      );
    END IF;

    INSERT INTO public.attendance_hours_calculation (
      attendance_record_id,
      employee_id,
      work_schedule_id,
      total_hours,
      normal_hours,
      overtime_diurno_hours,
      overtime_nocturno_hours,
      overtime_feriado_hours,
      overtime_evening_25_hours,
      overtime_night_50_hours,
      overtime_late_75_hours,
      overtime_morning_25_hours,
      overtime_holiday_100_hours,
      lunch_minutes,
      time_segments,
      calculation_method
    ) VALUES (
      v_record.id,
      v_record.employee_id,
      v_record.work_schedule_id,
      GREATEST(0, v_total_minutes / 60.0),
      v_normal_hours,
      -- legacy mirrors (approx; late_75 solo en columnas nuevas)
      ROUND((COALESCE(v_bands.evening_25, 0) + COALESCE(v_bands.morning_25, 0))::NUMERIC, 2),
      ROUND((COALESCE(v_bands.night_50, 0) + COALESCE(v_bands.late_75, 0))::NUMERIC, 2),
      ROUND(COALESCE(v_bands.holiday_100, 0)::NUMERIC, 2),
      ROUND(COALESCE(v_bands.evening_25, 0)::NUMERIC, 2),
      ROUND(COALESCE(v_bands.night_50, 0)::NUMERIC, 2),
      ROUND(COALESCE(v_bands.late_75, 0)::NUMERIC, 2),
      ROUND(COALESCE(v_bands.morning_25, 0)::NUMERIC, 2),
      ROUND(COALESCE(v_bands.holiday_100, 0)::NUMERIC, 2),
      v_break_minutes,
      v_time_segments,
      'automatic'
    )
    ON CONFLICT ON CONSTRAINT attendance_hours_calculation_attendance_record_id_key DO UPDATE SET
      total_hours = EXCLUDED.total_hours,
      normal_hours = EXCLUDED.normal_hours,
      overtime_diurno_hours = EXCLUDED.overtime_diurno_hours,
      overtime_nocturno_hours = EXCLUDED.overtime_nocturno_hours,
      overtime_feriado_hours = EXCLUDED.overtime_feriado_hours,
      overtime_evening_25_hours = EXCLUDED.overtime_evening_25_hours,
      overtime_night_50_hours = EXCLUDED.overtime_night_50_hours,
      overtime_late_75_hours = EXCLUDED.overtime_late_75_hours,
      overtime_morning_25_hours = EXCLUDED.overtime_morning_25_hours,
      overtime_holiday_100_hours = EXCLUDED.overtime_holiday_100_hours,
      lunch_minutes = EXCLUDED.lunch_minutes,
      time_segments = EXCLUDED.time_segments,
      calculated_at = NOW(),
      updated_at = NOW()
    RETURNING id INTO v_calc_id;

    attendance_record_id := v_record.id;
    calculation_id := v_calc_id;
    total_hours := GREATEST(0, v_total_minutes / 60.0);
    normal_hours := v_normal_hours;
    overtime_evening_25_hours := ROUND(COALESCE(v_bands.evening_25, 0)::NUMERIC, 2);
    overtime_night_50_hours := ROUND(COALESCE(v_bands.night_50, 0)::NUMERIC, 2);
    overtime_late_75_hours := ROUND(COALESCE(v_bands.late_75, 0)::NUMERIC, 2);
    overtime_morning_25_hours := ROUND(COALESCE(v_bands.morning_25, 0)::NUMERIC, 2);
    overtime_holiday_100_hours := ROUND(COALESCE(v_bands.holiday_100, 0)::NUMERIC, 2);
    overtime_diurno_hours := ROUND((overtime_evening_25_hours + overtime_morning_25_hours)::NUMERIC, 2);
    overtime_nocturno_hours := ROUND((overtime_night_50_hours + overtime_late_75_hours)::NUMERIC, 2);
    overtime_feriado_hours := overtime_holiday_100_hours;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.calculate_attendance_hours_batch(UUID[], INTEGER) IS
  'Batch hours: HE clasificada por franjas de reloj 25/50/75/100% (+ columnas legacy). Opt-in metadata: ordinary_cap_by_shift (tope 8/7/6 por jornada), overtime_min_minutes (umbral minimo de HE).';
