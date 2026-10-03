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
