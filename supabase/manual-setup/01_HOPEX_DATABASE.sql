-- HOPEX EXPRESS CARGO: NEW EMPTY SUPABASE PROJECT ONLY.
-- Paste the ENTIRE file into SQL Editor and Run once as postgres.
-- Includes all 22 migrations in order; no customer/payment/staff data import.
-- One transaction: an error rolls back this setup.
-- SQL syntax is checked locally; execution on your project is not yet verified.
begin;
do $hopex_guard$
begin
  if exists (select 1 from pg_tables where schemaname = 'public') then
    raise exception 'Hopex setup requires a NEW EMPTY project. Public tables already exist; nothing was applied.';
  end if;
  if to_regclass('auth.users') is null or to_regclass('storage.buckets') is null then
    raise exception 'Supabase Auth/Storage schemas are required.';
  end if;
end;
$hopex_guard$;


-- MIGRATION 01/22: 0001_shipments_and_auth.sql
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


-- MIGRATION 02/22: 20260808172013_shipping_rates_fx_and_invoice_snapshots.sql
-- TCAST pricing, multi-item cargo and immutable invoice snapshots.
-- Additive migration: existing shipments, payments and customer data remain intact.

create table if not exists public.shipping_rates (
  id uuid primary key default gen_random_uuid(),
  shipping_method text not null check (shipping_method in ('Air Cargo','Sea Cargo')),
  currency text not null default 'USD' check (currency = 'USD'),
  pricing_unit text not null check (pricing_unit in ('KG','CBM')),
  rate numeric(14,6) not null check (rate > 0),
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  created_by uuid references public.staff_profiles (id) on delete set null,
  updated_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (shipping_method = 'Air Cargo' and pricing_unit = 'KG') or
    (shipping_method = 'Sea Cargo' and pricing_unit = 'CBM')
  ),
  check (effective_to is null or effective_to >= effective_from)
);

create unique index if not exists shipping_rates_one_active_method_idx
  on public.shipping_rates (shipping_method) where is_active;
create index if not exists shipping_rates_effective_idx
  on public.shipping_rates (shipping_method, effective_from desc);

create table if not exists public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  rate_date date not null,
  base_currency text not null default 'USD' check (base_currency = 'USD'),
  usd_to_tzs numeric(18,6) not null check (usd_to_tzs > 0),
  usd_to_aed numeric(18,6) not null check (usd_to_aed > 0),
  source text not null default 'MANUAL' check (source in ('MANUAL','API','OVERRIDE')),
  notes text,
  created_by uuid references public.staff_profiles (id) on delete set null,
  updated_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (rate_date, base_currency)
);

create index if not exists exchange_rates_date_idx
  on public.exchange_rates (rate_date desc);

create table if not exists public.shipment_items (
  id uuid primary key default gen_random_uuid(),
  shipment_id text not null references public.shipments (id) on delete cascade,
  item_number integer not null check (item_number > 0),
  description text not null check (btrim(description) <> ''),
  quantity numeric(14,3) not null check (quantity > 0),
  unit text not null check (unit in ('PCS','BOX','CARTON','BAG','SET','PALLET','UNIT','OTHER')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (shipment_id, item_number)
);

create index if not exists shipment_items_shipment_id_idx
  on public.shipment_items (shipment_id, sort_order);

create table if not exists public.rate_change_audit (
  id bigint generated always as identity primary key,
  event_type text not null check (event_type in (
    'SHIPPING_RATE_CREATED','SHIPPING_RATE_CHANGED',
    'EXCHANGE_RATE_CREATED','EXCHANGE_RATE_CHANGED','SHIPMENT_RATE_OVERRIDE'
  )),
  entity_type text not null,
  entity_id text not null,
  affected_date date,
  old_value jsonb,
  new_value jsonb not null,
  changed_by uuid references public.staff_profiles (id) on delete set null,
  changed_at timestamptz not null default now()
);

create index if not exists rate_change_audit_changed_at_idx
  on public.rate_change_audit (changed_at desc);

alter table public.company_settings
  add column if not exists exchange_rate_policy text not null default 'REQUIRE_TODAY'
  check (exchange_rate_policy in ('REQUIRE_TODAY','LATEST_APPROVED'));

alter table public.shipments
  add column if not exists customer_name_snapshot text,
  add column if not exists customer_phone_snapshot text,
  add column if not exists customer_email_snapshot text,
  add column if not exists pricing_unit text check (pricing_unit in ('KG','CBM')),
  add column if not exists standard_rate_usd numeric(14,6),
  add column if not exists applied_rate_usd numeric(14,6),
  add column if not exists rate_overridden boolean not null default false,
  add column if not exists override_reason text,
  add column if not exists overridden_by uuid references public.staff_profiles (id) on delete set null,
  add column if not exists override_timestamp timestamptz,
  add column if not exists base_currency text default 'USD' check (base_currency = 'USD'),
  add column if not exists base_amount_usd numeric(16,2),
  add column if not exists usd_to_tzs_rate_used numeric(18,6),
  add column if not exists usd_to_aed_rate_used numeric(18,6),
  add column if not exists selected_exchange_rate numeric(18,6),
  add column if not exists exchange_rate_date date,
  add column if not exists invoice_currency text check (invoice_currency in ('USD','TZS','AED')),
  add column if not exists invoice_amount numeric(18,2),
  add column if not exists invoice_number text,
  add column if not exists invoice_finalized_at timestamptz;

create unique index if not exists shipments_invoice_number_idx
  on public.shipments (invoice_number) where invoice_number is not null;

alter table public.shipping_rates enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.shipment_items enable row level security;
alter table public.rate_change_audit enable row level security;

grant select, insert, update, delete on public.shipping_rates to authenticated;
grant select, insert, update, delete on public.exchange_rates to authenticated;
grant select, insert, update, delete on public.shipment_items to authenticated;
grant select on public.rate_change_audit to authenticated;
grant usage, select on sequence public.rate_change_audit_id_seq to authenticated;

drop policy if exists "staff can read shipping rates" on public.shipping_rates;
create policy "staff can read shipping rates" on public.shipping_rates
  for select to authenticated using (true);
drop policy if exists "management can insert shipping rates" on public.shipping_rates;
create policy "management can insert shipping rates" on public.shipping_rates
  for insert to authenticated
  with check (public.staff_role() in ('Admin','Manager'));
drop policy if exists "management can update shipping rates" on public.shipping_rates;
create policy "management can update shipping rates" on public.shipping_rates
  for update to authenticated
  using (public.staff_role() in ('Admin','Manager'))
  with check (public.staff_role() in ('Admin','Manager'));
drop policy if exists "management can delete shipping rates" on public.shipping_rates;
create policy "management can delete shipping rates" on public.shipping_rates
  for delete to authenticated
  using (public.staff_role() in ('Admin','Manager'));

drop policy if exists "staff can read exchange rates" on public.exchange_rates;
create policy "staff can read exchange rates" on public.exchange_rates
  for select to authenticated using (true);
drop policy if exists "management can insert exchange rates" on public.exchange_rates;
create policy "management can insert exchange rates" on public.exchange_rates
  for insert to authenticated
  with check (public.staff_role() in ('Admin','Manager'));
drop policy if exists "management can update exchange rates" on public.exchange_rates;
create policy "management can update exchange rates" on public.exchange_rates
  for update to authenticated
  using (public.staff_role() in ('Admin','Manager'))
  with check (public.staff_role() in ('Admin','Manager'));
drop policy if exists "management can delete exchange rates" on public.exchange_rates;
create policy "management can delete exchange rates" on public.exchange_rates
  for delete to authenticated
  using (public.staff_role() in ('Admin','Manager'));

drop policy if exists "staff full access" on public.shipment_items;
create policy "staff full access" on public.shipment_items
  for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

drop policy if exists "management can read rate audit" on public.rate_change_audit;
create policy "management can read rate audit" on public.rate_change_audit
  for select to authenticated
  using (public.staff_role() in ('Admin','Manager'));

create or replace function public.set_shipping_rate(
  p_shipping_method text,
  p_rate numeric,
  p_effective_from date
)
returns public.shipping_rates
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_result public.shipping_rates;
  v_unit text;
begin
  if public.staff_role() not in ('Admin','Manager') then
    raise exception 'Only Admin or Manager can update shipping rates.';
  end if;
  if p_shipping_method not in ('Air Cargo','Sea Cargo') or p_rate <= 0 then
    raise exception 'A valid shipping method and positive rate are required.';
  end if;

  v_unit := case when p_shipping_method = 'Air Cargo' then 'KG' else 'CBM' end;

  update public.shipping_rates
  set is_active = false,
      effective_to = greatest(effective_from, p_effective_from - 1),
      updated_by = auth.uid(),
      updated_at = now()
  where shipping_method = p_shipping_method and is_active;

  insert into public.shipping_rates (
    shipping_method, currency, pricing_unit, rate, effective_from,
    is_active, created_by, updated_by
  ) values (
    p_shipping_method, 'USD', v_unit, p_rate, p_effective_from,
    true, auth.uid(), auth.uid()
  ) returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.set_shipping_rate(text,numeric,date) from public;
grant execute on function public.set_shipping_rate(text,numeric,date) to authenticated;

create or replace function public.audit_rate_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event text;
  v_entity text;
  v_date date;
begin
  if tg_table_name = 'shipping_rates' then
    v_event := case when tg_op = 'INSERT' then 'SHIPPING_RATE_CREATED' else 'SHIPPING_RATE_CHANGED' end;
    v_entity := 'shipping_rate';
    v_date := new.effective_from;
  else
    v_event := case when tg_op = 'INSERT' then 'EXCHANGE_RATE_CREATED' else 'EXCHANGE_RATE_CHANGED' end;
    v_entity := 'exchange_rate';
    v_date := new.rate_date;
  end if;

  insert into public.rate_change_audit (
    event_type, entity_type, entity_id, affected_date,
    old_value, new_value, changed_by
  ) values (
    v_event, v_entity, new.id::text, v_date,
    case when tg_op = 'UPDATE' then to_jsonb(old) else null end,
    to_jsonb(new), auth.uid()
  );
  return new;
end;
$$;

revoke all on function public.audit_rate_change() from public, anon, authenticated;

drop trigger if exists trg_audit_shipping_rate on public.shipping_rates;
create trigger trg_audit_shipping_rate
  after insert or update on public.shipping_rates
  for each row execute function public.audit_rate_change();

drop trigger if exists trg_audit_exchange_rate on public.exchange_rates;
create trigger trg_audit_exchange_rate
  after insert or update on public.exchange_rates
  for each row execute function public.audit_rate_change();

create or replace function public.guard_shipment_pricing_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.rate_overridden then
    if public.staff_role() not in ('Admin','Manager') then
      raise exception 'Only Admin or Manager can override a shipment rate.';
    end if;
    if new.override_reason is null or btrim(new.override_reason) = '' then
      raise exception 'An override reason is required.';
    end if;
    new.overridden_by := coalesce(new.overridden_by, auth.uid());
    new.override_timestamp := coalesce(new.override_timestamp, now());
  elsif new.standard_rate_usd is not null and new.applied_rate_usd is distinct from new.standard_rate_usd then
    raise exception 'A changed applied rate must be recorded as an authorized override.';
  end if;

  if new.invoice_finalized_at is not null then
    if new.base_amount_usd is null or new.invoice_currency is null or new.invoice_amount is null then
      raise exception 'A finalized invoice requires base amount, invoice currency and invoice amount snapshots.';
    end if;
    if new.invoice_currency = 'TZS' and new.usd_to_tzs_rate_used is null then
      raise exception 'A TZS invoice requires the USD/TZS rate snapshot.';
    end if;
    if new.invoice_currency = 'AED' and new.usd_to_aed_rate_used is null then
      raise exception 'An AED invoice requires the USD/AED rate snapshot.';
    end if;
  end if;

  if tg_op = 'UPDATE' and old.invoice_finalized_at is not null and (
    new.customer_name_snapshot is distinct from old.customer_name_snapshot or
    new.customer_phone_snapshot is distinct from old.customer_phone_snapshot or
    new.customer_email_snapshot is distinct from old.customer_email_snapshot or
    new.shipment_type is distinct from old.shipment_type or
    new.description is distinct from old.description or
    new.weight_kg is distinct from old.weight_kg or
    new.volume_cbm is distinct from old.volume_cbm or
    new.pcs is distinct from old.pcs or
    new.pricing_unit is distinct from old.pricing_unit or
    new.standard_rate_usd is distinct from old.standard_rate_usd or
    new.applied_rate_usd is distinct from old.applied_rate_usd or
    new.rate_overridden is distinct from old.rate_overridden or
    new.override_reason is distinct from old.override_reason or
    new.base_currency is distinct from old.base_currency or
    new.base_amount_usd is distinct from old.base_amount_usd or
    new.usd_to_tzs_rate_used is distinct from old.usd_to_tzs_rate_used or
    new.usd_to_aed_rate_used is distinct from old.usd_to_aed_rate_used or
    new.selected_exchange_rate is distinct from old.selected_exchange_rate or
    new.exchange_rate_date is distinct from old.exchange_rate_date or
    new.invoice_currency is distinct from old.invoice_currency or
    new.invoice_amount is distinct from old.invoice_amount or
    new.invoice_number is distinct from old.invoice_number or
    new.invoice_finalized_at is distinct from old.invoice_finalized_at
  ) then
    raise exception 'Finalized invoice pricing snapshots are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_shipment_pricing_snapshot() from public, anon, authenticated;

drop trigger if exists trg_guard_shipment_pricing_snapshot on public.shipments;
create trigger trg_guard_shipment_pricing_snapshot
  before insert or update on public.shipments
  for each row execute function public.guard_shipment_pricing_snapshot();

create or replace function public.guard_finalized_shipment_items()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_shipment_id text;
begin
  v_shipment_id := case when tg_op = 'DELETE' then old.shipment_id else new.shipment_id end;
  if exists (
    select 1 from public.shipments
    where id = v_shipment_id and invoice_finalized_at is not null
  ) then
    raise exception 'Cargo items on a finalized invoice are immutable.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_finalized_shipment_items() from public, anon, authenticated;

drop trigger if exists trg_guard_finalized_shipment_items on public.shipment_items;
create trigger trg_guard_finalized_shipment_items
  before insert or update or delete on public.shipment_items
  for each row execute function public.guard_finalized_shipment_items();

create or replace function public.audit_shipment_rate_override()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.rate_overridden and (
    tg_op = 'INSERT' or
    old.rate_overridden is distinct from new.rate_overridden or
    old.applied_rate_usd is distinct from new.applied_rate_usd
  ) then
    insert into public.rate_change_audit (
      event_type, entity_type, entity_id, old_value, new_value, changed_by
    ) values (
      'SHIPMENT_RATE_OVERRIDE', 'shipment', new.id,
      case when tg_op = 'UPDATE' then jsonb_build_object(
        'standard_rate_usd', old.standard_rate_usd,
        'applied_rate_usd', old.applied_rate_usd,
        'rate_overridden', old.rate_overridden
      ) else null end,
      jsonb_build_object(
        'standard_rate_usd', new.standard_rate_usd,
        'applied_rate_usd', new.applied_rate_usd,
        'reason', new.override_reason
      ),
      auth.uid()
    );
  end if;
  return new;
end;
$$;

revoke all on function public.audit_shipment_rate_override() from public, anon, authenticated;

drop trigger if exists trg_audit_shipment_rate_override on public.shipments;
create trigger trg_audit_shipment_rate_override
  after insert or update on public.shipments
  for each row execute function public.audit_shipment_rate_override();


-- MIGRATION 03/22: 20260808173840_harden_shipment_item_policy.sql
-- Keep shipment item access limited to an active authenticated session without
-- using a linter-ambiguous always-true write policy.
drop policy if exists "staff full access" on public.shipment_items;
create policy "staff full access" on public.shipment_items
  for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);


-- MIGRATION 04/22: 20260809145324_item_qr_packing_allocations.sql
-- Item-level QR identities and Packing List box allocations.
-- This migration extends the existing shipment_items and packing_lists models;
-- it does not change pricing, invoices, or shipment quantities.

alter table public.company_settings
  add column if not exists default_item_sticker_size text not null default '60x40';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'company_settings_item_sticker_size_check'
      and conrelid = 'public.company_settings'::regclass
  ) then
    alter table public.company_settings
      add constraint company_settings_item_sticker_size_check
      check (default_item_sticker_size in ('50x30','60x40','100x50'));
  end if;
end $$;

alter table public.shipment_items
  add column if not exists item_code text,
  add column if not exists qr_token uuid default gen_random_uuid(),
  add column if not exists qr_created_at timestamptz default now();

-- Historical finalized invoices already have immutable shipment items. Suspend
-- that existing guard only for this controlled identity backfill; the whole
-- migration is transactional and the trigger is restored immediately.
alter table public.shipment_items disable trigger trg_guard_finalized_shipment_items;

update public.shipment_items as item
set item_code = shipment.tracking_number || '-' || lpad(item.item_number::text, 2, '0'),
    qr_token = coalesce(item.qr_token, gen_random_uuid()),
    qr_created_at = coalesce(item.qr_created_at, item.created_at, now())
from public.shipments as shipment
where shipment.id = item.shipment_id
  and item.item_code is null;

alter table public.shipment_items enable trigger trg_guard_finalized_shipment_items;

alter table public.shipment_items
  alter column item_code set not null,
  alter column qr_token set not null,
  alter column qr_created_at set not null;

create unique index if not exists shipment_items_item_code_uidx
  on public.shipment_items (item_code);
create unique index if not exists shipment_items_qr_token_uidx
  on public.shipment_items (qr_token);

create or replace function public.ensure_shipment_item_identity()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_tracking_number text;
begin
  if tg_op = 'UPDATE' then
    new.item_code := old.item_code;
    new.qr_token := old.qr_token;
    new.qr_created_at := old.qr_created_at;
    return new;
  end if;

  select tracking_number into v_tracking_number
  from public.shipments
  where id = new.shipment_id;

  if v_tracking_number is null then
    raise exception 'Shipment tracking number is required before creating cargo items.';
  end if;

  new.item_code := coalesce(
    nullif(btrim(new.item_code), ''),
    v_tracking_number || '-' || lpad(new.item_number::text, 2, '0')
  );
  new.qr_token := coalesce(new.qr_token, gen_random_uuid());
  new.qr_created_at := coalesce(new.qr_created_at, now());
  return new;
end;
$$;

revoke all on function public.ensure_shipment_item_identity() from public, anon, authenticated;

drop trigger if exists trg_ensure_shipment_item_identity on public.shipment_items;
create trigger trg_ensure_shipment_item_identity
  before insert or update on public.shipment_items
  for each row execute function public.ensure_shipment_item_identity();

create table if not exists public.packing_boxes (
  id uuid primary key default gen_random_uuid(),
  packing_list_id text not null references public.packing_lists (id) on delete cascade,
  box_number integer not null check (box_number > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (packing_list_id, box_number),
  unique (id, packing_list_id)
);

create table if not exists public.packing_list_items (
  id uuid primary key default gen_random_uuid(),
  packing_list_id text not null references public.packing_lists (id) on delete cascade,
  box_id uuid not null,
  shipment_item_id uuid not null references public.shipment_items (id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (box_id, shipment_item_id),
  constraint packing_list_items_box_list_fk
    foreign key (box_id, packing_list_id)
    references public.packing_boxes (id, packing_list_id)
    on delete cascade
);

create index if not exists packing_boxes_list_idx
  on public.packing_boxes (packing_list_id, box_number);
create index if not exists packing_list_items_list_idx
  on public.packing_list_items (packing_list_id);
create index if not exists packing_list_items_item_idx
  on public.packing_list_items (shipment_item_id);

insert into public.packing_boxes (packing_list_id, box_number)
select id, 1 from public.packing_lists
on conflict (packing_list_id, box_number) do nothing;

alter table public.packing_boxes enable row level security;
alter table public.packing_list_items enable row level security;

grant select on public.packing_boxes to authenticated;
grant select on public.packing_list_items to authenticated;

drop policy if exists "active staff can read packing boxes" on public.packing_boxes;
create policy "active staff can read packing boxes" on public.packing_boxes
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1 from public.staff_profiles
      where id = (select auth.uid()) and active
    )
  );

drop policy if exists "active staff can read packing allocations" on public.packing_list_items;
create policy "active staff can read packing allocations" on public.packing_list_items
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1 from public.staff_profiles
      where id = (select auth.uid()) and active
    )
  );

create or replace function public.assert_active_staff()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.staff_profiles
    where id = auth.uid() and active
  ) then
    raise exception 'An active staff session is required.';
  end if;
end;
$$;

revoke all on function public.assert_active_staff() from public, anon, authenticated;

create or replace function public.create_packing_box(
  p_packing_list_id text,
  p_box_number integer default null
)
returns public.packing_boxes
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_box_number integer;
  v_result public.packing_boxes%rowtype;
begin
  perform public.assert_active_staff();

  select status into v_status
  from public.packing_lists
  where id = p_packing_list_id
  for update;

  if v_status is null then raise exception 'Packing List not found.'; end if;
  if v_status <> 'Draft' then raise exception 'Only Draft Packing Lists can be edited.'; end if;

  if p_box_number is not null and p_box_number <= 0 then
    raise exception 'Box number must be greater than zero.';
  end if;

  select coalesce(p_box_number, coalesce(max(box_number), 0) + 1)
  into v_box_number
  from public.packing_boxes
  where packing_list_id = p_packing_list_id;

  insert into public.packing_boxes (packing_list_id, box_number, created_by)
  values (p_packing_list_id, v_box_number, auth.uid())
  returning * into v_result;

  return v_result;
end;
$$;

revoke all on function public.create_packing_box(text, integer) from public, anon;
grant execute on function public.create_packing_box(text, integer) to authenticated;

create or replace function public.upsert_packing_allocation(
  p_box_id uuid,
  p_shipment_item_id uuid,
  p_quantity numeric,
  p_operation text default 'ADD'
)
returns public.packing_list_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.shipment_items%rowtype;
  v_list_id text;
  v_list_status text;
  v_current numeric(14,3) := 0;
  v_allocated numeric(14,3) := 0;
  v_delta numeric(14,3);
  v_available numeric(14,3);
  v_new_quantity numeric(14,3);
  v_result public.packing_list_items%rowtype;
begin
  perform public.assert_active_staff();
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero.'; end if;
  if upper(p_operation) not in ('ADD','SET') then raise exception 'Unsupported allocation operation.'; end if;

  select * into v_item
  from public.shipment_items
  where id = p_shipment_item_id
  for update;
  if v_item.id is null then raise exception 'Shipment item not found.'; end if;

  select box.packing_list_id, list.status
  into v_list_id, v_list_status
  from public.packing_boxes as box
  join public.packing_lists as list on list.id = box.packing_list_id
  where box.id = p_box_id
  for update of box, list;

  if v_list_id is null then raise exception 'Packing box not found.'; end if;
  if v_list_status <> 'Draft' then raise exception 'Only Draft Packing Lists can be edited.'; end if;

  select coalesce(quantity, 0) into v_current
  from public.packing_list_items
  where box_id = p_box_id and shipment_item_id = p_shipment_item_id
  for update;
  v_current := coalesce(v_current, 0);

  select coalesce(sum(allocation.quantity), 0) into v_allocated
  from public.packing_list_items as allocation
  join public.packing_lists as list on list.id = allocation.packing_list_id
  where allocation.shipment_item_id = p_shipment_item_id
    and list.status in ('Draft','Dispatched');

  v_available := v_item.quantity - v_allocated;
  v_new_quantity := case when upper(p_operation) = 'SET' then p_quantity else v_current + p_quantity end;
  v_delta := v_new_quantity - v_current;

  if v_delta > v_available then
    raise exception 'Only % % are available for this item.',
      trim(to_char(greatest(v_available, 0), 'FM999999999990.###')),
      v_item.unit;
  end if;

  insert into public.packing_list_items (
    packing_list_id, box_id, shipment_item_id, quantity, created_by
  ) values (
    v_list_id, p_box_id, p_shipment_item_id, v_new_quantity, auth.uid()
  )
  on conflict (box_id, shipment_item_id) do update
    set quantity = excluded.quantity,
        updated_at = now()
  returning * into v_result;

  update public.packing_lists
  set shipment_ids = case
        when v_item.shipment_id = any(shipment_ids) then shipment_ids
        else array_append(shipment_ids, v_item.shipment_id)
      end,
      updated_at = current_date::text
  where id = v_list_id;

  update public.shipments
  set packing_list_id = coalesce(packing_list_id, v_list_id)
  where id = v_item.shipment_id;

  return v_result;
end;
$$;

revoke all on function public.upsert_packing_allocation(uuid, uuid, numeric, text) from public, anon;
grant execute on function public.upsert_packing_allocation(uuid, uuid, numeric, text) to authenticated;

