-- Additive inspection workflow; no existing customer/job data is changed.
alter table public.jobs add column if not exists inspection jsonb;
alter table public.jobs add column if not exists inspection_payment_id uuid references public.payment_requests(id);
alter table public.jobs add column if not exists inspection_converted_at timestamptz;
alter table public.jobs add column if not exists compliance_outcome text;
alter table public.jobs add column if not exists installation_compliant_at timestamptz;
alter table public.jobs add column if not exists installation_quote_ref text;
create unique index if not exists jobs_inspection_payment_once on public.jobs(inspection_payment_id) where inspection_payment_id is not null;
alter table public.jobs add constraint jobs_inspection_outcome_check check (compliance_outcome is null or compliance_outcome in ('compliant','declined','converted','installed'));
create or replace function public.guard_inspection_job() returns trigger language plpgsql set search_path = public as $$
declare p payment_requests; k text; a jsonb;
begin
  if new.inspection_payment_id is not null then
    select * into p from payment_requests where id = new.inspection_payment_id;
    if p.id is null or p.lead_id is distinct from new.lead_id or p.quote_ref is distinct from new.quote_ref or p.status <> 'paid' or p.payment_type <> 'inspection' or coalesce(p.amount_paid_cents,p.amount_cents) <> 12000 then
      raise exception 'Inspection requires its own paid $120 quote payment';
    end if;
  end if;
  if (new.work_type = 'inspection' and (new.status = 'completed' or new.certificate_sent_at is not null)) or new.inspection_converted_at is not null then
    if new.inspection_payment_id is null then raise exception 'Inspection payment must be allocated'; end if;
    if new.inspection is null then raise exception 'Inspection findings are required'; end if;
    foreach k in array array['coverage','photoelectric','age_expiry','functionality','interconnection'] loop
      if coalesce(new.inspection->'checks'->>k,'') not in ('pass','fail','na') then raise exception 'Inspection checklist is incomplete'; end if;
      if new.compliance_outcome = 'compliant' and new.inspection->'checks'->>k <> 'pass' then raise exception 'Compliant inspections must pass every check'; end if;
    end loop;
    for a in select value from jsonb_array_elements(coalesce(new.inspection->'alarms','[]'::jsonb)) loop
      if coalesce(a->>'location','') = '' or coalesce(a->>'expiry','') = '' or coalesce(a->>'photo','') = '' or coalesce(a->>'plate','') = '' then raise exception 'Inspection alarm evidence is incomplete'; end if;
    end loop;
    if new.inspection_converted_at is not null and (new.work_type <> 'install' or new.inspection->>'decision' is distinct from 'accepted' or new.inspection->>'compliant' is distinct from 'false' or coalesce(new.inspection->>'customer_name','') = '') then raise exception 'Customer must authorise conversion of a non-compliant inspection'; end if;
    if new.work_type = 'inspection' and new.status = 'completed' then
      if new.compliance_outcome not in ('compliant','declined') or new.compliance_outcome is null then raise exception 'Inspection outcome is required'; end if;
      if new.compliance_outcome = 'compliant' and (new.inspection->>'compliant' is distinct from 'true' or jsonb_array_length(new.inspection->'alarms') = 0) then raise exception 'Compliant inspection evidence required'; end if;
      if new.compliance_outcome = 'declined' and (new.inspection->>'compliant' is distinct from 'false' or new.inspection->>'decision' is distinct from 'declined' or coalesce(new.inspection->>'reason','') = '') then raise exception 'Declined inspection must record non-compliance and customer decision'; end if;
      if new.invoice_total_cents is distinct from 12000 or new.amount_due_cents is distinct from 0 or new.pay_status <> 'none' then raise exception 'Inspection must retain $120 with nothing further owing'; end if;
    end if;
    if new.inspection_converted_at is not null and new.status = 'completed' and (new.compliance_outcome is distinct from 'installed' or new.installation_compliant_at is null) then raise exception 'Confirm installation compliance before completion'; end if;
  end if;
  if (new.work_type = 'inspection' or new.inspection_converted_at is not null) and new.status = 'completed' then
    if coalesce(new.signoff_name,'') = '' or coalesce(new.signoff_signature,'') = '' then raise exception 'Inspection sign-off required'; end if;
  end if;
  if new.inspection_converted_at is not null and new.status = 'completed' then
    if exists(select 1 from jsonb_array_elements(new.invoice_items) x where x->>'code' = 'inspection') then raise exception 'Converted invoice cannot contain an inspection charge'; end if;
    if (select count(*) from jsonb_array_elements(new.invoice_items) x where x->>'code' = 'installation_callout' and (x->>'amount_cents')::integer = 5000 and (x->>'qty')::integer = 1) <> 1 then raise exception 'Converted installation requires one $50 call-out fee'; end if;
    if new.pay_status = 'none' and new.invoice_total_cents > 12000 + coalesce(new.prior_paid_cents,0) then raise exception 'Installation balance remains owing'; end if;
    if new.pay_status = 'paid' and new.invoice_total_cents > 12000 + coalesce(new.prior_paid_cents,0) + coalesce(new.paid_cents,0) then raise exception 'Installation payment is incomplete'; end if;
  end if;
  if new.certificate_sent_at is not null and (tg_op = 'INSERT' or new.certificate_sent_at is distinct from old.certificate_sent_at) and (new.work_type = 'inspection' or new.inspection_converted_at is not null) then
    if new.status <> 'completed' or new.pay_status not in ('paid','none') or new.compliance_outcome not in ('compliant','installed') or new.compliance_outcome is null then raise exception 'A non-compliant or unpaid inspection cannot issue a compliance certificate'; end if;
  end if;
  return new;
end $$;
drop trigger if exists inspection_job_guard on public.jobs;
create trigger inspection_job_guard before insert or update on public.jobs for each row execute function public.guard_inspection_job();
revoke all on function public.guard_inspection_job() from public,anon,authenticated;

