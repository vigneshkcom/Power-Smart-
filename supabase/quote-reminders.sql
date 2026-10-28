-- Durable quote reminders. No customer messages are sent by this migration.
begin;
create table if not exists public.quote_reminder_settings (
  lead_id uuid primary key references public.leads(id) on delete cascade,
  quote_id uuid references public.sent_emails(id) on delete set null,
  enabled boolean not null default true,
  unsubscribed boolean not null default false,
  unsubscribe_token uuid not null unique default gen_random_uuid(),
  reminder_count integer not null default 0 check (reminder_count between 0 and 3),
  next_at timestamptz,
  reply_baseline timestamptz not null default now(),
  reason text,
  updated_at timestamptz not null default now()
);
create table if not exists public.quote_reminder_runs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  quote_id uuid not null references public.sent_emails(id) on delete cascade,
  sequence integer not null check (sequence between 1 and 3),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  sms_status text not null default 'pending' check (sms_status in ('pending','sending','submitted','failed','unknown','skipped')),
  email_status text not null default 'pending' check (email_status in ('pending','sending','submitted','failed','unknown','skipped')),
  sms_to text, email_to text, sms_body text, email_subject text, email_body text,
  email_provider_id text, error text,
  unique(quote_id,sequence)
);
create table if not exists public.quote_reminder_worker (
  id boolean primary key default true check(id),
  secret text not null default encode(gen_random_bytes(32),'hex'),
  active boolean not null default false,
  last_run_at timestamptz, last_result jsonb
);
insert into public.quote_reminder_worker(id) values(true) on conflict do nothing;
alter table public.quote_reminder_settings enable row level security;
alter table public.quote_reminder_runs enable row level security;
alter table public.quote_reminder_worker enable row level security;
revoke all on public.quote_reminder_settings, public.quote_reminder_runs, public.quote_reminder_worker from anon, authenticated;
grant all on public.quote_reminder_settings, public.quote_reminder_runs, public.quote_reminder_worker to service_role;
create index if not exists quote_reminder_due_idx on public.quote_reminder_settings(next_at) where enabled;
create index if not exists quote_reminder_history_idx on public.quote_reminder_runs(lead_id,created_at desc);

-- Successful new quotes get a fresh sequence; customer/staff pauses persist.
create or replace function public.enrol_quote_reminders() returns trigger language plpgsql set search_path=public as $$
begin
  if new.kind='quote' and new.status='sent' and new.lead_id is not null then
    insert into public.quote_reminder_settings(lead_id,quote_id,next_at,reply_baseline)
      values(new.lead_id,new.id,greatest(new.created_at,now())+interval '3 days',now())
    on conflict(lead_id) do update set quote_id=excluded.quote_id,reminder_count=0,
      next_at=case when quote_reminder_settings.enabled then excluded.next_at else null end,
      reply_baseline=excluded.reply_baseline, updated_at=now(),
      reason=case when quote_reminder_settings.enabled then null else quote_reminder_settings.reason end;
  end if;
  return new;
end $$;
drop trigger if exists sent_quote_reminders on public.sent_emails;
create trigger sent_quote_reminders after insert on public.sent_emails for each row execute function public.enrol_quote_reminders();

-- Atomic claim prevents overlapping workers from sending the same round twice.
create or replace function public.claim_quote_reminder(p_lead_id uuid)
returns setof public.quote_reminder_runs language plpgsql set search_path=public as $$
declare s public.quote_reminder_settings; r public.quote_reminder_runs;
begin
  select * into s from public.quote_reminder_settings where lead_id=p_lead_id for update skip locked;
  if not found or not s.enabled or s.unsubscribed or s.next_at is null or s.next_at>now() or s.reminder_count>=3 then return; end if;
  if not exists(select 1 from public.leads l join public.sent_emails e on e.id=s.quote_id
    where l.id=s.lead_id and l.stage='quote_sent' and l.quote_ref=e.quote_ref and e.lead_id=l.id and e.kind='quote' and e.status='sent') then return; end if;
  insert into public.quote_reminder_runs(lead_id,quote_id,sequence)
    values(s.lead_id,s.quote_id,s.reminder_count+1) on conflict do nothing returning * into r;
  if not found then return; end if;
  update public.quote_reminder_settings set reminder_count=reminder_count+1,
    next_at=case when reminder_count+1<3 then now()+interval '3 days' else null end,
    reason=case when reminder_count+1=3 then 'Three-reminder limit reached' else null end, updated_at=now() where lead_id=s.lead_id;
  return next r;
end $$;
revoke all on function public.claim_quote_reminder(uuid) from public,anon,authenticated;
grant execute on function public.claim_quote_reminder(uuid) to service_role;

-- Replying to an SMS pauses both channels immediately; a staff resume records a new baseline.
create or replace function public.pause_reminders_on_sms_reply() returns trigger language plpgsql set search_path=public as $$
begin
  if new.direction='inbound' then
    update public.quote_reminder_settings s set enabled=false,next_at=null,
      reason=case when new.status='optout' then 'Customer opted out of SMS' else 'Customer replied by SMS; review before resuming' end,updated_at=now()
    from public.leads l where l.id=s.lead_id
      and right(regexp_replace(coalesce(l.phone,''),'[^0-9]','','g'),9)=right(regexp_replace(new.phone_number,'[^0-9]','','g'),9)
      and length(regexp_replace(new.phone_number,'[^0-9]','','g'))>=9 and new.created_at>=s.reply_baseline;
  end if;
  return new;
end $$;
drop trigger if exists sms_pause_quote_reminders on public.sms_messages;
create trigger sms_pause_quote_reminders after insert on public.sms_messages for each row execute function public.pause_reminders_on_sms_reply();

-- Existing Quote Sent customers get a full three-day grace period from setup.
create or replace function public.reschedule_reminders_on_stage() returns trigger language plpgsql set search_path=public as $$
begin
  if new.stage is distinct from old.stage then
    if new.stage='quote_sent' then
      insert into public.quote_reminder_settings(lead_id,quote_id,next_at,reply_baseline)
      select new.id,e.id,now()+interval '3 days',e.created_at from public.sent_emails e
      where e.lead_id=new.id and e.quote_ref=new.quote_ref and e.kind='quote' and e.status='sent'
      order by e.created_at desc limit 1
      on conflict(lead_id) do update set quote_id=excluded.quote_id,reply_baseline=excluded.reply_baseline
      where quote_reminder_settings.quote_id is null;
    end if;
    update public.quote_reminder_settings set
      next_at=case when new.stage='quote_sent' and enabled and not unsubscribed and reminder_count<3 then now()+interval '3 days' else null end,
      updated_at=now() where lead_id=new.id;
  end if;
  return new;
end $$;
drop trigger if exists leads_reminder_stage on public.leads;
create trigger leads_reminder_stage after update of stage on public.leads for each row execute function public.reschedule_reminders_on_stage();

insert into public.quote_reminder_settings(lead_id,quote_id,next_at,reply_baseline)
select distinct on(l.id) l.id,e.id,now()+interval '3 days',e.created_at
from public.leads l join public.sent_emails e on e.lead_id=l.id and e.quote_ref=l.quote_ref
where l.stage='quote_sent' and e.kind='quote' and e.status='sent' and e.created_at>now()-interval '30 days'
order by l.id,e.created_at desc
on conflict(lead_id) do nothing;
notify pgrst,'reload schema';
commit;