create or replace function public.remove_packing_allocation(p_allocation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allocation public.packing_list_items%rowtype;
  v_shipment_id text;
  v_status text;
begin
  perform public.assert_active_staff();

  select * into v_allocation
  from public.packing_list_items
  where id = p_allocation_id;
  if v_allocation.id is null then raise exception 'Packing allocation not found.'; end if;

  perform 1 from public.shipment_items where id = v_allocation.shipment_item_id for update;
  select status into v_status from public.packing_lists
  where id = v_allocation.packing_list_id for update;
  if v_status <> 'Draft' then raise exception 'Only Draft Packing Lists can be edited.'; end if;

  select shipment_id into v_shipment_id
  from public.shipment_items
  where id = v_allocation.shipment_item_id;

  delete from public.packing_list_items where id = p_allocation_id;

  if not exists (
    select 1
    from public.packing_list_items as allocation
    join public.shipment_items as item on item.id = allocation.shipment_item_id
    where allocation.packing_list_id = v_allocation.packing_list_id
      and item.shipment_id = v_shipment_id
  ) then
    update public.packing_lists
    set shipment_ids = array_remove(shipment_ids, v_shipment_id),
        updated_at = current_date::text
    where id = v_allocation.packing_list_id;

    update public.shipments
    set packing_list_id = null
    where id = v_shipment_id and packing_list_id = v_allocation.packing_list_id;
  end if;
end;
$$;

revoke all on function public.remove_packing_allocation(uuid) from public, anon;
grant execute on function public.remove_packing_allocation(uuid) to authenticated;

create or replace function public.move_packing_allocation(
  p_allocation_id uuid,
  p_to_box_id uuid,
  p_quantity numeric
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_source public.packing_list_items%rowtype;
  v_target_list_id text;
  v_status text;
begin
  perform public.assert_active_staff();
  if p_quantity is null or p_quantity <= 0 then raise exception 'Move quantity must be greater than zero.'; end if;

  select * into v_source from public.packing_list_items where id = p_allocation_id;
  if v_source.id is null then raise exception 'Packing allocation not found.'; end if;
  if v_source.box_id = p_to_box_id then raise exception 'Choose a different destination box.'; end if;

  perform 1 from public.shipment_items where id = v_source.shipment_item_id for update;
  select * into v_source from public.packing_list_items where id = p_allocation_id for update;

  select box.packing_list_id, list.status
  into v_target_list_id, v_status
  from public.packing_boxes as box
  join public.packing_lists as list on list.id = box.packing_list_id
  where box.id = p_to_box_id
  for update of box, list;

  if v_target_list_id is null then raise exception 'Destination box not found.'; end if;
  if v_target_list_id <> v_source.packing_list_id then
    raise exception 'Items can only be moved between boxes in the same Packing List.';
  end if;
  if v_status <> 'Draft' then raise exception 'Only Draft Packing Lists can be edited.'; end if;
  if p_quantity > v_source.quantity then
    raise exception 'Only % can be moved from this box.', trim(to_char(v_source.quantity, 'FM999999999990.###'));
  end if;

  insert into public.packing_list_items (
    packing_list_id, box_id, shipment_item_id, quantity, created_by
  ) values (
    v_source.packing_list_id, p_to_box_id, v_source.shipment_item_id, p_quantity, auth.uid()
  )
  on conflict (box_id, shipment_item_id) do update
    set quantity = public.packing_list_items.quantity + excluded.quantity,
        updated_at = now();

  if p_quantity = v_source.quantity then
    delete from public.packing_list_items where id = v_source.id;
  else
    update public.packing_list_items
    set quantity = quantity - p_quantity,
        updated_at = now()
    where id = v_source.id;
  end if;
end;
$$;

revoke all on function public.move_packing_allocation(uuid, uuid, numeric) from public, anon;
grant execute on function public.move_packing_allocation(uuid, uuid, numeric) to authenticated;

create or replace function public.guard_finalized_shipment_items()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_shipment_id text;
  v_allocated numeric(14,3) := 0;
begin
  v_shipment_id := case when tg_op = 'DELETE' then old.shipment_id else new.shipment_id end;

  if exists (
    select 1 from public.shipments
    where id = v_shipment_id and invoice_finalized_at is not null
  ) then
    raise exception 'Cargo items on a finalized invoice are immutable.';
  end if;

  if tg_op = 'DELETE' and exists (
    select 1 from public.packing_list_items where shipment_item_id = old.id
  ) then
    raise exception 'This item is already used in a Packing List and cannot be deleted.';
  end if;

  if tg_op = 'UPDATE' and new.quantity <> old.quantity then
    select coalesce(sum(allocation.quantity), 0) into v_allocated
    from public.packing_list_items as allocation
    join public.packing_lists as list on list.id = allocation.packing_list_id
    where allocation.shipment_item_id = old.id
      and list.status in ('Draft','Dispatched');

    if new.quantity < v_allocated then
      raise exception 'This item already has % % allocated to Packing Lists. Quantity cannot be reduced below % %.',
        trim(to_char(v_allocated, 'FM999999999990.###')), old.unit,
        trim(to_char(v_allocated, 'FM999999999990.###')), old.unit;
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_finalized_shipment_items() from public, anon, authenticated;

create or replace function public.guard_packing_list_lock()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.status = 'Dispatched' then
    raise exception 'Dispatched Packing Lists are locked.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_packing_list_lock() from public, anon, authenticated;

drop trigger if exists trg_guard_packing_list_lock on public.packing_lists;
create trigger trg_guard_packing_list_lock
  before update or delete on public.packing_lists
  for each row execute function public.guard_packing_list_lock();

create or replace function public.guard_packing_child_lock()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list_id text;
begin
  v_list_id := case when tg_op = 'DELETE' then old.packing_list_id else new.packing_list_id end;
  if exists (
    select 1 from public.packing_lists where id = v_list_id and status = 'Dispatched'
  ) then
    raise exception 'Dispatched Packing Lists are locked.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_packing_child_lock() from public, anon, authenticated;

drop trigger if exists trg_guard_packing_boxes_lock on public.packing_boxes;
create trigger trg_guard_packing_boxes_lock
  before insert or update or delete on public.packing_boxes
  for each row execute function public.guard_packing_child_lock();

drop trigger if exists trg_guard_packing_allocations_lock on public.packing_list_items;
create trigger trg_guard_packing_allocations_lock
  before insert or update or delete on public.packing_list_items
  for each row execute function public.guard_packing_child_lock();


-- MIGRATION 05/22: 20260811093520_staff_management_and_active_access.sql
-- TCAST staff management and active-session enforcement.
-- Additive only: existing Auth users and business data are preserved.

alter table public.staff_profiles
  add column if not exists username text,
  add column if not exists phone text not null default '',
  add column if not exists must_change_password boolean not null default false,
  add column if not exists last_login_at timestamptz,
  add column if not exists created_by uuid references public.staff_profiles (id) on delete set null,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists disabled_at timestamptz;

-- Give all pre-existing staff a stable username without changing their Auth id.
with username_candidates as (
  select
    id,
    case
      when length(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g')) < 3
        then 'staff-' || left(id::text, 8)
      else regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]', '', 'g')
    end as base_username
  from public.staff_profiles
  where username is null or btrim(username) = ''
), ranked_usernames as (
  select
    id,
    base_username,
    row_number() over (partition by base_username order by id) as duplicate_number
  from username_candidates
)
update public.staff_profiles as profile
set username = case
  when ranked.duplicate_number = 1 then left(ranked.base_username, 32)
  else left(ranked.base_username, 27) || '-' || ranked.duplicate_number::text
end
from ranked_usernames as ranked
where profile.id = ranked.id;

alter table public.staff_profiles alter column username set not null;

create unique index if not exists staff_profiles_username_lower_uidx
  on public.staff_profiles (lower(username));
create unique index if not exists staff_profiles_email_lower_uidx
  on public.staff_profiles (lower(email));
create index if not exists staff_profiles_created_by_idx
  on public.staff_profiles (created_by);
create index if not exists staff_profiles_active_role_idx
  on public.staff_profiles (active, role);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'staff_profiles_username_format_check'
      and conrelid = 'public.staff_profiles'::regclass
  ) then
    alter table public.staff_profiles
      add constraint staff_profiles_username_format_check
      check (username ~ '^[a-z0-9][a-z0-9._-]{2,31}$');
  end if;
end $$;

create table if not exists public.staff_management_audit (
  id bigint generated by default as identity primary key,
  action text not null check (action in (
    'STAFF_CREATED', 'STAFF_UPDATED', 'PASSWORD_RESET',
    'ROLE_CHANGED', 'ACCOUNT_DISABLED', 'ACCOUNT_ENABLED',
    'PASSWORD_CHANGED'
  )),
  target_staff_id uuid references public.staff_profiles (id) on delete set null,
  performed_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists staff_management_audit_target_idx
  on public.staff_management_audit (target_staff_id, created_at desc);
create index if not exists staff_management_audit_actor_idx
  on public.staff_management_audit (performed_by, created_at desc);

alter table public.staff_management_audit enable row level security;
grant select on public.staff_management_audit to authenticated;
grant usage, select on sequence public.staff_management_audit_id_seq to authenticated;

-- SECURITY DEFINER avoids recursive staff_profiles RLS checks. The calling
-- identity is always derived from auth.uid(), never from browser input.
create or replace function public.is_active_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles
    where id = (select auth.uid())
      and active
      and not must_change_password
  );
$$;

create or replace function public.is_staff_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.staff_profiles
    where id = (select auth.uid())
      and active
      and not must_change_password
      and role = 'Admin'
  );
$$;

revoke all on function public.is_active_staff() from public, anon;
revoke all on function public.is_staff_admin() from public, anon;
grant execute on function public.is_active_staff() to authenticated;
grant execute on function public.is_staff_admin() to authenticated;

create or replace function public.staff_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select role
  from public.staff_profiles
  where id = (select auth.uid())
    and active
    and not must_change_password
$$;

revoke all on function public.staff_role() from public, anon;
grant execute on function public.staff_role() to authenticated;

-- Restrictive policies are ANDed with existing role/module policies. This
-- closes every direct Data API path for disabled staff without changing the
-- public exact-tracking RPC.
do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'customers', 'packing_lists', 'shipments', 'payment_records', 'expenses',
    'company_settings', 'shipping_rates', 'exchange_rates', 'shipment_items',
    'rate_change_audit', 'packing_boxes', 'packing_list_items'
  ] loop
    execute format('drop policy if exists "active staff access gate" on public.%I', protected_table);
    execute format(
      'create policy "active staff access gate" on public.%I as restrictive for all to authenticated using ((select public.is_active_staff())) with check ((select public.is_active_staff()))',
      protected_table
    );
  end loop;
end $$;

drop policy if exists "staff can read profiles" on public.staff_profiles;
drop policy if exists "staff can update own profile" on public.staff_profiles;
drop policy if exists "admins can update any profile" on public.staff_profiles;
drop policy if exists "admins can delete profiles" on public.staff_profiles;

create policy "staff can read own profile" on public.staff_profiles
  for select to authenticated
  using (id = (select auth.uid()));
create policy "admins can read staff profiles" on public.staff_profiles
  for select to authenticated
  using ((select public.is_staff_admin()));
create policy "admins can update staff profiles" on public.staff_profiles
  for update to authenticated
  using ((select public.is_staff_admin()))
  with check ((select public.is_staff_admin()));

drop policy if exists "admins can read staff audit" on public.staff_management_audit;
create policy "admins can read staff audit" on public.staff_management_audit
  for select to authenticated
  using ((select public.is_staff_admin()));

-- Direct profile updates are deliberately narrow. Auth email, role, status,
-- username and password changes go through the authenticated Edge Functions.
create or replace function public.staff_profiles_guard_self_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) = old.id and not public.is_staff_admin() then
    if new.role is distinct from old.role
      or new.active is distinct from old.active
      or new.username is distinct from old.username
      or new.email is distinct from old.email
      or new.created_by is distinct from old.created_by
      or new.must_change_password is distinct from old.must_change_password then
      raise exception 'Privileged staff fields can only be changed through the secure staff service.';
    end if;
  end if;
  new.updated_at = now();
  return new;
end;
$$;

-- Public signup stays outside this migration. The application exposes no
-- registration path; only an authenticated Admin Edge Function creates users.


-- MIGRATION 06/22: 20260811153000_fix_staff_auth_trigger_username.sql
-- Keep the existing auth.users -> staff_profiles trigger compatible with the
-- required staff username introduced by staff management.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  fallback_username text;
  resolved_username text;
begin
  requested_username := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  fallback_username := regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9._-]', '', 'g');

  if requested_username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'
    and not exists (
      select 1 from public.staff_profiles profile
      where lower(profile.username) = requested_username
    ) then
    resolved_username := requested_username;
  else
    if fallback_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
      fallback_username := 'staff-' || left(new.id::text, 8);
    end if;

    fallback_username := left(fallback_username, 32);
    if exists (
      select 1 from public.staff_profiles profile
      where lower(profile.username) = fallback_username
    ) then
      fallback_username := left(fallback_username, 23) || '-' || left(new.id::text, 8);
    end if;
    resolved_username := fallback_username;
  end if;

  insert into public.staff_profiles (id, email, username, name, initials, role)
  values (
    new.id,
    new.email,
    resolved_username,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'initials', upper(left(split_part(new.email, '@', 1), 2))),
    'Operations Staff'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


-- MIGRATION 07/22: 20260815013914_shipment_status_lifecycle.sql
-- TCAST shipment lifecycle, immutable status history, hold flags, and delivery confirmation.
-- Additive and data-preserving. This file must be tested before any Production application.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.shipments
  add column if not exists is_on_hold boolean not null default false,
  add column if not exists hold_reason text,
  add column if not exists held_at timestamptz,
  add column if not exists held_by uuid references public.staff_profiles (id) on delete set null,
  add column if not exists customs_type text,
  add column if not exists customs_location text,
  add column if not exists customs_started_at timestamptz,
  add column if not exists dispatch_reference text,
  add column if not exists dispatched_at timestamptz,
  add column if not exists arrived_at timestamptz,
  add column if not exists delivered_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'shipments_customs_type_check'
      and conrelid = 'public.shipments'::regclass
  ) then
    alter table public.shipments
      add constraint shipments_customs_type_check
      check (customs_type is null or customs_type in ('AIRPORT', 'SEA_PORT'));
  end if;
end $$;

-- "On Hold" becomes an orthogonal flag. Preserve every row and map legacy
-- display values to the canonical lifecycle values used by the new workflow.
update public.shipments
set is_on_hold = true,
    hold_reason = coalesce(nullif(hold_reason, ''), 'Migrated from legacy On Hold status'),
    held_at = coalesce(held_at, nullif(updated_at, '')::timestamptz)
where status = 'On Hold';

alter table public.shipments drop constraint if exists shipments_status_check;
alter table public.shipments alter column status drop default;

update public.shipments
set status = case status
  when 'Received' then 'RECEIVED'
  when 'Processing' then 'RECEIVED'
  when 'Packed' then 'PACKED'
  when 'Dispatched' then 'DISPATCHED'
  when 'In Transit' then 'ON_TRANSIT'
  when 'Arrived' then 'ARRIVED'
  when 'Ready for Collection' then 'ARRIVED'
  when 'Delivered' then 'DELIVERED'
  when 'On Hold' then 'RECEIVED'
  else status
end;

alter table public.shipments alter column status set default 'RECEIVED';
alter table public.shipments
  add constraint shipments_status_check
  check (status in (
    'RECEIVED', 'PACKED', 'DISPATCHED', 'ON_TRANSIT',
    'IN_CUSTOMS', 'ARRIVED', 'DELIVERED'
  )) not valid;
alter table public.shipments validate constraint shipments_status_check;

create table if not exists public.shipment_status_history (
  id uuid primary key default gen_random_uuid(),
  shipment_id text not null references public.shipments (id) on delete cascade,
  previous_status text,
  new_status text not null,
  location text,
  customs_type text,
  customs_location text,
  dispatch_reference text,
  public_note text,
  internal_note text,
  is_correction boolean not null default false,
  correction_reason text,
  changed_by uuid references public.staff_profiles (id) on delete set null,
  changed_by_name text not null default 'System',
  changed_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint shipment_status_history_previous_check check (
    previous_status is null or previous_status in (
      'RECEIVED', 'PACKED', 'DISPATCHED', 'ON_TRANSIT',
      'IN_CUSTOMS', 'ARRIVED', 'DELIVERED'
    )
  ),
  constraint shipment_status_history_new_check check (
    new_status in (
      'RECEIVED', 'PACKED', 'DISPATCHED', 'ON_TRANSIT',
      'IN_CUSTOMS', 'ARRIVED', 'DELIVERED'
    )
  ),
  constraint shipment_status_history_customs_check check (
    customs_type is null or customs_type in ('AIRPORT', 'SEA_PORT')
  ),
  constraint shipment_status_history_correction_check check (
    not is_correction or nullif(btrim(correction_reason), '') is not null
  )
);

create index if not exists shipment_status_history_shipment_changed_idx
  on public.shipment_status_history (shipment_id, changed_at, id);
create index if not exists shipment_status_history_status_changed_idx
  on public.shipment_status_history (new_status, changed_at desc);

create table if not exists public.shipment_delivery_confirmations (
  id uuid primary key default gen_random_uuid(),
  shipment_id text not null unique references public.shipments (id) on delete restrict,
  recipient_name text not null check (btrim(recipient_name) <> ''),
  recipient_phone text,
  delivered_at timestamptz not null,
  released_by uuid not null references public.staff_profiles (id) on delete restrict,
  notes text,
  proof_storage_path text,
  created_at timestamptz not null default now()
);

create index if not exists shipment_delivery_released_by_idx
  on public.shipment_delivery_confirmations (released_by);

create table if not exists public.business_audit_log (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  entity_type text not null,
  entity_id text not null,
  actor_id uuid references public.staff_profiles (id) on delete set null,
  actor_name text not null default 'System',
  occurred_at timestamptz not null default now(),
  details jsonb not null default '{}'::jsonb
);

create index if not exists business_audit_entity_idx
  on public.business_audit_log (entity_type, entity_id, occurred_at desc);
create index if not exists business_audit_actor_idx
  on public.business_audit_log (actor_id, occurred_at desc);

-- Preserve the legacy JSON events in the normalized audit table. The unique
-- predicate makes this safe if a QA database applies the migration again.
with legacy_events as (
  select
    shipment.id as shipment_id,
    event.value as event,
    event.ordinality,
    lag(
      case event.value ->> 'status'
        when 'Received' then 'RECEIVED'
        when 'Processing' then 'RECEIVED'
        when 'Packed' then 'PACKED'
        when 'Dispatched' then 'DISPATCHED'
        when 'In Transit' then 'ON_TRANSIT'
        when 'Arrived' then 'ARRIVED'
        when 'Ready for Collection' then 'ARRIVED'
        when 'Delivered' then 'DELIVERED'
        else null
      end
    ) over (partition by shipment.id order by event.ordinality) as previous_status
  from public.shipments as shipment
  cross join lateral jsonb_array_elements(shipment.status_history)
    with ordinality as event(value, ordinality)
), mapped_events as (
  select
    shipment_id,
    previous_status,
    case event ->> 'status'
      when 'Received' then 'RECEIVED'
      when 'Processing' then 'RECEIVED'
      when 'Packed' then 'PACKED'
      when 'Dispatched' then 'DISPATCHED'
      when 'In Transit' then 'ON_TRANSIT'
      when 'Arrived' then 'ARRIVED'
      when 'Ready for Collection' then 'ARRIVED'
      when 'Delivered' then 'DELIVERED'
      else null
    end as new_status,
    nullif(event ->> 'location', '') as location,
    case when coalesce((event ->> 'isPublic')::boolean, false)
      then nullif(event ->> 'note', '') else null end as public_note,
    case when not coalesce((event ->> 'isPublic')::boolean, false)
      then nullif(event ->> 'note', '') else null end as internal_note,
    coalesce(nullif(event ->> 'staff', ''), 'Legacy migration') as changed_by_name,
    case when coalesce(event ->> 'timestamp', '') ~ '^\d{4}-\d{2}-\d{2}'
      then (event ->> 'timestamp')::timestamptz else now() end as changed_at,
    ordinality
  from legacy_events
)
insert into public.shipment_status_history (
  shipment_id, previous_status, new_status, location, public_note,
  internal_note, changed_by_name, changed_at, metadata
)
select
  shipment_id, previous_status, new_status, location, public_note,
  internal_note, changed_by_name, changed_at,
  jsonb_build_object('source', 'legacy_status_history', 'ordinality', ordinality)
from mapped_events
where new_status is not null
  and not exists (
    select 1 from public.shipment_status_history existing
    where existing.shipment_id = mapped_events.shipment_id
      and existing.changed_at = mapped_events.changed_at
      and existing.new_status = mapped_events.new_status
      and existing.metadata ->> 'source' = 'legacy_status_history'
  );

-- Every shipment has at least one lifecycle event after migration.
insert into public.shipment_status_history (
  shipment_id, previous_status, new_status, location,
  public_note, changed_by_name, changed_at, metadata
)
select
  shipment.id, null, shipment.status, shipment.origin,
  case shipment.status
    when 'RECEIVED' then 'Cargo received at the Dubai office.'
    when 'PACKED' then 'Cargo packed for dispatch.'
    when 'DISPATCHED' then 'Cargo dispatched from Dubai.'
    when 'ON_TRANSIT' then 'Cargo is on transit to Tanzania.'
    when 'IN_CUSTOMS' then 'Cargo is undergoing customs clearance.'
    when 'ARRIVED' then 'Cargo arrived at the Tanzania office.'
    when 'DELIVERED' then 'Cargo delivered.'
  end,
  'Migration', coalesce(nullif(shipment.updated_at, '')::timestamptz, now()),
  jsonb_build_object('source', 'migration_current_status')
from public.shipments as shipment
where not exists (
  select 1 from public.shipment_status_history history
  where history.shipment_id = shipment.id
);

alter table public.shipment_status_history enable row level security;
alter table public.shipment_delivery_confirmations enable row level security;
alter table public.business_audit_log enable row level security;

grant select on public.shipment_status_history to authenticated;
grant select on public.shipment_delivery_confirmations to authenticated;
grant select on public.business_audit_log to authenticated;

drop policy if exists "active staff can read shipment history" on public.shipment_status_history;
create policy "active staff can read shipment history"
  on public.shipment_status_history for select to authenticated
  using ((select public.is_active_staff()));

drop policy if exists "active staff can read delivery confirmations" on public.shipment_delivery_confirmations;
create policy "active staff can read delivery confirmations"
  on public.shipment_delivery_confirmations for select to authenticated
  using ((select public.is_active_staff()));

drop policy if exists "managers can read business audit" on public.business_audit_log;
create policy "managers can read business audit"
  on public.business_audit_log for select to authenticated
  using ((select public.staff_role()) in ('Admin', 'Manager'));

create or replace function public.shipment_status_label(p_status text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case p_status
    when 'RECEIVED' then 'Received at Dubai Office'
    when 'PACKED' then 'Packed for Dispatch'
    when 'DISPATCHED' then 'Dispatched from Dubai'
    when 'ON_TRANSIT' then 'On Transit to Tanzania'
    when 'IN_CUSTOMS' then 'In Customs'
    when 'ARRIVED' then 'Arrived at Tanzania Office'
    when 'DELIVERED' then 'Delivered'
    else p_status
  end
$$;

create or replace function public.transition_shipment_status(
  p_shipment_id text,
  p_new_status text,
  p_location text default null,
  p_public_note text default null,
  p_internal_note text default null,
  p_customs_type text default null,
  p_customs_location text default null,
  p_dispatch_reference text default null,
  p_correction_reason text default null,
  p_recipient_name text default null,
  p_recipient_phone text default null,
  p_delivered_at timestamptz default null,
  p_delivery_notes text default null,
  p_proof_storage_path text default null
)
returns public.shipment_status_history
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_shipment public.shipments%rowtype;
  v_expected_status text;
  v_is_correction boolean;
  v_changed_at timestamptz := now();
  v_history public.shipment_status_history%rowtype;
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor_id
    and profile.active
    and not profile.must_change_password;

  if v_actor_name is null then
    raise exception 'An active staff session is required.';
  end if;

  if p_new_status not in (
    'RECEIVED', 'PACKED', 'DISPATCHED', 'ON_TRANSIT',
    'IN_CUSTOMS', 'ARRIVED', 'DELIVERED'
  ) then
    raise exception 'Unsupported shipment status: %', p_new_status;
  end if;

  select * into v_shipment
  from public.shipments
  where id = p_shipment_id
  for update;

  if v_shipment.id is null then
    raise exception 'Shipment not found.';
  end if;
  if v_shipment.status = p_new_status then
    raise exception 'Shipment is already in status %.', p_new_status;
  end if;

  v_expected_status := case v_shipment.status
    when 'RECEIVED' then 'PACKED'
    when 'PACKED' then 'DISPATCHED'
    when 'DISPATCHED' then 'ON_TRANSIT'
    when 'ON_TRANSIT' then 'IN_CUSTOMS'
    when 'IN_CUSTOMS' then 'ARRIVED'
    when 'ARRIVED' then 'DELIVERED'
    else null
  end;
  v_is_correction := p_new_status is distinct from v_expected_status;

  if v_is_correction then
    if v_actor_role not in ('Admin', 'Manager') then
      raise exception 'Only an Admin or Manager can skip or reverse lifecycle stages.';
    end if;
    if nullif(btrim(p_correction_reason), '') is null then
      raise exception 'Reason for status correction is required.';
    end if;
  end if;

  if p_new_status = 'PACKED' and exists (
    select 1
    from public.shipment_items as item
    where item.shipment_id = p_shipment_id
      and coalesce((
        select sum(allocation.quantity)
        from public.packing_list_items as allocation
        where allocation.shipment_item_id = item.id
      ), 0) < item.quantity
  ) then
    raise exception 'Every shipment item must be fully allocated to Packing List boxes before marking the shipment PACKED.';
  end if;

  if p_new_status = 'IN_CUSTOMS' then
    if p_customs_type not in ('AIRPORT', 'SEA_PORT') then
      raise exception 'Customs type Airport or Sea Port is required.';
    end if;
  end if;

  if p_new_status = 'DELIVERED' then
    if nullif(btrim(p_recipient_name), '') is null then
      raise exception 'Recipient name is required before delivery.';
    end if;
    if p_delivered_at is null then
      raise exception 'Collection or delivery date is required.';
    end if;
  end if;

  perform set_config('app.status_transition_authorized', 'true', true);
  update public.shipments
  set status = p_new_status,
      customs_type = case when p_new_status = 'IN_CUSTOMS' then p_customs_type else customs_type end,
      customs_location = case when p_new_status = 'IN_CUSTOMS' then nullif(btrim(p_customs_location), '') else customs_location end,
      customs_started_at = case when p_new_status = 'IN_CUSTOMS' then v_changed_at else customs_started_at end,
      dispatch_reference = case when p_new_status = 'DISPATCHED' then nullif(btrim(p_dispatch_reference), '') else dispatch_reference end,
      dispatched_at = case when p_new_status = 'DISPATCHED' then v_changed_at else dispatched_at end,
      arrived_at = case when p_new_status = 'ARRIVED' then v_changed_at else arrived_at end,
      delivered_at = case when p_new_status = 'DELIVERED' then p_delivered_at else delivered_at end,
      updated_at = v_changed_at::text,
      status_history = status_history || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'status', p_new_status,
        'location', nullif(btrim(p_location), ''),
        'timestamp', v_changed_at,
        'staff', v_actor_name,
        'note', nullif(btrim(p_public_note), ''),
        'isPublic', true,
        'customsType', p_customs_type,
        'customsLocation', nullif(btrim(p_customs_location), '')
      )))
  where id = p_shipment_id;

  insert into public.shipment_status_history (
    shipment_id, previous_status, new_status, location, customs_type,
    customs_location, dispatch_reference, public_note, internal_note,
    is_correction, correction_reason, changed_by, changed_by_name, changed_at
  ) values (
    p_shipment_id, v_shipment.status, p_new_status, nullif(btrim(p_location), ''),
    case when p_new_status = 'IN_CUSTOMS' then p_customs_type else null end,
    case when p_new_status = 'IN_CUSTOMS' then nullif(btrim(p_customs_location), '') else null end,
    case when p_new_status = 'DISPATCHED' then nullif(btrim(p_dispatch_reference), '') else null end,
    nullif(btrim(p_public_note), ''), nullif(btrim(p_internal_note), ''),
    v_is_correction, nullif(btrim(p_correction_reason), ''),
    v_actor_id, v_actor_name, v_changed_at
  ) returning * into v_history;

  if p_new_status = 'DELIVERED' then
    insert into public.shipment_delivery_confirmations (
      shipment_id, recipient_name, recipient_phone, delivered_at,
      released_by, notes, proof_storage_path
    ) values (
      p_shipment_id, btrim(p_recipient_name), nullif(btrim(p_recipient_phone), ''),
      p_delivered_at, v_actor_id, nullif(btrim(p_delivery_notes), ''),
      nullif(btrim(p_proof_storage_path), '')
    )
    on conflict (shipment_id) do update set
      recipient_name = excluded.recipient_name,
      recipient_phone = excluded.recipient_phone,
      delivered_at = excluded.delivered_at,
      released_by = excluded.released_by,
      notes = excluded.notes,
      proof_storage_path = excluded.proof_storage_path;
  end if;

  insert into public.business_audit_log (
    action, entity_type, entity_id, actor_id, actor_name, occurred_at, details
  ) values (
    case when p_new_status = 'DELIVERED' then 'DELIVERED_CONFIRMED' else 'STATUS_UPDATED' end,
    'shipment', p_shipment_id, v_actor_id, v_actor_name, v_changed_at,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_shipment.status,
      'new_status', p_new_status,
      'is_correction', v_is_correction,
      'correction_reason', nullif(btrim(p_correction_reason), '')
    ))
  );

  return v_history;
end;
$$;

revoke all on function public.transition_shipment_status(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) from public, anon;
grant execute on function public.transition_shipment_status(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) to authenticated;

