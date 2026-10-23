-- Stripe booking-fee payment tracking. Run once in Supabase SQL Editor.
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  quote_ref text,
  customer_email text not null,
  payment_type text not null default 'booking_fee',
  description text not null default 'Booking fee',
  request_key text,
  amount_cents integer not null check (amount_cents > 0),
  amount_paid_cents integer,
  currency text not null default 'aud',
  status text not null check (status in ('sent','paid','expired','failed')),
  stripe_session_id text not null unique,
  stripe_payment_intent_id text,
  stripe_event_id text unique,
  checkout_url text not null,
  sent_at timestamptz,
  paid_at timestamptz
);
create index if not exists payment_requests_lead_idx on public.payment_requests (lead_id, created_at desc);
create unique index if not exists payment_requests_request_key_idx on public.payment_requests(request_key) where request_key is not null;
alter table public.payment_requests enable row level security;
drop trigger if exists payment_requests_touch on public.payment_requests;
create trigger payment_requests_touch before update on public.payment_requests for each row execute function public.touch_updated_at();
