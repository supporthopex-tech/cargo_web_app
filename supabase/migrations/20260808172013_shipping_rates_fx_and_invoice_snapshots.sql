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
