-- Warranty jobs: book a free warranty visit for a customer whose smoke alarm is faulty, track the faulty
-- alarms the electrician brings back, and only message the customer when the office ticks the box.
-- Run once in Supabase -> SQL Editor (after jobs.sql, tech-job-flow.sql and stock.sql). Safe to run again.

-- 1. A new work type for jobs.
alter table public.jobs drop constraint if exists jobs_work_type_check;
alter table public.jobs add constraint jobs_work_type_check
  check (work_type in ('install','inspection','service','warranty'));

-- 2. Whether booking confirmations, day-before reminders and the completion email may go to the customer,
--    and by which channel. Existing jobs keep today's behaviour (true). Warranty jobs store the office's ticks.
--    notify_customer = notify_email or notify_sms.
alter table public.jobs
  add column if not exists notify_customer boolean not null default true,
  add column if not exists notify_email    boolean not null default true,
  add column if not exists notify_sms      boolean not null default true;

-- 3. Faulty alarms in the stock tracker. Each alarm replaced on a warranty job puts one faulty alarm in that
--    electrician's van (worked out from the job). The office records taking faulty alarms back here, as
--    condition = 'faulty' (negative qty), so they no longer count as being with the electrician.
alter table public.stock_movements
  add column if not exists condition text not null default 'good';
alter table public.stock_movements drop constraint if exists stock_movements_condition_check;
alter table public.stock_movements add constraint stock_movements_condition_check
  check (condition in ('good','faulty'));

notify pgrst, 'reload schema';
