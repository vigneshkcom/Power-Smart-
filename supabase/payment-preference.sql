-- Records how an accepted customer wants to arrange the upfront fee.
alter table public.leads
  add column if not exists payment_preference text
  check (payment_preference in ('stripe','phone'));
