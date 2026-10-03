-- Run only after the lifecycle migration has been applied to an isolated QA DB.
-- The transaction always rolls back; failures raise an exception before rollback.
begin;

do $$
declare
  invalid_statuses bigint;
  missing_history bigint;
  public_function text;
begin
  select count(*) into invalid_statuses
  from public.shipments
  where status not in ('RECEIVED','PACKED','DISPATCHED','ON_TRANSIT','IN_CUSTOMS','ARRIVED','DELIVERED');
  if invalid_statuses <> 0 then raise exception '% shipments have invalid lifecycle status', invalid_statuses; end if;

  select count(*) into missing_history
  from public.shipments shipment
  where not exists (select 1 from public.shipment_status_history history where history.shipment_id = shipment.id);
  if missing_history <> 0 then raise exception '% shipments are missing normalized status history', missing_history; end if;

  if exists (select 1 from public.shipments where status = 'IN_CUSTOMS' and customs_type is null) then
    raise exception 'IN_CUSTOMS shipment is missing airport/sea-port metadata';
  end if;

  select pg_get_functiondef('public.track_shipment(text)'::regprocedure) into public_function;
  if position('internal_note' in lower(public_function)) > 0 or position('actor_id' in lower(public_function)) > 0 then
    raise exception 'Public tracking function contains an internal-only field';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.shipments'::regclass
      and tgname = 'trg_guard_shipment_status_direct_update' and not tgisinternal
  ) then raise exception 'Direct shipment status update guard is missing'; end if;
end $$;

-- Recovery: because this QA check is read-only, rollback is sufficient. For an
-- application migration failure, restore from the pre-migration Supabase backup
-- and retain the additive migration file for root-cause analysis; never delete
-- or reset shipment rows as a rollback mechanism.
rollback;
