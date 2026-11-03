-- Stock tracker: stock given to / taken back from each electrician.
-- Run once in Supabase -> SQL Editor.
-- What an electrician has used is worked out from their completed jobs (no extra entry needed).
create table if not exists public.stock_movements (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz not null default now(),
  electrician_id uuid not null references public.electricians(id) on delete cascade,
  product        text not null check (product in ('hardwired','battery','controller')),
  qty            int  not null check (qty <> 0),   -- positive = given to electrician, negative = taken back / written off
  kind           text not null default 'issue' check (kind in ('issue','return','adjust')),
  note           text,
  created_by     text
);
create index if not exists stock_movements_tech_idx on public.stock_movements (electrician_id, created_at);
alter table public.stock_movements enable row level security;
notify pgrst, 'reload schema';
