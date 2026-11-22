-- Pin the existing customer cohort to Stripe. Switch defaults only after the
-- gateway credentials and webhook are deployed and verified.
alter table public.leads add column if not exists payment_gateway text not null default 'stripe'
  check (payment_gateway in ('stripe', 'revolut'));
alter table public.jobs add column if not exists payment_gateway text not null default 'stripe'
  check (payment_gateway in ('stripe', 'revolut'));

-- Revolut order creation has no documented idempotency guarantee. Claim each
-- checkout locally before calling it and recover interrupted calls by reference.
create table if not exists public.checkout_attempts (
  request_key text primary key,
  created_at timestamptz not null default now(),
  amount_cents integer not null check (amount_cents > 0),
  currency text not null check (currency = 'AUD'),
  metadata jsonb not null,
  order_id uuid unique
);
alter table public.checkout_attempts enable row level security;
revoke all on public.checkout_attempts from anon, authenticated;
grant all on public.checkout_attempts to service_role;
