-- Integration test against the actual trigger. All fixture rows roll back.
begin;
do $$
declare l uuid; j uuid; actual text;
begin
  insert into public.leads(name,stage) values ('Stage sync rollback test','quote_accepted') returning id into l;
  insert into public.jobs(job_no,lead_id,customer_name,status) values (-990001,l,'Stage sync rollback test','scheduled') returning id into j;
  select stage into actual from public.leads where id=l;
  if actual <> 'quote_accepted' then raise exception 'Waiting list incorrectly scheduled'; end if;
  update public.jobs set scheduled_start=now() where id=j;
  select stage into actual from public.leads where id=l;
  if actual <> 'scheduled' then raise exception 'Booking did not set Scheduled'; end if;
  update public.jobs set status='cancelled' where id=j;
  select stage into actual from public.leads where id=l;
  if actual <> 'scheduled' then raise exception 'Cancellation inferred an unrelated stage'; end if;
  update public.jobs set status='completed' where id=j;
  select stage into actual from public.leads where id=l;
  if actual <> 'won' then raise exception 'Completion did not set Installed'; end if;
  update public.jobs set status='on_site', notes='Correction' where id=j;
  select stage into actual from public.leads where id=l;
  if actual <> 'won' then raise exception 'Reopening downgraded Installed'; end if;
  insert into public.jobs(job_no,lead_id,customer_name,status,scheduled_start)
    values (-990002,l,'Stage sync rollback test','scheduled',now());
  select stage into actual from public.leads where id=l;
  if actual <> 'won' then raise exception 'Later visit downgraded Installed'; end if;
  update public.leads set stage='quote_accepted' where id=l;
  insert into public.jobs(job_no,lead_id,customer_name,status,scheduled_start)
    values (-990003,l,'Stage sync rollback test','scheduled',now());
  select stage into actual from public.leads where id=l;
  if actual <> 'scheduled' then raise exception 'Direct scheduled creation failed'; end if;
end $$;
rollback;
select 'PASS: waiting list, scheduling, cancellation, completion, reopening and later visits' as result;
