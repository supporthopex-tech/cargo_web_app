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