create or replace function public.create_initial_shipment_status_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.shipment_status_history (
    shipment_id, previous_status, new_status, location, public_note,
    changed_by, changed_by_name, changed_at, metadata
  ) values (
    new.id, null, new.status, new.origin, 'Cargo received at the Dubai office.',
    (select auth.uid()), coalesce(nullif(new.created_by, ''), 'System'),
    coalesce(nullif(new.created_at, '')::timestamptz, now()),
    jsonb_build_object('source', 'shipment_created')
  );
  return new;
end;
$$;

revoke all on function public.create_initial_shipment_status_history() from public, anon, authenticated;
drop trigger if exists trg_create_initial_shipment_status_history on public.shipments;
create trigger trg_create_initial_shipment_status_history
  after insert on public.shipments
  for each row execute function public.create_initial_shipment_status_history();

create or replace function public.dispatch_packing_list_with_status(
  p_packing_list_id text,
  p_dispatch_note text default null
)
returns public.packing_lists
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list public.packing_lists%rowtype;
  v_shipment record;
  v_has_shipments boolean := false;
begin
  select * into v_list
  from public.packing_lists
  where id = p_packing_list_id
  for update;
  if v_list.id is null then raise exception 'Packing List not found.'; end if;
  if v_list.status <> 'Draft' then raise exception 'Only a Draft Packing List can be dispatched.'; end if;

  for v_shipment in
    select shipment.id, shipment.status, shipment.origin, shipment.shipment_type
    from public.shipments as shipment
    where exists (
      select 1
      from public.shipment_items as item
      join public.packing_list_items as allocation on allocation.shipment_item_id = item.id
      where item.shipment_id = shipment.id
        and allocation.packing_list_id = p_packing_list_id
    )
    order by shipment.id
    for update of shipment
  loop
    v_has_shipments := true;
    if v_shipment.status = 'RECEIVED' then
      perform public.transition_shipment_status(
        p_shipment_id => v_shipment.id,
        p_new_status => 'PACKED',
        p_location => v_shipment.origin,
        p_public_note => 'Packed for dispatch in Packing List ' || v_list.list_id
      );
      v_shipment.status := 'PACKED';
    end if;
    if v_shipment.status = 'PACKED' then
      perform public.transition_shipment_status(
        p_shipment_id => v_shipment.id,
        p_new_status => 'DISPATCHED',
        p_location => v_shipment.origin,
        p_public_note => coalesce(nullif(btrim(p_dispatch_note), ''), 'Dispatched from Dubai'),
        p_dispatch_reference => v_list.list_id
      );
    elsif v_shipment.status not in ('DISPATCHED','ON_TRANSIT','IN_CUSTOMS','ARRIVED','DELIVERED') then
      raise exception 'Shipment % cannot be dispatched from status %.', v_shipment.id, v_shipment.status;
    end if;
  end loop;

  if not v_has_shipments then raise exception 'Packing List has no allocated shipment items.'; end if;

  update public.packing_lists
  set status = 'Dispatched', dispatched_at = now()::text, updated_at = now()::text
  where id = p_packing_list_id
  returning * into v_list;
  return v_list;
end;
$$;

revoke all on function public.dispatch_packing_list_with_status(text, text) from public, anon;
grant execute on function public.dispatch_packing_list_with_status(text, text) to authenticated;

create or replace function public.set_shipment_hold(
  p_shipment_id text,
  p_on_hold boolean,
  p_reason text
)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor_name text;
  v_result public.shipments%rowtype;
begin
  select name into v_actor_name
  from public.staff_profiles
  where id = v_actor_id and active and not must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if p_on_hold and nullif(btrim(p_reason), '') is null then
    raise exception 'A hold reason is required.';
  end if;

  update public.shipments
  set is_on_hold = p_on_hold,
      hold_reason = case when p_on_hold then btrim(p_reason) else null end,
      held_at = case when p_on_hold then now() else null end,
      held_by = case when p_on_hold then v_actor_id else null end,
      updated_at = now()::text
  where id = p_shipment_id
  returning * into v_result;

  if v_result.id is null then raise exception 'Shipment not found.'; end if;

  insert into public.business_audit_log (
    action, entity_type, entity_id, actor_id, actor_name, details
  ) values (
    case when p_on_hold then 'SHIPMENT_HOLD_APPLIED' else 'SHIPMENT_HOLD_RELEASED' end,
    'shipment', p_shipment_id, v_actor_id, v_actor_name,
    jsonb_build_object('reason', nullif(btrim(p_reason), ''))
  );
  return v_result;
end;
$$;

revoke all on function public.set_shipment_hold(text, boolean, text) from public, anon;
grant execute on function public.set_shipment_hold(text, boolean, text) to authenticated;

create or replace function public.guard_shipment_status_direct_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status
    and coalesce(current_setting('app.status_transition_authorized', true), 'false') <> 'true'
  then
    raise exception 'Shipment status must be changed through transition_shipment_status().';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_shipment_status_direct_update() from public, anon, authenticated;
drop trigger if exists trg_guard_shipment_status_direct_update on public.shipments;
create trigger trg_guard_shipment_status_direct_update
  before update of status on public.shipments
  for each row execute function public.guard_shipment_status_direct_update();

create or replace function public.track_shipment(p_tracking_number text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment public.shipments%rowtype;
  v_receiver_name text;
begin
  select * into v_shipment
  from public.shipments
  where upper(tracking_number) = upper(btrim(p_tracking_number));
  if not found then return null; end if;

  select name into v_receiver_name
  from public.customers
  where id = v_shipment.customer_id;

  return jsonb_build_object(
    'shipmentNumber', v_shipment.tracking_number,
    'status', v_shipment.status,
    'statusLabel', public.shipment_status_label(v_shipment.status),
    'isOnHold', v_shipment.is_on_hold,
    'origin', v_shipment.origin,
    'destination', v_shipment.destination_city || ', ' || v_shipment.destination,
    'currentLocation', coalesce((
      select history.location
      from public.shipment_status_history as history
      where history.shipment_id = v_shipment.id
        and history.location is not null
      order by history.changed_at desc, history.id desc
      limit 1
    ), v_shipment.destination_city),
    'receiver', coalesce(v_receiver_name, '—'),
    'weightKg', v_shipment.weight_kg,
    'pcs', v_shipment.pcs,
    'lastUpdate', v_shipment.updated_at,
    'history', coalesce((
      select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'status', history.new_status,
        'label', public.shipment_status_label(history.new_status),
        'location', history.location,
        'customsType', history.customs_type,
        'customsLocation', history.customs_location,
        'time', history.changed_at,
        'description', history.public_note
      )) order by history.changed_at, history.id)
      from public.shipment_status_history as history
      where history.shipment_id = v_shipment.id
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.track_shipment(text) from public;
grant execute on function public.track_shipment(text) to anon, authenticated;

-- Extend the active-staff gate to the new internal tables. The public tracking
-- RPC remains the only anonymous surface.
drop policy if exists "active staff access gate" on public.shipment_status_history;
create policy "active staff access gate" on public.shipment_status_history
  as restrictive for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));
drop policy if exists "active staff access gate" on public.shipment_delivery_confirmations;
create policy "active staff access gate" on public.shipment_delivery_confirmations
  as restrictive for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));
drop policy if exists "active staff access gate" on public.business_audit_log;
create policy "active staff access gate" on public.business_audit_log
  as restrictive for all to authenticated
  using ((select public.is_active_staff()))
  with check ((select public.is_active_staff()));


-- MIGRATION 08/22: 20260815013917_double_entry_accounting.sql
-- TCAST double-entry accounting foundation.
-- Additive only: legacy invoices, payments and expenses remain intact. Historical
-- records are previewed before backfill; Production application requires a
-- separately reviewed dry run and explicit authorization.

set lock_timeout = '5s';
set statement_timeout = '60s';

create sequence if not exists public.journal_entry_number_seq;

create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  account_type text not null check (account_type in ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance text not null check (normal_balance in ('DEBIT','CREDIT')),
  parent_id uuid references public.accounting_accounts (id) on delete restrict,
  active boolean not null default true,
  system_account boolean not null default false,
  allow_manual_posting boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_accounts_name_check check (btrim(name) <> ''),
  constraint accounting_accounts_code_check check (btrim(code) <> '')
);

create index if not exists accounting_accounts_type_active_idx
  on public.accounting_accounts (account_type, active, code);
create index if not exists accounting_accounts_parent_idx
  on public.accounting_accounts (parent_id);

insert into public.accounting_accounts
  (code, name, account_type, normal_balance, system_account, allow_manual_posting)
values
  ('1000', 'Cash', 'ASSET', 'DEBIT', true, true),
  ('1010', 'Bank', 'ASSET', 'DEBIT', true, true),
  ('1100', 'Accounts Receivable', 'ASSET', 'DEBIT', true, false),
  ('1200', 'Other Current Assets', 'ASSET', 'DEBIT', false, true),
  ('2000', 'Accounts Payable', 'LIABILITY', 'CREDIT', true, false),
  ('2100', 'Other Liabilities', 'LIABILITY', 'CREDIT', false, true),
  ('3000', 'Owner''s Capital', 'EQUITY', 'CREDIT', true, true),
  ('3100', 'Retained Earnings', 'EQUITY', 'CREDIT', true, false),
  ('4000', 'Air Cargo Revenue', 'REVENUE', 'CREDIT', true, false),
  ('4010', 'Sea Cargo Revenue', 'REVENUE', 'CREDIT', true, false),
  ('4020', 'Clearing Revenue', 'REVENUE', 'CREDIT', false, true),
  ('4030', 'Other Service Revenue', 'REVENUE', 'CREDIT', false, true),
  ('4090', 'Other Income', 'REVENUE', 'CREDIT', true, true),
  ('5000', 'Office Rent', 'EXPENSE', 'DEBIT', false, true),
  ('5010', 'Staff Salaries', 'EXPENSE', 'DEBIT', false, true),
  ('5020', 'Transport Expense', 'EXPENSE', 'DEBIT', false, true),
  ('5030', 'Fuel Expense', 'EXPENSE', 'DEBIT', false, true),
  ('5040', 'Packing Materials', 'EXPENSE', 'DEBIT', false, true),
  ('5050', 'Airport Charges', 'EXPENSE', 'DEBIT', false, true),
  ('5060', 'Port Charges', 'EXPENSE', 'DEBIT', false, true),
  ('5070', 'Customs / Clearing Costs', 'EXPENSE', 'DEBIT', false, true),
  ('5080', 'Utilities', 'EXPENSE', 'DEBIT', false, true),
  ('5090', 'Internet / Phone', 'EXPENSE', 'DEBIT', false, true),
  ('5100', 'Marketing', 'EXPENSE', 'DEBIT', false, true),
  ('5110', 'Bank Charges', 'EXPENSE', 'DEBIT', false, true),
  ('5190', 'General Expenses', 'EXPENSE', 'DEBIT', false, true),
  ('5200', 'Other Expenses', 'EXPENSE', 'DEBIT', false, true)
on conflict (code) do update set
  name = excluded.name,
  account_type = excluded.account_type,
  normal_balance = excluded.normal_balance,
  system_account = excluded.system_account;

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_number text not null unique,
  entry_date date not null,
  description text not null,
  reference_type text not null,
  reference_id text not null,
  currency text not null check (currency in ('USD','TZS','AED')),
  exchange_rate numeric(18,6) not null check (exchange_rate > 0),
  original_amount numeric(18,2) not null check (original_amount >= 0),
  base_amount numeric(18,2) not null check (base_amount >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','POSTED','VOIDED')),
  reversal_of uuid references public.journal_entries (id) on delete restrict,
  correction_reason text,
  created_by uuid references public.staff_profiles (id) on delete set null,
  posted_by uuid references public.staff_profiles (id) on delete set null,
  voided_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  voided_at timestamptz,
  constraint journal_entries_description_check check (btrim(description) <> '')
);

create unique index if not exists journal_entries_posted_reference_idx
  on public.journal_entries (reference_type, reference_id)
  where status = 'POSTED' and reversal_of is null;
create index if not exists journal_entries_date_status_idx
  on public.journal_entries (status, entry_date, id);
create index if not exists journal_entries_reference_idx
  on public.journal_entries (reference_type, reference_id);
create index if not exists journal_entries_created_by_idx
  on public.journal_entries (created_by);

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries (id) on delete restrict,
  account_id uuid not null references public.accounting_accounts (id) on delete restrict,
  description text,
  debit numeric(18,2) not null default 0 check (debit >= 0),
  credit numeric(18,2) not null default 0 check (credit >= 0),
  original_debit numeric(18,2) not null default 0 check (original_debit >= 0),
  original_credit numeric(18,2) not null default 0 check (original_credit >= 0),
  created_at timestamptz not null default now(),
  constraint journal_lines_one_side_check check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  )
);

create index if not exists journal_lines_entry_idx
  on public.journal_lines (journal_entry_id);
create index if not exists journal_lines_account_entry_idx
  on public.journal_lines (account_id, journal_entry_id);

alter table public.shipments
  add column if not exists accounting_journal_entry_id uuid
    references public.journal_entries (id) on delete restrict;

alter table public.payment_records
  add column if not exists status text not null default 'POSTED',
  add column if not exists receiving_account_id uuid
    references public.accounting_accounts (id) on delete restrict,
  add column if not exists exchange_rate numeric(18,6),
  add column if not exists reporting_amount numeric(18,2),
  add column if not exists accounting_journal_entry_id uuid
    references public.journal_entries (id) on delete restrict;

alter table public.expenses
  add column if not exists expense_number text,
  add column if not exists payee text,
  add column if not exists payment_method text,
  add column if not exists expense_account_id uuid
    references public.accounting_accounts (id) on delete restrict,
  add column if not exists payment_account_id uuid
    references public.accounting_accounts (id) on delete restrict,
  add column if not exists exchange_rate numeric(18,6),
  add column if not exists reporting_amount numeric(18,2),
  add column if not exists status text not null default 'DRAFT',
  add column if not exists accounting_journal_entry_id uuid
    references public.journal_entries (id) on delete restrict,
  add column if not exists receipt_storage_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_records_accounting_status_check'
      and conrelid = 'public.payment_records'::regclass
  ) then
    alter table public.payment_records add constraint payment_records_accounting_status_check
      check (status in ('DRAFT','POSTED','VOIDED'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_accounting_status_check'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses add constraint expenses_accounting_status_check
      check (status in ('DRAFT','POSTED','VOIDED'));
  end if;
end $$;

create unique index if not exists expenses_expense_number_idx
  on public.expenses (expense_number) where expense_number is not null;
create index if not exists payment_records_accounting_entry_idx
  on public.payment_records (accounting_journal_entry_id);
create index if not exists expenses_accounting_entry_idx
  on public.expenses (accounting_journal_entry_id);
create index if not exists expenses_accounts_date_idx
  on public.expenses (expense_account_id, date);

create table if not exists public.other_income (
  id uuid primary key default gen_random_uuid(),
  income_number text not null unique,
  income_date date not null,
  income_account_id uuid not null references public.accounting_accounts (id) on delete restrict,
  receiving_account_id uuid not null references public.accounting_accounts (id) on delete restrict,
  description text not null check (btrim(description) <> ''),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null check (currency in ('USD','TZS','AED')),
  exchange_rate numeric(18,6) not null check (exchange_rate > 0),
  reporting_amount numeric(18,2) not null check (reporting_amount > 0),
  reference text,
  status text not null default 'DRAFT' check (status in ('DRAFT','POSTED','VOIDED')),
  accounting_journal_entry_id uuid references public.journal_entries (id) on delete restrict,
  created_by uuid not null references public.staff_profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists other_income_date_status_idx
  on public.other_income (status, income_date);
create index if not exists other_income_accounts_idx
  on public.other_income (income_account_id, receiving_account_id);

create or replace function public.accounting_reporting_amount(
  p_currency text,
  p_amount numeric,
  p_exchange_rate numeric
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_amount <= 0 then raise exception 'Amount must be greater than zero.'; end if;
  if p_currency = 'USD' then return round(p_amount, 2); end if;
  if p_currency not in ('TZS', 'AED') then raise exception 'Unsupported currency %.', p_currency; end if;
  if p_exchange_rate is null or p_exchange_rate <= 0 then
    raise exception 'A positive historical exchange-rate snapshot is required for %.', p_currency;
  end if;
  return round(p_amount / p_exchange_rate, 2);
end;
$$;

create or replace function public.guard_journal_posting()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_debit numeric(18,2);
  v_credit numeric(18,2);
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' then
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
    from public.journal_lines
    where journal_entry_id = new.id;
    if v_debit <= 0 or v_debit <> v_credit then
      raise exception 'Posted journal % is not balanced. Debit %, Credit %.', new.entry_number, v_debit, v_credit;
    end if;
    new.posted_at := coalesce(new.posted_at, now());
  end if;
  if old.status in ('POSTED', 'VOIDED') and new.status = 'DRAFT' then
    raise exception 'A posted or voided journal cannot return to Draft.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_journal_posting() from public, anon, authenticated;
drop trigger if exists trg_guard_journal_posting on public.journal_entries;
create trigger trg_guard_journal_posting
  before update of status on public.journal_entries
  for each row execute function public.guard_journal_posting();

create or replace function public.guard_posted_journal_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry_id uuid := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
begin
  if exists (
    select 1 from public.journal_entries
    where id = v_entry_id and status in ('POSTED', 'VOIDED')
  ) then
    raise exception 'Posted journal lines are immutable.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_posted_journal_lines() from public, anon, authenticated;
drop trigger if exists trg_guard_posted_journal_lines on public.journal_lines;
create trigger trg_guard_posted_journal_lines
  before insert or update or delete on public.journal_lines
  for each row execute function public.guard_posted_journal_lines();

create or replace function public.post_invoice_accounting(p_shipment_id text)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_actor_name text;
  v_shipment public.shipments%rowtype;
  v_ar uuid;
  v_revenue uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select name, role into v_actor_name, v_role
  from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.invoice_finalized_at is null or v_shipment.invoice_amount is null or v_shipment.invoice_currency is null then
    raise exception 'The invoice must be finalized before accounting posting.';
  end if;
  if v_shipment.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_shipment.accounting_journal_entry_id;
    return v_entry;
  end if;

  v_exchange_rate := case v_shipment.invoice_currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end;
  v_base_amount := public.accounting_reporting_amount(
    v_shipment.invoice_currency, v_shipment.invoice_amount, v_exchange_rate
  );
  select id into v_ar from public.accounting_accounts where code = '1100' and active;
  select id into v_revenue from public.accounting_accounts
    where code = case when v_shipment.shipment_type = 'Air Cargo' then '4000' else '4010' end and active;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_shipment.invoice_finalized_at::date,
    'Cargo invoice ' || coalesce(v_shipment.invoice_number, v_shipment.tracking_number),
    'INVOICE', p_shipment_id, v_shipment.invoice_currency, v_exchange_rate,
    v_shipment.invoice_amount, v_base_amount, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_ar, 'Accounts receivable', v_base_amount, 0, v_shipment.invoice_amount, 0),
    (v_entry.id, v_revenue, 'Cargo revenue', 0, v_base_amount, 0, v_shipment.invoice_amount);

  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.shipments set accounting_journal_entry_id = v_entry.id where id = p_shipment_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_POSTED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_entry;
end;
$$;

revoke all on function public.post_invoice_accounting(text) from public, anon;
grant execute on function public.post_invoice_accounting(text) to authenticated;

create or replace function public.post_payment_accounting(
  p_payment_id text,
  p_receiving_account_code text default '1010'
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_payment public.payment_records%rowtype;
  v_shipment public.shipments%rowtype;
  v_receiving uuid;
  v_ar uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_previously_paid numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if p_receiving_account_code not in ('1000','1010') then raise exception 'Payments may be received into Cash or Bank only.'; end if;

  select * into v_payment from public.payment_records where id = p_payment_id for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_payment.accounting_journal_entry_id;
    return v_entry;
  end if;
  select * into v_shipment from public.shipments where id = v_payment.shipment_id;
  if v_shipment.accounting_journal_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  if v_payment.currency is distinct from v_shipment.invoice_currency then
    raise exception 'Payment currency must match invoice currency %.', v_shipment.invoice_currency;
  end if;
  select coalesce(sum(amount), 0) into v_previously_paid
  from public.payment_records
  where shipment_id = v_payment.shipment_id and id <> v_payment.id and status = 'POSTED';
  if v_previously_paid + v_payment.amount > v_shipment.invoice_amount + 0.01 then
    raise exception 'Payment exceeds the outstanding invoice balance.';
  end if;
  v_exchange_rate := coalesce(v_payment.exchange_rate, case v_payment.currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end);
  v_base_amount := public.accounting_reporting_amount(v_payment.currency, v_payment.amount, v_exchange_rate);
  select id into v_receiving from public.accounting_accounts where code = p_receiving_account_code and active;
  select id into v_ar from public.accounting_accounts where code = '1100' and active;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_payment.date::date, 'Payment ' || v_payment.receipt_number,
    'PAYMENT', p_payment_id, v_payment.currency, v_exchange_rate,
    v_payment.amount, v_base_amount, v_actor
  ) returning * into v_entry;
  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_receiving, 'Customer payment received', v_base_amount, 0, v_payment.amount, 0),
    (v_entry.id, v_ar, 'Reduce accounts receivable', 0, v_base_amount, 0, v_payment.amount);
  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.payment_records set
    status = 'POSTED', receiving_account_id = v_receiving,
    exchange_rate = v_exchange_rate, reporting_amount = v_base_amount,
    accounting_journal_entry_id = v_entry.id
  where id = p_payment_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('PAYMENT_POSTED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_entry;
end;
$$;

revoke all on function public.post_payment_accounting(text, text) from public, anon;
grant execute on function public.post_payment_accounting(text, text) to authenticated;

create or replace function public.post_expense_accounting(
  p_expense_id text,
  p_expense_account_code text,
  p_payment_account_code text default '1010'
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_expense public.expenses%rowtype;
  v_expense_account uuid;
  v_payment_account uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select name, role into v_actor_name, v_role from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_role not in ('Admin','Manager') then raise exception 'Expense posting requires Manager or Admin access.'; end if;
  if p_payment_account_code not in ('1000','1010') then raise exception 'Expenses may be paid from Cash or Bank only.'; end if;

  select * into v_expense from public.expenses where id = p_expense_id for update;
  if v_expense.id is null then raise exception 'Expense not found.'; end if;
  if v_expense.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_expense.accounting_journal_entry_id;
    return v_entry;
  end if;
  select id into v_expense_account from public.accounting_accounts
    where code = p_expense_account_code and account_type = 'EXPENSE' and active;
  if v_expense_account is null then raise exception 'A valid active expense account is required.'; end if;
  select id into v_payment_account from public.accounting_accounts
    where code = p_payment_account_code and account_type = 'ASSET' and active;

  v_exchange_rate := coalesce(v_expense.exchange_rate, case v_expense.currency
    when 'USD' then 1
    when 'TZS' then (select usd_to_tzs from public.exchange_rates where rate_date <= v_expense.date::date order by rate_date desc limit 1)
    when 'AED' then (select usd_to_aed from public.exchange_rates where rate_date <= v_expense.date::date order by rate_date desc limit 1)
  end);
  v_base_amount := public.accounting_reporting_amount(v_expense.currency, v_expense.amount, v_exchange_rate);

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_expense.date::date, v_expense.description, 'EXPENSE', p_expense_id,
    v_expense.currency, v_exchange_rate, v_expense.amount, v_base_amount, v_actor
  ) returning * into v_entry;
  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_expense_account, v_expense.description, v_base_amount, 0, v_expense.amount, 0),
    (v_entry.id, v_payment_account, 'Expense payment', 0, v_base_amount, 0, v_expense.amount);
  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.expenses set
    status = 'POSTED', expense_account_id = v_expense_account,
    payment_account_id = v_payment_account, exchange_rate = v_exchange_rate,
    reporting_amount = v_base_amount, accounting_journal_entry_id = v_entry.id,
    expense_number = coalesce(expense_number, 'EXP-' || to_char(v_expense.date::date, 'YYMMDD') || '-' || right(v_expense.id, 4))
  where id = p_expense_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('EXPENSE_POSTED', 'expense', p_expense_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_entry;
end;
$$;

revoke all on function public.post_expense_accounting(text, text, text) from public, anon;
grant execute on function public.post_expense_accounting(text, text, text) to authenticated;

create or replace function public.create_other_income(
  p_income_date date,
  p_income_account_code text,
  p_receiving_account_code text,
  p_description text,
  p_amount numeric,
  p_currency text,
  p_exchange_rate numeric,
  p_reference text default null
)
returns public.other_income
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_income_account uuid;
  v_receiving_account uuid;
  v_reporting numeric(18,2);
  v_entry public.journal_entries%rowtype;
  v_income public.other_income%rowtype;
begin
  select name, role into v_actor_name, v_role from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_role not in ('Admin','Manager') then raise exception 'Other income posting requires Manager or Admin access.'; end if;
  select id into v_income_account from public.accounting_accounts
    where code = p_income_account_code and account_type = 'REVENUE' and active and allow_manual_posting;
  select id into v_receiving_account from public.accounting_accounts
    where code = p_receiving_account_code and account_type = 'ASSET' and active;
  if v_income_account is null or v_receiving_account is null then raise exception 'Valid income and receiving accounts are required.'; end if;
  v_reporting := public.accounting_reporting_amount(p_currency, p_amount, p_exchange_rate);

  insert into public.other_income (
    income_number, income_date, income_account_id, receiving_account_id,
    description, amount, currency, exchange_rate, reporting_amount,
    reference, status, created_by
  ) values (
    'OIN-' || to_char(p_income_date, 'YYMMDD') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    p_income_date, v_income_account, v_receiving_account, btrim(p_description),
    p_amount, p_currency, p_exchange_rate, v_reporting, nullif(btrim(p_reference), ''), 'DRAFT', v_actor
  ) returning * into v_income;
  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    p_income_date, btrim(p_description), 'OTHER_INCOME', v_income.id::text,
    p_currency, p_exchange_rate, p_amount, v_reporting, v_actor
  ) returning * into v_entry;
  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_receiving_account, btrim(p_description), v_reporting, 0, p_amount, 0),
    (v_entry.id, v_income_account, btrim(p_description), 0, v_reporting, 0, p_amount);
  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.other_income set status = 'POSTED', accounting_journal_entry_id = v_entry.id where id = v_income.id returning * into v_income;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('OTHER_INCOME_POSTED', 'other_income', v_income.id::text, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_income;
end;
$$;

revoke all on function public.create_other_income(date, text, text, text, numeric, text, numeric, text) from public, anon;
grant execute on function public.create_other_income(date, text, text, text, numeric, text, numeric, text) to authenticated;

create or replace function public.guard_posted_accounting_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'POSTED'
     and coalesce(current_setting('app.accounting_void_authorized', true), 'false') <> 'true' then
    raise exception 'Posted accounting records are immutable. Use void_accounting_entry() with a correction reason.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_posted_accounting_document() from public, anon, authenticated;
drop trigger if exists trg_guard_posted_payment on public.payment_records;
create trigger trg_guard_posted_payment before update or delete on public.payment_records
  for each row execute function public.guard_posted_accounting_document();
drop trigger if exists trg_guard_posted_expense on public.expenses;
create trigger trg_guard_posted_expense before update or delete on public.expenses
  for each row execute function public.guard_posted_accounting_document();
drop trigger if exists trg_guard_posted_other_income on public.other_income;
create trigger trg_guard_posted_other_income before update or delete on public.other_income
  for each row execute function public.guard_posted_accounting_document();

create or replace function public.void_accounting_entry(
  p_journal_entry_id uuid,
  p_reason text
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_original public.journal_entries%rowtype;
  v_reversal public.journal_entries%rowtype;
begin
  select name, role into v_actor_name, v_role
  from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_role not in ('Admin','Manager') then
    raise exception 'Voiding a posted entry requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A correction reason is required.';
  end if;

  select * into v_original from public.journal_entries
  where id = p_journal_entry_id for update;
  if v_original.id is null then raise exception 'Journal entry not found.'; end if;
  if v_original.status <> 'POSTED' then raise exception 'Only a posted journal can be voided.'; end if;
  if v_original.reversal_of is not null then raise exception 'A reversal entry cannot be voided again.'; end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, reversal_of,
    correction_reason, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    current_date, 'Reversal: ' || v_original.description, 'REVERSAL', v_original.id::text,
    v_original.currency, v_original.exchange_rate, v_original.original_amount,
    v_original.base_amount, v_original.id, btrim(p_reason), v_actor
  ) returning * into v_reversal;

  insert into public.journal_lines (
    journal_entry_id, account_id, description, debit, credit, original_debit, original_credit
  )
  select v_reversal.id, account_id, 'Reversal: ' || coalesce(description, v_original.description),
    credit, debit, original_credit, original_debit
  from public.journal_lines where journal_entry_id = v_original.id;

  update public.journal_entries set status = 'POSTED', posted_by = v_actor
  where id = v_reversal.id returning * into v_reversal;
  perform set_config('app.accounting_void_authorized', 'true', true);
  update public.journal_entries
  set status = 'VOIDED', voided_by = v_actor, voided_at = now(), correction_reason = btrim(p_reason)
  where id in (v_original.id, v_reversal.id);

  if v_original.reference_type = 'PAYMENT' then
    update public.payment_records set status = 'VOIDED' where id = v_original.reference_id;
  elsif v_original.reference_type = 'EXPENSE' then
    update public.expenses set status = 'VOIDED' where id = v_original.reference_id;
  elsif v_original.reference_type = 'OTHER_INCOME' then
    update public.other_income set status = 'VOIDED' where id::text = v_original.reference_id;
  end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('ACCOUNTING_ENTRY_VOIDED', 'journal_entry', v_original.id::text, v_actor, v_actor_name,
    jsonb_build_object('reason', btrim(p_reason), 'reversal_entry_id', v_reversal.id));
  select * into v_reversal from public.journal_entries where id = v_reversal.id;
  return v_reversal;
end;
$$;

revoke all on function public.void_accounting_entry(uuid, text) from public, anon;
grant execute on function public.void_accounting_entry(uuid, text) to authenticated;

-- Preview legacy rows before any accounting backfill. No financial values are
-- invented: non-USD records without a saved FX snapshot are explicitly blocked.
create or replace function public.accounting_backfill_preview()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'invoiceCandidates', (select count(*) from public.shipments where invoice_finalized_at is not null and accounting_journal_entry_id is null),
    'invoiceBlockedMissingFx', (select count(*) from public.shipments where invoice_finalized_at is not null and accounting_journal_entry_id is null and ((invoice_currency = 'TZS' and usd_to_tzs_rate_used is null) or (invoice_currency = 'AED' and usd_to_aed_rate_used is null))),
    'paymentCandidates', (select count(*) from public.payment_records where accounting_journal_entry_id is null),
    'paymentBlockedMissingFx', (select count(*) from public.payment_records payment join public.shipments shipment on shipment.id = payment.shipment_id where payment.accounting_journal_entry_id is null and ((payment.currency = 'TZS' and shipment.usd_to_tzs_rate_used is null) or (payment.currency = 'AED' and shipment.usd_to_aed_rate_used is null))),
    'expenseCandidates', (select count(*) from public.expenses where accounting_journal_entry_id is null),
    'expenseBlockedMissingFx', (select count(*) from public.expenses expense where expense.accounting_journal_entry_id is null and expense.currency <> 'USD' and not exists (select 1 from public.exchange_rates rate where rate.rate_date <= expense.date::date))
  )
$$;

revoke all on function public.accounting_backfill_preview() from public, anon;
grant execute on function public.accounting_backfill_preview() to authenticated;

create or replace view public.accounting_trial_balance
with (security_invoker = true)
as
select
  account.id as account_id,
  account.code,
  account.name,
  account.account_type,
  coalesce(sum(case when entry.id is not null then line.debit else 0 end), 0)::numeric(18,2) as debit,
  coalesce(sum(case when entry.id is not null then line.credit else 0 end), 0)::numeric(18,2) as credit,
  (
    coalesce(sum(case when entry.id is not null then line.debit else 0 end), 0)
    - coalesce(sum(case when entry.id is not null then line.credit else 0 end), 0)
  )::numeric(18,2) as balance
from public.accounting_accounts as account
left join public.journal_lines as line on line.account_id = account.id
left join public.journal_entries as entry on entry.id = line.journal_entry_id and entry.status = 'POSTED'
where account.active
group by account.id, account.code, account.name, account.account_type;

alter table public.accounting_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;
alter table public.other_income enable row level security;

grant select on public.accounting_accounts, public.journal_entries, public.journal_lines, public.other_income to authenticated;
grant select on public.accounting_trial_balance to authenticated;

drop policy if exists "financial roles read accounts" on public.accounting_accounts;
create policy "financial roles read accounts" on public.accounting_accounts for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));
drop policy if exists "admins manage accounts" on public.accounting_accounts;
create policy "admins manage accounts" on public.accounting_accounts for all to authenticated
  using ((select public.staff_role()) = 'Admin')
  with check ((select public.staff_role()) = 'Admin');

