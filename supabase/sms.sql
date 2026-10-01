-- PowerSmart SMS portal storage. Run once in the PowerSmart Supabase SQL Editor.
-- The Vercel API uses SUPABASE_SERVICE_ROLE_KEY; no browser has database access.
create extension if not exists pgcrypto;

create table if not exists public.sms_messages (
  id uuid primary key default gen_random_uuid(),
  phone_number text not null,
  message text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null default 'pending',
  sms_gate_id text,
  created_at timestamptz not null default now()
);

create index if not exists sms_messages_phone_created_idx on public.sms_messages (phone_number, created_at);
create index if not exists sms_messages_created_idx on public.sms_messages (created_at desc);
create index if not exists sms_messages_gate_id_idx on public.sms_messages (sms_gate_id) where sms_gate_id is not null;

alter table public.sms_messages enable row level security;
