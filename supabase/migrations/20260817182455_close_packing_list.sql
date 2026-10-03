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
