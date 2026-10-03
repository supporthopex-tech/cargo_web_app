-- TCAST shared backend — full schema for the Cargo App + public tracking.
-- Run this in the Supabase SQL editor (or `supabase db push`) on a fresh
-- project. Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE / DROP-then-
-- CREATE for policies throughout.
--
-- Design notes:
--  - Primary keys are `text`, not `uuid`. The Cargo App already generates its
--    own ids client-side (see src/lib/autoNumber.ts: generateId()), and
--    business-facing numbers (tracking numbers, receipt numbers, packing
--    list numbers) are generated the same way. Matching that instead of
--    switching to server-generated uuids keeps the existing business logic
--    untouched.
--  - `shipments.status_history` is a single `jsonb` array column, not a
--    separate child table. The app's `updateShipmentStatus` action already
--    treats status history as "append one event to an array on the
--    shipment" — jsonb mirrors that exactly instead of introducing a new
--    relational shape the app would have to be redesigned around.
--  - created_at/updated_at/date-ish columns are `text`, matching the exact
--    string formats the app already produces (todayDate(): 'YYYY-MM-DD',
--    nowISO(): 'YYYY-MM-DD HH:MM'). No date-parsing behavior changes.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- customers
-- ---------------------------------------------------------------------------
create table if not exists public.customers (
  id          text primary key,
  name        text not null,
  company     text not null default '',
  phone       text not null default '',
  email       text not null default '',
  address     text not null default '',
  city        text not null default '',
  notes       text,
  created_at  text not null,
  updated_at  text not null
);

-- ---------------------------------------------------------------------------
-- packing_lists
-- ---------------------------------------------------------------------------
create table if not exists public.packing_lists (
  id             text primary key,
  list_id        text not null unique,
  status         text not null default 'Draft' check (status in ('Draft','Dispatched')),
  shipment_ids   text[] not null default '{}',
  origin         text not null default '',
  destination    text not null default '',
  shipment_type  text not null check (shipment_type in ('Air Cargo','Sea Cargo')),
  notes          text,
  created_at     text not null,
  updated_at     text not null,
  dispatched_at  text,
  created_by     text not null
);

-- ---------------------------------------------------------------------------
-- shipments
-- ---------------------------------------------------------------------------
create table if not exists public.shipments (
  id                 text primary key,
  tracking_number    text not null unique,
  status             text not null default 'Received'
                       check (status in (
                         'Received','Processing','Packed','Dispatched',
                         'In Transit','Arrived','Ready for Collection',
                         'Delivered','On Hold'
                       )),
  shipment_type      text not null check (shipment_type in ('Air Cargo','Sea Cargo')),
  cargo_category     text not null,
  service_type       text not null,
  customer_id        text references public.customers (id) on delete set null,

  origin             text not null,
  destination        text not null,
  destination_city   text not null,
  description        text not null default '',

  weight_kg          numeric(10,2) not null default 0,
  volume_cbm         numeric(10,2) not null default 0,
  pcs                integer not null default 0,

  shipping_rate      text not null default '',
  base_rate          numeric(12,2) not null default 0,
  other_charges      numeric(12,2) not null default 0,
  discount           numeric(12,2) not null default 0,
  total_amount       numeric(12,2) not null default 0,
  amount_paid        numeric(12,2) not null default 0,
  currency           text not null default 'TZS' check (currency in ('TZS','USD','AED')),

  packing_list_id    text references public.packing_lists (id) on delete set null,
  notes              text,

  -- Array of StatusEvent: { status, location, timestamp, staff, note, isPublic }
  status_history     jsonb not null default '[]'::jsonb,

  created_by         text not null,
  created_at         text not null,
  updated_at         text not null
);

create index if not exists shipments_tracking_number_idx on public.shipments (tracking_number);
create index if not exists shipments_status_idx on public.shipments (status);
create index if not exists shipments_customer_id_idx on public.shipments (customer_id);
create index if not exists shipments_packing_list_id_idx on public.shipments (packing_list_id);

-- ---------------------------------------------------------------------------
-- payment_records
-- ---------------------------------------------------------------------------
create table if not exists public.payment_records (
  id               text primary key,
  receipt_number   text not null unique,
  shipment_id      text not null references public.shipments (id) on delete cascade,
  amount           numeric(12,2) not null,
  currency         text not null default 'TZS' check (currency in ('TZS','USD','AED')),
  method           text not null default '',
  date             text not null,
  note             text,
  created_at       text not null,
  created_by       text not null
);

create index if not exists payment_records_shipment_id_idx on public.payment_records (shipment_id);

-- ---------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------
create table if not exists public.expenses (
  id           text primary key,
  date         text not null,
  category     text not null,
  description  text not null default '',
  amount       numeric(12,2) not null,
  currency     text not null default 'TZS' check (currency in ('TZS','USD','AED')),
  reference    text,
  shipment_id  text references public.shipments (id) on delete set null,
  notes        text,
  created_at   text not null,
  created_by   text not null
);

