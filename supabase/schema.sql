-- PowerSmart pipeline schema
-- Run this once in Supabase → SQL Editor → New query → Run.
--
-- Security model: RLS is ENABLED with NO policies, so the public anon key
-- can't read or write anything. All access goes through Vercel serverless
-- functions using the service_role key (server-side only).

create extension if not exists pgcrypto;

-- ---------- Leads (pipeline cards) ----------
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  name         text not null,
  phone        text,
  email        text,
  postcode     text,
  source       text not null default 'Website',
  stage        text not null default 'new_lead'
               check (stage in ('new_lead','follow_up','shopping','quote_sent','won','not_reachable','out_of_area')),
  agent        text,
  quote_ref    text,
  quote_total  numeric(10,2)
);

create index if not exists leads_stage_idx      on public.leads (stage);
create index if not exists leads_updated_idx    on public.leads (updated_at desc);
create index if not exists leads_email_idx      on public.leads (lower(email));

-- ---------- Comments on a lead ----------
create table if not exists public.lead_comments (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads(id) on delete cascade,
  created_at timestamptz not null default now(),
  author     text,
  body       text not null
);

create index if not exists lead_comments_lead_idx on public.lead_comments (lead_id, created_at);

-- ---------- keep updated_at fresh ----------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- ---------- lock it down: RLS on, no policies ----------
alter table public.leads         enable row level security;
alter table public.lead_comments enable row level security;