drop policy if exists "financial roles read journals" on public.journal_entries;
create policy "financial roles read journals" on public.journal_entries for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));
drop policy if exists "financial roles read journal lines" on public.journal_lines;
create policy "financial roles read journal lines" on public.journal_lines for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));
drop policy if exists "financial roles read other income" on public.other_income;
create policy "financial roles read other income" on public.other_income for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));

-- Active staff remains a restrictive gate; accounting role policies above
-- further narrow these tables to Manager/Admin.
do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'accounting_accounts', 'journal_entries', 'journal_lines', 'other_income'
  ] loop
    execute format('drop policy if exists "active staff access gate" on public.%I', protected_table);
    execute format(
      'create policy "active staff access gate" on public.%I as restrictive for all to authenticated using ((select public.is_active_staff())) with check ((select public.is_active_staff()))',
      protected_table
    );
  end loop;
end $$;

insert into public.business_audit_log (
  action, entity_type, entity_id, actor_name, details
)
values (
  'ACCOUNTING_SCHEMA_INSTALLED', 'system', 'double_entry_accounting', 'Migration',
  jsonb_build_object('reporting_currency', 'USD', 'backfill_applied', false)
);


-- MIGRATION 09/22: 20260816112517_add_bank_account_name.sql
-- Add the bank account holder name so invoices can show "Account Name"
-- alongside the existing Bank Name / Bank Account / Bank SWIFT fields.
-- Additive only: existing rows default to '' and keep working unchanged.

alter table public.company_settings
  add column if not exists bank_account_name text not null default '';


-- MIGRATION 10/22: 20260817182455_close_packing_list.sql
-- Packing List "Close" stage: a formal, guarded business-state transition
-- that lets staff lock a Packing List's contents once packing is verified,
-- WITHOUT touching shipment status. This reuses the existing Draft/Dispatched
-- lock architecture (guard_packing_list_lock / guard_packing_child_lock) and
-- the existing "authorized transition" session-flag pattern already used by
-- transition_shipment_status() / guard_shipment_status_direct_update() for
-- shipments — no second, conflicting locking mechanism is introduced.
--
-- State model: Draft -> Closed -> Dispatched (Dispatched is still reachable
-- directly from Draft too, unchanged, for staff who dispatch without an
-- explicit close step). Closed and Dispatched are both "locked" states from
-- the packing_list_items/packing_boxes point of view. Reopening a Closed
-- list is intentionally NOT implemented here — see close_packing_list().

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.packing_lists drop constraint if exists packing_lists_status_check;
alter table public.packing_lists
  add constraint packing_lists_status_check
  check (status in ('Draft', 'Closed', 'Dispatched'));

alter table public.packing_lists
  add column if not exists closed_at text,
  add column if not exists closed_by text;

-- ---------------------------------------------------------------------------
-- Every place that decides "does this allocation still count against the
-- item's packed quantity" must include Closed lists — closing a list does
-- not release or invalidate its allocations.
-- ---------------------------------------------------------------------------

create or replace function public.upsert_packing_allocation(
  p_box_id uuid,
  p_shipment_item_id uuid,
  p_quantity numeric,
  p_operation text default 'ADD'
)
returns public.packing_list_items
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item public.shipment_items%rowtype;
  v_list_id text;
  v_list_status text;
  v_current numeric(14,3) := 0;
  v_allocated numeric(14,3) := 0;
  v_delta numeric(14,3);
  v_available numeric(14,3);
  v_new_quantity numeric(14,3);
  v_result public.packing_list_items%rowtype;
begin
  perform public.assert_active_staff();
  if p_quantity is null or p_quantity <= 0 then raise exception 'Quantity must be greater than zero.'; end if;
  if upper(p_operation) not in ('ADD','SET') then raise exception 'Unsupported allocation operation.'; end if;

  select * into v_item
  from public.shipment_items
  where id = p_shipment_item_id
  for update;
  if v_item.id is null then raise exception 'Shipment item not found.'; end if;

  select box.packing_list_id, list.status
  into v_list_id, v_list_status
  from public.packing_boxes as box
  join public.packing_lists as list on list.id = box.packing_list_id
  where box.id = p_box_id
  for update of box, list;

  if v_list_id is null then raise exception 'Packing box not found.'; end if;
  if v_list_status <> 'Draft' then raise exception 'Only Draft Packing Lists can be edited.'; end if;

  select coalesce(quantity, 0) into v_current
  from public.packing_list_items
  where box_id = p_box_id and shipment_item_id = p_shipment_item_id
  for update;
  v_current := coalesce(v_current, 0);

  select coalesce(sum(allocation.quantity), 0) into v_allocated
  from public.packing_list_items as allocation
  join public.packing_lists as list on list.id = allocation.packing_list_id
  where allocation.shipment_item_id = p_shipment_item_id
    and list.status in ('Draft','Closed','Dispatched');

  v_available := v_item.quantity - v_allocated;
  v_new_quantity := case when upper(p_operation) = 'SET' then p_quantity else v_current + p_quantity end;
  v_delta := v_new_quantity - v_current;

  if v_delta > v_available then
    raise exception 'Only % % are available for this item.',
      trim(to_char(greatest(v_available, 0), 'FM999999999990.###')),
      v_item.unit;
  end if;

  insert into public.packing_list_items (
    packing_list_id, box_id, shipment_item_id, quantity, created_by
  ) values (
    v_list_id, p_box_id, p_shipment_item_id, v_new_quantity, auth.uid()
  )
  on conflict (box_id, shipment_item_id) do update
    set quantity = excluded.quantity,
        updated_at = now()
  returning * into v_result;

  update public.packing_lists
  set shipment_ids = case
        when v_item.shipment_id = any(shipment_ids) then shipment_ids
        else array_append(shipment_ids, v_item.shipment_id)
      end,
      updated_at = current_date::text
  where id = v_list_id;

  update public.shipments
  set packing_list_id = coalesce(packing_list_id, v_list_id)
  where id = v_item.shipment_id;

  return v_result;
end;
$$;

create or replace function public.guard_finalized_shipment_items()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_shipment_id text;
  v_allocated numeric(14,3) := 0;
begin
  v_shipment_id := case when tg_op = 'DELETE' then old.shipment_id else new.shipment_id end;

  if exists (
    select 1 from public.shipments
    where id = v_shipment_id and invoice_finalized_at is not null
  ) then
    raise exception 'Cargo items on a finalized invoice are immutable.';
  end if;

  if tg_op = 'DELETE' and exists (
    select 1 from public.packing_list_items where shipment_item_id = old.id
  ) then
    raise exception 'This item is already used in a Packing List and cannot be deleted.';
  end if;

  if tg_op = 'UPDATE' and new.quantity <> old.quantity then
    select coalesce(sum(allocation.quantity), 0) into v_allocated
    from public.packing_list_items as allocation
    join public.packing_lists as list on list.id = allocation.packing_list_id
    where allocation.shipment_item_id = old.id
      and list.status in ('Draft','Closed','Dispatched');

    if new.quantity < v_allocated then
      raise exception 'This item already has % % allocated to Packing Lists. Quantity cannot be reduced below % %.',
        trim(to_char(v_allocated, 'FM999999999990.###')), old.unit,
        trim(to_char(v_allocated, 'FM999999999990.###')), old.unit;
    end if;
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- Locking: extend "locked once Dispatched" to "locked once no longer Draft"
-- (i.e. Closed or Dispatched). The packing_lists-level guard additionally
-- respects the same authorized-transition session flag already used for
-- shipments, so close_packing_list()/dispatch_packing_list_with_status() can
-- perform their own controlled status write while any other direct client
-- update remains blocked.
-- ---------------------------------------------------------------------------

create or replace function public.guard_packing_list_lock()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_authorized boolean := coalesce(current_setting('app.packing_list_status_transition_authorized', true), 'false') = 'true';
begin
  -- Whole row is locked once no longer Draft (Closed or Dispatched), same as
  -- the pre-existing "Dispatched Packing Lists are locked" behavior, just
  -- extended to Closed too.
  if old.status <> 'Draft' and not v_authorized then
    raise exception '% Packing Lists are locked.', old.status;
  end if;
  -- Independently, ANY direct change to status itself — even from Draft —
  -- must go through close_packing_list() / dispatch_packing_list_with_status(),
  -- mirroring guard_shipment_status_direct_update() for shipments. Without
  -- this, a raw client UPDATE could set status = 'Closed' on a Draft row
  -- while skipping every pre-close validation and the closed_at/closed_by/
  -- audit-log bookkeeping.
  if tg_op = 'UPDATE' and new.status is distinct from old.status and not v_authorized then
    raise exception 'Packing List status must be changed through close_packing_list() or dispatch_packing_list_with_status().';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create or replace function public.guard_packing_child_lock()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list_id text;
begin
  v_list_id := case when tg_op = 'DELETE' then old.packing_list_id else new.packing_list_id end;
  if exists (
    select 1 from public.packing_lists where id = v_list_id and status <> 'Draft'
  ) then
    raise exception 'This Packing List is closed or dispatched and its contents are locked.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

-- ---------------------------------------------------------------------------
-- close_packing_list(): the guarded RPC. Direct client UPDATEs of
-- packing_lists.status are blocked by guard_packing_list_lock() above; this
-- is the only sanctioned way to transition Draft -> Closed.
-- ---------------------------------------------------------------------------

create or replace function public.close_packing_list(
  p_packing_list_id text
)
returns public.packing_lists
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor_name text;
  v_list public.packing_lists%rowtype;
  v_changed_at text := now()::text;
begin
  -- (3) caller must be an active staff member. (4) permission to close:
  -- packing actions are open to every active staff role in this app today
  -- (Draft creation, box/allocation edits, and Dispatch All all have no
  -- extra role gate either) so Close follows the same model rather than
  -- introducing an inconsistent restriction.
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor_id
    and profile.active
    and not profile.must_change_password;

  if v_actor_name is null then
    raise exception 'An active staff session is required.';
  end if;

  -- (1)/(2) the packing list must exist.
  select * into v_list
  from public.packing_lists
  where id = p_packing_list_id
  for update;

  if v_list.id is null then
    raise exception 'Packing List not found.';
  end if;

  -- (5) must currently be open.
  if v_list.status <> 'Draft' then
    raise exception 'Only an open Packing List can be closed.';
  end if;

  -- (6) must contain at least one saved allocation.
  if not exists (
    select 1 from public.packing_list_items where packing_list_id = p_packing_list_id
  ) then
    raise exception 'This Packing List has no packed items to close.';
  end if;

  -- (7) no invalid/negative quantity. packing_list_items.quantity already has
  -- a `check (quantity > 0)` table constraint, so this can never actually be
  -- true today — kept as an explicit, defense-in-depth re-check rather than
  -- silently trusting the table constraint never changes.
  if exists (
    select 1 from public.packing_list_items
    where packing_list_id = p_packing_list_id and quantity <= 0
  ) then
    raise exception 'This Packing List has an invalid quantity and cannot be closed.';
  end if;

  -- (8) no allocation, combined with any other active list's allocations for
  -- the same item, may exceed the original Shipment Item quantity.
  if exists (
    select 1
    from (
      select allocation.shipment_item_id,
             sum(allocation.quantity) as allocated,
             item.quantity as item_quantity
      from public.packing_list_items as allocation
      join public.shipment_items as item on item.id = allocation.shipment_item_id
      join public.packing_lists as list on list.id = allocation.packing_list_id
      where list.status in ('Draft','Closed','Dispatched')
        and allocation.shipment_item_id in (
          select shipment_item_id from public.packing_list_items where packing_list_id = p_packing_list_id
        )
      group by allocation.shipment_item_id, item.quantity
    ) as totals
    where totals.allocated > totals.item_quantity
  ) then
    raise exception 'One or more items exceed the original Shipment Item quantity and cannot be closed.';
  end if;

  -- (9) "required packing information saved": every row read above came from
  -- committed table state, so there is nothing left pending client-side.

  perform set_config('app.packing_list_status_transition_authorized', 'true', true);
  update public.packing_lists
  set status = 'Closed',
      closed_at = v_changed_at,
      closed_by = v_actor_name,
      updated_at = v_changed_at
  where id = p_packing_list_id
  returning * into v_list;

  insert into public.business_audit_log (
    action, entity_type, entity_id, actor_id, actor_name, occurred_at, details
  ) values (
    'PACKING_LIST_CLOSED', 'packing_list', p_packing_list_id, v_actor_id, v_actor_name, now(),
    jsonb_build_object('list_id', v_list.list_id)
  );

  return v_list;
end;
$$;

revoke all on function public.close_packing_list(text) from public, anon;
grant execute on function public.close_packing_list(text) to authenticated;

-- ---------------------------------------------------------------------------
-- dispatch_packing_list_with_status(): unchanged behavior for every existing
-- caller (a Draft list dispatches exactly as before). Additionally allows
-- dispatching a Closed list — Close and Dispatch are sequential real-world
-- steps (verify & seal, then send), not mutually exclusive terminal states,
-- so a Closed list is not a dead end. Closing a list still never touches
-- shipment status by itself; only this explicit Dispatch action does, and
-- only when a staff member calls it.
-- ---------------------------------------------------------------------------

create or replace function public.dispatch_packing_list_with_status(
  p_packing_list_id text,
  p_dispatch_note text default null
)
returns public.packing_lists
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_list public.packing_lists%rowtype;
  v_shipment record;
  v_has_shipments boolean := false;
begin
  select * into v_list
  from public.packing_lists
  where id = p_packing_list_id
  for update;
  if v_list.id is null then raise exception 'Packing List not found.'; end if;
  if v_list.status not in ('Draft','Closed') then
    raise exception 'Only an open or closed Packing List can be dispatched.';
  end if;

  for v_shipment in
    select shipment.id, shipment.status, shipment.origin, shipment.shipment_type
    from public.shipments as shipment
    where exists (
      select 1
      from public.shipment_items as item
      join public.packing_list_items as allocation on allocation.shipment_item_id = item.id
      where item.shipment_id = shipment.id
        and allocation.packing_list_id = p_packing_list_id
    )
    order by shipment.id
    for update of shipment
  loop
    v_has_shipments := true;
    if v_shipment.status = 'RECEIVED' then
      perform public.transition_shipment_status(
        p_shipment_id => v_shipment.id,
        p_new_status => 'PACKED',
        p_location => v_shipment.origin,
        p_public_note => 'Packed for dispatch in Packing List ' || v_list.list_id
      );
      v_shipment.status := 'PACKED';
    end if;
    if v_shipment.status = 'PACKED' then
      perform public.transition_shipment_status(
        p_shipment_id => v_shipment.id,
        p_new_status => 'DISPATCHED',
        p_location => v_shipment.origin,
        p_public_note => coalesce(nullif(btrim(p_dispatch_note), ''), 'Dispatched from Dubai'),
        p_dispatch_reference => v_list.list_id
      );
    elsif v_shipment.status not in ('DISPATCHED','ON_TRANSIT','IN_CUSTOMS','ARRIVED','DELIVERED') then
      raise exception 'Shipment % cannot be dispatched from status %.', v_shipment.id, v_shipment.status;
    end if;
  end loop;

  if not v_has_shipments then raise exception 'Packing List has no allocated shipment items.'; end if;

  perform set_config('app.packing_list_status_transition_authorized', 'true', true);
  update public.packing_lists
  set status = 'Dispatched', dispatched_at = now()::text, updated_at = now()::text
  where id = p_packing_list_id
  returning * into v_list;
  return v_list;
end;
$$;


-- MIGRATION 11/22: 20260817184710_storage_inventory.sql
-- Storage / Inventory module.
--
-- Adds a minimal, additive "returned to customer" representation (no such
-- workflow exists anywhere in this codebase today — confirmed by inspection
-- of every migration and every frontend screen) and a single guarded,
-- paginated read RPC that computes every inventory quantity server-side so
-- the browser never has to pull the full historical shipment_items table
-- to answer "what's in storage right now".
--
-- Quantity semantics (derived, never stored as a mutable counter, matching
-- the existing packed/available pattern in packing.ts):
--   total_quantity      = shipment_items.quantity (unchanged, existing)
--   packed_quantity     = sum(packing_list_items.quantity) for allocations in
--                          Draft/Closed/Dispatched lists — the exact existing
--                          "packed" meaning already used everywhere in the
--                          app (allocatedQuantity in src/lib/packing.ts). Not
--                          redefined here.
--   dispatched_quantity = sum(packing_list_items.quantity) for allocations in
--                          Dispatched lists ONLY. A packing list only reaches
--                          Dispatched via dispatch_packing_list_with_status(),
--                          which is also what moves the shipment to
--                          DISPATCHED+ — i.e. this is genuinely "has left the
--                          Dubai warehouse", not merely "packed into a box".
--   returned_quantity   = sum(item_returns.quantity) for this item.
--   storage_quantity    = total_quantity - dispatched_quantity - returned_quantity,
--                          floored at 0. An item packed into a Draft/Closed
--                          list's box is still physically in storage — only
--                          Dispatch and Return remove it.
--   remaining_quantity  = total_quantity - packed_quantity (existing,
--                          unchanged "available to pack" meaning).

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- item_returns: minimal persistent representation of "returned to customer
-- without being shipped". Append-only from the app's point of view (no
-- update/delete RPC is provided — a correction is a new, possibly negative
-- adjustment is explicitly NOT supported here to avoid a second, conflicting
-- way to represent "how much of this item is actually in storage"; if a
-- return needs correcting, that is a separate, explicitly-scoped follow-up).
-- ---------------------------------------------------------------------------

