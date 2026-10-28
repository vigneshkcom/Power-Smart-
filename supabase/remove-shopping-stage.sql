-- Preserve existing leads by moving the retired stage into Follow-Up.
begin;
update public.leads set stage='follow_up' where stage='shopping';
alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check check (stage in
  ('new_lead','quote_accepted','follow_up','quote_sent','scheduled','won','not_reachable','out_of_area'));
commit;
