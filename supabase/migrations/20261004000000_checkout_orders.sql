-- One row per checkout attempt. Written only by Edge Functions (service role);
-- RLS is on with no policies, so the public anon key can't read or write it.
create table public.checkout_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  name text not null,
  email text not null,
  line1 text not null,
  line2 text,
  city text not null,
  state text not null,
  postal_code text not null,
  country text not null,

  plan text not null check (plan in ('full', 'split')),
  amount_cents integer not null,
  terms_accepted_at timestamptz not null,

  -- pending: form submitted, card not charged yet
  -- paid:    Stripe confirmed the (first) payment succeeded
  -- failed:  Stripe reported the payment failed
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  paid_at timestamptz,

  stripe_customer_id text unique,
  stripe_payment_intent_id text,
  stripe_subscription_id text
);

create index checkout_orders_email_idx on public.checkout_orders (lower(email));
create index checkout_orders_status_idx on public.checkout_orders (status);

alter table public.checkout_orders enable row level security;

create function public.checkout_orders_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger checkout_orders_touch before update on public.checkout_orders
for each row execute function public.checkout_orders_touch();
