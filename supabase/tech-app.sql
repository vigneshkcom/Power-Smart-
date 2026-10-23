-- Electrician phone app (/tech): alarms installed, invoice and card payment.
-- Run once in Supabase → SQL Editor (after jobs.sql).

-- Electricians sign in to the app with their code (e.g. 1011), so codes must be unique.
create unique index if not exists electricians_code_key on public.electricians (code) where code is not null;

alter table public.jobs
  add column if not exists alarms_installed    int,    -- from the invoice alarm line
  add column if not exists alarm_type          text,   -- battery | hardwired (null when mixed)
  add column if not exists tech_notes          text,
  add column if not exists invoice_items       jsonb,  -- [{ code, label, qty, unit_cents, amount_cents }]
  add column if not exists invoice_total_cents int,
  add column if not exists approved_at         timestamptz,   -- customer approved the invoice on site
  add column if not exists amount_due_cents    int,
  add column if not exists pay_status          text not null default 'unpaid',
  add column if not exists pay_session_id      text,          -- Stripe Checkout session
  add column if not exists paid_cents          int,
  add column if not exists paid_at             timestamptz,
  add column if not exists completed_at        timestamptz;

alter table public.jobs drop constraint if exists jobs_alarm_type_check;
alter table public.jobs add constraint jobs_alarm_type_check
  check (alarm_type is null or alarm_type in ('battery','hardwired'));

alter table public.jobs drop constraint if exists jobs_pay_status_check;
alter table public.jobs add constraint jobs_pay_status_check
  check (pay_status in ('unpaid','pending','paid','later','none'));

notify pgrst, 'reload schema';
