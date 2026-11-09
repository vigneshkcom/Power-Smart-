-- Billing address for invoices. Empty = same as the installation address.
-- Run once in the Supabase SQL editor.
begin;
alter table public.leads
  add column if not exists billing_line1 text,
  add column if not exists billing_suburb text,
  add column if not exists billing_state text,
  add column if not exists billing_postcode text;
notify pgrst, 'reload schema';
commit;
