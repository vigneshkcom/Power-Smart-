-- Manual "Send reminder now" runs are extra: they are stored as runs flagged manual (sequence 0) and never use up
-- one of the three automatic follow-ups. Run once in Supabase -> SQL Editor.
alter table public.quote_reminder_runs add column if not exists manual boolean not null default false;
alter table public.quote_reminder_runs drop constraint if exists quote_reminder_runs_sequence_check;
alter table public.quote_reminder_runs add constraint quote_reminder_runs_sequence_check check (sequence between 0 and 3);
alter table public.quote_reminder_runs drop constraint if exists quote_reminder_runs_quote_id_sequence_key;
create unique index if not exists quote_reminder_runs_auto_seq_idx on public.quote_reminder_runs(quote_id, sequence) where not manual;
notify pgrst, 'reload schema';
