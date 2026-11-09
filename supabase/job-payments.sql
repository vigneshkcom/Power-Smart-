-- A list of every payment received on a job (date, amount, method, who), shown in the job window of /tools/schedule.
-- Run once in the Supabase SQL editor. Until then the job window falls back to the totals already stored on the job.
begin;
alter table public.jobs
  add column if not exists payments jsonb not null default '[]'::jsonb;
notify pgrst, 'reload schema';
commit;
