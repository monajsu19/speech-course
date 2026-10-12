-- Split-plan orders: tracks the 2nd monthly charge, which Stripe makes on its own a month later.
--   null:      full-plan order, or the 1st payment hasn't gone through yet
--   scheduled: 1st payment went through, 2nd is coming
--   paid:      2nd payment went through
--   failed:    2nd payment was declined (Stripe retries; a later success flips it to paid)
alter table public.checkout_orders
  add column second_payment text check (second_payment in ('scheduled', 'paid', 'failed')),
  add column second_paid_at timestamptz;

create or replace function public.checkout_orders_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  if new.plan = 'split' and new.status = 'paid' and new.second_payment is null then
    new.second_payment := 'scheduled';
  end if;
  return new;
end;
$$;