create index if not exists expenses_shipment_id_idx on public.expenses (shipment_id);

-- ---------------------------------------------------------------------------
-- company_settings (single row)
-- ---------------------------------------------------------------------------
create table if not exists public.company_settings (
  id                              text primary key default 'default',
  company_name                    text not null,
  business_type                   text not null,
  default_currency                text not null check (default_currency in ('TZS','USD','AED')),
  default_origin                  text not null,
  default_destination_country     text not null,
  supported_destination_cities    text[] not null default '{}',
  address                         text not null default '',
  phone                           text not null default '',
  email                           text not null default '',
  website                         text not null default '',
  tax_id                          text not null default '',
  bank_name                       text not null default '',
  bank_account                    text not null default '',
  bank_swift                      text not null default '',
  terms_and_conditions            text not null default ''
);

-- ---------------------------------------------------------------------------
-- staff_profiles (role/name for Supabase Auth users — replaces the old
-- plaintext `users` array in useAuthStore)
-- ---------------------------------------------------------------------------
create table if not exists public.staff_profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  name        text not null,
  initials    text not null,
  role        text not null default 'Operations Staff' check (role in ('Admin','Manager','Operations Staff')),
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- auto-create a staff_profiles row whenever a new Supabase Auth user is
-- created (via the dashboard invite flow, or self-signup), always defaulting
-- to Operations Staff. User-editable metadata must never decide authorization;
-- Admins promote via the Staff Roles screen afterward.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.staff_profiles (id, email, name, initials, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'initials', upper(left(split_part(new.email, '@', 1), 2))),
    'Operations Staff'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_handle_new_auth_user on auth.users;
create trigger trg_handle_new_auth_user
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Backfill users created before this trigger existed. Every missing profile
-- starts at the least-privileged role; an Admin promotes it explicitly later.
insert into public.staff_profiles (id, email, name, initials, role)
select
  user_row.id,
  user_row.email,
  coalesce(user_row.raw_user_meta_data ->> 'name', split_part(user_row.email, '@', 1)),
  coalesce(user_row.raw_user_meta_data ->> 'initials', upper(left(split_part(user_row.email, '@', 1), 2))),
  'Operations Staff'
from auth.users as user_row
where user_row.email is not null
on conflict (id) do nothing;

-- keep updated_at-style bookkeeping simple: the app sets updated_at itself
-- on every write (see useAppStore.ts), so no DB-side triggers are needed.

-- Looks up the calling user's own role. Not security definer — it relies on
-- "staff can read profiles" below (open to all authenticated) to read
-- staff_profiles, same as the inline admin-check subqueries elsewhere in
-- this file, so there's no RLS recursion risk.
create or replace function public.staff_role()
returns text
language sql
stable
set search_path = public
as $$
  select role from public.staff_profiles where id = auth.uid()
$$;

-- ---------------------------------------------------------------------------
-- Row Level Security — authenticated staff only on every business table,
-- with role-aware policies on the tables the app's UI already treats as
-- Admin/Manager-only (expenses, company settings). customers, shipments,
-- packing_lists and payment_records stay open to every authenticated role
-- because every role already uses those screens day-to-day in the app.
-- The publishable key has NO direct table access; public tracking goes
-- through the track_shipment() function below instead, so the anon key
-- can never list/enumerate shipments, customers, payments, etc.
-- ---------------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.packing_lists enable row level security;
alter table public.shipments enable row level security;
alter table public.payment_records enable row level security;
alter table public.expenses enable row level security;
alter table public.company_settings enable row level security;
alter table public.staff_profiles enable row level security;

drop policy if exists "staff full access" on public.customers;
create policy "staff full access" on public.customers for all to authenticated using (true) with check (true);

drop policy if exists "staff full access" on public.packing_lists;
create policy "staff full access" on public.packing_lists for all to authenticated using (true) with check (true);

drop policy if exists "staff full access" on public.shipments;
create policy "staff full access" on public.shipments for all to authenticated using (true) with check (true);

drop policy if exists "staff full access" on public.payment_records;
create policy "staff full access" on public.payment_records for all to authenticated using (true) with check (true);

-- Expenses: Admin/Manager only, matching the Expenses screen's existing
-- Admin-only gating (now Admin+Manager) — Operations Staff has never had
-- any UI path to this data.
drop policy if exists "staff full access" on public.expenses;
drop policy if exists "admin manager full access" on public.expenses;
create policy "admin manager full access" on public.expenses for all to authenticated
  using (public.staff_role() in ('Admin','Manager'))
  with check (public.staff_role() in ('Admin','Manager'));

