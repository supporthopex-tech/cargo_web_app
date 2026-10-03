-- Keep the established transition_shipment_status() lifecycle rules, but wrap
-- the write and authoritative readback in the same transaction. If RLS or any
-- other condition prevents the changed shipment from being read back, raising
-- here rolls the transition and its timeline entry back together.

set lock_timeout = '5s';
set statement_timeout = '60s';

create or replace function public.transition_shipment_status_confirmed(
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
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_history public.shipment_status_history%rowtype;
  v_shipment public.shipments%rowtype;
begin
  v_history := public.transition_shipment_status(
    p_shipment_id,
    p_new_status,
    p_location,
    p_public_note,
    p_internal_note,
    p_customs_type,
    p_customs_location,
    p_dispatch_reference,
    p_correction_reason,
    p_recipient_name,
    p_recipient_phone,
    p_delivered_at,
    p_delivery_notes,
    p_proof_storage_path
  );

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.id = p_shipment_id;

  if v_shipment.id is null then
    raise exception 'Shipment status confirmation failed because the changed row could not be read back.';
  end if;
  if v_shipment.status is distinct from p_new_status then
    raise exception 'Shipment status confirmation failed because the stored status did not match.';
  end if;

  return jsonb_build_object(
    'shipment', to_jsonb(v_shipment),
    'history', to_jsonb(v_history)
  );
end;
$$;

revoke all on function public.transition_shipment_status_confirmed(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) from public, anon;
grant execute on function public.transition_shipment_status_confirmed(
  text, text, text, text, text, text, text, text, text,
  text, text, timestamptz, text, text
) to authenticated;
