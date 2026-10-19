-- Add the installation address captured when a customer accepts a quote.
alter table public.leads
  add column if not exists address_line1 text,
  add column if not exists address_suburb text,
  add column if not exists address_state text,
  add column if not exists address_postcode text;
