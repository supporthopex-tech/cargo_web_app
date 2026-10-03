-- Run only after the three 20260911 migrations have been applied to an
-- isolated QA database. This script always rolls back its test records.
begin;

do $$
declare
  v_actor uuid;
  v_shipment public.shipments%rowtype;
  v_unit numeric(18,2);
  v_billable public.cargo_extra_charges%rowtype;
  v_company public.cargo_extra_charges%rowtype;
  v_payment_one jsonb;
  v_payment_replay jsonb;
  v_payment_two jsonb;
  v_key_one uuid := gen_random_uuid();
  v_key_two uuid := gen_random_uuid();
  v_failure_key uuid := gen_random_uuid();
  v_before_paid numeric(18,2);
  v_after_paid numeric(18,2);
begin
  if to_regclass('public.cargo_extra_charges') is null then
    raise exception 'cargo_extra_charges is missing';
  end if;
  if to_regclass('public.payment_receipt_counters') is null then
    raise exception 'payment_receipt_counters is missing';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_recalculate_shipment_amount_paid' and not tgisinternal
  ) then
    raise exception 'amount_paid recalculation trigger is missing';
  end if;
  if to_regprocedure('public.record_payment(text,numeric,text,text,date,text,uuid,text)') is null then
    raise exception 'record_payment RPC is missing';
  end if;
  if to_regprocedure('public.transition_shipment_status_confirmed(text,text,text,text,text,text,text,text,text,text,text,timestamp with time zone,text,text)') is null then
    raise exception 'confirmed status RPC is missing';
  end if;
  if has_table_privilege('authenticated', 'public.payment_records', 'INSERT') then
    raise exception 'authenticated must not insert payment_records directly';
  end if;
  if has_table_privilege('authenticated', 'public.cargo_extra_charges', 'INSERT') then
    raise exception 'authenticated must not insert cargo_extra_charges directly';
  end if;
  if not has_function_privilege('authenticated', 'public.record_payment(text,numeric,text,text,date,text,uuid,text)', 'EXECUTE') then
    raise exception 'authenticated cannot execute record_payment';
  end if;
  if exists (
    select receipt_number from public.payment_records
    group by receipt_number having count(*) > 1
  ) then
    raise exception 'duplicate receipt numbers already exist';
  end if;

  select profile.id into v_actor
  from public.staff_profiles as profile
  where profile.active and not profile.must_change_password and profile.role = 'Admin'
  order by profile.created_at
  limit 1;
  if v_actor is null then
    raise notice 'Behavioral QA skipped: no active Admin profile exists in this isolated database.';
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.accounting_journal_entry_id is not null
    and shipment.voided_at is null
    and coalesce(shipment.invoice_amount, shipment.total_amount, 0) > 0
    and case coalesce(shipment.invoice_currency, shipment.currency)
      when 'USD' then true
      when 'TZS' then shipment.usd_to_tzs_rate_used > 0
      when 'AED' then shipment.usd_to_aed_rate_used > 0
      else false
    end
    and coalesce(shipment.invoice_amount, shipment.total_amount, 0)
      + coalesce((
          select sum(charge.amount)
          from public.cargo_extra_charges as charge
          where charge.shipment_id = shipment.id
            and charge.status = 'ACTIVE'
            and charge.charge_direction = 'billable_to_customer'
        ), 0)
      + case coalesce(shipment.invoice_currency, shipment.currency) when 'TZS' then 2000 else 2 end
      >= coalesce((
          select sum(payment.amount)
          from public.payment_records as payment
          where payment.shipment_id = shipment.id and payment.status = 'POSTED'
        ), 0)
  order by shipment.created_at
  limit 1
  for update;
  if v_shipment.id is null then
    raise notice 'Behavioral QA skipped: no posted, non-voided invoice with a valid FX snapshot exists.';
    return;
  end if;

  v_unit := case coalesce(v_shipment.invoice_currency, v_shipment.currency)
    when 'TZS' then 1000 else 1 end;
  v_before_paid := coalesce((
    select sum(payment.amount) from public.payment_records as payment
    where payment.shipment_id = v_shipment.id and payment.status = 'POSTED'
  ), 0);

  v_billable := public.create_cargo_extra_charge(
    v_shipment.id, 'pickup', null, 'billable_to_customer', v_unit,
    coalesce(v_shipment.invoice_currency, v_shipment.currency), current_date,
    'Rollback-only QA billable charge', null, gen_random_uuid()
  );
  v_company := public.create_cargo_extra_charge(
    v_shipment.id, 'supplier_payment', null, 'company_expense', v_unit,
    coalesce(v_shipment.invoice_currency, v_shipment.currency), current_date,
    'Rollback-only QA company expense', 'Bank Transfer', gen_random_uuid()
  );
  if v_billable.accounting_journal_entry_id is null or v_company.accounting_journal_entry_id is null then
    raise exception 'cargo charge accounting did not post';
  end if;

  v_billable := public.update_cargo_extra_charge(
    v_billable.id, 'pickup', null, 'billable_to_customer', v_unit * 2,
    v_billable.currency, current_date, 'Rollback-only QA edited charge', null,
    'Rollback-only QA edit'
  );
  if v_billable.amount <> v_unit * 2 then raise exception 'cargo charge edit did not persist'; end if;
  v_company := public.delete_cargo_extra_charge(v_company.id, 'Rollback-only QA delete');
  if v_company.status <> 'DELETED' then raise exception 'cargo charge delete did not persist'; end if;

  v_payment_one := public.record_payment(
    v_shipment.id, v_unit, coalesce(v_shipment.invoice_currency, v_shipment.currency),
    'Bank Transfer', current_date, 'Rollback-only QA payment one', v_key_one, '1010'
  );
  v_payment_replay := public.record_payment(
    v_shipment.id, v_unit, coalesce(v_shipment.invoice_currency, v_shipment.currency),
    'Bank Transfer', current_date, 'Rollback-only QA payment one', v_key_one, '1010'
  );
  if (v_payment_replay ->> 'idempotentReplay')::boolean is not true then
    raise exception 'repeated idempotency key was not returned as a replay';
  end if;
  if v_payment_one #>> '{payment,id}' is distinct from v_payment_replay #>> '{payment,id}' then
    raise exception 'idempotency replay created or returned a different payment';
  end if;
  if (select count(*) from public.payment_records where idempotency_key = v_key_one) <> 1 then
    raise exception 'idempotency key created more than one payment';
  end if;

  v_payment_two := public.record_payment(
    v_shipment.id, v_unit, coalesce(v_shipment.invoice_currency, v_shipment.currency),
    'Bank Transfer', current_date, 'Rollback-only QA payment two', v_key_two, '1010'
  );
  if v_payment_one #>> '{payment,receipt_number}' = v_payment_two #>> '{payment,receipt_number}' then
    raise exception 'two payments received the same receipt number';
  end if;

  begin
    perform public.record_payment(
      v_shipment.id,
      coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable.amount + 1,
      coalesce(v_shipment.invoice_currency, v_shipment.currency),
      'Bank Transfer', current_date, 'This must fail', v_failure_key, '1010'
    );
    raise exception 'forced overpayment unexpectedly succeeded';
  exception when others then
    if sqlerrm = 'forced overpayment unexpectedly succeeded' then raise; end if;
  end;
  if exists (select 1 from public.payment_records where idempotency_key = v_failure_key) then
    raise exception 'failed payment left a partial payment row';
  end if;

  select shipment.amount_paid into v_after_paid
  from public.shipments as shipment where shipment.id = v_shipment.id;
  if v_after_paid <> v_before_paid + (v_unit * 2) then
    raise exception 'shipment amount_paid does not equal the POSTED payment sum';
  end if;

  if exists (
    select entry.id
    from public.journal_entries as entry
    join public.journal_lines as line on line.journal_entry_id = entry.id
    where entry.status = 'POSTED'
      and entry.reference_type in ('PAYMENT', 'EXTRA_CHARGE')
    group by entry.id
    having round(sum(line.debit), 2) <> round(sum(line.credit), 2)
  ) then
    raise exception 'a posted payment or cargo-charge journal is unbalanced';
  end if;
end $$;

-- All QA-created payments, counters, charges, journals and audit rows disappear.
rollback;
