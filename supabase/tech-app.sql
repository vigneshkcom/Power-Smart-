-- Electrician phone app (/tech): app PINs, on-site checklist, invoice and card payment.
-- Run once in Supabase → SQL Editor (after jobs.sql).

alter table public.electricians
  add column if not exists pin_hash text;              -- sha256, set from /tools/schedule → Electricians

alter table public.jobs
  add column if not exists checklist           jsonb,  -- { question_id: "yes" | "no" | "na" }
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

alter table public.jobs drop constraint if exists jobs_pay_status_check;
alter table public.jobs add constraint jobs_pay_status_check
  check (pay_status in ('unpaid','pending','paid','later','none'));

notify pgrst, 'reload schema';
