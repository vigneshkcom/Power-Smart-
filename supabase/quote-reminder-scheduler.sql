-- Apply after quote-reminders.sql. Worker remains paused until explicitly activated.
create extension if not exists pg_cron;
create extension if not exists pg_net;
revoke all on all tables in schema net from anon, authenticated;
create or replace function public.dispatch_quote_reminders() returns bigint
language plpgsql set search_path=public as $$
declare config public.quote_reminder_worker; request_id bigint;
begin
  select * into config from public.quote_reminder_worker where id=true;
  if not config.active then return null; end if;
  select net.http_post(
    url:='https://portal.powersmartco.com.au/api/pipeline?resource=reminders',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||config.secret),
    body:='{"action":"run"}'::jsonb,timeout_milliseconds:=55000
  ) into request_id;
  return request_id;
end $$;
revoke all on function public.dispatch_quote_reminders() from public,anon,authenticated;
-- Brisbane is UTC+10 year round. 23:00 UTC Sunday = 09:00 Monday Queensland.
-- A second application-level check enforces weekdays and 9am–5pm.
select cron.schedule('powersmart-quote-reminders','*/10 0-6,23 * * *','select public.dispatch_quote_reminders();');
