-- Electrician app job flow: per-alarm records, payment method, work sign-off.
-- Run once in Supabase → SQL Editor (after tech-app.sql).
alter table public.jobs
  add column if not exists alarm_units        jsonb,        -- [{ id, location, type, photo }] one entry per alarm installed
  add column if not exists pay_method         text,         -- card | bank_transfer | cash
  add column if not exists signoff_name       text,         -- electrician who signed off the work
  add column if not exists signoff_signature  text,         -- PNG data URL of the signature
  add column if not exists signoff_at         timestamptz,
  add column if not exists invoice_emailed_at timestamptz;  -- invoice (paid or pending) emailed to the customer

alter table public.jobs drop constraint if exists jobs_pay_method_check;
alter table public.jobs add constraint jobs_pay_method_check
  check (pay_method is null or pay_method in ('card','bank_transfer','cash'));

notify pgrst, 'reload schema';
