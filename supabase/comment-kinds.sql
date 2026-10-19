-- Add structured activity types to the lead timeline.
-- Existing activity remains readable and is classified by the portal from its wording.

alter table public.lead_comments
  add column if not exists kind text not null default 'note';
