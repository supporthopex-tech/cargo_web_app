-- Race-safe receipt numbers, idempotent payment submission and one-transaction
-- payment + accounting + shipment-balance updates.
-- Existing rows are inspected to seed counters but are never rewritten.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.payment_records
  add column if not exists idempotency_key uuid;

create unique index if not exists payment_records_idempotency_key_idx
  on public.payment_records (idempotency_key)
  where idempotency_key is not null;

create table if not exists public.payment_receipt_counters (
  receipt_date date primary key,
  last_value bigint not null check (last_value >= 0),
  updated_at timestamptz not null default now()
);

-- Seed every daily counter above the highest legacy number in the existing
-- RCT-YYMMDD-NNNN format. Other receipt formats remain untouched and cannot
-- collide because their prefixes differ.
with parsed_receipts as (
  select
    to_date(substring(receipt_number from 5 for 6), 'YYMMDD') as receipt_date,
    substring(receipt_number from 12)::bigint as sequence_value
  from public.payment_records
  where receipt_number ~ '^RCT-[0-9]{6}-[0-9]+$'
), seeded as (
  select receipt_date, max(sequence_value) as last_value
  from parsed_receipts
  group by receipt_date
)
insert into public.payment_receipt_counters (receipt_date, last_value)
select receipt_date, last_value from seeded
on conflict (receipt_date) do update
set last_value = greatest(public.payment_receipt_counters.last_value, excluded.last_value),
    updated_at = now();

alter table public.payment_receipt_counters enable row level security;
revoke all on table public.payment_receipt_counters from public, anon, authenticated;

-- Recalculate the stored amount_paid whenever a payment becomes POSTED,
-- REFUNDED/VOIDED, moves shipments or changes amount. The trigger is a
-- backstop for every future payment path; the migration deliberately does not
-- rewrite historical shipment rows.
create or replace function public.recalculate_shipment_amount_paid()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shipment_id text;
  v_previous_shipment_id text;
begin
  foreach v_shipment_id in array array[
    case when tg_op = 'INSERT' then null else old.shipment_id end,
    case when tg_op = 'DELETE' then null else new.shipment_id end
  ] loop
    if v_shipment_id is not null and v_shipment_id is distinct from v_previous_shipment_id then
      update public.shipments
      set amount_paid = (
            select coalesce(sum(payment.amount), 0)
            from public.payment_records as payment
            where payment.shipment_id = v_shipment_id
              and payment.status = 'POSTED'
          ),
          updated_at = now()::text
      where id = v_shipment_id;
      v_previous_shipment_id := v_shipment_id;
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.recalculate_shipment_amount_paid() from public, anon, authenticated;
drop trigger if exists trg_recalculate_shipment_amount_paid on public.payment_records;
create trigger trg_recalculate_shipment_amount_paid
  after insert or update of amount, status, shipment_id or delete
  on public.payment_records
  for each row execute function public.recalculate_shipment_amount_paid();

-- Keep the established journal posting contract, but make its overpayment
-- guard use the same authoritative Total Due formula as record_payment().
-- This also protects any legacy DRAFT payment posted through this existing RPC.
create or replace function public.post_payment_accounting(
  p_payment_id text,
  p_receiving_account_code text default '1010'
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_payment public.payment_records%rowtype;
  v_shipment public.shipments%rowtype;
  v_receiving uuid;
  v_ar uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_previously_paid numeric(18,2);
  v_billable_charges numeric(18,2);
  v_total_due numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if p_receiving_account_code not in ('1000','1010') then
    raise exception 'Payments may be received into Cash or Bank only.';
  end if;

  select payment.* into v_payment
  from public.payment_records as payment
  where payment.id = p_payment_id
  for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.accounting_journal_entry_id is not null then
    select entry.* into v_entry
    from public.journal_entries as entry
    where entry.id = v_payment.accounting_journal_entry_id;
    return v_entry;
  end if;

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.id = v_payment.shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.accounting_journal_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  if v_payment.currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Payment currency must match invoice currency %.', coalesce(v_shipment.invoice_currency, v_shipment.currency);
  end if;

  select coalesce(sum(charge.amount), 0) into v_billable_charges
  from public.cargo_extra_charges as charge
  where charge.shipment_id = v_payment.shipment_id
    and charge.status = 'ACTIVE'
    and charge.charge_direction = 'billable_to_customer';
  v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable_charges;

  select coalesce(sum(payment.amount), 0) into v_previously_paid
  from public.payment_records as payment
  where payment.shipment_id = v_payment.shipment_id
    and payment.id <> v_payment.id
    and payment.status = 'POSTED';
  if v_previously_paid + v_payment.amount > v_total_due + 0.01 then
    raise exception 'Payment exceeds the outstanding invoice balance.';
  end if;

  v_exchange_rate := coalesce(v_payment.exchange_rate, case v_payment.currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end);
  if v_exchange_rate is null or v_exchange_rate <= 0 then
    raise exception 'The shipment needs a valid invoice exchange-rate snapshot before this payment can be posted.';
  end if;
  v_base_amount := public.accounting_reporting_amount(v_payment.currency, v_payment.amount, v_exchange_rate);

  select account.id into v_receiving
  from public.accounting_accounts as account
  where account.code = p_receiving_account_code and account.active;
  select account.id into v_ar
  from public.accounting_accounts as account
  where account.code = '1100' and account.active;
  if v_receiving is null or v_ar is null then
    raise exception 'Required accounting accounts are not configured.';
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_payment.date::date, 'Payment ' || v_payment.receipt_number,
    'PAYMENT', p_payment_id, v_payment.currency, v_exchange_rate,
    v_payment.amount, v_base_amount, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_receiving, 'Customer payment received', v_base_amount, 0, v_payment.amount, 0),
    (v_entry.id, v_ar, 'Reduce accounts receivable', 0, v_base_amount, 0, v_payment.amount);

  update public.journal_entries
  set status = 'POSTED', posted_by = v_actor
  where id = v_entry.id
  returning * into v_entry;
  update public.payment_records
  set status = 'POSTED', receiving_account_id = v_receiving,
      exchange_rate = v_exchange_rate, reporting_amount = v_base_amount,
      accounting_journal_entry_id = v_entry.id
  where id = p_payment_id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'PAYMENT_POSTED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number)
  );
  return v_entry;
