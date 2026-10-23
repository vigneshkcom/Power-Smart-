-- PowerSmart pipeline stage and quote numbering migration.
-- Run once in Supabase SQL Editor before deploying the matching application code.

alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check
  check (stage in ('new_lead','quote_accepted','follow_up','shopping','quote_sent','assigned','won','not_reachable','out_of_area'));

create sequence if not exists public.quote_reference_sequence
  start with 7000
  increment by 1
  minvalue 7000;

create or replace function public.next_quote_reference()
returns bigint
language sql
security definer
set search_path = public
as $$
  select nextval('public.quote_reference_sequence');
$$;

revoke all on function public.next_quote_reference() from public;
grant execute on function public.next_quote_reference() to service_role;
