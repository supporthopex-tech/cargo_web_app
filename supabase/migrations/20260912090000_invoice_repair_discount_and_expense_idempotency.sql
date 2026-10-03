-- Invoice repair, invoice amendment, customer discounts and idempotent expense
-- recording.
--
-- Four gaps are closed here:
--   1. A shipment whose invoice is finalized but whose invoice journal is
--      missing (for example because the journal was removed during a data
--      cleanup) could never accept a payment and had no repair path.
--   2. A finalized invoice that was entered incorrectly could not be corrected
--      at all: the pricing snapshot is immutable by design and nothing was
--      allowed to void and reissue it.
--   3. shipments.discount existed but was never written, never posted to the
--      ledger and never shown.
--   4. Expenses had no idempotency key, so a double submit created duplicate
--      expenses and duplicate journal entries.
--
-- Semantics chosen for discounts (important):
--   shipments.invoice_amount stays the NET amount the customer owes, so every
--   existing Total Due formula keeps working untouched. The gross invoice value
--   is derived as invoice_amount + discount. The ledger records the gross as
--   revenue and the discount as contra-revenue, so a discount is visible in the
--   income statement instead of silently shrinking revenue.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 1. Contra-revenue account for customer discounts.
-- ---------------------------------------------------------------------------
insert into public.accounting_accounts
  (code, name, account_type, normal_balance, system_account, allow_manual_posting)
values
  ('4900', 'Sales Discounts', 'REVENUE', 'DEBIT', true, false)
on conflict (code) do update set
  name = excluded.name,
  account_type = excluded.account_type,
  normal_balance = excluded.normal_balance,
  system_account = excluded.system_account,
  allow_manual_posting = excluded.allow_manual_posting;

-- ---------------------------------------------------------------------------
-- 2. Invoice amendment bookkeeping columns.
-- ---------------------------------------------------------------------------
alter table public.shipments
  add column if not exists discount_reason text,
  add column if not exists invoice_revision integer not null default 1,
  add column if not exists invoice_amended_at timestamptz,
  add column if not exists invoice_amended_by uuid,
  add column if not exists invoice_amendment_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'shipments_discount_nonnegative_check'
  ) then
    alter table public.shipments
      add constraint shipments_discount_nonnegative_check
      check (coalesce(discount, 0) >= 0);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Expense idempotency key.
-- ---------------------------------------------------------------------------
alter table public.expenses
  add column if not exists idempotency_key uuid;

