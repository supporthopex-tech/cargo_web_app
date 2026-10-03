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
