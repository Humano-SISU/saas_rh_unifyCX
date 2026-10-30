/**
 * calculate_attendance_hours_batch: ordinary cap by jornada (8/7/6) and minimum overtime,
 * both opt-in through company_payroll_configs.metadata.
 *
 * Runs the real PL/pgSQL on a throwaway local Postgres (initdb + pg_ctl in a temp dir) with
 * stub tables, loading the previous function definition first and then the new migration,
 * so "flag off" is checked against the old output row by row.
 *
 * Needs initdb, pg_ctl and psql in PATH; without them the cases are skipped.
 * Run: npx tsx --test tests/integration/ahc-ordinary-cap-by-shift.test.ts
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGRATIONS = join(__dirname, '../../supabase/migrations')
const NEW_MIGRATION = '20261029120000_ahc_ordinary_cap_by_shift.sql'

const hasPostgres = ['initdb', 'pg_ctl', 'psql'].every(
  (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0
)
const SKIP = hasPostgres ? false : 'sin initdb / pg_ctl / psql en PATH'

function migration(file: string): string {
  return readFileSync(join(MIGRATIONS, file), 'utf8')
}

/** Cut one `CREATE OR REPLACE FUNCTION name(...)` statement out of a migration file. */
function extractFunction(file: string, name: string): string {
  const text = migration(file)
  const start = text.search(new RegExp(`CREATE OR REPLACE FUNCTION (public\\.)?${name}\\(`))
  assert.ok(start >= 0, `${name} not found in ${file}`)
  const bodyOpen = text.indexOf('$$', start)
  const bodyClose = text.indexOf('$$', bodyOpen + 2)
  const end = text.indexOf(';', bodyClose)
  return text.slice(start, end + 1)
}

const STUB_SCHEMA = `
CREATE TABLE companies (id UUID PRIMARY KEY, country_code TEXT, timezone TEXT, settings JSONB);
CREATE TABLE labor_laws (
  country_code TEXT, year INTEGER, is_active BOOLEAN, legal_daily_hours NUMERIC,
  mandatory_break_minutes INTEGER, holidays JSONB
);
CREATE TABLE company_payroll_configs (company_id UUID, is_active BOOLEAN, metadata JSONB);
CREATE TABLE company_metadata (company_id UUID, custom_holidays JSONB);
CREATE TABLE work_schedules (
  id UUID PRIMARY KEY, shift_type TEXT NOT NULL DEFAULT 'normal', shift_config JSONB,
  break_duration INTEGER,
  monday_start TIME, monday_end TIME, tuesday_start TIME, tuesday_end TIME,
  wednesday_start TIME, wednesday_end TIME, thursday_start TIME, thursday_end TIME,
  friday_start TIME, friday_end TIME, saturday_start TIME, saturday_end TIME,
  sunday_start TIME, sunday_end TIME
);
CREATE TABLE employees (id UUID PRIMARY KEY, company_id UUID, work_schedule_id UUID);
CREATE TABLE attendance_records (
  id UUID PRIMARY KEY, employee_id UUID, date DATE, check_in TIMESTAMPTZ, check_out TIMESTAMPTZ,
  lunch_start TIMESTAMPTZ, lunch_end TIMESTAMPTZ, flags JSONB
);
CREATE TABLE attendance_hours_calculation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendance_record_id UUID CONSTRAINT attendance_hours_calculation_attendance_record_id_key UNIQUE,
  employee_id UUID, work_schedule_id UUID,
  total_hours DECIMAL(5,2), normal_hours DECIMAL(5,2),
  overtime_diurno_hours DECIMAL(5,2), overtime_nocturno_hours DECIMAL(5,2),
  overtime_feriado_hours DECIMAL(5,2), overtime_evening_25_hours DECIMAL(5,2),
  overtime_night_50_hours DECIMAL(5,2), overtime_late_75_hours DECIMAL(5,2),
  overtime_morning_25_hours DECIMAL(5,2), overtime_holiday_100_hours DECIMAL(5,2),
  lunch_minutes INTEGER, time_segments JSONB, calculation_method TEXT,
  calculated_at TIMESTAMPTZ, updated_at TIMESTAMPTZ
);
INSERT INTO labor_laws VALUES ('HND', 2026, TRUE, 8, 60, '[]');
`

