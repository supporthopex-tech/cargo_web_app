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
