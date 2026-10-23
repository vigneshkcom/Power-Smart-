-- Add custom payments without changing historical booking-fee records.
begin;
alter table public.payment_requests
  add column if not exists payment_type text not null default 'booking_fee',
  add column if not exists description text not null default 'Booking fee',
  add column if not exists request_key text;
create unique index if not exists payment_requests_request_key_idx
  on public.payment_requests(request_key) where request_key is not null;
notify pgrst, 'reload schema';
commit;
