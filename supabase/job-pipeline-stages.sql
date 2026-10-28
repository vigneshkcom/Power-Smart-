-- Job and pipeline changes commit together. Keep the existing 'won' stored value
-- for Installed so existing reports, quotes and integrations remain compatible.
begin;
alter table public.leads drop constraint if exists leads_stage_check;
alter table public.leads add constraint leads_stage_check check (stage in
  ('new_lead','quote_accepted','follow_up','shopping','quote_sent','scheduled','won','not_reachable','out_of_area'));

create or replace function public.sync_job_pipeline_stage()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.lead_id is null then return new; end if;
  if TG_OP = 'UPDATE' then
    if new.status is not distinct from old.status
      and new.lead_id is not distinct from old.lead_id
      and new.scheduled_start is not distinct from old.scheduled_start then
      return new;
    end if;
  end if;
  if new.status = 'completed' then
    update public.leads set stage = 'won'
      where id = new.lead_id and stage <> 'won';
  elsif new.status in ('scheduled','en_route','on_site') and new.scheduled_start is not null then
    -- A later service visit or correction must not undo a completed installation.
    update public.leads set stage = 'scheduled'
      where id = new.lead_id and stage not in ('scheduled','won');
  end if;
  -- Cancellation, removal of a date, and unrelated edits do not infer a sales stage.
  return new;
end $$;
drop trigger if exists jobs_pipeline_stage on public.jobs;
create trigger jobs_pipeline_stage after insert or update of status, scheduled_start, lead_id
  on public.jobs for each row execute function public.sync_job_pipeline_stage();

-- Align already booked/completed customers. Completed work takes precedence.
update public.leads l set stage = 'won'
where l.stage <> 'won' and exists (select 1 from public.jobs j where j.lead_id=l.id and j.status='completed');
update public.leads l set stage = 'scheduled'
where l.stage not in ('won','scheduled') and exists
  (select 1 from public.jobs j where j.lead_id=l.id and j.status in ('scheduled','en_route','on_site') and j.scheduled_start is not null);
notify pgrst, 'reload schema';
commit;
