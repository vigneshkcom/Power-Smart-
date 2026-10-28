-- Bind each job to the quote selected at scheduling time, so later payments
-- remain on that quote even if the customer is sent another quote.
begin;
alter table public.jobs add column if not exists quote_ref text;
create index if not exists jobs_lead_quote_idx on public.jobs (lead_id, quote_ref);
-- Existing jobs are matched only to a quote issued for that exact lead before
-- the job was created. Existing explicit links are never changed.
update public.jobs j
set quote_ref = (
  select e.quote_ref from public.sent_emails e
  where e.lead_id = j.lead_id and e.kind = 'quote' and e.status = 'sent'
    and e.quote_ref is not null and e.created_at <= j.created_at
  order by e.created_at desc, e.id desc limit 1
)
where j.quote_ref is null and j.lead_id is not null
  and exists (select 1 from public.sent_emails e where e.lead_id = j.lead_id
    and e.kind = 'quote' and e.status = 'sent' and e.quote_ref is not null and e.created_at <= j.created_at);
notify pgrst, 'reload schema';
commit;
