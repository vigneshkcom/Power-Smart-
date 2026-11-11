-- Apply before enabling the Meta leadgen webhook.
create table if not exists public.meta_lead_deliveries (
  leadgen_id text primary key,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

alter table public.meta_lead_deliveries enable row level security;
