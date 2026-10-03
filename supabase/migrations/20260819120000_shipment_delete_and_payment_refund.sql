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