end;
$$;

revoke all on function public.post_payment_accounting(text, text) from public, anon;
grant execute on function public.post_payment_accounting(text, text) to authenticated;

create or replace function public.record_payment(
  p_shipment_id text,
  p_amount numeric,
  p_currency text,
  p_method text,
  p_payment_date date,
  p_note text,
  p_idempotency_key uuid,
  p_receiving_account_code text default '1010'
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_email text;
  v_shipment public.shipments%rowtype;
  v_payment public.payment_records%rowtype;
  v_counter bigint;
  v_receipt_number text;
  v_billable_charges numeric(18,2);
  v_total_due numeric(18,2);
  v_amount_paid numeric(18,2);
  v_shipment_updated_at text;
begin
  select profile.email
  into v_actor_email
  from public.staff_profiles as profile
  where profile.id = v_actor
    and profile.active
    and not profile.must_change_password;
  if v_actor_email is null then raise exception 'An active staff session is required.'; end if;

  if p_idempotency_key is null then raise exception 'An idempotency key is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_payment
  from public.payment_records
  where idempotency_key = p_idempotency_key;
  if v_payment.id is not null then
    if v_payment.shipment_id is distinct from p_shipment_id
       or v_payment.amount is distinct from p_amount
       or v_payment.currency is distinct from p_currency
       or v_payment.method is distinct from btrim(p_method)
       or v_payment.date is distinct from p_payment_date::text then
      raise exception 'Idempotency key was already used for a different payment request.';
    end if;
    select shipment.* into v_shipment
    from public.shipments as shipment
    where shipment.id = v_payment.shipment_id
    for update;
    if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
    select coalesce(sum(payment.amount), 0)
    into v_amount_paid
    from public.payment_records as payment
    where payment.shipment_id = v_payment.shipment_id and payment.status = 'POSTED';
    select coalesce(sum(charge.amount), 0)
    into v_billable_charges
    from public.cargo_extra_charges as charge
    where charge.shipment_id = v_payment.shipment_id
      and charge.status = 'ACTIVE'
      and charge.charge_direction = 'billable_to_customer';
    v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable_charges;
    update public.shipments
    set amount_paid = v_amount_paid, updated_at = now()::text
    where id = v_payment.shipment_id
    returning updated_at into v_shipment_updated_at;
    return jsonb_build_object(
      'payment', to_jsonb(v_payment),
      'shipmentAmountPaid', v_amount_paid,
      'shipmentUpdatedAt', v_shipment_updated_at,
      'totalDue', v_total_due,
      'idempotentReplay', true
    );
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'Payment amount must be greater than zero.'; end if;
  if p_currency not in ('USD','TZS','AED') then raise exception 'Unsupported payment currency.'; end if;
  if nullif(btrim(p_method), '') is null then raise exception 'Payment method is required.'; end if;
  if p_payment_date is null then raise exception 'Payment date is required.'; end if;
  if p_receiving_account_code not in ('1000','1010') then
    raise exception 'Payments may be received into Cash or Bank only.';
  end if;

  select * into v_shipment
  from public.shipments
  where id = p_shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then raise exception 'Payments cannot be recorded against a voided shipment.'; end if;
  if v_shipment.accounting_journal_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  if p_currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Payment currency must match invoice currency %.', coalesce(v_shipment.invoice_currency, v_shipment.currency);
  end if;

  select coalesce(sum(charge.amount), 0)
  into v_billable_charges
  from public.cargo_extra_charges as charge
  where charge.shipment_id = p_shipment_id
    and charge.status = 'ACTIVE'
    and charge.charge_direction = 'billable_to_customer';
  v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_billable_charges;

  select coalesce(sum(payment.amount), 0)
  into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = p_shipment_id and payment.status = 'POSTED';
  if v_amount_paid + p_amount > v_total_due + 0.01 then
    raise exception 'Payment exceeds the outstanding invoice balance.';
  end if;

  insert into public.payment_receipt_counters as counter (receipt_date, last_value)
  values (current_date, 1)
  on conflict (receipt_date) do update
  set last_value = counter.last_value + 1,
      updated_at = now()
  returning last_value into v_counter;

  v_receipt_number := 'RCT-' || to_char(current_date, 'YYMMDD') || '-'
    || lpad(v_counter::text, greatest(4, length(v_counter::text)), '0');

  insert into public.payment_records (
    id, receipt_number, shipment_id, amount, currency, method, date, note,
    status, idempotency_key, created_at, created_by
  ) values (
    gen_random_uuid()::text, v_receipt_number, p_shipment_id, p_amount,
    p_currency, btrim(p_method), p_payment_date::text, nullif(btrim(p_note), ''),
    'DRAFT', p_idempotency_key, now()::text, v_actor_email
  ) returning * into v_payment;

  perform public.post_payment_accounting(v_payment.id, p_receiving_account_code);

  select payment.* into v_payment
  from public.payment_records as payment
  where payment.id = v_payment.id;
  select coalesce(sum(payment.amount), 0)
  into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = p_shipment_id and payment.status = 'POSTED';

  update public.shipments
  set amount_paid = v_amount_paid, updated_at = now()::text
  where id = p_shipment_id
  returning updated_at into v_shipment_updated_at;

  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'shipmentAmountPaid', v_amount_paid,
    'shipmentUpdatedAt', v_shipment_updated_at,
    'totalDue', v_total_due,
    'idempotentReplay', false
  );
