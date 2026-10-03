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