create table if not exists public.item_returns (
  id uuid primary key default gen_random_uuid(),
  shipment_item_id uuid not null references public.shipment_items (id) on delete restrict,
  quantity numeric(14,3) not null check (quantity > 0),
  reason text,
  returned_by uuid references public.staff_profiles (id) on delete set null,
  returned_by_name text not null default 'System',
  returned_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists item_returns_item_idx on public.item_returns (shipment_item_id);
create index if not exists item_returns_returned_at_idx on public.item_returns (returned_at desc);

alter table public.item_returns enable row level security;

grant select on public.item_returns to authenticated;

drop policy if exists "active staff can read item returns" on public.item_returns;
create policy "active staff can read item returns" on public.item_returns
  for select to authenticated
  using (
    (select auth.uid()) is not null
    and exists (
      select 1 from public.staff_profiles
      where id = (select auth.uid()) and active
    )
  );
-- No insert/update/delete policy: writes only happen through
-- record_item_return() below (SECURITY DEFINER bypasses RLS for its own
-- insert), matching packing_boxes/packing_list_items.

-- ---------------------------------------------------------------------------
-- record_item_return(): the only sanctioned way to record a return. Re-checks
-- the storage quantity itself rather than trusting a client-supplied value,
-- so a return can never exceed what the server believes is actually in
-- storage at the moment of the call.
-- ---------------------------------------------------------------------------

create or replace function public.record_item_return(
  p_shipment_item_id uuid,
  p_quantity numeric,
  p_reason text default null
)
returns public.item_returns
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor_name text;
  v_item public.shipment_items%rowtype;
  v_dispatched numeric(14,3) := 0;
  v_returned numeric(14,3) := 0;
  v_storage numeric(14,3);
  v_result public.item_returns%rowtype;
begin
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor_id
    and profile.active
    and not profile.must_change_password;

  if v_actor_name is null then
    raise exception 'An active staff session is required.';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'Return quantity must be greater than zero.';
  end if;

  select * into v_item
  from public.shipment_items
  where id = p_shipment_item_id
  for update;
  if v_item.id is null then raise exception 'Shipment item not found.'; end if;

  select coalesce(sum(allocation.quantity), 0) into v_dispatched
  from public.packing_list_items as allocation
  join public.packing_lists as list on list.id = allocation.packing_list_id
  where allocation.shipment_item_id = p_shipment_item_id
    and list.status = 'Dispatched';

  select coalesce(sum(ret.quantity), 0) into v_returned
  from public.item_returns as ret
  where ret.shipment_item_id = p_shipment_item_id
  for update;

  v_storage := greatest(0, v_item.quantity - v_dispatched - v_returned);

  if p_quantity > v_storage then
    raise exception 'Only % % is currently in storage for this item.',
      trim(to_char(v_storage, 'FM999999999990.###')), v_item.unit;
  end if;

  insert into public.item_returns (
    shipment_item_id, quantity, reason, returned_by, returned_by_name
  ) values (
    p_shipment_item_id, p_quantity, nullif(btrim(p_reason), ''), v_actor_id, v_actor_name
  )
  returning * into v_result;

  insert into public.business_audit_log (
    action, entity_type, entity_id, actor_id, actor_name, occurred_at, details
  ) values (
    'ITEM_RETURNED', 'shipment_item', p_shipment_item_id::text, v_actor_id, v_actor_name, now(),
    jsonb_build_object('quantity', p_quantity, 'reason', nullif(btrim(p_reason), ''))
  );

  return v_result;
end;
$$;

revoke all on function public.record_item_return(uuid, numeric, text) from public, anon;
grant execute on function public.record_item_return(uuid, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- search_inventory(): the Storage/Inventory screen's only data source.
-- Guarded read (active staff only, matching every other packing/shipment
-- RPC), paginated and filtered entirely in Postgres so the browser never
-- has to hold the full shipment_items table in memory. total_count is a
-- window aggregate over the filtered set (computed before LIMIT/OFFSET) so
-- the UI can render page numbers without a second round trip.
-- ---------------------------------------------------------------------------

create or replace function public.search_inventory(
  p_search text default null,
  p_customer_id text default null,
  p_tracking_number text default null,
  p_packing_status text default null,
  p_returned_only boolean default false,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  shipment_item_id uuid,
  item_code text,
  description text,
  unit text,
  total_quantity numeric,
  packed_quantity numeric,
  dispatched_quantity numeric,
  returned_quantity numeric,
  storage_quantity numeric,
  shipment_id text,
  tracking_number text,
  shipment_status text,
  customer_id text,
  customer_name text,
  last_updated timestamptz,
  total_count bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.staff_profiles where id = auth.uid() and active
  ) then
    raise exception 'An active staff session is required.';
  end if;

  if p_packing_status is not null and p_packing_status not in ('NOT_PACKED','PARTIALLY_PACKED','FULLY_PACKED') then
    raise exception 'Unsupported packing status filter: %', p_packing_status;
  end if;

  return query
  with packed as (
    select
      allocation.shipment_item_id as item_id,
      sum(allocation.quantity) filter (where list.status in ('Draft','Closed','Dispatched')) as packed_quantity,
      sum(allocation.quantity) filter (where list.status = 'Dispatched') as dispatched_quantity
    from public.packing_list_items as allocation
    join public.packing_lists as list on list.id = allocation.packing_list_id
    group by allocation.shipment_item_id
  ),
  returned as (
    select ret.shipment_item_id as item_id, sum(ret.quantity) as returned_quantity
    from public.item_returns as ret
    group by ret.shipment_item_id
  ),
  base as (
    select
      item.id as shipment_item_id,
      item.item_code,
      item.description,
      item.unit,
      item.quantity as total_quantity,
      coalesce(packed.packed_quantity, 0) as packed_quantity,
      coalesce(packed.dispatched_quantity, 0) as dispatched_quantity,
      coalesce(returned.returned_quantity, 0) as returned_quantity,
      greatest(0, item.quantity - coalesce(packed.dispatched_quantity, 0) - coalesce(returned.returned_quantity, 0)) as storage_quantity,
      shipment.id as shipment_id,
      shipment.tracking_number,
      shipment.status as shipment_status,
      nullif(shipment.updated_at, '')::timestamptz as last_updated,
      customer.id as customer_id,
      coalesce(nullif(customer.company, ''), nullif(customer.name, ''), nullif(shipment.customer_name_snapshot, ''), 'Unknown') as customer_name
    from public.shipment_items as item
    join public.shipments as shipment on shipment.id = item.shipment_id
    left join public.customers as customer on customer.id = shipment.customer_id
    left join packed on packed.item_id = item.id
    left join returned on returned.item_id = item.id
  )
  select
    base.shipment_item_id, base.item_code, base.description, base.unit,
    base.total_quantity, base.packed_quantity, base.dispatched_quantity,
    base.returned_quantity, base.storage_quantity,
    base.shipment_id, base.tracking_number, base.shipment_status,
    base.customer_id, base.customer_name, base.last_updated,
    count(*) over() as total_count
  from base
  where (p_search is null or btrim(p_search) = '' or
      base.item_code ilike '%' || p_search || '%' or
      base.description ilike '%' || p_search || '%' or
      base.tracking_number ilike '%' || p_search || '%' or
      base.customer_name ilike '%' || p_search || '%')
    and (p_customer_id is null or base.customer_id = p_customer_id)
    and (p_tracking_number is null or btrim(p_tracking_number) = '' or base.tracking_number ilike '%' || p_tracking_number || '%')
    and (p_packing_status is null or
      (p_packing_status = 'NOT_PACKED' and base.packed_quantity <= 0) or
      (p_packing_status = 'PARTIALLY_PACKED' and base.packed_quantity > 0 and base.packed_quantity < base.total_quantity) or
      (p_packing_status = 'FULLY_PACKED' and base.packed_quantity >= base.total_quantity))
    and (not p_returned_only or base.returned_quantity > 0)
  order by base.last_updated desc nulls last, base.tracking_number, base.item_code
  limit greatest(coalesce(p_limit, 50), 1)
  offset greatest(coalesce(p_offset, 0), 0);
end;
$$;

revoke all on function public.search_inventory(text, text, text, text, boolean, integer, integer) from public, anon;
grant execute on function public.search_inventory(text, text, text, text, boolean, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- get_inventory_item_detail(): the detail-view data source for a single
-- item — same guarded pattern, plus the boxes/packing lists the item was
-- packed into (for the "Boxes containing this item" style breakdown already
-- used in ItemDetails.tsx) and its return history.
-- ---------------------------------------------------------------------------

create or replace function public.get_inventory_item_detail(p_shipment_item_id uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_item public.shipment_items%rowtype;
  v_shipment public.shipments%rowtype;
  v_customer public.customers%rowtype;
  v_dispatched numeric(14,3) := 0;
  v_packed numeric(14,3) := 0;
  v_returned numeric(14,3) := 0;
  v_boxes jsonb;
  v_returns jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.staff_profiles where id = auth.uid() and active
  ) then
    raise exception 'An active staff session is required.';
  end if;

  select * into v_item from public.shipment_items where id = p_shipment_item_id;
  if v_item.id is null then raise exception 'Shipment item not found.'; end if;

  select * into v_shipment from public.shipments where id = v_item.shipment_id;
  select * into v_customer from public.customers where id = v_shipment.customer_id;

  select coalesce(sum(allocation.quantity) filter (where list.status in ('Draft','Closed','Dispatched')), 0),
         coalesce(sum(allocation.quantity) filter (where list.status = 'Dispatched'), 0)
  into v_packed, v_dispatched
  from public.packing_list_items as allocation
  join public.packing_lists as list on list.id = allocation.packing_list_id
  where allocation.shipment_item_id = p_shipment_item_id;

  select coalesce(sum(ret.quantity), 0) into v_returned
  from public.item_returns as ret where ret.shipment_item_id = p_shipment_item_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'boxNumber', box.box_number,
    'packingListId', list.id,
    'packingListNumber', list.list_id,
    'packingListStatus', list.status,
    'quantity', allocation.quantity
  ) order by list.list_id, box.box_number), '[]'::jsonb)
  into v_boxes
  from public.packing_list_items as allocation
  join public.packing_boxes as box on box.id = allocation.box_id
  join public.packing_lists as list on list.id = allocation.packing_list_id
  where allocation.shipment_item_id = p_shipment_item_id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'quantity', ret.quantity,
    'reason', ret.reason,
    'returnedBy', ret.returned_by_name,
    'returnedAt', ret.returned_at
  ) order by ret.returned_at desc), '[]'::jsonb)
  into v_returns
  from public.item_returns as ret
  where ret.shipment_item_id = p_shipment_item_id;

  return jsonb_build_object(
    'shipmentItemId', v_item.id,
    'itemCode', v_item.item_code,
    'description', v_item.description,
    'unit', v_item.unit,
    'qrToken', v_item.qr_token,
    'totalQuantity', v_item.quantity,
    'packedQuantity', v_packed,
    'dispatchedQuantity', v_dispatched,
    'returnedQuantity', v_returned,
    'storageQuantity', greatest(0, v_item.quantity - v_dispatched - v_returned),
    'shipmentId', v_shipment.id,
    'trackingNumber', v_shipment.tracking_number,
    'shipmentStatus', v_shipment.status,
    'customerId', v_customer.id,
    'customerName', coalesce(nullif(v_customer.company, ''), nullif(v_customer.name, ''), nullif(v_shipment.customer_name_snapshot, ''), 'Unknown'),
    'boxes', v_boxes,
    'returns', v_returns
  );
end;
$$;

revoke all on function public.get_inventory_item_detail(uuid) from public, anon;
grant execute on function public.get_inventory_item_detail(uuid) to authenticated;


-- MIGRATION 12/22: 20260817190000_staff_profile_pictures.sql
-- Staff profile pictures.
--
-- Adds one nullable column to the existing staff_profiles table (the path
-- of the currently-active photo, not a URL — the bucket is private, so a
-- signed URL is minted on demand by the frontend and never persisted) and
-- a new private Storage bucket with its own RLS policies.
--
-- Ownership boundary is enforced by Storage RLS itself, not just by what
-- buttons the UI shows: a staff member may only write to their own
-- "{user_id}/profile.{ext}" object; an Admin may write to any staff
-- member's — mirroring the exact "self OR Admin" shape already used by
-- staff_profiles' own "staff can update own profile" /
-- "admins can update any profile" policies (see 0001_shipments_and_auth.sql).
-- MIME type and file size are enforced at the bucket level (native Storage
-- feature), so a client-side check is only ever a fast-fail convenience,
-- never the real gate.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.staff_profiles
  add column if not exists avatar_path text;

-- ---------------------------------------------------------------------------
-- Bucket: private (public = false). Every read/write already requires an
-- authenticated Supabase session in this app (see 0001's RLS comment on why
-- the anon/publishable key has no table access at all) — a public bucket
-- would be the first exception to that, so this stays private and reads go
-- through short-lived signed URLs instead.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-profile-images', 'staff-profile-images', false,
  2097152, -- 2 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Any active staff member can read any profile photo (a colleague's photo
-- is not sensitive data, and every screen that shows staff — Staff
-- Management, the sidebar/topbar avatar — needs to resolve photos for
-- users other than the viewer). Uploads/replaces/removals stay restricted
-- to the object's own folder, or an Admin.
drop policy if exists "staff can read profile images" on storage.objects;
create policy "staff can read profile images" on storage.objects
  for select to authenticated
  using (bucket_id = 'staff-profile-images' and public.is_active_staff());

drop policy if exists "staff can upload own profile image" on storage.objects;
create policy "staff can upload own profile image" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and name ~ '^[0-9a-fA-F-]{36}/profile\.(jpg|jpeg|png|webp)$'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  );

drop policy if exists "staff can replace own profile image" on storage.objects;
create policy "staff can replace own profile image" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  )
  with check (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and name ~ '^[0-9a-fA-F-]{36}/profile\.(jpg|jpeg|png|webp)$'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  );

drop policy if exists "staff can remove own profile image" on storage.objects;
create policy "staff can remove own profile image" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  );


-- MIGRATION 13/22: 20260817193000_controlled_deletion_archive.sql
-- Controlled Data Deletion / Archive System.
--
-- Audit findings (by inspecting every table's RLS policy and every FK's ON
-- DELETE behavior, not just the frontend delete buttons):
--
--   customers        -- "for all ... using (true)" let ANY authenticated
--                        staff hard-delete ANY customer via a direct table
--                        call; only the Customers.tsx UI checked for
--                        existing shipments, and only client-side.
--   shipments        -- same blanket policy. Worse: payment_records.
--                        shipment_id is "on delete cascade", so deleting a
--                        shipment with POSTED payments would silently wipe
--                        the payment_records evidence for money already
--                        booked in the (immutable) journal_entries ledger —
--                        a real reconciliation hazard. (Packed/delivered
--                        shipments already have a safety net via existing
--                        "on delete restrict" FKs from shipment_items and
--                        shipment_delivery_confirmations — this migration
--                        closes the payments/invoice gap specifically.)
--   packing_lists    -- same blanket policy, and no guard at all against
--                        deleting a Closed/Dispatched list (only Draft was
--                        ever *meant* to be deletable — guard_packing_list_
--                        lock() only fires on UPDATE, never DELETE).
--   payment_records,
--   expenses,
--   journal_entries,
--   journal_lines,
--   other_income     -- already correctly guarded by the existing
--                        accounting migration (20260815013917): posted rows
--                        are immutable (guard_posted_accounting_document /
--                        guard_posted_journal_lines), and journal_entries /
--                        journal_lines / other_income have no direct
--                        INSERT/UPDATE/DELETE grant for `authenticated` at
--                        all — every write goes through a SECURITY DEFINER
--                        RPC. No changes needed here; this migration does
--                        not touch these tables.
--   staff_profiles   -- already correctly refuses hard delete: deleteUser()
--                        in useAuthStore.ts always throws and tells the
--                        caller to disable the account instead. No DB
--                        change needed; confirmed by reading, not assumed.
--   company_settings -- had an "admin manager can delete settings" DELETE
--                        policy with no UI path to it and no legitimate use
--                        case (the app assumes exactly one settings row
--                        exists everywhere it reads company_settings) —
--                        removed entirely below. Never-hard-delete, no
--                        exceptions, not even for Admin.
--
-- Classification applied below:
--   customers   -> safe-delete only with zero shipments; controlled-archive
--                  (archived_at/by, RPC-guarded) otherwise.
--   shipments   -> safe-delete only with no invoice, no journal entry, no
--                  payments (the already-existing FK restricts already
--                  cover packed/delivered); controlled-void (voided_at/by/
--                  reason, RPC-guarded, status untouched) otherwise.
--   packing_lists -> safe-delete only while Draft (matches the existing,
--                  already-Draft-only frontend flow — now enforced
--                  server-side too); never-hard-delete once Closed or
--                  Dispatched.
--   payment_records / expenses / journal* / other_income -> already
--                  never-hard-delete once posted (pre-existing).
--   staff_profiles -> already never-hard-delete (pre-existing).
--   company_settings -> never-hard-delete (hardened below).
--
-- Every guard below reuses public.business_audit_log for the archive/void/
-- delete trail — no new audit table, per the spec's explicit instruction.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- customers: archive columns + hard-delete guard + archive/unarchive RPCs
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists archived_at timestamptz,
  add column if not exists archived_by uuid references public.staff_profiles (id) on delete set null,
  add column if not exists archived_reason text;

create or replace function public.guard_and_log_customer_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
begin
  if exists (select 1 from public.shipments where customer_id = old.id) then
    raise exception 'This customer has shipment history and cannot be deleted. Archive it instead.';
  end if;

  select name into v_actor_name from public.staff_profiles where id = v_actor;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('CUSTOMER_DELETED', 'customer', old.id, v_actor, coalesce(v_actor_name, 'System'), now(),
    jsonb_build_object('name', old.name, 'company', old.company));

  return old;
end;
$$;

revoke all on function public.guard_and_log_customer_delete() from public, anon, authenticated;
drop trigger if exists trg_guard_and_log_customer_delete on public.customers;
create trigger trg_guard_and_log_customer_delete
  before delete on public.customers
  for each row execute function public.guard_and_log_customer_delete();

create or replace function public.archive_customer(p_customer_id text, p_reason text default null)
returns public.customers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_result public.customers%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can archive a customer.'; end if;

  update public.customers
  set archived_at = now(), archived_by = v_actor, archived_reason = nullif(btrim(p_reason), '')
  where id = p_customer_id and archived_at is null
  returning * into v_result;
  if v_result.id is null then raise exception 'Customer not found or already archived.'; end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('CUSTOMER_ARCHIVED', 'customer', p_customer_id, v_actor, v_actor_name, now(),
    jsonb_build_object('reason', nullif(btrim(p_reason), '')));

  return v_result;
end;
$$;

create or replace function public.unarchive_customer(p_customer_id text)
returns public.customers
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_result public.customers%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can restore an archived customer.'; end if;

  update public.customers
  set archived_at = null, archived_by = null, archived_reason = null
  where id = p_customer_id and archived_at is not null
  returning * into v_result;
  if v_result.id is null then raise exception 'Customer not found or not archived.'; end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at)
  values ('CUSTOMER_UNARCHIVED', 'customer', p_customer_id, v_actor, v_actor_name, now());

  return v_result;
end;
$$;

revoke all on function public.archive_customer(text, text) from public, anon;
revoke all on function public.unarchive_customer(text) from public, anon;
grant execute on function public.archive_customer(text, text) to authenticated;
grant execute on function public.unarchive_customer(text) to authenticated;

-- Split the old blanket "for all using(true)" into open read/write +
-- Admin-only delete, so deletion can never again be a UI-only restriction.
drop policy if exists "staff full access" on public.customers;
drop policy if exists "staff can read customers" on public.customers;
create policy "staff can read customers" on public.customers for select to authenticated using (true);
drop policy if exists "staff can write customers" on public.customers;
create policy "staff can write customers" on public.customers for insert to authenticated with check (true);
drop policy if exists "staff can update customers" on public.customers;
create policy "staff can update customers" on public.customers for update to authenticated using (true) with check (true);
drop policy if exists "admin can delete customers" on public.customers;
create policy "admin can delete customers" on public.customers for delete to authenticated
  using (public.is_staff_admin());

-- ---------------------------------------------------------------------------
-- shipments: void columns + hard-delete guard + void/unvoid RPCs
-- ---------------------------------------------------------------------------

alter table public.shipments
  add column if not exists voided_at timestamptz,
  add column if not exists voided_by uuid references public.staff_profiles (id) on delete set null,
  add column if not exists voided_reason text;

create or replace function public.guard_and_log_shipment_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
begin
  if old.invoice_finalized_at is not null or old.accounting_journal_entry_id is not null then
    raise exception 'This shipment has been invoiced and cannot be deleted. Void it instead.';
  end if;
  if exists (select 1 from public.payment_records where shipment_id = old.id) then
    raise exception 'This shipment has payment records and cannot be deleted. Void it instead.';
  end if;

  select name into v_actor_name from public.staff_profiles where id = v_actor;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('SHIPMENT_DELETED', 'shipment', old.id, v_actor, coalesce(v_actor_name, 'System'), now(),
    jsonb_build_object('trackingNumber', old.tracking_number, 'status', old.status));

  return old;
end;
$$;

revoke all on function public.guard_and_log_shipment_delete() from public, anon, authenticated;
drop trigger if exists trg_guard_and_log_shipment_delete on public.shipments;
create trigger trg_guard_and_log_shipment_delete
  before delete on public.shipments
  for each row execute function public.guard_and_log_shipment_delete();

create or replace function public.void_shipment(p_shipment_id text, p_reason text)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_result public.shipments%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can void a shipment.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to void a shipment.'; end if;

  update public.shipments
  set voided_at = now(), voided_by = v_actor, voided_reason = btrim(p_reason)
  where id = p_shipment_id and voided_at is null
  returning * into v_result;
  if v_result.id is null then raise exception 'Shipment not found or already voided.'; end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('SHIPMENT_VOIDED', 'shipment', p_shipment_id, v_actor, v_actor_name, now(),
    jsonb_build_object('reason', btrim(p_reason)));

  return v_result;
end;
$$;

create or replace function public.unvoid_shipment(p_shipment_id text)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_result public.shipments%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can restore a voided shipment.'; end if;

  update public.shipments
  set voided_at = null, voided_by = null, voided_reason = null
  where id = p_shipment_id and voided_at is not null
  returning * into v_result;
  if v_result.id is null then raise exception 'Shipment not found or not voided.'; end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at)
  values ('SHIPMENT_UNVOIDED', 'shipment', p_shipment_id, v_actor, v_actor_name, now());

  return v_result;
end;
$$;

revoke all on function public.void_shipment(text, text) from public, anon;
revoke all on function public.unvoid_shipment(text) from public, anon;
grant execute on function public.void_shipment(text, text) to authenticated;
grant execute on function public.unvoid_shipment(text) to authenticated;

drop policy if exists "staff full access" on public.shipments;
drop policy if exists "staff can read shipments" on public.shipments;
create policy "staff can read shipments" on public.shipments for select to authenticated using (true);
drop policy if exists "staff can insert shipments" on public.shipments;
create policy "staff can insert shipments" on public.shipments for insert to authenticated with check (true);
drop policy if exists "staff can update shipments" on public.shipments;
create policy "staff can update shipments" on public.shipments for update to authenticated using (true) with check (true);
drop policy if exists "admin can delete shipments" on public.shipments;
create policy "admin can delete shipments" on public.shipments for delete to authenticated
  using (public.is_staff_admin());

-- ---------------------------------------------------------------------------
-- packing_lists: hard-delete guard (Draft only) + audit log on delete.
-- Deletion stays open to every active staff role — matching the existing
-- "packing is operational, not Admin-gated" precedent (see packing.close in
-- useAuthStore.ts) — only the Draft-only condition is new, and only at the
-- server layer; the frontend already never offered delete for a non-Draft
-- list.
-- ---------------------------------------------------------------------------

create or replace function public.guard_and_log_packing_list_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
begin
  if old.status <> 'Draft' then
    raise exception 'Only a Draft Packing List can be deleted.';
  end if;

  select name into v_actor_name from public.staff_profiles where id = v_actor;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('PACKING_LIST_DELETED', 'packing_list', old.id, v_actor, coalesce(v_actor_name, 'System'), now(),
    jsonb_build_object('listId', old.list_id));

  return old;
end;
$$;

revoke all on function public.guard_and_log_packing_list_delete() from public, anon, authenticated;
drop trigger if exists trg_guard_and_log_packing_list_delete on public.packing_lists;
create trigger trg_guard_and_log_packing_list_delete
  before delete on public.packing_lists
  for each row execute function public.guard_and_log_packing_list_delete();

-- ---------------------------------------------------------------------------
-- company_settings: never-hard-delete, no exceptions. The app reads this
-- table everywhere assuming exactly one row exists; there was never a UI
-- path to this policy and no legitimate reason to keep it.
-- ---------------------------------------------------------------------------

drop policy if exists "admin manager can delete settings" on public.company_settings;


-- MIGRATION 14/22: 20260817200000_stage5_integration_review.sql
-- Stage 5: Integration Review.
--
-- A verification pass across Stages 1-4 (Storage/Inventory, Staff Profile
-- Pictures, Barcode on All Documents, Controlled Deletion/Archive), checking
-- each stage against the pre-existing status-lifecycle + double-entry
-- accounting system (20260815013917_double_entry_accounting.sql) it wasn't
-- built alongside. Most checks confirmed no breakage. One genuine gap was
-- found and is fixed here; everything else is recorded as a deliberate,
-- reasoned scope decision rather than "fixed" busywork:
--
--   FOUND AND FIXED — void_shipment() left phantom revenue on the books.
--     A shipment can only be voided (not hard-deleted) once it carries an
--     accounting_journal_entry_id (guard_and_log_shipment_delete blocks the
--     delete path specifically for that reason: "This shipment has been
--     invoiced and cannot be deleted. Void it instead."). But the original
--     void_shipment() (20260817193000) only ever touched
--     shipments.voided_at/by/reason — it never reversed the posted invoice
--     journal entry. Result: voiding an invoiced shipment left its "Dr
--     Accounts Receivable / Cr Cargo Revenue" entry POSTED forever, so
--     Financial Reports (Income Statement, Trial Balance, AR aging, etc.)
--     would keep counting revenue for cargo that's now flagged VOIDED. This
--     is a real cross-stage break, not a polish item, so it's fixed below
--     using the existing, already-audited reversal primitive
--     (void_accounting_entry, from the accounting migration) rather than
--     inventing a new one. unvoid_shipment() is deliberately left as-is: it
--     restores the shipment's operational flag but does NOT auto-repost
--     accounting, matching this codebase's existing "never auto-invent a
--     journal entry" principle (see accounting_backfill_preview()'s header
--     comment in the prior migration) — re-recognizing revenue for a
--     reinstated shipment is a deliberate finance decision, not something
--     to infer silently on unvoid.
--
--   REVIEWED, NOT A BREAK — a voided-but-already-paid shipment can leave
--     Accounts Receivable negative for that customer. This is correct
--     double-entry behavior, not a bug: cash was received for cargo whose
--     revenue has now been reversed, so the ledger is properly showing a
--     customer credit balance pending a manual refund/adjustment decision
--     by finance — auto-generating a refund entry would be exactly the kind
--     of invented accounting entry this codebase's existing conventions
--     avoid, so none is created here.
--
--   REVIEWED, NOT A BREAK — packing/inventory chain. Derived quantities
--     (packed/dispatched/returned/storage, in src/lib/inventory.ts and
--     packing.ts) are always computed via SUM aggregation over
--     packing_list_items/item_returns, never a mutable counter, so nothing
--     added by archive/void/avatar/barcode changes this session could have
--     desynced them. Storage/search_inventory() intentionally still surfaces
--     items belonging to a voided shipment (staff still need to physically
--     locate and process the return of cargo whose shipment was cancelled)
--     — this is correct operational behavior, not something to hide.
--
--   REVIEWED, NOT A BREAK — staff_profiles.avatar_path vs. the self-update
--     guard trigger. staff_profiles_guard_self_update() (pre-existing) only
--     locks role/active/must_change_password on self-updates; avatar_path
--     was never in its protected-column list, so the Stage 2 self-service
--     upload path was never at risk of being silently blocked.
--
--   REVIEWED, NOT A BREAK — barcode value integrity. All five PDF generators
--     (invoice, receipt, packing list, item stickers, shipping label) encode
--     the same identifier already used for that document's QR code, so the
--     barcode is always a second, redundant encoding of a value already
--     verified correct — no new source of truth was introduced.
--
--   REVIEWED, NOT A BREAK — archived customers. CreateShipment.tsx already
--     excludes archived customers from the "matching customers" picker,
--     preventing new shipments against an archived account, while existing
--     shipments/invoices/documents for that customer remain fully readable
--     (archive is a visibility flag, not a delete) — history, statements,
--     and accounting for past shipments are unaffected either way.

create or replace function public.void_shipment(p_shipment_id text, p_reason text)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_result public.shipments%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can void a shipment.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to void a shipment.'; end if;

  update public.shipments
  set voided_at = now(), voided_by = v_actor, voided_reason = btrim(p_reason)
  where id = p_shipment_id and voided_at is null
  returning * into v_result;
  if v_result.id is null then raise exception 'Shipment not found or already voided.'; end if;

  -- Reverse any posted revenue for this shipment so voiding it doesn't leave
  -- phantom income in Financial Reports. Guarded on status = 'POSTED' so a
  -- journal entry that was already reversed by some other path (or never
  -- posted at all) is left untouched rather than raising.
  if v_result.accounting_journal_entry_id is not null
     and exists (
       select 1 from public.journal_entries
       where id = v_result.accounting_journal_entry_id and status = 'POSTED'
     )
  then
    perform public.void_accounting_entry(
      v_result.accounting_journal_entry_id,
      'Shipment ' || p_shipment_id || ' voided: ' || btrim(p_reason)
    );
  end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('SHIPMENT_VOIDED', 'shipment', p_shipment_id, v_actor, v_actor_name, now(),
    jsonb_build_object(
      'reason', btrim(p_reason),
      'accountingReversed', v_result.accounting_journal_entry_id is not null
    ));

  return v_result;
end;
$$;

revoke all on function public.void_shipment(text, text) from public, anon;
grant execute on function public.void_shipment(text, text) to authenticated;


-- MIGRATION 15/22: 20260819120000_shipment_delete_and_payment_refund.sql
-- Real Shipment Delete + Payment Refund.
--
-- Void, Refund and Delete are three different concepts and this migration
-- keeps them that way rather than collapsing them:
--   VOID     = a financial/document transaction invalidated but RETAINED for
--              audit (existing void_shipment()/void_accounting_entry() —
--              unchanged by this migration).
--   REFUNDED = money that was actually received has been paid back to the
--              customer. The original payment stays in history forever with
--              status REFUNDED, linked to a new payment_refunds row and a
--              reversal journal entry — never deleted, never relabeled VOID.
--   DELETED  = the shipment record itself is permanently removed. Until
--              now this was impossible for any shipment with a payment on
--              file (guard_and_log_shipment_delete() blocked it outright,
--              "void it instead"). That blanket rule stays for shipments
--              with real warehouse activity (packing history, returns, a
--              delivery confirmation) — those still require void. For a
--              shipment that never got that far, delete is now allowed, and
--              any payment history on it is DETACHED (shipment_id -> null,
--              with a snapshot of what shipment it was for) rather than
--              cascade-deleted, so "Delete Shipment & Keep Financial Record"
--              is literal: the shipment disappears, the money trail doesn't.
--
-- refund_payment() is modeled directly on the existing void_accounting_entry()
-- primitive (same mirror-image reversal-entry mechanics) — it is not a new
-- accounting engine, just a thin wrapper that also records refund-specific
-- detail (method, date, who processed it, reason) that void alone doesn't
-- capture, and relabels the payment REFUNDED instead of VOIDED afterward.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- payment_records: allow detachment from a deleted shipment, keep it findable
-- ---------------------------------------------------------------------------

