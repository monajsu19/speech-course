-- Mirror of the EmailOctopus waitlist. EmailOctopus stays the source of truth (its embed form
-- collects signups); the emailoctopus-webhook Edge Function keeps this in sync and
-- sync-waitlist does the initial import. RLS is on with no policies, so only the service role can touch it.
create table public.waitlist_contacts (
  emailoctopus_id uuid primary key,
  email text not null,
  first_name text,
  last_name text,
  fields jsonb not null default '{}',
  tags text[] not null default '{}',
  status text not null
    check (status in ('pending', 'subscribed', 'unsubscribed', 'bounced', 'complained', 'deleted')),
  joined_at timestamptz,
  -- when EmailOctopus last changed this contact; webhook events can arrive out of order,
  -- so anything older than what's stored is skipped
  emailoctopus_updated_at timestamptz not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index waitlist_contacts_email_idx on public.waitlist_contacts (lower(email));
create index waitlist_contacts_status_idx on public.waitlist_contacts (status);

alter table public.waitlist_contacts enable row level security;

create function public.waitlist_contacts_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger waitlist_contacts_touch before update on public.waitlist_contacts
for each row execute function public.waitlist_contacts_touch();

-- Upserts a batch of contacts, keeping only the newest version of each.
-- A webhook batch can hold several events for one contact, hence the distinct on
-- (and the window, so the signup time from a contact.created in the same batch isn't lost).
create function public.upsert_waitlist_contacts(contacts jsonb) returns void
language sql set search_path = '' as $$
  insert into public.waitlist_contacts as w
    (emailoctopus_id, email, first_name, last_name, fields, tags, status, joined_at, emailoctopus_updated_at)
  select distinct on (c.emailoctopus_id)
    c.emailoctopus_id, c.email,
    nullif(c.fields ->> 'FirstName', ''), nullif(c.fields ->> 'LastName', ''),
    coalesce(c.fields, '{}'), coalesce(c.tags, '{}'),
    c.status, min(c.joined_at) over (partition by c.emailoctopus_id), c.emailoctopus_updated_at
  from jsonb_to_recordset(contacts) as c(
    emailoctopus_id uuid, email text, fields jsonb, tags text[],
    status text, joined_at timestamptz, emailoctopus_updated_at timestamptz
  )
  order by c.emailoctopus_id, c.emailoctopus_updated_at desc
  -- a deleted contact keeps the details it had, so the row still says who it was
  on conflict (emailoctopus_id) do update set
    email = excluded.email,
    first_name = case when excluded.status = 'deleted' then w.first_name else excluded.first_name end,
    last_name = case when excluded.status = 'deleted' then w.last_name else excluded.last_name end,
    fields = case when excluded.status = 'deleted' then w.fields else excluded.fields end,
    tags = case when excluded.status = 'deleted' then w.tags else excluded.tags end,
    status = excluded.status,
    joined_at = coalesce(w.joined_at, excluded.joined_at),
    emailoctopus_updated_at = excluded.emailoctopus_updated_at
  where w.emailoctopus_updated_at <= excluded.emailoctopus_updated_at;
$$;

revoke execute on function public.upsert_waitlist_contacts(jsonb) from public, anon, authenticated;