// Wednesday 2026-09-02; Tegucigalpa is UTC-6 all year.
const SEED = `
INSERT INTO companies VALUES
  ('c0000000-0000-0000-0000-000000000001', 'HND', 'America/Tegucigalpa', '{}'),
  ('c0000000-0000-0000-0000-000000000002', 'HND', 'America/Tegucigalpa', '{}');
INSERT INTO company_payroll_configs VALUES
  ('c0000000-0000-0000-0000-000000000001', TRUE, '{}'),
  ('c0000000-0000-0000-0000-000000000002', TRUE, '{"ordinary_cap_by_shift": true, "ordinary_hours_override": "9"}');

INSERT INTO work_schedules (id, wednesday_start, wednesday_end, break_duration) VALUES
  ('5c000000-0000-0000-0000-00000000000d', '08:00', '17:00', 60),
  ('5c000000-0000-0000-0000-00000000000a', '14:00', '22:00', 60),
  ('5c000000-0000-0000-0000-00000000000b', '22:00', '05:00', 60);

INSERT INTO employees VALUES
  ('e0000000-0000-0000-0000-00000000000d', 'c0000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-00000000000d'),
  ('e0000000-0000-0000-0000-00000000000a', 'c0000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-00000000000a'),
  ('e0000000-0000-0000-0000-00000000000b', 'c0000000-0000-0000-0000-000000000001', '5c000000-0000-0000-0000-00000000000b'),
  ('e0000000-0000-0000-0000-000000000000', 'c0000000-0000-0000-0000-000000000001', NULL),
  ('e0000000-0000-0000-0000-0000000000a2', 'c0000000-0000-0000-0000-000000000002', '5c000000-0000-0000-0000-00000000000a');

INSERT INTO attendance_records VALUES
  -- day shift 08–17, stays until 19:00
  ('a0000000-0000-0000-0000-000000000001', 'e0000000-0000-0000-0000-00000000000d', '2026-09-02',
   '2026-09-02 08:00-06', '2026-09-02 19:00-06', '2026-09-02 12:00-06', '2026-09-02 13:00-06', NULL),
  -- mixed shift 14–22, leaves 00:30
  ('a0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-00000000000a', '2026-09-02',
   '2026-09-02 14:00-06', '2026-09-03 00:30-06', '2026-09-02 18:00-06', '2026-09-02 19:00-06', NULL),
  -- night shift 22–05, stays until 07:00
  ('a0000000-0000-0000-0000-000000000003', 'e0000000-0000-0000-0000-00000000000b', '2026-09-02',
   '2026-09-02 22:00-06', '2026-09-03 07:00-06', '2026-09-03 02:00-06', '2026-09-03 03:00-06', NULL),
  -- no schedule: jornada from the marks (18:00–03:00 → nocturno)
  ('a0000000-0000-0000-0000-000000000004', 'e0000000-0000-0000-0000-000000000000', '2026-09-02',
   '2026-09-02 18:00-06', '2026-09-03 03:00-06', '2026-09-02 22:00-06', '2026-09-02 23:00-06', NULL),
  -- day shift, leaves 17:10 (10 min overtime)
  ('a0000000-0000-0000-0000-000000000005', 'e0000000-0000-0000-0000-00000000000d', '2026-09-09',
   '2026-09-09 08:00-06', '2026-09-09 17:10-06', '2026-09-09 12:00-06', '2026-09-09 13:00-06', NULL),
  -- day shift, leaves 17:20 (20 min overtime)
  ('a0000000-0000-0000-0000-000000000006', 'e0000000-0000-0000-0000-00000000000d', '2026-09-16',
   '2026-09-16 08:00-06', '2026-09-16 17:20-06', '2026-09-16 12:00-06', '2026-09-16 13:00-06', NULL),
  -- company with override 9 and the flag on: override wins
  ('a0000000-0000-0000-0000-000000000007', 'e0000000-0000-0000-0000-0000000000a2', '2026-09-02',
   '2026-09-02 14:00-06', '2026-09-03 00:30-06', '2026-09-02 18:00-06', '2026-09-02 19:00-06', NULL);
`

const ALL_IDS = `ARRAY(SELECT id FROM attendance_records ORDER BY id)`

type Row = {
  id: string
  normal: number
  overtime: number
  bands: number
}

let dir = ''
let socketDir = ''