alter table public.payment_records
  alter column shipment_id drop not null,
  add column if not exists shipment_id_snapshot text,
  add column if not exists shipment_tracking_snapshot text;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'payment_records_shipment_id_fkey'
      and conrelid = 'public.payment_records'::regclass
  ) then
    alter table public.payment_records drop constraint payment_records_shipment_id_fkey;
  end if;
  alter table public.payment_records
    add constraint payment_records_shipment_id_fkey
    foreign key (shipment_id) references public.shipments (id) on delete set null;
end $$;

do $$
begin
  if exists (
    select 1 from pg_constraint
    where conname = 'payment_records_accounting_status_check'
      and conrelid = 'public.payment_records'::regclass
  ) then
    alter table public.payment_records drop constraint payment_records_accounting_status_check;
  end if;
  alter table public.payment_records add constraint payment_records_accounting_status_check
    check (status in ('DRAFT','POSTED','VOIDED','REFUNDED'));
end $$;

-- ---------------------------------------------------------------------------
-- payment_refunds: one row per refund, immutable, always linked to a
-- reversal journal entry via void_accounting_entry().
-- ---------------------------------------------------------------------------

create table if not exists public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id text not null references public.payment_records (id) on delete restrict,
  refund_amount numeric(18,2) not null check (refund_amount > 0),
  currency text not null check (currency in ('USD','TZS','AED')),
  refund_method text,
  refund_date date not null default current_date,
  reason text not null check (btrim(reason) <> ''),
  processed_by uuid references public.staff_profiles (id) on delete set null,
  processed_by_name text not null,
  accounting_journal_entry_id uuid references public.journal_entries (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists payment_refunds_payment_id_idx on public.payment_refunds (payment_id);

alter table public.payment_refunds enable row level security;
drop policy if exists "staff can read payment refunds" on public.payment_refunds;
create policy "staff can read payment refunds" on public.payment_refunds
  for select to authenticated using (true);
-- No insert/update/delete policy for `authenticated` — every refund is
-- created exclusively through refund_payment() below (SECURITY DEFINER),
-- matching journal_entries/journal_lines' own "no direct client write" rule.

-- ---------------------------------------------------------------------------
-- refund_payment(): reverse a POSTED payment's ledger entry, relabel it
-- REFUNDED (not VOIDED), record the refund detail. Full-amount refund only —
-- a true partial refund would need its own smaller reversal entry rather
-- than reusing void_accounting_entry()'s whole-entry mirror, which is a
-- larger design than this fix covers; refunding half of a payment today
-- means refunding it in full and recording the correct payment separately.
-- ---------------------------------------------------------------------------

create or replace function public.refund_payment(
  p_payment_id text,
  p_reason text,
  p_refund_method text default null
)
returns public.payment_refunds
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_payment public.payment_records%rowtype;
  v_reversal public.journal_entries%rowtype;
  v_refund public.payment_refunds%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can refund a payment.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to refund a payment.'; end if;

  select * into v_payment from public.payment_records where id = p_payment_id for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.status <> 'POSTED' then
    raise exception 'Only a posted payment can be refunded (current status: %).', v_payment.status;
  end if;
  if v_payment.accounting_journal_entry_id is null then
    raise exception 'This payment has no posted journal entry to reverse.';
  end if;

  -- Reverses the ledger and, per void_accounting_entry()'s own PAYMENT
  -- branch, sets payment_records.status = 'VOIDED' as a side effect — we
  -- immediately relabel it REFUNDED below since here that status flip means
  -- something more specific than a plain void (money actually went back).
  v_reversal := public.void_accounting_entry(v_payment.accounting_journal_entry_id, 'Refund: ' || btrim(p_reason));

  update public.payment_records set status = 'REFUNDED' where id = p_payment_id;

  insert into public.payment_refunds (
    payment_id, refund_amount, currency, refund_method, refund_date, reason,
    processed_by, processed_by_name, accounting_journal_entry_id
  ) values (
    p_payment_id, v_payment.amount, v_payment.currency, nullif(btrim(p_refund_method), ''), current_date,
    btrim(p_reason), v_actor, v_actor_name, v_reversal.id
  ) returning * into v_refund;

  if v_payment.shipment_id is not null then
    update public.shipments
    set amount_paid = greatest(0, amount_paid - v_payment.amount), updated_at = current_date::text
    where id = v_payment.shipment_id;
  end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('PAYMENT_REFUNDED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'reason', btrim(p_reason), 'refundAmount', v_payment.amount, 'currency', v_payment.currency,
      'refundMethod', nullif(btrim(p_refund_method), ''), 'reversalJournalEntryId', v_reversal.id,
      'refundId', v_refund.id
    ));

  return v_refund;
end;
$$;

revoke all on function public.refund_payment(text, text, text) from public, anon;
grant execute on function public.refund_payment(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_shipment(): real permanent delete. Blocked (same message shape as
-- the old blanket guard) whenever the shipment has real warehouse activity
-- — packing history, a return, or a delivery confirmation — since those
-- cases still need the full audit trail that only Void preserves. Otherwise
-- allowed even with payments/an invoice on file: any posted invoice revenue
-- is reversed first (mirrors void_shipment()), any payment_records rows are
-- detached (never cascade-deleted) with a snapshot of the shipment identity.
-- ---------------------------------------------------------------------------

create or replace function public.delete_shipment(p_shipment_id text, p_reason text)
returns public.shipments
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_shipment public.shipments%rowtype;
  v_entry_status text;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password and role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can delete a shipment.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to delete a shipment.'; end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if exists (
    select 1 from public.packing_list_items pli
    join public.shipment_items si on si.id = pli.shipment_item_id
    where si.shipment_id = p_shipment_id
  ) then
    raise exception 'This shipment has packing history and cannot be deleted. Void it instead.';
  end if;
  if exists (
    select 1 from public.item_returns ir
    join public.shipment_items si on si.id = ir.shipment_item_id
    where si.shipment_id = p_shipment_id
  ) then
    raise exception 'This shipment has return history and cannot be deleted. Void it instead.';
  end if;
  if exists (select 1 from public.shipment_delivery_confirmations where shipment_id = p_shipment_id) then
    raise exception 'This shipment has a delivery confirmation on file and cannot be deleted. Void it instead.';
  end if;

  -- Reverse any still-POSTED invoice revenue so deleting the shipment can
  -- never leave phantom income behind (the same rule void_shipment() follows).
  if v_shipment.accounting_journal_entry_id is not null then
    select status into v_entry_status from public.journal_entries where id = v_shipment.accounting_journal_entry_id;
    if v_entry_status = 'POSTED' then
      perform public.void_accounting_entry(
        v_shipment.accounting_journal_entry_id,
        'Shipment ' || p_shipment_id || ' deleted: ' || btrim(p_reason)
      );
    end if;
  end if;

  -- Detach (never cascade-delete) any payment history — "Delete Shipment &
  -- Keep Financial Record" is literal. Snapshot the shipment identity before
  -- the reference disappears so refunded/kept payments stay identifiable.
  update public.payment_records
  set shipment_id = null,
      shipment_id_snapshot = p_shipment_id,
      shipment_tracking_snapshot = v_shipment.tracking_number
  where shipment_id = p_shipment_id;

  update public.packing_lists
  set shipment_ids = array_remove(shipment_ids, p_shipment_id), updated_at = current_date::text
  where p_shipment_id = any(shipment_ids);

  perform set_config('app.shipment_delete_reason', btrim(p_reason), true);
  delete from public.shipments where id = p_shipment_id;

  return v_shipment;
end;
$$;

revoke all on function public.delete_shipment(text, text) from public, anon;
grant execute on function public.delete_shipment(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- guard_and_log_shipment_delete(): rewritten to match the rules above. The
-- old blanket "any invoice / any payment blocks delete" check is replaced
-- with the packing/returns/delivery-confirmation check — delete_shipment()
-- already validates the same thing before it gets here, but this trigger is
-- the backstop against any DELETE that bypasses the RPC (e.g. a raw
-- supabase-js .delete() call), so it must independently enforce the same
-- rule, not just log after the fact.
-- ---------------------------------------------------------------------------

create or replace function public.guard_and_log_shipment_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_reason text := nullif(btrim(coalesce(current_setting('app.shipment_delete_reason', true), '')), '');
  v_entry_status text;
begin
  if exists (
    select 1 from public.packing_list_items pli
    join public.shipment_items si on si.id = pli.shipment_item_id
    where si.shipment_id = old.id
  ) then
    raise exception 'This shipment has packing history and cannot be deleted. Void it instead.';
  end if;
  if exists (
    select 1 from public.item_returns ir
    join public.shipment_items si on si.id = ir.shipment_item_id
    where si.shipment_id = old.id
  ) then
    raise exception 'This shipment has return history and cannot be deleted. Void it instead.';
  end if;
  if exists (select 1 from public.shipment_delivery_confirmations where shipment_id = old.id) then
    raise exception 'This shipment has a delivery confirmation on file and cannot be deleted. Void it instead.';
  end if;

  -- Backstop, not just a log: delete_shipment() already reverses a still-
  -- POSTED invoice before it ever reaches here, but RLS policy "admin can
  -- delete shipments" (20260817193000_controlled_deletion_archive.sql)
  -- permits any Admin to issue a raw client `.delete()` on `shipments`
  -- directly, bypassing the RPC entirely. Without this, that path would
  -- delete the shipment while leaving its invoice's revenue POSTED forever
  -- — phantom income with no shipment behind it. Mirrors delete_shipment()'s
  -- own reversal exactly, so no path through this trigger can produce a
  -- different accounting outcome than going through the RPC.
  if old.accounting_journal_entry_id is not null then
    select status into v_entry_status from public.journal_entries where id = old.accounting_journal_entry_id;
    if v_entry_status = 'POSTED' then
      perform public.void_accounting_entry(
        old.accounting_journal_entry_id,
        coalesce(v_reason, 'Shipment ' || old.id || ' deleted (reason not supplied by caller)')
      );
    end if;
  end if;

  -- Backstop: the FK's `on delete set null` (this migration, above) nulls
  -- payment_records.shipment_id automatically regardless of delete path,
  -- but only delete_shipment() otherwise fills in what shipment a detached
  -- payment used to belong to. Do it here too so a bypassed delete still
  -- leaves affected payments identifiable in reports, not just "—".
  -- shipment_id is still old.id at this point: this is a BEFORE DELETE
  -- trigger, so it runs before the FK action nulls it out.
  update public.payment_records
  set shipment_id_snapshot = coalesce(shipment_id_snapshot, old.id),
      shipment_tracking_snapshot = coalesce(shipment_tracking_snapshot, old.tracking_number)
  where shipment_id = old.id;

  select name into v_actor_name from public.staff_profiles where id = v_actor;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, occurred_at, details)
  values ('SHIPMENT_DELETED', 'shipment', old.id, v_actor, coalesce(v_actor_name, 'System'), now(),
    jsonb_build_object(
      'trackingNumber', old.tracking_number, 'status', old.status, 'reason', v_reason,
      'hadPostedInvoice', old.accounting_journal_entry_id is not null
    ));
  perform set_config('app.shipment_delete_reason', '', true);
  return old;
end;
$$;
-- Trigger itself (trg_guard_and_log_shipment_delete, BEFORE DELETE ON
-- shipments) already exists from 20260817193000_controlled_deletion_archive.sql
-- and needs no change — only the function body above is replaced.


-- MIGRATION 16/22: 20260819130000_partial_packing_dispatch.sql
-- Partial packing fix. Two real-world workflows were being conflated:
--
-- 1. transition_shipment_status()'s PACKED guard required EVERY shipment
--    item to be 100% allocated to Packing List boxes before the shipment
--    could become PACKED. Partial packing (some pieces boxed now, the rest
--    packed later or left in storage) is the normal warehouse workflow —
--    the item-level allocation model (packing_boxes/packing_list_items,
--    see 20260809145324_item_qr_packing_allocations.sql) already supports
--    it fully; only this all-or-nothing gate did not. The guard now only
--    requires that packing has actually started (at least one item has an
--    allocation), matching "Packed" as a deliberate staff action rather
--    than a synonym for "100% boxed."
--
-- 2. dispatch_packing_list_with_status() auto-cascaded every shipment on
--    the list through transition_shipment_status(..., 'PACKED', ...) then
--    ('DISPATCHED', ...) as a side effect of dispatching the *packing
--    list*. Combined with the old 100%-allocation guard, this is exactly
--    what produced "every shipment item must be fully allocated" errors
--    for a normal partial-pack-and-ship. Packing List status and Shipment
--    status are distinct concepts (a list can be Dispatched — physically
--    handed to the carrier — independent of what lifecycle stage each of
--    its shipments individually reports). Dispatching a Packing List now
--    only ever changes that list's own status column; whether/when a
--    shipment becomes PACKED or DISPATCHED is a separate, explicit staff
--    action via the existing transition_shipment_status()/Update Status
--    UI, never an automatic side effect of this RPC.

set lock_timeout = '5s';
set statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 1. Loosen the PACKED guard: require packing to have started, not finished.
-- Full function body re-supplied (Postgres CREATE OR REPLACE requires the
-- whole definition); only the PACKED guard block actually changes from the
-- original in 20260815013914_shipment_status_lifecycle.sql.
-- ---------------------------------------------------------------------------

create or replace function public.transition_shipment_status(
  p_shipment_id text,
  p_new_status text,
  p_location text default null,
  p_public_note text default null,
  p_internal_note text default null,
  p_customs_type text default null,
  p_customs_location text default null,
  p_dispatch_reference text default null,
  p_correction_reason text default null,
  p_recipient_name text default null,
  p_recipient_phone text default null,
  p_delivered_at timestamptz default null,
  p_delivery_notes text default null,
  p_proof_storage_path text default null
)
returns public.shipment_status_history
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_shipment public.shipments%rowtype;
  v_expected_status text;
  v_is_correction boolean;
  v_changed_at timestamptz := now();
  v_history public.shipment_status_history%rowtype;
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor_id
    and profile.active
    and not profile.must_change_password;

  if v_actor_name is null then
    raise exception 'An active staff session is required.';
  end if;

  if p_new_status not in (
    'RECEIVED', 'PACKED', 'DISPATCHED', 'ON_TRANSIT',
    'IN_CUSTOMS', 'ARRIVED', 'DELIVERED'
  ) then
    raise exception 'Unsupported shipment status: %', p_new_status;
  end if;

  select * into v_shipment
  from public.shipments
  where id = p_shipment_id
  for update;

  if v_shipment.id is null then
    raise exception 'Shipment not found.';
  end if;
  if v_shipment.status = p_new_status then
    raise exception 'Shipment is already in status %.', p_new_status;
  end if;

  v_expected_status := case v_shipment.status
    when 'RECEIVED' then 'PACKED'
    when 'PACKED' then 'DISPATCHED'
    when 'DISPATCHED' then 'ON_TRANSIT'
    when 'ON_TRANSIT' then 'IN_CUSTOMS'
    when 'IN_CUSTOMS' then 'ARRIVED'
    when 'ARRIVED' then 'DELIVERED'
    else null
  end;
  v_is_correction := p_new_status is distinct from v_expected_status;

  if v_is_correction then
    if v_actor_role not in ('Admin', 'Manager') then
      raise exception 'Only an Admin or Manager can skip or reverse lifecycle stages.';
    end if;
    if nullif(btrim(p_correction_reason), '') is null then
      raise exception 'Reason for status correction is required.';
    end if;
  end if;

  -- Was: every item's allocated sum >= its quantity (100% boxed). Now: at
  -- least one item has some allocation — partial packing (e.g. 4 of 10
  -- pieces boxed, 6 remain in storage for a later Packing List) is a valid,
  -- normal reason to mark a shipment PACKED; it is a deliberate staff
  -- action, not an automatic 100%-allocation checkpoint.
  if p_new_status = 'PACKED' and not exists (
    select 1
    from public.shipment_items as item
    join public.packing_list_items as allocation on allocation.shipment_item_id = item.id
    where item.shipment_id = p_shipment_id
  ) then
    raise exception 'At least one shipment item must be packed into a Packing List box before marking the shipment PACKED.';
  end if;

  if p_new_status = 'IN_CUSTOMS' then
    if p_customs_type not in ('AIRPORT', 'SEA_PORT') then
      raise exception 'Customs type Airport or Sea Port is required.';
    end if;
  end if;

  if p_new_status = 'DELIVERED' then
    if nullif(btrim(p_recipient_name), '') is null then
      raise exception 'Recipient name is required before delivery.';
    end if;
    if p_delivered_at is null then
      raise exception 'Collection or delivery date is required.';
    end if;
  end if;

  perform set_config('app.status_transition_authorized', 'true', true);
  update public.shipments
  set status = p_new_status,
      customs_type = case when p_new_status = 'IN_CUSTOMS' then p_customs_type else customs_type end,
      customs_location = case when p_new_status = 'IN_CUSTOMS' then nullif(btrim(p_customs_location), '') else customs_location end,
      customs_started_at = case when p_new_status = 'IN_CUSTOMS' then v_changed_at else customs_started_at end,
      dispatch_reference = case when p_new_status = 'DISPATCHED' then nullif(btrim(p_dispatch_reference), '') else dispatch_reference end,
      dispatched_at = case when p_new_status = 'DISPATCHED' then v_changed_at else dispatched_at end,
      arrived_at = case when p_new_status = 'ARRIVED' then v_changed_at else arrived_at end,
      delivered_at = case when p_new_status = 'DELIVERED' then p_delivered_at else delivered_at end,
      updated_at = v_changed_at::text,
      status_history = status_history || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'status', p_new_status,
        'location', nullif(btrim(p_location), ''),
        'timestamp', v_changed_at,
        'staff', v_actor_name,
        'note', nullif(btrim(p_public_note), ''),
        'isPublic', true,
        'customsType', p_customs_type,
        'customsLocation', nullif(btrim(p_customs_location), '')
      )))
  where id = p_shipment_id;

  insert into public.shipment_status_history (
    shipment_id, previous_status, new_status, location, customs_type,
    customs_location, dispatch_reference, public_note, internal_note,
    is_correction, correction_reason, changed_by, changed_by_name, changed_at
  ) values (
    p_shipment_id, v_shipment.status, p_new_status, nullif(btrim(p_location), ''),
    case when p_new_status = 'IN_CUSTOMS' then p_customs_type else null end,
    case when p_new_status = 'IN_CUSTOMS' then nullif(btrim(p_customs_location), '') else null end,
    case when p_new_status = 'DISPATCHED' then nullif(btrim(p_dispatch_reference), '') else null end,
    nullif(btrim(p_public_note), ''), nullif(btrim(p_internal_note), ''),
    v_is_correction, nullif(btrim(p_correction_reason), ''),
    v_actor_id, v_actor_name, v_changed_at
  ) returning * into v_history;

  if p_new_status = 'DELIVERED' then
    insert into public.shipment_delivery_confirmations (
      shipment_id, recipient_name, recipient_phone, delivered_at,
      released_by, notes, proof_storage_path
    ) values (
      p_shipment_id, btrim(p_recipient_name), nullif(btrim(p_recipient_phone), ''),
      p_delivered_at, v_actor_id, nullif(btrim(p_delivery_notes), ''),
      nullif(btrim(p_proof_storage_path), '')
    )
    on conflict (shipment_id) do update set
      recipient_name = excluded.recipient_name,
      recipient_phone = excluded.recipient_phone,
      delivered_at = excluded.delivered_at,
      released_by = excluded.released_by,
      notes = excluded.notes,
      proof_storage_path = excluded.proof_storage_path;
  end if;

  insert into public.business_audit_log (
    action, entity_type, entity_id, actor_id, actor_name, occurred_at, details
  ) values (
    case when p_new_status = 'DELIVERED' then 'DELIVERED_CONFIRMED' else 'STATUS_UPDATED' end,
    'shipment', p_shipment_id, v_actor_id, v_actor_name, v_changed_at,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_shipment.status,
      'new_status', p_new_status,
      'is_correction', v_is_correction,
      'correction_reason', nullif(btrim(p_correction_reason), '')
    ))
  );

  return v_history;
end;
$$;

revoke all on function public.transition_shipment_status(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) from public, anon;
grant execute on function public.transition_shipment_status(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. dispatch_packing_list_with_status() no longer touches shipment status
-- at all. It only ever transitions the Packing List's own status column to
-- 'Dispatched' — mirroring close_packing_list()'s "never touch shipment
-- status" contract, and now also writing its own business_audit_log entry
-- for the same audit-trail reasons close does.
-- ---------------------------------------------------------------------------

create or replace function public.dispatch_packing_list_with_status(
  p_packing_list_id text,
  p_dispatch_note text default null
)
returns public.packing_lists
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := (select auth.uid());
  v_actor_name text;
  v_list public.packing_lists%rowtype;
  v_changed_at text := now()::text;
begin
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor_id
    and profile.active
    and not profile.must_change_password;

  if v_actor_name is null then
    raise exception 'An active staff session is required.';
  end if;

  select * into v_list
  from public.packing_lists
  where id = p_packing_list_id
  for update;
  if v_list.id is null then raise exception 'Packing List not found.'; end if;
  if v_list.status not in ('Draft','Closed') then
    raise exception 'Only an open or closed Packing List can be dispatched.';
  end if;

  if not exists (
    select 1 from public.packing_list_items where packing_list_id = p_packing_list_id
  ) then
    raise exception 'Packing List has no allocated shipment items.';
  end if;

  perform set_config('app.packing_list_status_transition_authorized', 'true', true);
  update public.packing_lists
  set status = 'Dispatched', dispatched_at = v_changed_at, updated_at = v_changed_at
  where id = p_packing_list_id
  returning * into v_list;

  insert into public.business_audit_log (
    action, entity_type, entity_id, actor_id, actor_name, occurred_at, details
  ) values (
    'PACKING_LIST_DISPATCHED', 'packing_list', p_packing_list_id, v_actor_id, v_actor_name, now(),
    jsonb_strip_nulls(jsonb_build_object('list_id', v_list.list_id, 'note', nullif(btrim(p_dispatch_note), '')))
  );

  return v_list;
end;
$$;

revoke all on function public.dispatch_packing_list_with_status(text, text) from public, anon;
grant execute on function public.dispatch_packing_list_with_status(text, text) to authenticated;


-- MIGRATION 17/22: 20260911090000_cargo_extra_charges.sql
-- Normalized cargo extra charges with audited, double-entry posting.
-- Additive and idempotent: no existing shipment, payment, expense or journal
-- rows are deleted or rewritten by this migration.

set lock_timeout = '5s';
set statement_timeout = '60s';

create table if not exists public.cargo_extra_charges (
  id uuid primary key default gen_random_uuid(),
  shipment_id text references public.shipments (id) on delete set null,
  shipment_id_snapshot text,
  shipment_tracking_snapshot text,
  charge_type text not null check (charge_type in (
    'export_packing', 'pickup', 'forklift', 'warehouse',
    'dg_packing', 'supplier_payment', 'other'
  )),
  custom_label text,
  charge_direction text not null check (charge_direction in (
    'billable_to_customer', 'company_expense'
  )),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null default 'TZS' check (currency in ('TZS','USD','AED')),
  charge_date date not null default current_date,
  note text,
  payment_method text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DELETED')),
  idempotency_key uuid,
  exchange_rate numeric(18,6),
  reporting_amount numeric(18,2),
  accounting_journal_entry_id uuid references public.journal_entries (id) on delete restrict,
  created_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_by uuid references public.staff_profiles (id) on delete set null,
  deleted_at timestamptz,
  deletion_reason text,
  constraint cargo_extra_charges_custom_label_check check (
    charge_type <> 'other' or nullif(btrim(custom_label), '') is not null
  ),
  constraint cargo_extra_charges_supplier_direction_check check (
    charge_type <> 'supplier_payment' or charge_direction = 'company_expense'
  ),
  constraint cargo_extra_charges_payment_method_check check (
    payment_method is null or nullif(btrim(payment_method), '') is not null
  )
);

-- A deleted/reversed charge is retained for audit even if an otherwise-empty
-- shipment is later hard-deleted. Active charges block that deletion; the
-- trigger below snapshots identity before this SET NULL relationship fires.
alter table public.cargo_extra_charges
  add column if not exists shipment_id_snapshot text,
  add column if not exists shipment_tracking_snapshot text,
  alter column shipment_id drop not null;
alter table public.cargo_extra_charges
  drop constraint if exists cargo_extra_charges_shipment_id_fkey;
alter table public.cargo_extra_charges
  add constraint cargo_extra_charges_shipment_id_fkey
  foreign key (shipment_id) references public.shipments (id) on delete set null;

create unique index if not exists cargo_extra_charges_idempotency_idx
  on public.cargo_extra_charges (idempotency_key)
  where idempotency_key is not null;
create index if not exists cargo_extra_charges_shipment_status_idx
  on public.cargo_extra_charges (shipment_id, status, charge_date, created_at);
create index if not exists cargo_extra_charges_direction_date_idx
  on public.cargo_extra_charges (charge_direction, charge_date, id);
create index if not exists cargo_extra_charges_accounting_entry_idx
  on public.cargo_extra_charges (accounting_journal_entry_id);

alter table public.cargo_extra_charges enable row level security;
revoke all on table public.cargo_extra_charges from anon, authenticated;
grant select on table public.cargo_extra_charges to authenticated;

drop policy if exists "active staff can read cargo extra charges" on public.cargo_extra_charges;
drop policy if exists "active staff can read authorized cargo extra charges" on public.cargo_extra_charges;
create policy "active staff can read authorized cargo extra charges"
  on public.cargo_extra_charges for select to authenticated
  using (
    (select public.is_active_staff())
    and (
      charge_direction = 'billable_to_customer'
      or (select public.staff_role()) in ('Admin','Manager')
    )
  );

create or replace function public.guard_and_snapshot_cargo_charges_on_shipment_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.cargo_extra_charges as charge
    where charge.shipment_id = old.id and charge.status = 'ACTIVE'
  ) then
    raise exception 'This shipment has active cargo charges and cannot be deleted. Delete the charges or void the shipment instead.';
  end if;
  update public.cargo_extra_charges
  set shipment_id_snapshot = old.id,
      shipment_tracking_snapshot = old.tracking_number,
      updated_at = now()
  where shipment_id = old.id;
  return old;
end;
$$;

revoke all on function public.guard_and_snapshot_cargo_charges_on_shipment_delete() from public, anon, authenticated;
drop trigger if exists trg_guard_snapshot_cargo_charges_on_shipment_delete on public.shipments;
create trigger trg_guard_snapshot_cargo_charges_on_shipment_delete
  before delete on public.shipments
  for each row execute function public.guard_and_snapshot_cargo_charges_on_shipment_delete();

