-- Apply before deploying the pipeline update. Preserve existing card positions.
begin;
alter table public.leads add column if not exists pipeline_order_at timestamptz;
-- Do not turn this backfill into customer activity.
alter table public.leads disable trigger leads_touch;
update public.leads set pipeline_order_at = updated_at where pipeline_order_at is null;
alter table public.leads enable trigger leads_touch;
alter table public.leads alter column pipeline_order_at set default now();
alter table public.leads alter column pipeline_order_at set not null;
create index if not exists leads_pipeline_order_idx on public.leads (pipeline_order_at desc, id desc);

alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check check (stage in
  ('new_lead','quote_accepted','follow_up','quote_sent','scheduled','won','not_reachable','not_interested','out_of_area'));
commit;
