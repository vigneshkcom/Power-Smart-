-- Real database checks. No fixture rows or edits persist, and no messages send.
begin;
do $$
declare lead_id uuid; saved_order timestamptz; actual_order timestamptz; actual_stage text;
begin
  insert into public.leads(name) values ('TEST pipeline rollback verification')
    returning id, pipeline_order_at into lead_id, saved_order;
  if saved_order is null then raise exception 'New leads need a saved position'; end if;
  update public.leads set name='TEST edited rollback verification' where id=lead_id;
  select pipeline_order_at into actual_order from public.leads where id=lead_id;
  if actual_order is distinct from saved_order then raise exception 'Editing moved the lead'; end if;
  update public.leads set updated_at=now(), stage='not_interested' where id=lead_id;
  select pipeline_order_at, stage into actual_order, actual_stage from public.leads where id=lead_id;
  if actual_order is distinct from saved_order then raise exception 'Activity moved the lead'; end if;
  if actual_stage <> 'not_interested' then raise exception 'Not interested stage was not saved'; end if;
end $$;
rollback;
select 'PASS: new lead position, edit stability, activity stability and Not interested stage; fixture rolled back' as result;