-- Internal helper. Only the three guarded CRUD RPCs below may invoke it.
create or replace function public.post_cargo_extra_charge_accounting(
  p_charge_id uuid
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_charge public.cargo_extra_charges%rowtype;
  v_shipment public.shipments%rowtype;
  v_debit_account uuid;
  v_credit_account uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_debit_code text;
  v_credit_code text;
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor
    and profile.active
    and not profile.must_change_password;

  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;

  select * into v_charge
  from public.cargo_extra_charges
  where id = p_charge_id
  for update;
  if v_charge.id is null or v_charge.status <> 'ACTIVE' then
    raise exception 'Cargo charge not found.';
  end if;

  if v_charge.accounting_journal_entry_id is not null then
    select * into v_entry
    from public.journal_entries
    where id = v_charge.accounting_journal_entry_id and status = 'POSTED';
    if v_entry.id is not null then return v_entry; end if;
  end if;

  select * into v_shipment
  from public.shipments
  where id = v_charge.shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if v_charge.currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Charge currency must match the shipment invoice currency.';
  end if;

  v_exchange_rate := case v_charge.currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end;
  if v_exchange_rate is null or v_exchange_rate <= 0 then
    raise exception 'The shipment needs a valid invoice exchange-rate snapshot before this charge can be posted.';
  end if;
  v_base_amount := public.accounting_reporting_amount(v_charge.currency, v_charge.amount, v_exchange_rate);

  if v_charge.charge_direction = 'billable_to_customer' then
    v_debit_code := '1100';
    v_credit_code := case v_shipment.shipment_type when 'Air Cargo' then '4000' when 'Sea Cargo' then '4010' else '4030' end;
  else
    v_debit_code := case v_charge.charge_type
      when 'export_packing' then '5040'
      when 'dg_packing' then '5040'
      when 'pickup' then '5020'
      when 'forklift' then '5020'
      when 'warehouse' then '5190'
      else '5200'
    end;
    v_credit_code := case when v_charge.payment_method = 'Cash' then '1000' else '1010' end;
  end if;

  select id into v_debit_account from public.accounting_accounts where code = v_debit_code and active;
  select id into v_credit_account from public.accounting_accounts where code = v_credit_code and active;
  if v_debit_account is null or v_credit_account is null then
    raise exception 'Required accounting accounts are not configured.';
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_charge.charge_date,
    case when v_charge.charge_direction = 'billable_to_customer'
      then 'Billable cargo charge'
      else 'Cargo company expense'
    end || ': ' || coalesce(nullif(btrim(v_charge.custom_label), ''), replace(initcap(v_charge.charge_type), '_', ' ')),
    'EXTRA_CHARGE', v_charge.id::text, v_charge.currency, v_exchange_rate,
    v_charge.amount, v_base_amount, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_debit_account, 'Cargo extra charge debit', v_base_amount, 0, v_charge.amount, 0),
    (v_entry.id, v_credit_account, 'Cargo extra charge credit', 0, v_base_amount, 0, v_charge.amount);

  update public.journal_entries
  set status = 'POSTED', posted_by = v_actor
  where id = v_entry.id
  returning * into v_entry;

  update public.cargo_extra_charges
  set exchange_rate = v_exchange_rate,
      reporting_amount = v_base_amount,
      accounting_journal_entry_id = v_entry.id,
      updated_by = v_actor,
      updated_at = now()
  where id = v_charge.id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_POSTED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object(
      'shipment_id', v_charge.shipment_id,
      'direction', v_charge.charge_direction,
      'amount', v_charge.amount,
      'currency', v_charge.currency,
      'journal_entry_id', v_entry.id
    )
  );

  return v_entry;
end;
$$;

revoke all on function public.post_cargo_extra_charge_accounting(uuid) from public, anon, authenticated;

create or replace function public.create_cargo_extra_charge(
  p_shipment_id text,
  p_charge_type text,
  p_custom_label text,
  p_charge_direction text,
  p_amount numeric,
  p_currency text,
  p_charge_date date,
  p_note text,
  p_payment_method text,
  p_idempotency_key uuid
)
returns public.cargo_extra_charges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_shipment public.shipments%rowtype;
  v_charge public.cargo_extra_charges%rowtype;
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;
  if p_idempotency_key is null then raise exception 'An idempotency key is required.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select charge.* into v_charge
  from public.cargo_extra_charges as charge
  where charge.idempotency_key = p_idempotency_key;
  if v_charge.id is not null then return v_charge; end if;

  if p_charge_type not in ('export_packing','pickup','forklift','warehouse','dg_packing','supplier_payment','other') then
    raise exception 'Unsupported cargo charge type.';
  end if;
  if p_charge_direction not in ('billable_to_customer','company_expense') then
    raise exception 'Unsupported cargo charge direction.';
  end if;
  if p_charge_type = 'supplier_payment' and p_charge_direction <> 'company_expense' then
    raise exception 'Supplier Payment must be a company expense.';
  end if;
  if p_charge_type = 'other' and nullif(btrim(p_custom_label), '') is null then
    raise exception 'A custom label is required for Other cargo charges.';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Charge amount must be greater than zero.'; end if;
  if p_charge_date is null then raise exception 'Charge date is required.'; end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then raise exception 'Cargo charges cannot be added to a voided shipment.'; end if;
  if p_currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Charge currency must match the shipment invoice currency.';
  end if;

  insert into public.cargo_extra_charges (
    shipment_id, charge_type, custom_label, charge_direction, amount,
    currency, charge_date, note, payment_method, idempotency_key, created_by, updated_by
  ) values (
    p_shipment_id, p_charge_type, nullif(btrim(p_custom_label), ''), p_charge_direction, p_amount,
    p_currency, p_charge_date, nullif(btrim(p_note), ''),
    case when p_charge_direction = 'company_expense' then coalesce(nullif(btrim(p_payment_method), ''), 'Bank Transfer') else null end,
    p_idempotency_key, v_actor, v_actor
  ) returning * into v_charge;

  perform public.post_cargo_extra_charge_accounting(v_charge.id);
  select charge.* into v_charge
  from public.cargo_extra_charges as charge
  where charge.id = v_charge.id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_CREATED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object('shipment_id', p_shipment_id, 'direction', p_charge_direction)
  );
  return v_charge;
end;
$$;

create or replace function public.update_cargo_extra_charge(
  p_charge_id uuid,
  p_charge_type text,
  p_custom_label text,
  p_charge_direction text,
  p_amount numeric,
  p_currency text,
  p_charge_date date,
  p_note text,
  p_payment_method text,
  p_reason text
)
returns public.cargo_extra_charges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_charge public.cargo_extra_charges%rowtype;
  v_shipment public.shipments%rowtype;
  v_amount_paid numeric(18,2);
  v_other_billable numeric(18,2);
  v_total_due numeric(18,2);
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'An edit reason is required.'; end if;

  select * into v_charge from public.cargo_extra_charges where id = p_charge_id for update;
  if v_charge.id is null or v_charge.status <> 'ACTIVE' then raise exception 'Cargo charge not found.'; end if;
  select * into v_shipment from public.shipments where id = v_charge.shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if p_charge_type not in ('export_packing','pickup','forklift','warehouse','dg_packing','supplier_payment','other') then
    raise exception 'Unsupported cargo charge type.';
  end if;
  if p_charge_direction not in ('billable_to_customer','company_expense') then
    raise exception 'Unsupported cargo charge direction.';
  end if;
  if p_charge_type = 'supplier_payment' and p_charge_direction <> 'company_expense' then
    raise exception 'Supplier Payment must be a company expense.';
  end if;
  if p_charge_type = 'other' and nullif(btrim(p_custom_label), '') is null then
    raise exception 'A custom label is required for Other cargo charges.';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Charge amount must be greater than zero.'; end if;
  if p_charge_date is null then raise exception 'Charge date is required.'; end if;
  if p_currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Charge currency must match the shipment invoice currency.';
  end if;

  -- An edit may reduce the customer-facing balance (for example by converting
  -- a billable charge into a company expense). Never permit that change to
  -- make already-posted receipts exceed the newly calculated Total Due.
  select coalesce(sum(payment.amount), 0) into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = v_charge.shipment_id and payment.status = 'POSTED';
  select coalesce(sum(other_charge.amount), 0) into v_other_billable
  from public.cargo_extra_charges as other_charge
  where other_charge.shipment_id = v_charge.shipment_id
    and other_charge.id <> v_charge.id
    and other_charge.status = 'ACTIVE'
    and other_charge.charge_direction = 'billable_to_customer';
  v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0)
    + v_other_billable
    + case when p_charge_direction = 'billable_to_customer' then p_amount else 0 end;
  if v_amount_paid > v_total_due + 0.01 then
    raise exception 'This charge change would make posted payments exceed the shipment total due.';
  end if;

  if v_charge.accounting_journal_entry_id is not null and exists (
    select 1 from public.journal_entries where id = v_charge.accounting_journal_entry_id and status = 'POSTED'
  ) then
    perform public.void_accounting_entry(v_charge.accounting_journal_entry_id, btrim(p_reason));
  end if;

  update public.cargo_extra_charges
  set charge_type = p_charge_type,
      custom_label = nullif(btrim(p_custom_label), ''),
      charge_direction = p_charge_direction,
      amount = p_amount,
      currency = p_currency,
      charge_date = p_charge_date,
      note = nullif(btrim(p_note), ''),
      payment_method = case when p_charge_direction = 'company_expense'
        then coalesce(nullif(btrim(p_payment_method), ''), 'Bank Transfer') else null end,
      exchange_rate = null,
      reporting_amount = null,
      accounting_journal_entry_id = null,
      updated_by = v_actor,
      updated_at = now()
  where id = p_charge_id
  returning * into v_charge;

  perform public.post_cargo_extra_charge_accounting(v_charge.id);
  select charge.* into v_charge
  from public.cargo_extra_charges as charge
  where charge.id = p_charge_id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_UPDATED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object('shipment_id', v_charge.shipment_id, 'reason', btrim(p_reason))
  );
  return v_charge;
end;
$$;

create or replace function public.delete_cargo_extra_charge(
  p_charge_id uuid,
  p_reason text
)
returns public.cargo_extra_charges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_charge public.cargo_extra_charges%rowtype;
  v_shipment public.shipments%rowtype;
  v_amount_paid numeric(18,2);
  v_other_billable numeric(18,2);
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A deletion reason is required.'; end if;

  select * into v_charge from public.cargo_extra_charges where id = p_charge_id for update;
  if v_charge.id is null or v_charge.status <> 'ACTIVE' then raise exception 'Cargo charge not found.'; end if;

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.id = v_charge.shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if v_charge.charge_direction = 'billable_to_customer' then
    select coalesce(sum(payment.amount), 0) into v_amount_paid
    from public.payment_records as payment
    where payment.shipment_id = v_charge.shipment_id and payment.status = 'POSTED';
    select coalesce(sum(other_charge.amount), 0) into v_other_billable
    from public.cargo_extra_charges as other_charge
    where other_charge.shipment_id = v_charge.shipment_id
      and other_charge.id <> v_charge.id
      and other_charge.status = 'ACTIVE'
      and other_charge.charge_direction = 'billable_to_customer';
    if v_amount_paid > coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_other_billable + 0.01 then
      raise exception 'This charge cannot be deleted because posted payments would exceed the shipment total due.';
    end if;
  end if;

  if v_charge.accounting_journal_entry_id is not null and exists (
    select 1 from public.journal_entries where id = v_charge.accounting_journal_entry_id and status = 'POSTED'
  ) then
    perform public.void_accounting_entry(v_charge.accounting_journal_entry_id, btrim(p_reason));
  end if;

  update public.cargo_extra_charges
  set status = 'DELETED', deleted_by = v_actor, deleted_at = now(),
      deletion_reason = btrim(p_reason), updated_by = v_actor, updated_at = now()
  where id = p_charge_id
  returning * into v_charge;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_DELETED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object('shipment_id', v_charge.shipment_id, 'reason', btrim(p_reason))
  );
  return v_charge;
end;
$$;

revoke all on function public.create_cargo_extra_charge(text, text, text, text, numeric, text, date, text, text, uuid) from public, anon;
revoke all on function public.update_cargo_extra_charge(uuid, text, text, text, numeric, text, date, text, text, text) from public, anon;
revoke all on function public.delete_cargo_extra_charge(uuid, text) from public, anon;
grant execute on function public.create_cargo_extra_charge(text, text, text, text, numeric, text, date, text, text, uuid) to authenticated;
grant execute on function public.update_cargo_extra_charge(uuid, text, text, text, numeric, text, date, text, text, text) to authenticated;
grant execute on function public.delete_cargo_extra_charge(uuid, text) to authenticated;


-- MIGRATION 18/22: 20260911091000_atomic_payment_recording.sql
-- Race-safe receipt numbers, idempotent payment submission and one-transaction
-- payment + accounting + shipment-balance updates.
-- Existing rows are inspected to seed counters but are never rewritten.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.payment_records
  add column if not exists idempotency_key uuid;

create unique index if not exists payment_records_idempotency_key_idx
  on public.payment_records (idempotency_key)
  where idempotency_key is not null;

create table if not exists public.payment_receipt_counters (
  receipt_date date primary key,
  last_value bigint not null check (last_value >= 0),
  updated_at timestamptz not null default now()
);

-- Seed every daily counter above the highest legacy number in the existing
-- RCT-YYMMDD-NNNN format. Other receipt formats remain untouched and cannot
-- collide because their prefixes differ.
with parsed_receipts as (
  select
    to_date(substring(receipt_number from 5 for 6), 'YYMMDD') as receipt_date,
    substring(receipt_number from 12)::bigint as sequence_value
  from public.payment_records
  where receipt_number ~ '^RCT-[0-9]{6}-[0-9]+$'
), seeded as (
  select receipt_date, max(sequence_value) as last_value
  from parsed_receipts
  group by receipt_date
)
insert into public.payment_receipt_counters (receipt_date, last_value)
select receipt_date, last_value from seeded
on conflict (receipt_date) do update
set last_value = greatest(public.payment_receipt_counters.last_value, excluded.last_value),
    updated_at = now();

alter table public.payment_receipt_counters enable row level security;
revoke all on table public.payment_receipt_counters from public, anon, authenticated;

-- Recalculate the stored amount_paid whenever a payment becomes POSTED,
-- REFUNDED/VOIDED, moves shipments or changes amount. The trigger is a
-- backstop for every future payment path; the migration deliberately does not
-- rewrite historical shipment rows.
create or replace function public.recalculate_shipment_amount_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment_id text;
  v_previous_shipment_id text;
begin
  foreach v_shipment_id in array array[
    case when tg_op = 'INSERT' then null else old.shipment_id end,
    case when tg_op = 'DELETE' then null else new.shipment_id end
  ] loop
    if v_shipment_id is not null and v_shipment_id is distinct from v_previous_shipment_id then
      update public.shipments
      set amount_paid = (
            select coalesce(sum(payment.amount), 0)
            from public.payment_records as payment
            where payment.shipment_id = v_shipment_id
              and payment.status = 'POSTED'
          ),
          updated_at = now()::text
      where id = v_shipment_id;
      v_previous_shipment_id := v_shipment_id;
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.recalculate_shipment_amount_paid() from public, anon, authenticated;
drop trigger if exists trg_recalculate_shipment_amount_paid on public.payment_records;
create trigger trg_recalculate_shipment_amount_paid
  after insert or update of amount, status, shipment_id or delete
  on public.payment_records
  for each row execute function public.recalculate_shipment_amount_paid();

-- Keep the established journal posting contract, but make its overpayment
-- guard use the same authoritative Total Due formula as record_payment().
-- This also protects any legacy DRAFT payment posted through this existing RPC.
create or replace function public.post_payment_accounting(
  p_payment_id text,
  p_receiving_account_code text default '1010'
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_payment public.payment_records%rowtype;
  v_shipment public.shipments%rowtype;
  v_receiving uuid;
  v_ar uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_previously_paid numeric(18,2);
  v_billable_charges numeric(18,2);
  v_total_due numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if p_receiving_account_code not in ('1000','1010') then
    raise exception 'Payments may be received into Cash or Bank only.';
  end if;

  select payment.* into v_payment
  from public.payment_records as payment
  where payment.id = p_payment_id
  for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.accounting_journal_entry_id is not null then
    select entry.* into v_entry
    from public.journal_entries as entry
    where entry.id = v_payment.accounting_journal_entry_id;
    return v_entry;
  end if;

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.id = v_payment.shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.accounting_journal_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  if v_payment.currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Payment currency must match invoice currency %.', coalesce(v_shipment.invoice_currency, v_shipment.currency);
  end if;

  select coalesce(sum(charge.amount), 0) into v_billable_charges
  from public.cargo_extra_charges as charge
  where charge.shipment_id = v_payment.shipment_id
    and charge.status = 'ACTIVE'
    and charge.charge_direction = 'billable_to_customer';
  v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable_charges;

  select coalesce(sum(payment.amount), 0) into v_previously_paid
  from public.payment_records as payment
  where payment.shipment_id = v_payment.shipment_id
    and payment.id <> v_payment.id
    and payment.status = 'POSTED';
  if v_previously_paid + v_payment.amount > v_total_due + 0.01 then
    raise exception 'Payment exceeds the outstanding invoice balance.';
  end if;

  v_exchange_rate := coalesce(v_payment.exchange_rate, case v_payment.currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end);
  if v_exchange_rate is null or v_exchange_rate <= 0 then
    raise exception 'The shipment needs a valid invoice exchange-rate snapshot before this payment can be posted.';
  end if;
  v_base_amount := public.accounting_reporting_amount(v_payment.currency, v_payment.amount, v_exchange_rate);

  select account.id into v_receiving
  from public.accounting_accounts as account
  where account.code = p_receiving_account_code and account.active;
  select account.id into v_ar
  from public.accounting_accounts as account
  where account.code = '1100' and account.active;
  if v_receiving is null or v_ar is null then
    raise exception 'Required accounting accounts are not configured.';
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_payment.date::date, 'Payment ' || v_payment.receipt_number,
    'PAYMENT', p_payment_id, v_payment.currency, v_exchange_rate,
    v_payment.amount, v_base_amount, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_receiving, 'Customer payment received', v_base_amount, 0, v_payment.amount, 0),
    (v_entry.id, v_ar, 'Reduce accounts receivable', 0, v_base_amount, 0, v_payment.amount);

  update public.journal_entries
  set status = 'POSTED', posted_by = v_actor
  where id = v_entry.id
  returning * into v_entry;
  update public.payment_records
  set status = 'POSTED', receiving_account_id = v_receiving,
      exchange_rate = v_exchange_rate, reporting_amount = v_base_amount,
      accounting_journal_entry_id = v_entry.id
  where id = p_payment_id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'PAYMENT_POSTED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number)
  );
  return v_entry;
end;
$$;

revoke all on function public.post_payment_accounting(text, text) from public, anon;
grant execute on function public.post_payment_accounting(text, text) to authenticated;

create or replace function public.record_payment(
  p_shipment_id text,
  p_amount numeric,
  p_currency text,
  p_method text,
  p_payment_date date,
  p_note text,
  p_idempotency_key uuid,
  p_receiving_account_code text default '1010'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_email text;
  v_shipment public.shipments%rowtype;
  v_payment public.payment_records%rowtype;
  v_counter bigint;
  v_receipt_number text;
  v_billable_charges numeric(18,2);
  v_total_due numeric(18,2);
  v_amount_paid numeric(18,2);
  v_shipment_updated_at text;
begin
  select profile.email
  into v_actor_email
  from public.staff_profiles as profile
  where profile.id = v_actor
    and profile.active
    and not profile.must_change_password;
  if v_actor_email is null then raise exception 'An active staff session is required.'; end if;

  if p_idempotency_key is null then raise exception 'An idempotency key is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_payment
  from public.payment_records
  where idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if v_payment.shipment_id is distinct from p_shipment_id
       or v_payment.amount is distinct from p_amount
       or v_payment.currency is distinct from p_currency
       or v_payment.method is distinct from btrim(p_method)
       or v_payment.date is distinct from p_payment_date::text then
      raise exception 'Idempotency key was already used for a different payment request.';
    end if;
    select shipment.* into v_shipment
    from public.shipments as shipment
    where shipment.id = v_payment.shipment_id
    for update;
    if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
    select coalesce(sum(payment.amount), 0)
    into v_amount_paid
    from public.payment_records as payment
    where payment.shipment_id = v_payment.shipment_id and payment.status = 'POSTED';
    select coalesce(sum(charge.amount), 0)
    into v_billable_charges
    from public.cargo_extra_charges as charge
    where charge.shipment_id = v_payment.shipment_id
      and charge.status = 'ACTIVE'
      and charge.charge_direction = 'billable_to_customer';
    v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable_charges;
    update public.shipments
    set amount_paid = v_amount_paid, updated_at = now()::text
    where id = v_payment.shipment_id
    returning updated_at into v_shipment_updated_at;
    return jsonb_build_object(
      'payment', to_jsonb(v_payment),
      'shipmentAmountPaid', v_amount_paid,
      'shipmentUpdatedAt', v_shipment_updated_at,
      'totalDue', v_total_due,
      'idempotentReplay', true
    );
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'Payment amount must be greater than zero.'; end if;
  if p_currency not in ('USD','TZS','AED') then raise exception 'Unsupported payment currency.'; end if;
  if nullif(btrim(p_method), '') is null then raise exception 'Payment method is required.'; end if;
  if p_payment_date is null then raise exception 'Payment date is required.'; end if;
  if p_receiving_account_code not in ('1000','1010') then
    raise exception 'Payments may be received into Cash or Bank only.';
  end if;

  select * into v_shipment
  from public.shipments
  where id = p_shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then raise exception 'Payments cannot be recorded against a voided shipment.'; end if;
  if v_shipment.accounting_journal_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  if p_currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Payment currency must match invoice currency %.', coalesce(v_shipment.invoice_currency, v_shipment.currency);
  end if;

  select coalesce(sum(charge.amount), 0)
  into v_billable_charges
  from public.cargo_extra_charges as charge
  where charge.shipment_id = p_shipment_id
    and charge.status = 'ACTIVE'
    and charge.charge_direction = 'billable_to_customer';
  v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable_charges;

  select coalesce(sum(payment.amount), 0)
  into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = p_shipment_id and payment.status = 'POSTED';
  if v_amount_paid + p_amount > v_total_due + 0.01 then
    raise exception 'Payment exceeds the outstanding invoice balance.';
  end if;

  insert into public.payment_receipt_counters as counter (receipt_date, last_value)
  values (current_date, 1)
  on conflict (receipt_date) do update
  set last_value = counter.last_value + 1,
      updated_at = now()
  returning last_value into v_counter;

  v_receipt_number := 'RCT-' || to_char(current_date, 'YYMMDD') || '-'
    || lpad(v_counter::text, greatest(4, length(v_counter::text)), '0');

  insert into public.payment_records (
    id, receipt_number, shipment_id, amount, currency, method, date, note,
    status, idempotency_key, created_at, created_by
  ) values (
    gen_random_uuid()::text, v_receipt_number, p_shipment_id, p_amount,
    p_currency, btrim(p_method), p_payment_date::text, nullif(btrim(p_note), ''),
    'DRAFT', p_idempotency_key, now()::text, v_actor_email
  ) returning * into v_payment;

  perform public.post_payment_accounting(v_payment.id, p_receiving_account_code);

  select payment.* into v_payment
  from public.payment_records as payment
  where payment.id = v_payment.id;
  select coalesce(sum(payment.amount), 0)
  into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = p_shipment_id and payment.status = 'POSTED';

  update public.shipments
  set amount_paid = v_amount_paid, updated_at = now()::text
  where id = p_shipment_id
  returning updated_at into v_shipment_updated_at;

  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'shipmentAmountPaid', v_amount_paid,
    'shipmentUpdatedAt', v_shipment_updated_at,
    'totalDue', v_total_due,
    'idempotentReplay', false
  );
end;
$$;

-- The historical refund RPC manually subtracted amount_paid. The trigger above
-- now derives amount_paid from POSTED rows, so keep the refund transaction
-- atomic while removing that obsolete second subtraction.
create or replace function public.refund_payment(
  p_payment_id text,
  p_reason text,
  p_refund_method text default null
)
returns public.payment_refunds
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_payment public.payment_records%rowtype;
  v_reversal public.journal_entries%rowtype;
  v_refund public.payment_refunds%rowtype;
begin
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password and profile.role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can refund a payment.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to refund a payment.'; end if;

  select payment.* into v_payment
  from public.payment_records as payment
  where payment.id = p_payment_id
  for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.status <> 'POSTED' then
    raise exception 'Only a posted payment can be refunded (current status: %).', v_payment.status;
  end if;
  if v_payment.accounting_journal_entry_id is null then
    raise exception 'This payment has no posted journal entry to reverse.';
  end if;

  v_reversal := public.void_accounting_entry(
    v_payment.accounting_journal_entry_id,
    'Refund: ' || btrim(p_reason)
  );
  update public.payment_records set status = 'REFUNDED' where id = p_payment_id;

  insert into public.payment_refunds (
    payment_id, refund_amount, currency, refund_method, refund_date, reason,
    processed_by, processed_by_name, accounting_journal_entry_id
  ) values (
    p_payment_id, v_payment.amount, v_payment.currency,
    nullif(btrim(p_refund_method), ''), current_date, btrim(p_reason),
    v_actor, v_actor_name, v_reversal.id
  ) returning * into v_refund;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'PAYMENT_REFUNDED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'reason', btrim(p_reason), 'refundAmount', v_payment.amount,
      'currency', v_payment.currency, 'refundMethod', nullif(btrim(p_refund_method), ''),
      'reversalJournalEntryId', v_reversal.id, 'refundId', v_refund.id
    )
  );
  return v_refund;
end;
$$;

revoke all on function public.refund_payment(text, text, text) from public, anon;
grant execute on function public.refund_payment(text, text, text) to authenticated;

revoke all on function public.record_payment(text, numeric, text, text, date, text, uuid, text) from public, anon;
grant execute on function public.record_payment(text, numeric, text, text, date, text, uuid, text) to authenticated;

-- New payments must use record_payment(); direct reads and deletion of legacy
-- draft rows remain available under the existing RLS/guard rules.
revoke insert, update on table public.payment_records from authenticated;
grant select, delete on table public.payment_records to authenticated;


-- MIGRATION 19/22: 20260911092000_status_transition_confirmation.sql
-- Keep the established transition_shipment_status() lifecycle rules, but wrap
-- the write and authoritative readback in the same transaction. If RLS or any
-- other condition prevents the changed shipment from being read back, raising
-- here rolls the transition and its timeline entry back together.

set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function public.transition_shipment_status_confirmed(
  p_shipment_id text,
  p_new_status text,
  p_location text default null,
  p_public_note text default null,
  p_internal_note text default null,
  p_customs_type text default null,
  p_customs_location text default null,
  p_dispatch_reference text default null,
  p_correction_reason text default null,
  p_recipient_name text default null,
  p_recipient_phone text default null,
  p_delivered_at timestamptz default null,
  p_delivery_notes text default null,
  p_proof_storage_path text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_history public.shipment_status_history%rowtype;
  v_shipment public.shipments%rowtype;
begin
  v_history := public.transition_shipment_status(
    p_shipment_id,
    p_new_status,
    p_location,
    p_public_note,
    p_internal_note,
    p_customs_type,
    p_customs_location,
    p_dispatch_reference,
    p_correction_reason,
    p_recipient_name,
    p_recipient_phone,
    p_delivered_at,
    p_delivery_notes,
    p_proof_storage_path
  );

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.id = p_shipment_id;

  if v_shipment.id is null then
    raise exception 'Shipment status confirmation failed because the changed row could not be read back.';
  end if;
  if v_shipment.status is distinct from p_new_status then
    raise exception 'Shipment status confirmation failed because the stored status did not match.';
  end if;

  return jsonb_build_object(
    'shipment', to_jsonb(v_shipment),
    'history', to_jsonb(v_history)
  );
end;
$$;

revoke all on function public.transition_shipment_status_confirmed(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) from public, anon;
grant execute on function public.transition_shipment_status_confirmed(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) to authenticated;


-- MIGRATION 20/22: 20260912085000_migration_ledger.sql
-- A ledger of which migrations this database has actually had applied.
--
-- Until now nothing recorded that, because migrations are pasted into the SQL
-- Editor by hand. The result was silent drift: the 20260911* release was live
-- in Production while its pull request was still a draft, and nothing in the
-- database or the repository could tell you so.
--
-- This creates the same table the Supabase CLI uses
-- (supabase_migrations.schema_migrations), so `supabase db push` will later
-- skip anything already recorded here, and backfills it by DETECTING what is
-- present rather than assuming. Every migration from here on ends with one
-- insert into this table -- see supabase/README.md.
--
-- Safe to run more than once. It creates nothing else and changes no data.

set lock_timeout = '5s';
set statement_timeout = '60s';

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text,
  applied_at timestamptz not null default now()
);