create unique index if not exists expenses_idempotency_key_idx
  on public.expenses (idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 4. Allow an authorized amendment to move a finalized pricing snapshot.
--    Everything else about the guard is unchanged: without the session flag a
--    finalized invoice stays immutable.
-- ---------------------------------------------------------------------------
create or replace function public.guard_shipment_pricing_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.rate_overridden then
    if public.staff_role() not in ('Admin','Manager') then
      raise exception 'Only Admin or Manager can override a shipment rate.';
    end if;
    if new.override_reason is null or btrim(new.override_reason) = '' then
      raise exception 'An override reason is required.';
    end if;
    new.overridden_by := coalesce(new.overridden_by, auth.uid());
    new.override_timestamp := coalesce(new.override_timestamp, now());
  elsif new.standard_rate_usd is not null and new.applied_rate_usd is distinct from new.standard_rate_usd then
    raise exception 'A changed applied rate must be recorded as an authorized override.';
  end if;

  if new.invoice_finalized_at is not null then
    if new.base_amount_usd is null or new.invoice_currency is null or new.invoice_amount is null then
      raise exception 'A finalized invoice requires base amount, invoice currency and invoice amount snapshots.';
    end if;
    if new.invoice_currency = 'TZS' and new.usd_to_tzs_rate_used is null then
      raise exception 'A TZS invoice requires the USD/TZS rate snapshot.';
    end if;
    if new.invoice_currency = 'AED' and new.usd_to_aed_rate_used is null then
      raise exception 'An AED invoice requires the USD/AED rate snapshot.';
    end if;
  end if;

  if tg_op = 'UPDATE'
    and old.invoice_finalized_at is not null
    and coalesce(current_setting('app.invoice_amend_authorized', true), 'false') <> 'true'
    and (
      new.customer_name_snapshot is distinct from old.customer_name_snapshot or
      new.customer_phone_snapshot is distinct from old.customer_phone_snapshot or
      new.customer_email_snapshot is distinct from old.customer_email_snapshot or
      new.shipment_type is distinct from old.shipment_type or
      new.description is distinct from old.description or
      new.weight_kg is distinct from old.weight_kg or
      new.volume_cbm is distinct from old.volume_cbm or
      new.pcs is distinct from old.pcs or
      new.pricing_unit is distinct from old.pricing_unit or
      new.standard_rate_usd is distinct from old.standard_rate_usd or
      new.applied_rate_usd is distinct from old.applied_rate_usd or
      new.rate_overridden is distinct from old.rate_overridden or
      new.override_reason is distinct from old.override_reason or
      new.base_currency is distinct from old.base_currency or
      new.base_amount_usd is distinct from old.base_amount_usd or
      new.usd_to_tzs_rate_used is distinct from old.usd_to_tzs_rate_used or
      new.usd_to_aed_rate_used is distinct from old.usd_to_aed_rate_used or
      new.selected_exchange_rate is distinct from old.selected_exchange_rate or
      new.exchange_rate_date is distinct from old.exchange_rate_date or
      new.invoice_currency is distinct from old.invoice_currency or
      new.invoice_amount is distinct from old.invoice_amount or
      new.invoice_number is distinct from old.invoice_number or
      new.invoice_finalized_at is distinct from old.invoice_finalized_at
    )
  then
    raise exception 'Finalized invoice pricing snapshots are immutable.';
  end if;

  return new;
end;
$$;

revoke all on function public.guard_shipment_pricing_snapshot() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Invoice posting, now discount aware and safe to call again after a
--    journal was lost. Revenue is credited with the gross invoice value and
--    the discount is debited to contra-revenue, so AR still equals the net
--    amount the customer owes.
-- ---------------------------------------------------------------------------
create or replace function public.post_invoice_accounting(p_shipment_id text)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_role text;
  v_actor_name text;
  v_shipment public.shipments%rowtype;
  v_ar uuid;
  v_revenue uuid;
  v_discount_account uuid;
  v_exchange_rate numeric(18,6);
  v_discount numeric(18,2);
  v_gross numeric(18,2);
  v_net_base numeric(18,2);
  v_gross_base numeric(18,2);
  v_discount_base numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role into v_actor_name, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.invoice_finalized_at is null or v_shipment.invoice_amount is null or v_shipment.invoice_currency is null then
    raise exception 'The invoice must be finalized before accounting posting.';
  end if;
  if v_shipment.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_shipment.accounting_journal_entry_id;
    return v_entry;
  end if;

  -- Self-heal a broken link rather than posting the invoice twice.
  select * into v_entry
  from public.journal_entries
  where reference_type = 'INVOICE' and reference_id = p_shipment_id and status = 'POSTED'
  order by created_at desc
  limit 1;
  if v_entry.id is not null then
    update public.shipments set accounting_journal_entry_id = v_entry.id where id = p_shipment_id;
    return v_entry;
  end if;

  v_discount := round(coalesce(v_shipment.discount, 0), 2);
  if v_discount < 0 then raise exception 'A discount cannot be negative.'; end if;
  v_gross := round(v_shipment.invoice_amount + v_discount, 2);

  v_exchange_rate := case v_shipment.invoice_currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end;
  v_net_base := public.accounting_reporting_amount(
    v_shipment.invoice_currency, v_shipment.invoice_amount, v_exchange_rate
  );
  if v_discount > 0 then
    v_gross_base := public.accounting_reporting_amount(
      v_shipment.invoice_currency, v_gross, v_exchange_rate
    );
    -- Derive the discount leg from the two rounded figures so debits and
    -- credits always balance to the cent.
    v_discount_base := round(v_gross_base - v_net_base, 2);
  else
    v_gross_base := v_net_base;
    v_discount_base := 0;
  end if;

  select id into v_ar from public.accounting_accounts where code = '1100' and active;
  select id into v_revenue from public.accounting_accounts
    where code = case when v_shipment.shipment_type = 'Air Cargo' then '4000' else '4010' end and active;
  if v_discount_base > 0 then
    select id into v_discount_account from public.accounting_accounts where code = '4900' and active;
    if v_discount_account is null then
      raise exception 'The Sales Discounts account (4900) is missing or inactive.';
    end if;
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_shipment.invoice_finalized_at::date,
    'Cargo invoice ' || coalesce(v_shipment.invoice_number, v_shipment.tracking_number),
    'INVOICE', p_shipment_id, v_shipment.invoice_currency, v_exchange_rate,
    v_gross, v_gross_base, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_ar, 'Accounts receivable', v_net_base, 0, v_shipment.invoice_amount, 0),
    (v_entry.id, v_revenue, 'Cargo revenue', 0, v_gross_base, 0, v_gross);

  if v_discount_base > 0 then
    insert into public.journal_lines
      (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
    values
      (v_entry.id, v_discount_account,
       'Customer discount' || coalesce(' - ' || nullif(btrim(v_shipment.discount_reason), ''), ''),
       v_discount_base, 0, v_discount, 0);
  end if;

  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.shipments set accounting_journal_entry_id = v_entry.id where id = p_shipment_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_POSTED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'journal_entry_id', v_entry.id,
      'entry_number', v_entry.entry_number,
      'discount', v_discount,
      'grossAmount', v_gross
    ));
  return v_entry;