function psql(sql: string): string {
  return execFileSync(
    'psql',
    ['-h', socketDir, '-p', '54329', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-qAt', '-F', '|'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  )
}

function setMetadata(companyNo: 1 | 2, metadata: Record<string, unknown>): void {
  psql(
    `UPDATE company_payroll_configs SET metadata = '${JSON.stringify(metadata)}'::jsonb
     WHERE company_id = 'c0000000-0000-0000-0000-00000000000${companyNo}';`
  )
}

function runBatch(): Map<string, Row> {
  const out = psql(`
    SELECT attendance_record_id, normal_hours,
           overtime_diurno_hours + overtime_nocturno_hours + overtime_feriado_hours,
           overtime_evening_25_hours + overtime_night_50_hours + overtime_late_75_hours
             + overtime_morning_25_hours + overtime_holiday_100_hours
    FROM calculate_attendance_hours_batch(${ALL_IDS});
  `)
  const rows = new Map<string, Row>()
  for (const line of out.trim().split('\n')) {
    const [id, normal, overtime, bands] = line.split('|')
    rows.set(id.slice(-1), { id, normal: Number(normal), overtime: Number(overtime), bands: Number(bands) })
  }
  return rows
}

function snapshotTable(): string {
  return psql(`
    SELECT attendance_record_id, total_hours, normal_hours, overtime_diurno_hours,
           overtime_nocturno_hours, overtime_feriado_hours, overtime_evening_25_hours,
           overtime_night_50_hours, overtime_late_75_hours, overtime_morning_25_hours,
           overtime_holiday_100_hours, lunch_minutes, time_segments
    FROM attendance_hours_calculation ORDER BY attendance_record_id;
  `)
}

describe('calculate_attendance_hours_batch: ordinary cap by shift + overtime minimum', { skip: SKIP }, () => {
  let previousOutput = ''

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'ahc-cap-'))
    socketDir = dir
    execFileSync('initdb', ['-D', join(dir, 'data'), '-U', process.env.USER || 'postgres', '-A', 'trust'], {
      stdio: 'ignore',
    })
    execFileSync(
      'pg_ctl',
      ['-D', join(dir, 'data'), '-l', join(dir, 'log'), '-o', `-k ${socketDir} -p 54329 -c listen_addresses=''`, '-w', 'start'],
      { stdio: 'ignore' }
    )

    psql(STUB_SCHEMA)
    psql(extractFunction('20260211000007_create_holiday_functions.sql', 'determine_shift_type'))
    psql(extractFunction('20260412120000_multipay_fundamentals.sql', 'is_holiday_date'))
    for (const fn of ['resolve_shift_day_config', 'time_span_minutes', 'work_schedule_implicit_break_minutes', 'date_to_day_key']) {
      psql(extractFunction('20260522120000_work_schedules_shift_config.sql', fn))
    }
    psql(extractFunction('20260715103000_ahc_overtime_clock_bands.sql', 'classify_overtime_minute_band'))
    psql(extractFunction('20260715103000_ahc_overtime_clock_bands.sql', 'allocate_overtime_by_clock_bands'))
    psql(SEED)

    // Previous definition → reference output with no flags anywhere.
    setMetadata(2, {})
    psql(extractFunction('20260715103000_ahc_overtime_clock_bands.sql', 'calculate_attendance_hours_batch'))
    psql(`SELECT count(*) FROM calculate_attendance_hours_batch(${ALL_IDS});`)
    previousOutput = snapshotTable()

    psql(migration(NEW_MIGRATION))
  })

  after(() => {
    if (!dir) return
    spawnSync('pg_ctl', ['-D', join(dir, 'data'), '-m', 'immediate', 'stop'], { stdio: 'ignore' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('flags off: same rows as the previous definition', () => {
    setMetadata(1, {})
    setMetadata(2, {})
    psql('DELETE FROM attendance_hours_calculation;')
    runBatch()
    assert.equal(previousOutput.trim().split('\n').length, 7)
    assert.equal(snapshotTable(), previousOutput)
  })

  it('flag on: mixed 14–22 leaving 00:30 → 7 ordinary + 2.5 overtime', () => {
    setMetadata(1, { ordinary_cap_by_shift: true })
    const r = runBatch().get('2')!
    assert.equal(r.normal, 7)
    assert.equal(r.overtime, 2.5)
    assert.equal(r.bands, 2.5)
  })

  it('flag on: night 22–05 staying until 07:00 → 6 ordinary + 2 overtime (not mixed)', () => {
    setMetadata(1, { ordinary_cap_by_shift: true })
    const r = runBatch().get('3')!
    assert.equal(r.normal, 6)
    assert.equal(r.overtime, 2)
  })

  it('flag on: day shift unchanged (8 ordinary + 2 overtime)', () => {
    setMetadata(1, { ordinary_cap_by_shift: true })
    const r = runBatch().get('1')!
    assert.equal(r.normal, 8)
    assert.equal(r.overtime, 2)
  })

  it('flag on without a schedule: jornada from the marks (18:00–03:00 → nocturno)', () => {
    setMetadata(1, { ordinary_cap_by_shift: true })
    const r = runBatch().get('4')!
    assert.equal(r.normal, 6)
    assert.equal(r.overtime, 2)
  })

  it('flag on with ordinary_hours_override: the override still wins', () => {
    setMetadata(2, { ordinary_cap_by_shift: true, ordinary_hours_override: '9' })
    const r = runBatch().get('7')!
    assert.equal(r.normal, 9)
    assert.equal(r.overtime, 0.5)
  })

  it('flag stored as the string "true" also turns it on', () => {
    setMetadata(1, { ordinary_cap_by_shift: 'true' })
    assert.equal(runBatch().get('2')!.normal, 7)
  })

  it('overtime_min_minutes 15: 10 min is not overtime, 20 min counts in full', () => {
    setMetadata(1, { overtime_min_minutes: 15 })
    const rows = runBatch()
    assert.deepEqual(
      { normal: rows.get('5')!.normal, overtime: rows.get('5')!.overtime, bands: rows.get('5')!.bands },
      { normal: 8, overtime: 0, bands: 0 }
    )
    assert.equal(rows.get('6')!.overtime, 0.33)
    // Mixed shift without the cap flag keeps today's 8 h cap.
    assert.equal(rows.get('2')!.normal, 8)
  })
})