-- Nothing outside the dashboard/service role has any business reading this.
alter table supabase_migrations.schema_migrations enable row level security;
revoke all on table supabase_migrations.schema_migrations from public, anon, authenticated;

comment on table supabase_migrations.schema_migrations is
  'One row per applied migration, keyed by the filename timestamp. Every migration in supabase/migrations must record itself here as its last statement.';

-- Backfill from evidence. Each entry names a sentinel object that only exists
-- once that migration has run, so a database that skipped one is not marked as
-- having it.
do $$
declare
  v_migration record;
  v_present boolean;
begin
  for v_migration in
    select * from (values
      ('0001',           'shipments_and_auth',                      $q$select to_regclass('public.shipments') is not null$q$),
      ('20260808172013', 'shipping_rates_fx_and_invoice_snapshots', $q$select to_regclass('public.shipping_rates') is not null$q$),
      ('20260808173840', 'harden_shipment_item_policy',             $q$select exists (select 1 from pg_policies where schemaname='public' and tablename='shipment_items' and policyname='staff full access')$q$),
      ('20260809145324', 'item_qr_packing_allocations',             $q$select to_regclass('public.packing_boxes') is not null$q$),
      ('20260811093520', 'staff_management_and_active_access',      $q$select to_regclass('public.staff_management_audit') is not null$q$),
      ('20260811153000', 'fix_staff_auth_trigger_username',         $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='handle_new_auth_user' and p.prosrc like '%username%')$q$),
      ('20260815013914', 'shipment_status_lifecycle',               $q$select to_regclass('public.shipment_status_history') is not null$q$),
      ('20260815013917', 'double_entry_accounting',                 $q$select to_regclass('public.accounting_accounts') is not null$q$),
      ('20260816112517', 'add_bank_account_name',                   $q$select exists (select 1 from information_schema.columns where table_schema='public' and table_name='company_settings' and column_name='bank_account_name')$q$),
      ('20260817182455', 'close_packing_list',                      $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='close_packing_list')$q$),
      ('20260817184710', 'storage_inventory',                       $q$select to_regclass('public.item_returns') is not null$q$),
      ('20260817190000', 'staff_profile_pictures',                  $q$select exists (select 1 from information_schema.columns where table_schema='public' and table_name='staff_profiles' and column_name='avatar_path')$q$),
      ('20260817193000', 'controlled_deletion_archive',             $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='archive_customer')$q$),
      ('20260817200000', 'stage5_integration_review',               $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='void_shipment')$q$),
      ('20260819120000', 'shipment_delete_and_payment_refund',      $q$select to_regclass('public.payment_refunds') is not null$q$),
      ('20260819130000', 'partial_packing_dispatch',                $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='dispatch_packing_list_with_status')$q$),
      ('20260911090000', 'cargo_extra_charges',                     $q$select to_regclass('public.cargo_extra_charges') is not null$q$),
      ('20260911091000', 'atomic_payment_recording',                $q$select to_regclass('public.payment_receipt_counters') is not null$q$),
      ('20260911092000', 'status_transition_confirmation',          $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='transition_shipment_status_confirmed')$q$),
      ('20260912090000', 'invoice_repair_discount_and_expense_idempotency', $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='repost_invoice_accounting')$q$)
    ) as t(version, name, probe)
  loop
    execute v_migration.probe into v_present;
    if v_present then
      insert into supabase_migrations.schema_migrations (version, name)
      values (v_migration.version, v_migration.name)
      on conflict (version) do nothing;
    end if;
  end loop;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20260912085000', 'migration_ledger')
on conflict (version) do nothing;


-- MIGRATION 21/22: 20260912090000_invoice_repair_discount_and_expense_idempotency.sql
-- Invoice repair, invoice amendment, customer discounts and idempotent expense
-- recording.
--
-- Four gaps are closed here:
--   1. A shipment whose invoice is finalized but whose invoice journal is
--      missing (for example because the journal was removed during a data
--      cleanup) could never accept a payment and had no repair path.
--   2. A finalized invoice that was entered incorrectly could not be corrected
--      at all: the pricing snapshot is immutable by design and nothing was
--      allowed to void and reissue it.
--   3. shipments.discount existed but was never written, never posted to the
--      ledger and never shown.
--   4. Expenses had no idempotency key, so a double submit created duplicate
--      expenses and duplicate journal entries.
--
-- Semantics chosen for discounts (important):
--   shipments.invoice_amount stays the NET amount the customer owes, so every
--   existing Total Due formula keeps working untouched. The gross invoice value
--   is derived as invoice_amount + discount. The ledger records the gross as
--   revenue and the discount as contra-revenue, so a discount is visible in the
--   income statement instead of silently shrinking revenue.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Contra-revenue account for customer discounts.
-- ---------------------------------------------------------------------------
insert into public.accounting_accounts
  (code, name, account_type, normal_balance, system_account, allow_manual_posting)
values
  ('4900', 'Sales Discounts', 'REVENUE', 'DEBIT', true, false)
on conflict (code) do update set
  name = excluded.name,
  account_type = excluded.account_type,
  normal_balance = excluded.normal_balance,
  system_account = excluded.system_account,
  allow_manual_posting = excluded.allow_manual_posting;

-- ---------------------------------------------------------------------------
-- 2. Invoice amendment bookkeeping columns.
-- ---------------------------------------------------------------------------
alter table public.shipments
  add column if not exists discount_reason text,
  add column if not exists invoice_revision integer not null default 1,
  add column if not exists invoice_amended_at timestamptz,
  add column if not exists invoice_amended_by uuid,
  add column if not exists invoice_amendment_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shipments_discount_nonnegative_check'
  ) then
    alter table public.shipments
      add constraint shipments_discount_nonnegative_check
      check (coalesce(discount, 0) >= 0);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Expense idempotency key.
-- ---------------------------------------------------------------------------
alter table public.expenses
  add column if not exists idempotency_key uuid;

create unique index if not exists expenses_idempotency_key_idx
  on public.expenses (idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 4. Allow an authorized amendment to move a finalized pricing snapshot.
--    Everything else about the guard is unchanged: without the session flag a
--    finalized invoice stays immutable.
-- ---------------------------------------------------------------------------
create or replace function public.guard_shipment_pricing_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.rate_overridden then
    if public.staff_role() not in ('Admin','Manager') then
      raise exception 'Only Admin or Manager can override a shipment rate.';
    end if;
    if new.override_reason is null or btrim(new.override_reason) = '' then
      raise exception 'An override reason is required.';
    end if;
    new.overridden_by := coalesce(new.overridden_by, auth.uid());
    new.override_timestamp := coalesce(new.override_timestamp, now());
  elsif new.standard_rate_usd is not null and new.applied_rate_usd is distinct from new.standard_rate_usd then
    raise exception 'A changed applied rate must be recorded as an authorized override.';
  end if;

  if new.invoice_finalized_at is not null then
    if new.base_amount_usd is null or new.invoice_currency is null or new.invoice_amount is null then
      raise exception 'A finalized invoice requires base amount, invoice currency and invoice amount snapshots.';
    end if;
    if new.invoice_currency = 'TZS' and new.usd_to_tzs_rate_used is null then
      raise exception 'A TZS invoice requires the USD/TZS rate snapshot.';
    end if;
    if new.invoice_currency = 'AED' and new.usd_to_aed_rate_used is null then
      raise exception 'An AED invoice requires the USD/AED rate snapshot.';
    end if;
  end if;

  if tg_op = 'UPDATE'
    and old.invoice_finalized_at is not null
    and coalesce(current_setting('app.invoice_amend_authorized', true), 'false') <> 'true'
    and (
      new.customer_name_snapshot is distinct from old.customer_name_snapshot or
      new.customer_phone_snapshot is distinct from old.customer_phone_snapshot or
      new.customer_email_snapshot is distinct from old.customer_email_snapshot or
      new.shipment_type is distinct from old.shipment_type or
      new.description is distinct from old.description or
      new.weight_kg is distinct from old.weight_kg or
      new.volume_cbm is distinct from old.volume_cbm or
      new.pcs is distinct from old.pcs or
      new.pricing_unit is distinct from old.pricing_unit or
      new.standard_rate_usd is distinct from old.standard_rate_usd or
      new.applied_rate_usd is distinct from old.applied_rate_usd or
      new.rate_overridden is distinct from old.rate_overridden or
      new.override_reason is distinct from old.override_reason or
      new.base_currency is distinct from old.base_currency or
      new.base_amount_usd is distinct from old.base_amount_usd or
      new.usd_to_tzs_rate_used is distinct from old.usd_to_tzs_rate_used or
      new.usd_to_aed_rate_used is distinct from old.usd_to_aed_rate_used or
      new.selected_exchange_rate is distinct from old.selected_exchange_rate or
      new.exchange_rate_date is distinct from old.exchange_rate_date or
      new.invoice_currency is distinct from old.invoice_currency or
      new.invoice_amount is distinct from old.invoice_amount or
      new.invoice_number is distinct from old.invoice_number or
      new.invoice_finalized_at is distinct from old.invoice_finalized_at
    )
  then
    raise exception 'Finalized invoice pricing snapshots are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_shipment_pricing_snapshot() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Invoice posting, now discount aware and safe to call again after a
--    journal was lost. Revenue is credited with the gross invoice value and
--    the discount is debited to contra-revenue, so AR still equals the net
--    amount the customer owes.
-- ---------------------------------------------------------------------------
create or replace function public.post_invoice_accounting(p_shipment_id text)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_actor_name text;
  v_shipment public.shipments%rowtype;
  v_ar uuid;
  v_revenue uuid;
  v_discount_account uuid;
  v_exchange_rate numeric(18,6);
  v_discount numeric(18,2);
  v_gross numeric(18,2);
  v_net_base numeric(18,2);
  v_gross_base numeric(18,2);
  v_discount_base numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role into v_actor_name, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.invoice_finalized_at is null or v_shipment.invoice_amount is null or v_shipment.invoice_currency is null then
    raise exception 'The invoice must be finalized before accounting posting.';
  end if;
  if v_shipment.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_shipment.accounting_journal_entry_id;
    return v_entry;
  end if;

  -- Self-heal a broken link rather than posting the invoice twice.
  select * into v_entry
  from public.journal_entries
  where reference_type = 'INVOICE' and reference_id = p_shipment_id and status = 'POSTED'
  order by created_at desc
  limit 1;
  if v_entry.id is not null then
    update public.shipments set accounting_journal_entry_id = v_entry.id where id = p_shipment_id;
    return v_entry;
  end if;

  v_discount := round(coalesce(v_shipment.discount, 0), 2);
  if v_discount < 0 then raise exception 'A discount cannot be negative.'; end if;
  v_gross := round(v_shipment.invoice_amount + v_discount, 2);

  v_exchange_rate := case v_shipment.invoice_currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end;
  v_net_base := public.accounting_reporting_amount(
    v_shipment.invoice_currency, v_shipment.invoice_amount, v_exchange_rate
  );
  if v_discount > 0 then
    v_gross_base := public.accounting_reporting_amount(
      v_shipment.invoice_currency, v_gross, v_exchange_rate
    );
    -- Derive the discount leg from the two rounded figures so debits and
    -- credits always balance to the cent.
    v_discount_base := round(v_gross_base - v_net_base, 2);
  else
    v_gross_base := v_net_base;
    v_discount_base := 0;
  end if;

  select id into v_ar from public.accounting_accounts where code = '1100' and active;
  select id into v_revenue from public.accounting_accounts
    where code = case when v_shipment.shipment_type = 'Air Cargo' then '4000' else '4010' end and active;
  if v_discount_base > 0 then
    select id into v_discount_account from public.accounting_accounts where code = '4900' and active;
    if v_discount_account is null then
      raise exception 'The Sales Discounts account (4900) is missing or inactive.';
    end if;
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_shipment.invoice_finalized_at::date,
    'Cargo invoice ' || coalesce(v_shipment.invoice_number, v_shipment.tracking_number),
    'INVOICE', p_shipment_id, v_shipment.invoice_currency, v_exchange_rate,
    v_gross, v_gross_base, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_ar, 'Accounts receivable', v_net_base, 0, v_shipment.invoice_amount, 0),
    (v_entry.id, v_revenue, 'Cargo revenue', 0, v_gross_base, 0, v_gross);

  if v_discount_base > 0 then
    insert into public.journal_lines
      (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
    values
      (v_entry.id, v_discount_account,
       'Customer discount' || coalesce(' - ' || nullif(btrim(v_shipment.discount_reason), ''), ''),
       v_discount_base, 0, v_discount, 0);
  end if;

  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.shipments set accounting_journal_entry_id = v_entry.id where id = p_shipment_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_POSTED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'journal_entry_id', v_entry.id,
      'entry_number', v_entry.entry_number,
      'discount', v_discount,
      'grossAmount', v_gross
    ));
  return v_entry;
end;
$$;

revoke all on function public.post_invoice_accounting(text) from public, anon;
grant execute on function public.post_invoice_accounting(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Repair path for a finalized invoice with no journal. Manager/Admin only
--    and always audited, because it creates ledger history.
-- ---------------------------------------------------------------------------
create or replace function public.repost_invoice_accounting(
  p_shipment_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_shipment public.shipments%rowtype;
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role into v_actor_name, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if v_role not in ('Admin','Manager') then
    raise exception 'Reposting an invoice requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required to repost an invoice.';
  end if;

  select * into v_shipment from public.shipments where id = p_shipment_id;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then
    raise exception 'A voided shipment cannot be reposted.';
  end if;
  if v_shipment.invoice_finalized_at is null then
    raise exception 'The invoice must be finalized before accounting posting.';
  end if;
  if v_shipment.accounting_journal_entry_id is not null then
    raise exception 'This invoice is already posted to the ledger.';
  end if;

  v_entry := public.post_invoice_accounting(p_shipment_id);

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_REPOSTED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number, 'reason', btrim(p_reason)));

  select * into v_shipment from public.shipments where id = p_shipment_id;
  return jsonb_build_object('shipment', to_jsonb(v_shipment), 'journalEntry', to_jsonb(v_entry));
end;
$$;

revoke all on function public.repost_invoice_accounting(text, text) from public, anon;
grant execute on function public.repost_invoice_accounting(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Correct a finalized invoice. The original journal is voided (reversal
--    entry, never a delete) and a fresh one is posted, so the ledger keeps the
--    full history of what was billed and what it was corrected to.
-- ---------------------------------------------------------------------------
create or replace function public.amend_invoice(
  p_shipment_id text,
  p_gross_amount numeric,
  p_discount numeric,
  p_discount_reason text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_shipment public.shipments%rowtype;
  v_discount numeric(18,2);
  v_gross numeric(18,2);
  v_net numeric(18,2);
  v_billable numeric(18,2);
  v_amount_paid numeric(18,2);
  v_total_due numeric(18,2);
  v_old_entry_id uuid;
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role into v_actor_name, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if v_role not in ('Admin','Manager') then
    raise exception 'Amending an invoice requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A correction reason is required to amend an invoice.';
  end if;

  v_gross := round(coalesce(p_gross_amount, 0), 2);
  v_discount := round(coalesce(p_discount, 0), 2);
  if v_gross <= 0 then raise exception 'The invoice amount must be greater than zero.'; end if;
  if v_discount < 0 then raise exception 'A discount cannot be negative.'; end if;
  if v_discount >= v_gross then raise exception 'A discount cannot be greater than or equal to the invoice amount.'; end if;
  v_net := round(v_gross - v_discount, 2);

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then raise exception 'A voided shipment cannot be amended.'; end if;
  if v_shipment.invoice_finalized_at is null then
    raise exception 'Only a finalized invoice can be amended.';
  end if;

  select coalesce(sum(charge.amount), 0) into v_billable
  from public.cargo_extra_charges as charge
  where charge.shipment_id = p_shipment_id
    and charge.status = 'ACTIVE'
    and charge.charge_direction = 'billable_to_customer';

  select coalesce(sum(payment.amount), 0) into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = p_shipment_id and payment.status = 'POSTED';

  v_total_due := round(v_net + v_billable, 2);
  if v_amount_paid > v_total_due + 0.01 then
    raise exception 'This amendment would reduce Total Due below the payments already posted (%).', v_amount_paid;
  end if;

  v_old_entry_id := v_shipment.accounting_journal_entry_id;

  -- Detach first so the void does not leave a shipment pointing at a voided
  -- entry if any later step fails; the whole function is one transaction.
  perform set_config('app.invoice_amend_authorized', 'true', true);
  update public.shipments
  set accounting_journal_entry_id = null,
      invoice_amount = v_net,
      total_amount = v_net,
      discount = v_discount,
      discount_reason = nullif(btrim(p_discount_reason), ''),
      invoice_revision = coalesce(invoice_revision, 1) + 1,
      invoice_amended_at = now(),
      invoice_amended_by = v_actor,
      invoice_amendment_reason = btrim(p_reason),
      updated_at = now()::text
  where id = p_shipment_id;

  if v_old_entry_id is not null then
    perform public.void_accounting_entry(v_old_entry_id, 'Invoice amended: ' || btrim(p_reason));
  end if;

  v_entry := public.post_invoice_accounting(p_shipment_id);
  perform set_config('app.invoice_amend_authorized', 'false', true);

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_AMENDED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'previousInvoiceAmount', v_shipment.invoice_amount,
      'previousDiscount', coalesce(v_shipment.discount, 0),
      'grossAmount', v_gross,
      'discount', v_discount,
      'netInvoiceAmount', v_net,
      'voidedJournalEntryId', v_old_entry_id,
      'journalEntryId', v_entry.id
    ));

  select * into v_shipment from public.shipments where id = p_shipment_id;
  return jsonb_build_object(
    'shipment', to_jsonb(v_shipment),
    'journalEntry', to_jsonb(v_entry),
    'totalDue', v_total_due,
    'amountPaid', v_amount_paid
  );
end;
$$;

revoke all on function public.amend_invoice(text, numeric, numeric, text, text) from public, anon;
grant execute on function public.amend_invoice(text, numeric, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Idempotent, one-transaction expense recording. A repeated submit with the
--    same key returns the original expense instead of creating another one.
-- ---------------------------------------------------------------------------
create or replace function public.record_expense(
  p_idempotency_key uuid,
  p_expense_date date,
  p_category text,
  p_description text,
  p_amount numeric,
  p_currency text,
  p_expense_account_code text,
  p_payment_method text default 'Bank Transfer',
  p_payment_account_code text default '1010',
  p_payee text default null,
  p_reference text default null,
  p_shipment_id text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_email text;
  v_role text;
  v_expense public.expenses%rowtype;
  v_expense_id text;
  v_entry public.journal_entries%rowtype;
begin
  select profile.email, profile.role into v_actor_email, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_email is null then raise exception 'An active staff session is required.'; end if;
  if v_role not in ('Admin','Manager') then
    raise exception 'Recording an expense requires Manager or Admin access.';
  end if;

  if p_idempotency_key is null then raise exception 'An idempotency key is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_expense from public.expenses where idempotency_key = p_idempotency_key;
  if v_expense.id is not null then
    if v_expense.amount is distinct from round(p_amount, 2)
       or v_expense.currency is distinct from p_currency
       or v_expense.date is distinct from p_expense_date::text
       or v_expense.category is distinct from p_category then
      raise exception 'Idempotency key was already used for a different expense request.';
    end if;
    return jsonb_build_object('expense', to_jsonb(v_expense), 'idempotentReplay', true);
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'The expense amount must be greater than zero.'; end if;
  if p_currency not in ('USD','TZS','AED') then raise exception 'Unsupported expense currency.'; end if;
  if nullif(btrim(p_description), '') is null then raise exception 'An expense description is required.'; end if;
  if p_expense_date is null then raise exception 'An expense date is required.'; end if;
  if p_payment_account_code not in ('1000','1010') then
    raise exception 'Expenses may be paid from Cash or Bank only.';
  end if;

  v_expense_id := (extract(epoch from clock_timestamp()) * 1000)::bigint::text
    || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 7);

  insert into public.expenses (
    id, date, category, description, amount, currency, reference, shipment_id,
    notes, payee, payment_method, status, created_at, created_by, idempotency_key
  ) values (
    v_expense_id, p_expense_date::text, p_category, btrim(p_description),
    round(p_amount, 2), p_currency, nullif(btrim(p_reference), ''),
    nullif(btrim(p_shipment_id), ''), nullif(btrim(p_notes), ''),
    nullif(btrim(p_payee), ''), coalesce(nullif(btrim(p_payment_method), ''), 'Bank Transfer'),
    'DRAFT', now()::text, v_actor_email, p_idempotency_key
  );

  v_entry := public.post_expense_accounting(v_expense_id, p_expense_account_code, p_payment_account_code);

  select * into v_expense from public.expenses where id = v_expense_id;
  return jsonb_build_object(
    'expense', to_jsonb(v_expense),
    'journalEntry', to_jsonb(v_entry),
    'idempotentReplay', false
  );
end;
$$;

revoke all on function public.record_expense(uuid, date, text, text, numeric, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.record_expense(uuid, date, text, text, numeric, text, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. One-off repair of stored balances.
--
--    20260911091000 added the recalculation trigger but deliberately left
--    historical rows alone, so shipments paid before that migration still show
--    amount_paid = 0 and render as Unpaid. Recompute every shipment from its
--    POSTED payments. This only ever writes the value the trigger would have
--    written, and touches no payment or journal row.
-- ---------------------------------------------------------------------------
update public.shipments as shipment
set amount_paid = computed.paid,
    updated_at = now()::text
from (
  select shipment.id as shipment_id,
         coalesce((
           select sum(payment.amount)
           from public.payment_records as payment
           where payment.shipment_id = shipment.id and payment.status = 'POSTED'
         ), 0)::numeric(12,2) as paid
  from public.shipments as shipment
) as computed
where shipment.id = computed.shipment_id
  and shipment.amount_paid is distinct from computed.paid;

-- ---------------------------------------------------------------------------
-- 10. Defence in depth: a payment may only be attached to a shipment whose
--     invoice journal is actually POSTED. record_payment() already checks that
--     the link is present, but a link pointing at a voided entry would slip
--     through, and direct inserts bypass the RPC entirely.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_requires_posted_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_entry_status text;
begin
  select shipment.accounting_journal_entry_id into v_entry_id
  from public.shipments as shipment
  where shipment.id = new.shipment_id;
  if v_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  select entry.status into v_entry_status
  from public.journal_entries as entry
  where entry.id = v_entry_id;
  if v_entry_status is distinct from 'POSTED' then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_payment_requires_posted_invoice() from public, anon, authenticated;
drop trigger if exists trg_guard_payment_requires_posted_invoice on public.payment_records;
create trigger trg_guard_payment_requires_posted_invoice
  before insert on public.payment_records
  for each row execute function public.guard_payment_requires_posted_invoice();

-- ---------------------------------------------------------------------------
-- 11. Record this migration in the ledger (see 20260912085000).
-- ---------------------------------------------------------------------------
insert into supabase_migrations.schema_migrations (version, name)
values ('20260912090000', 'invoice_repair_discount_and_expense_idempotency')
on conflict (version) do nothing;


-- MIGRATION 22/22: 20261003090000_hopex_company_branding.sql
-- Hopex: add the company fields already used by the imported app.
-- Intended for the NEW, empty Hopex project after all earlier migrations.

-- The imported staff-profile reader includes these optional fields.
-- Existing server access continues to use staff roles and RLS.
alter table public.staff_profiles
  add column if not exists permissions_mode text not null default 'ROLE_DEFAULT',
  add column if not exists permissions text[] not null default '{}';

alter table public.company_settings
  add column if not exists short_name text not null default '',
  add column if not exists logo_path text not null default '',
  add column if not exists whatsapp text not null default '',
  add column if not exists dubai_address text not null default '',
  add column if not exists dubai_phone text not null default '',
  add column if not exists dubai_email text not null default '',
  add column if not exists tanzania_address text not null default '',
  add column if not exists tanzania_phone text not null default '',
  add column if not exists tanzania_email text not null default '',
  add column if not exists registration_number text not null default '',
  add column if not exists iban text not null default '',
  add column if not exists payment_instructions text not null default '',
  add column if not exists invoice_footer text not null default '',
  add column if not exists receipt_footer text not null default '',
  add column if not exists quote_footer text not null default '',
  add column if not exists packing_list_footer text not null default '',
  add column if not exists powered_by_text text not null default '',
  add column if not exists tracking_prefix text not null default 'HOPEX',
  add column if not exists packing_list_prefix text not null default 'PL-HOPEX',
  add column if not exists primary_color text not null default '#0c1c35',
  add column if not exists secondary_color text not null default '#0a84d3',
  add column if not exists accent_color text not null default '#2f80ed';

-- No contacts, bank details, staff or customer records are invented or copied.
insert into public.company_settings (
  id, company_name, short_name, business_type, default_currency,
  default_origin, default_destination_country, supported_destination_cities
) values (
  'default', 'Hopex Express Cargo', 'HOPEX CARGO',
  'International Cargo & Freight Forwarding', 'TZS', 'Dubai, UAE', 'Tanzania',
  array['Dar es Salaam','Zanzibar','Arusha','Dodoma','Mwanza','Mbeya',
        'Morogoro','Tanga','Kigoma','Tabora','Mtwara','Iringa','Moshi','Songea','Other']
)
on conflict (id) do nothing;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261003090000', 'hopex_company_branding')
on conflict (version) do nothing;


-- All preceding migrations completed inside this transaction.
insert into supabase_migrations.schema_migrations (version, name) values
  ('0001', 'shipments_and_auth'),
  ('20260808172013', 'shipping_rates_fx_and_invoice_snapshots'),
  ('20260808173840', 'harden_shipment_item_policy'),
  ('20260809145324', 'item_qr_packing_allocations'),
  ('20260811093520', 'staff_management_and_active_access'),
  ('20260811153000', 'fix_staff_auth_trigger_username'),
  ('20260815013914', 'shipment_status_lifecycle'),
  ('20260815013917', 'double_entry_accounting'),
  ('20260816112517', 'add_bank_account_name'),
  ('20260817182455', 'close_packing_list'),
  ('20260817184710', 'storage_inventory'),
  ('20260817190000', 'staff_profile_pictures'),
  ('20260817193000', 'controlled_deletion_archive'),
  ('20260817200000', 'stage5_integration_review'),
  ('20260819120000', 'shipment_delete_and_payment_refund'),
  ('20260819130000', 'partial_packing_dispatch'),
  ('20260911090000', 'cargo_extra_charges'),
  ('20260911091000', 'atomic_payment_recording'),
  ('20260911092000', 'status_transition_confirmation'),
  ('20260912085000', 'migration_ledger'),
  ('20260912090000', 'invoice_repair_discount_and_expense_idempotency'),
  ('20261003090000', 'hopex_company_branding')
on conflict (version) do nothing;
commit;

select 'HOPEX DATABASE SETUP COMPLETE' as status,
  company_name, tracking_prefix, packing_list_prefix
from public.company_settings where id = 'default';