end;
$$;

revoke all on function public.post_invoice_accounting(text) from public, anon;
grant execute on function public.post_invoice_accounting(text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Repair path for a finalized invoice with no journal. Manager/Admin only
--    and always audited, because it creates ledger history.
-- ---------------------------------------------------------------------------
create or replace function public.repost_invoice_accounting(
  p_shipment_id text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_shipment public.shipments%rowtype;
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role into v_actor_name, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if v_role not in ('Admin','Manager') then
    raise exception 'Reposting an invoice requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A reason is required to repost an invoice.';
  end if;

  select * into v_shipment from public.shipments where id = p_shipment_id;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then
    raise exception 'A voided shipment cannot be reposted.';
  end if;
  if v_shipment.invoice_finalized_at is null then
    raise exception 'The invoice must be finalized before accounting posting.';
  end if;
  if v_shipment.accounting_journal_entry_id is not null then
    raise exception 'This invoice is already posted to the ledger.';
  end if;

  v_entry := public.post_invoice_accounting(p_shipment_id);

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_REPOSTED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number, 'reason', btrim(p_reason)));

  select * into v_shipment from public.shipments where id = p_shipment_id;
  return jsonb_build_object('shipment', to_jsonb(v_shipment), 'journalEntry', to_jsonb(v_entry));
end;
$$;

