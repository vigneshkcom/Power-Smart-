-- Day-before job reminders (5pm Brisbane the evening before the install). Run once, then job-reminder-scheduler.sql.
-- The worker starts PAUSED. Activate it with: update public.job_reminder_worker set active=true where id=true;
create table if not exists public.job_reminders (
  job_id          uuid not null references public.jobs(id) on delete cascade,
  scheduled_start timestamptz not null,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  email_status    text,
  sms_status      text,
  error           text,
  primary key (job_id, scheduled_start)      -- one reminder per job per booked time
);
create table if not exists public.job_reminder_worker (
  id boolean primary key default true check (id),
  secret text not null default encode(gen_random_bytes(32),'hex'),
  active boolean not null default false,
  last_run_at timestamptz, last_result jsonb
);
insert into public.job_reminder_worker(id) values(true) on conflict do nothing;
alter table public.job_reminders enable row level security;
alter table public.job_reminder_worker enable row level security;
revoke all on public.job_reminders, public.job_reminder_worker from anon, authenticated;
grant all on public.job_reminders, public.job_reminder_worker to service_role;