-- Company settings: every role reads this (Dashboard/CreateShipment use it
-- for default currency, origin, destination cities, etc.), but only
-- Admin/Manager can change it, matching the Settings screen's gating.
drop policy if exists "staff full access" on public.company_settings;
drop policy if exists "all staff can read settings" on public.company_settings;
create policy "all staff can read settings" on public.company_settings for select to authenticated using (true);
drop policy if exists "admin manager can insert settings" on public.company_settings;
create policy "admin manager can insert settings" on public.company_settings for insert to authenticated
  with check (public.staff_role() in ('Admin','Manager'));
drop policy if exists "admin manager can update settings" on public.company_settings;
create policy "admin manager can update settings" on public.company_settings for update to authenticated
  using (public.staff_role() in ('Admin','Manager')) with check (public.staff_role() in ('Admin','Manager'));
drop policy if exists "admin manager can delete settings" on public.company_settings;
create policy "admin manager can delete settings" on public.company_settings for delete to authenticated
  using (public.staff_role() in ('Admin','Manager'));

drop policy if exists "staff can read profiles" on public.staff_profiles;
create policy "staff can read profiles" on public.staff_profiles for select to authenticated using (true);

drop policy if exists "staff can update own profile" on public.staff_profiles;
create policy "staff can update own profile" on public.staff_profiles for update to authenticated
  using (id = auth.uid());

drop policy if exists "admins can update any profile" on public.staff_profiles;
create policy "admins can update any profile" on public.staff_profiles for update to authenticated
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.role = 'Admin'));

drop policy if exists "admins can delete profiles" on public.staff_profiles;
create policy "admins can delete profiles" on public.staff_profiles for delete to authenticated
  using (exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.role = 'Admin'));

-- Guard against privilege escalation: "staff can update own profile" above
-- has no WITH CHECK, so on its own it would let any authenticated user set
-- role='Admin' (or active=true) on their own row via a direct API call —
-- RLS only checks that the row being touched is still theirs, not which
-- columns changed. This trigger closes that gap: a non-admin updating their
-- own row cannot change role or active; admins are unaffected (including
-- editing their own row), and admin edits of *other* profiles go through
-- the separate "admins can update any profile" policy, untouched.
create or replace function public.staff_profiles_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() = old.id then
    if not exists (select 1 from public.staff_profiles sp where sp.id = auth.uid() and sp.role = 'Admin') then
      if new.role is distinct from old.role then
        raise exception 'Only an Admin can change a staff role.';
      end if;
      if new.active is distinct from old.active then
        raise exception 'Only an Admin can change account status.';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_staff_profiles_guard_self_update on public.staff_profiles;
create trigger trg_staff_profiles_guard_self_update
  before update on public.staff_profiles
  for each row execute function public.staff_profiles_guard_self_update();

-- ---------------------------------------------------------------------------
-- Public tracking — a single SECURITY DEFINER function, NOT a table grant.
-- Looking up one exact tracking number is safe to expose to anon; opening
-- SELECT on the shipments table itself would let anyone with the
-- publishable key dump every customer's shipment data.
-- ---------------------------------------------------------------------------
create or replace function public.track_shipment(p_tracking_number text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_shipment shipments%rowtype;
  v_receiver_name text;
  v_result jsonb;
begin
  select * into v_shipment from shipments where tracking_number = p_tracking_number;
  if not found then
    return null;
  end if;

  select name into v_receiver_name from customers where id = v_shipment.customer_id;

  select jsonb_build_object(
    'shipmentNumber', v_shipment.tracking_number,
    'status', v_shipment.status,
    'origin', v_shipment.origin,
    'destination', v_shipment.destination_city || ', ' || v_shipment.destination,
    'currentLocation', coalesce(
      (select event ->> 'location'
       from jsonb_array_elements(v_shipment.status_history) as event
       where coalesce((event ->> 'isPublic')::boolean, false) is true
       order by (event ->> 'timestamp') desc
       limit 1),
      v_shipment.destination_city
    ),
    'receiver', coalesce(v_receiver_name, '—'),
    'weightKg', v_shipment.weight_kg,
    'pcs', v_shipment.pcs,
    'lastUpdate', v_shipment.updated_at,
    'history', coalesce(
      (select jsonb_agg(
         jsonb_build_object(
           'status', event ->> 'status',
           'location', event ->> 'location',
           'time', event ->> 'timestamp',
           'description', event ->> 'note'
         )
         order by (event ->> 'timestamp') desc
       )
       from jsonb_array_elements(v_shipment.status_history) as event
       where (event ->> 'isPublic')::boolean is true),
      '[]'::jsonb
    )
  ) into v_result;

  return v_result;
end;
$$;

revoke all on function public.track_shipment(text) from public;
grant execute on function public.track_shipment(text) to anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime — lets the Cargo App subscribe to live changes if/when desired.
-- ---------------------------------------------------------------------------
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'shipments', 'customers', 'packing_lists', 'payment_records', 'expenses'
  ] loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = table_name
    ) then
      execute format('alter publication supabase_realtime add table public.%I', table_name);
    end if;
  end loop;
end;
$$;