revoke all on function public.repost_invoice_accounting(text, text) from public, anon;
grant execute on function public.repost_invoice_accounting(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Correct a finalized invoice. The original journal is voided (reversal
--    entry, never a delete) and a fresh one is posted, so the ledger keeps the
--    full history of what was billed and what it was corrected to.
-- ---------------------------------------------------------------------------
create or replace function public.amend_invoice(
  p_shipment_id text,
  p_gross_amount numeric,
  p_discount numeric,
  p_discount_reason text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_shipment public.shipments%rowtype;
  v_discount numeric(18,2);
  v_gross numeric(18,2);
  v_net numeric(18,2);
  v_billable numeric(18,2);
  v_amount_paid numeric(18,2);
  v_total_due numeric(18,2);
  v_old_entry_id uuid;
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role into v_actor_name, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if v_role not in ('Admin','Manager') then
    raise exception 'Amending an invoice requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A correction reason is required to amend an invoice.';
  end if;

  v_gross := round(coalesce(p_gross_amount, 0), 2);
  v_discount := round(coalesce(p_discount, 0), 2);
  if v_gross <= 0 then raise exception 'The invoice amount must be greater than zero.'; end if;
  if v_discount < 0 then raise exception 'A discount cannot be negative.'; end if;
  if v_discount >= v_gross then raise exception 'A discount cannot be greater than or equal to the invoice amount.'; end if;
  v_net := round(v_gross - v_discount, 2);

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then raise exception 'A voided shipment cannot be amended.'; end if;
  if v_shipment.invoice_finalized_at is null then
    raise exception 'Only a finalized invoice can be amended.';
  end if;

  select coalesce(sum(charge.amount), 0) into v_billable
  from public.cargo_extra_charges as charge
  where charge.shipment_id = p_shipment_id
    and charge.status = 'ACTIVE'
    and charge.charge_direction = 'billable_to_customer';

  select coalesce(sum(payment.amount), 0) into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = p_shipment_id and payment.status = 'POSTED';

  v_total_due := round(v_net + v_billable, 2);
  if v_amount_paid > v_total_due + 0.01 then
    raise exception 'This amendment would reduce Total Due below the payments already posted (%).', v_amount_paid;
  end if;

  v_old_entry_id := v_shipment.accounting_journal_entry_id;

  -- Detach first so the void does not leave a shipment pointing at a voided
  -- entry if any later step fails; the whole function is one transaction.
  perform set_config('app.invoice_amend_authorized', 'true', true);
  update public.shipments
  set accounting_journal_entry_id = null,
      invoice_amount = v_net,
      total_amount = v_net,
      discount = v_discount,
      discount_reason = nullif(btrim(p_discount_reason), ''),
      invoice_revision = coalesce(invoice_revision, 1) + 1,
      invoice_amended_at = now(),
      invoice_amended_by = v_actor,
      invoice_amendment_reason = btrim(p_reason),
      updated_at = now()::text
  where id = p_shipment_id;

  if v_old_entry_id is not null then
    perform public.void_accounting_entry(v_old_entry_id, 'Invoice amended: ' || btrim(p_reason));
  end if;

  v_entry := public.post_invoice_accounting(p_shipment_id);
  perform set_config('app.invoice_amend_authorized', 'false', true);

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_AMENDED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object(
      'reason', btrim(p_reason),
      'previousInvoiceAmount', v_shipment.invoice_amount,
      'previousDiscount', coalesce(v_shipment.discount, 0),
      'grossAmount', v_gross,
      'discount', v_discount,
      'netInvoiceAmount', v_net,
      'voidedJournalEntryId', v_old_entry_id,
      'journalEntryId', v_entry.id
    ));

  select * into v_shipment from public.shipments where id = p_shipment_id;
  return jsonb_build_object(
    'shipment', to_jsonb(v_shipment),
    'journalEntry', to_jsonb(v_entry),
    'totalDue', v_total_due,
    'amountPaid', v_amount_paid
  );
end;
$$;

revoke all on function public.amend_invoice(text, numeric, numeric, text, text) from public, anon;
grant execute on function public.amend_invoice(text, numeric, numeric, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Idempotent, one-transaction expense recording. A repeated submit with the
--    same key returns the original expense instead of creating another one.
-- ---------------------------------------------------------------------------
create or replace function public.record_expense(
  p_idempotency_key uuid,
  p_expense_date date,
  p_category text,
  p_description text,
  p_amount numeric,
  p_currency text,
  p_expense_account_code text,
  p_payment_method text default 'Bank Transfer',
  p_payment_account_code text default '1010',
  p_payee text default null,
  p_reference text default null,
  p_shipment_id text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_email text;
  v_role text;
  v_expense public.expenses%rowtype;
  v_expense_id text;
  v_entry public.journal_entries%rowtype;
begin
  select profile.email, profile.role into v_actor_email, v_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_email is null then raise exception 'An active staff session is required.'; end if;
  if v_role not in ('Admin','Manager') then
    raise exception 'Recording an expense requires Manager or Admin access.';
  end if;

  if p_idempotency_key is null then raise exception 'An idempotency key is required.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));

  select * into v_expense from public.expenses where idempotency_key = p_idempotency_key;
  if v_expense.id is not null then
    if v_expense.amount is distinct from round(p_amount, 2)
       or v_expense.currency is distinct from p_currency
       or v_expense.date is distinct from p_expense_date::text
       or v_expense.category is distinct from p_category then
      raise exception 'Idempotency key was already used for a different expense request.';
    end if;
    return jsonb_build_object('expense', to_jsonb(v_expense), 'idempotentReplay', true);
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'The expense amount must be greater than zero.'; end if;
  if p_currency not in ('USD','TZS','AED') then raise exception 'Unsupported expense currency.'; end if;
  if nullif(btrim(p_description), '') is null then raise exception 'An expense description is required.'; end if;
  if p_expense_date is null then raise exception 'An expense date is required.'; end if;
  if p_payment_account_code not in ('1000','1010') then
    raise exception 'Expenses may be paid from Cash or Bank only.';
  end if;

  v_expense_id := (extract(epoch from clock_timestamp()) * 1000)::bigint::text
    || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 7);

  insert into public.expenses (
    id, date, category, description, amount, currency, reference, shipment_id,
    notes, payee, payment_method, status, created_at, created_by, idempotency_key
  ) values (
    v_expense_id, p_expense_date::text, p_category, btrim(p_description),
    round(p_amount, 2), p_currency, nullif(btrim(p_reference), ''),
    nullif(btrim(p_shipment_id), ''), nullif(btrim(p_notes), ''),
    nullif(btrim(p_payee), ''), coalesce(nullif(btrim(p_payment_method), ''), 'Bank Transfer'),
    'DRAFT', now()::text, v_actor_email, p_idempotency_key
  );

  v_entry := public.post_expense_accounting(v_expense_id, p_expense_account_code, p_payment_account_code);

  select * into v_expense from public.expenses where id = v_expense_id;
  return jsonb_build_object(
    'expense', to_jsonb(v_expense),
    'journalEntry', to_jsonb(v_entry),
    'idempotentReplay', false
  );
end;
$$;

revoke all on function public.record_expense(uuid, date, text, text, numeric, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.record_expense(uuid, date, text, text, numeric, text, text, text, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 9. One-off repair of stored balances.
--
--    20260911091000 added the recalculation trigger but deliberately left
--    historical rows alone, so shipments paid before that migration still show
--    amount_paid = 0 and render as Unpaid. Recompute every shipment from its
--    POSTED payments. This only ever writes the value the trigger would have
--    written, and touches no payment or journal row.
-- ---------------------------------------------------------------------------
update public.shipments as shipment
set amount_paid = computed.paid,
    updated_at = now()::text
from (
  select shipment.id as shipment_id,
         coalesce((
           select sum(payment.amount)
           from public.payment_records as payment
           where payment.shipment_id = shipment.id and payment.status = 'POSTED'
         ), 0)::numeric(12,2) as paid
  from public.shipments as shipment
) as computed
where shipment.id = computed.shipment_id
  and shipment.amount_paid is distinct from computed.paid;

-- ---------------------------------------------------------------------------
-- 10. Defence in depth: a payment may only be attached to a shipment whose
--     invoice journal is actually POSTED. record_payment() already checks that
--     the link is present, but a link pointing at a voided entry would slip
--     through, and direct inserts bypass the RPC entirely.
-- ---------------------------------------------------------------------------
create or replace function public.guard_payment_requires_posted_invoice()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_entry_id uuid;
  v_entry_status text;
begin
  select shipment.accounting_journal_entry_id into v_entry_id
  from public.shipments as shipment
  where shipment.id = new.shipment_id;
  if v_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  select entry.status into v_entry_status
  from public.journal_entries as entry
  where entry.id = v_entry_id;
  if v_entry_status is distinct from 'POSTED' then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_payment_requires_posted_invoice() from public, anon, authenticated;
drop trigger if exists trg_guard_payment_requires_posted_invoice on public.payment_records;
create trigger trg_guard_payment_requires_posted_invoice
  before insert on public.payment_records
  for each row execute function public.guard_payment_requires_posted_invoice();

-- ---------------------------------------------------------------------------
-- 11. Record this migration in the ledger (see 20260912085000).
-- ---------------------------------------------------------------------------
insert into supabase_migrations.schema_migrations (version, name)
values ('20260912090000', 'invoice_repair_discount_and_expense_idempotency')
on conflict (version) do nothing;
