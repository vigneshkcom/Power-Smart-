-- Integration checks run inside a transaction and leave no customer/test records.
begin;
do $$
declare l uuid; q uuid; q2 uuid; total integer; s public.quote_reminder_settings; claimed integer;
begin
  insert into public.leads(name,email,phone,stage,quote_ref)
    values('Reminder rollback test','reminder@example.invalid','0499999999','quote_sent','REMINDER-TEST') returning id into l;
  insert into public.sent_emails(lead_id,kind,status,to_email,quote_ref)
    values(l,'quote','sent','reminder@example.invalid','REMINDER-TEST') returning id into q;
  select * into s from public.quote_reminder_settings where lead_id=l;
  if s.quote_id<>q or not s.enabled or s.next_at<now()+interval '71 hours' then raise exception 'Enrollment failed'; end if;
  select count(*) into claimed from public.claim_quote_reminder(l);
  if claimed<>0 then raise exception 'Claimed before due date'; end if;
  update public.quote_reminder_settings set next_at=now()-interval '1 second' where lead_id=l;
  select count(*) into claimed from public.claim_quote_reminder(l);
  if claimed<>1 then raise exception 'Due round was not claimed'; end if;
  select count(*) into claimed from public.claim_quote_reminder(l);
  if claimed<>0 then raise exception 'Duplicate claim was allowed'; end if;
  update public.quote_reminder_settings set next_at=now()-interval '1 second',enabled=false where lead_id=l;
  select count(*) into claimed from public.claim_quote_reminder(l);
  if claimed<>0 then raise exception 'Paused claim was allowed'; end if;
  update public.quote_reminder_settings set enabled=true where lead_id=l;
  update public.leads set stage='scheduled' where id=l;
  select * into s from public.quote_reminder_settings where lead_id=l;
  if s.next_at is not null then raise exception 'Stage exit did not stop scheduling'; end if;
  update public.leads set stage='quote_sent' where id=l;
  select * into s from public.quote_reminder_settings where lead_id=l;
  if s.next_at<now()+interval '71 hours' then raise exception 'Stage reentry did not wait three days'; end if;
  update public.quote_reminder_settings set next_at=now()-interval '1 second',reminder_count=3 where lead_id=l;
  select count(*) into claimed from public.claim_quote_reminder(l);
  if claimed<>0 then raise exception 'Three-reminder cap bypassed'; end if;
  insert into public.sms_messages(phone_number,message,direction,status) values('+61499999999','Question about quote','inbound','received');
  select * into s from public.quote_reminder_settings where lead_id=l;
  if s.enabled or s.next_at is not null then raise exception 'SMS reply did not pause'; end if;
  insert into public.sent_emails(lead_id,kind,status,to_email,quote_ref)
    values(l,'quote','sent','reminder@example.invalid','REMINDER-TEST-NEW') returning id into q2;
  select * into s from public.quote_reminder_settings where lead_id=l;
  if s.enabled or s.quote_id<>q2 or s.reminder_count<>0 then raise exception 'New quote lost pause or did not reset sequence'; end if;
  update public.quote_reminder_settings set quote_id=null where lead_id=l;
  update public.leads set stage='follow_up',quote_ref='REMINDER-TEST-NEW' where id=l;
  update public.leads set stage='quote_sent' where id=l;
  select * into s from public.quote_reminder_settings where lead_id=l;
  if s.quote_id<>q2 or s.enabled then raise exception 'Stage entry did not link an existing quote or lost pause'; end if;
  if has_table_privilege('anon','public.quote_reminder_worker','SELECT') or has_function_privilege('anon','public.claim_quote_reminder(uuid)','EXECUTE') then raise exception 'Public worker access'; end if;
end $$;
rollback;
select 'PASS: enrollment, due time, duplicate prevention, pause, stages, cap, reply pause, new quote, private worker' as result;
