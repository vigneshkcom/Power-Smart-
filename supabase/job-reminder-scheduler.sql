-- Apply after job-reminders.sql. Sends day-before reminders at 5:00pm Brisbane (07:00 UTC; Queensland has no daylight saving).
-- A second run at 5:30pm catches any job the first run missed; jobs already reminded are skipped.
create extension if not exists pg_cron;
create extension if not exists pg_net;
create or replace function public.dispatch_job_reminders() returns bigint
language plpgsql set search_path=public as $$
declare config public.job_reminder_worker; request_id bigint;
begin
  select * into config from public.job_reminder_worker where id=true;
  if not config.active then return null; end if;
  select net.http_post(
    url:='https://portal.powersmartco.com.au/api/pipeline?resource=job-reminders',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||config.secret),
    body:='{"action":"run"}'::jsonb,timeout_milliseconds:=55000
  ) into request_id;
  return request_id;
end $$;
revoke all on function public.dispatch_job_reminders() from public,anon,authenticated;
select cron.schedule('powersmart-job-reminders','0,30 7 * * *','select public.dispatch_job_reminders();');
