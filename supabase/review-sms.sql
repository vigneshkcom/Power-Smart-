-- Google review SMS after a job is completed. Run once in Supabase -> SQL Editor. Safe to run again.
-- review_sms = false stops the review text for that job (tick box on /tools/schedule). Default: send.
alter table public.jobs
  add column if not exists review_sms         boolean not null default true,
  add column if not exists review_sms_sent_at timestamptz;
notify pgrst, 'reload schema';
