-- PowerSmart outbound email log
-- Run this in Supabase → SQL Editor after schema.sql.
-- Stores every email sent to a customer through Resend (quotes + composed emails).
-- RLS enabled, no policies → only the serverless functions (service_role) can access it.

create table if not exists public.sent_emails (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  kind         text not null default 'email',          -- 'quote' | 'email'
  sender       text not null default 'customer_service',-- customer_service | mani | vignesh
  agent        text,                                     -- who operated the portal
  to_email     text not null,
  to_name      text,
  subject      text,
  body_html    text,
  body_text    text,
  quote_ref    text,
  quote_total  numeric(10,2),
  lead_id      uuid references public.leads(id) on delete set null,
  provider_id  text,                                     -- Resend message id
  status       text not null default 'sent',            -- 'sent' | 'failed'
  error        text
);

create index if not exists sent_emails_created_idx on public.sent_emails (created_at desc);
create index if not exists sent_emails_to_idx      on public.sent_emails (lower(to_email));
create index if not exists sent_emails_lead_idx    on public.sent_emails (lead_id);

alter table public.sent_emails enable row level security;
