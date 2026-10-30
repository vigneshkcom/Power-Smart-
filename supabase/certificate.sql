-- Compliance certificate: electrician licence number (printed on the certificate) and
-- when the certificate PDF was emailed (it is only sent once the job is paid in full).
-- Run once in Supabase → SQL Editor.
alter table public.electricians add column if not exists licence_no text;
alter table public.jobs add column if not exists certificate_sent_at timestamptz;
alter table public.jobs add column if not exists pay_receipt text;   -- Dropbox path of the cash receipt photo (required for cash payments)
notify pgrst, 'reload schema';
alter table public.jobs add column if not exists paid_invoice_emailed_at timestamptz;   -- paid tax invoice emailed after a pay-later balance was received
notify pgrst, 'reload schema';
-- Revert to assigned keeps the money already received as a credit on the job (see api/_jobs.js job_revert).
alter table public.jobs
  add column if not exists prior_paid_cents int,
  add column if not exists prior_pay_method text,
  add column if not exists prior_paid_by    text,          -- electrician id who collected it (cash is deducted from their pay)
  add column if not exists prior_paid_at    timestamptz,
  add column if not exists prior_receipt    text;
notify pgrst, 'reload schema';
