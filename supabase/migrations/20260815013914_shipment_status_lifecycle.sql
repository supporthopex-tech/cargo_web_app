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
