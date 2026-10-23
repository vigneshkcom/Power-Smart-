-- Adds the "Job Assigned" pipeline stage (set automatically when a job is assigned
-- to an electrician). "won" is shown as "Installed".
-- Run once in Supabase → SQL Editor.

alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check
  check (stage in ('new_lead','quote_accepted','follow_up','shopping','quote_sent','assigned','won','not_reachable','out_of_area'));

notify pgrst, 'reload schema';
