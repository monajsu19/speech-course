-- Weekly Feedback cohorts: buyers are split into private Circle spaces of about 50.
-- The Circle space and member tag for each cohort are created by supabase/functions/_shared/circle.ts
-- the first time someone is put in it. RLS is on with no policies, so only the service role can touch it.
create table public.circle_cohorts (
  number integer primary key,
  created_at timestamptz not null default now(),
  circle_space_id bigint unique,
  circle_tag_id bigint,
  -- set while one caller creates the Circle space, so a second caller doesn't make a duplicate
  setup_claimed_at timestamptz,
  -- the week whose posting window is currently open in this space (null = posting closed)
  posting_week integer,
  -- that week's pinned "post your video" post, unpinned when the next week's goes up
  weekly_post_id bigint
);

alter table public.circle_cohorts enable row level security;

alter table public.checkout_orders
  add column cohort integer references public.circle_cohorts (number),
  -- when the buyer was fully set up in Circle (invite, cohort space, cohort tag)
  add column circle_synced_at timestamptz;

create index checkout_orders_cohort_idx on public.checkout_orders (cohort);

-- Puts a paid order in a cohort and returns its number; an order that already has one keeps it.
-- Before fill_cutoff (the course start) cohorts fill in order and a new one opens when the last is full.
-- From then on late buyers join whichever cohort is smallest, so no tiny cohort gets started.
create function public.assign_cohort(order_id uuid, capacity integer, fill_cutoff timestamptz)
returns integer
language plpgsql set search_path = '' as $$
declare
  n integer;
begin
  select o.cohort into n from public.checkout_orders o where o.id = order_id for update;
  if n is not null then return n; end if;

  -- one assignment at a time, so two buyers can't both take the 50th seat
  perform pg_advisory_xact_lock(hashtext('public.assign_cohort'));

  if now() >= fill_cutoff then
    select c.number into n
    from public.circle_cohorts c left join public.checkout_orders o on o.cohort = c.number
    group by c.number order by count(o.id), c.number limit 1;
  else
    select c.number into n
    from public.circle_cohorts c left join public.checkout_orders o on o.cohort = c.number
    group by c.number having count(o.id) < capacity order by c.number limit 1;
  end if;

  if n is null then
    select coalesce(max(c.number), 0) + 1 into n from public.circle_cohorts c;
    insert into public.circle_cohorts (number) values (n);
  end if;

  update public.checkout_orders set cohort = n where id = order_id;
  return n;
end;
$$;

revoke execute on function public.assign_cohort(uuid, integer, timestamptz) from public, anon, authenticated;