end;
$$;

-- The historical refund RPC manually subtracted amount_paid. The trigger above
-- now derives amount_paid from POSTED rows, so keep the refund transaction
-- atomic while removing that obsolete second subtraction.
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
  select profile.name into v_actor_name
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password and profile.role = 'Admin';
  if v_actor_name is null then raise exception 'Only an active Admin can refund a payment.'; end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A reason is required to refund a payment.'; end if;

  select payment.* into v_payment
  from public.payment_records as payment
  where payment.id = p_payment_id
  for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.status <> 'POSTED' then
    raise exception 'Only a posted payment can be refunded (current status: %).', v_payment.status;
  end if;
  if v_payment.accounting_journal_entry_id is null then
    raise exception 'This payment has no posted journal entry to reverse.';
  end if;

  v_reversal := public.void_accounting_entry(
    v_payment.accounting_journal_entry_id,
    'Refund: ' || btrim(p_reason)
  );
  update public.payment_records set status = 'REFUNDED' where id = p_payment_id;

  insert into public.payment_refunds (
    payment_id, refund_amount, currency, refund_method, refund_date, reason,
    processed_by, processed_by_name, accounting_journal_entry_id
  ) values (
    p_payment_id, v_payment.amount, v_payment.currency,
    nullif(btrim(p_refund_method), ''), current_date, btrim(p_reason),
    v_actor, v_actor_name, v_reversal.id
  ) returning * into v_refund;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'PAYMENT_REFUNDED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'reason', btrim(p_reason), 'refundAmount', v_payment.amount,
      'currency', v_payment.currency, 'refundMethod', nullif(btrim(p_refund_method), ''),
      'reversalJournalEntryId', v_reversal.id, 'refundId', v_refund.id
    )
  );
  return v_refund;
end;
$$;

revoke all on function public.refund_payment(text, text, text) from public, anon;
grant execute on function public.refund_payment(text, text, text) to authenticated;

revoke all on function public.record_payment(text, numeric, text, text, date, text, uuid, text) from public, anon;
grant execute on function public.record_payment(text, numeric, text, text, date, text, uuid, text) to authenticated;

-- New payments must use record_payment(); direct reads and deletion of legacy
-- draft rows remain available under the existing RLS/guard rules.
revoke insert, update on table public.payment_records from authenticated;
grant select, delete on table public.payment_records to authenticated;
