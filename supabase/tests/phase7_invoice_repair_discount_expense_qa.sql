\set ON_ERROR_STOP on
\timing off

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values ('11111111-1111-1111-1111-111111111111', 'admin@tcast.test');
insert into public.staff_profiles (id, email, name, initials, role, active, username, must_change_password)
values ('11111111-1111-1111-1111-111111111111', 'admin@tcast.test', 'Test Admin', 'TA', 'Admin', true, 'testadmin', false)
on conflict (id) do update set role = 'Admin', active = true, must_change_password = false;

select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', false);

insert into public.customers (id, name, phone, email, created_at, updated_at)
values ('CUST-1', 'Test Customer', '+255700000000', 'cust@test.com', current_date::text, current_date::text);

insert into public.exchange_rates (rate_date, usd_to_tzs, usd_to_aed, created_by)
values (current_date - 30, 2700, 3.67, '11111111-1111-1111-1111-111111111111');

-- A finalized TZS invoice: 1,350,000 TZS at 2700/USD = 500.00 USD base.
insert into public.shipments (
  id, tracking_number, status, shipment_type, cargo_category, service_type, customer_id,
  origin, destination, destination_city, description, weight_kg, volume_cbm, pcs,
  shipping_rate, base_rate, other_charges, discount, total_amount, amount_paid, currency,
  base_currency, base_amount_usd, usd_to_tzs_rate_used, usd_to_aed_rate_used,
  invoice_currency, invoice_amount, invoice_number, invoice_finalized_at,
  created_by, created_at, updated_at
) values (
  'SHIP-1', 'TCAST-260912-0001', 'RECEIVED', 'Air Cargo', 'General Cargo', 'Air Cargo', 'CUST-1',
  'Dubai', 'Tanzania', 'Dar es Salaam', 'Test cargo', 100, 0, 10,
  'USD 5 / kg', 1350000, 0, 0, 1350000, 0, 'TZS',
  'USD', 500, 2700, 3.67,
  'TZS', 1350000, 'INV-TCAST-260912-0001', now(),
  'admin@tcast.test', current_date::text, current_date::text
);

select public.post_invoice_accounting('SHIP-1');
select accounting_journal_entry_id is not null as invoice_posted from public.shipments where id = 'SHIP-1';

\echo '--- T1: invoice journal is balanced and AR equals the net invoice'
select
  (select count(*) from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
     where e.reference_type = 'INVOICE' and e.reference_id = 'SHIP-1') as lines,
  (select sum(l.debit) = sum(l.credit) from public.journal_lines l join public.journal_entries e on e.id = l.journal_entry_id
     where e.reference_type = 'INVOICE' and e.reference_id = 'SHIP-1') as balanced;

-- ---------------------------------------------------------------------------
-- T2: reproduce the production breakage — invoice finalized, journal gone.
-- ---------------------------------------------------------------------------
\echo '--- T2: payment is refused while the invoice journal is missing'
do $$
declare v_entry uuid;
begin
  select accounting_journal_entry_id into v_entry from public.shipments where id = 'SHIP-1';
  update public.shipments set accounting_journal_entry_id = null where id = 'SHIP-1';
  -- Simulate the August cleanup, which removed journal history wholesale.
  alter table public.journal_lines disable trigger trg_guard_posted_journal_lines;
  delete from public.journal_lines where journal_entry_id = v_entry;
  alter table public.journal_lines enable trigger trg_guard_posted_journal_lines;
  delete from public.journal_entries where id = v_entry;
end $$;

do $$
begin
  perform public.record_payment('SHIP-1', 100000, 'TZS', 'Cash', current_date, null, gen_random_uuid(), '1000');
  raise exception 'FAIL: a payment was accepted without a posted invoice';
exception when others then
  if sqlerrm like '%invoice must be posted%' then
    raise notice 'PASS: %', sqlerrm;
  else
    raise exception 'FAIL: unexpected error %', sqlerrm;
  end if;
end $$;

\echo '--- T3: repost_invoice_accounting repairs it, and payment then succeeds'
select (public.repost_invoice_accounting('SHIP-1', 'Journal lost during data cleanup') -> 'journalEntry' ->> 'status') as reposted_status;

select (public.record_payment('SHIP-1', 350000, 'TZS', 'Cash', current_date, 'Part payment', gen_random_uuid(), '1000') ->> 'shipmentAmountPaid')::numeric as amount_paid_after_payment;

\echo '--- T4: amount_paid follows posted payments (bug 2)'
select amount_paid from public.shipments where id = 'SHIP-1';

\echo '--- T5: repost is refused once the invoice is already posted'
do $$
begin
  perform public.repost_invoice_accounting('SHIP-1', 'again');
  raise exception 'FAIL: a second repost was allowed';
exception when others then
  if sqlerrm like '%already posted%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: unexpected error %', sqlerrm; end if;
end $$;

-- ---------------------------------------------------------------------------
-- T6: amend the invoice and apply a discount.
-- Gross 1,400,000 with a 200,000 discount => 1,200,000 due.
-- ---------------------------------------------------------------------------
\echo '--- T6: amend_invoice applies a discount and reissues the journal'
select
  (public.amend_invoice('SHIP-1', 1400000, 200000, 'Regular customer rebate', 'Weight corrected') ->> 'totalDue')::numeric as total_due;

select invoice_amount, discount, discount_reason, invoice_revision from public.shipments where id = 'SHIP-1';

\echo '--- T7: the reissued journal has a discount line and still balances'
select
  count(*) as lines,
  sum(l.debit) = sum(l.credit) as balanced,
  sum(case when a.code = '4900' then l.debit else 0 end) as discount_debit,
  sum(case when a.code = '1100' then l.debit else 0 end) as ar_debit,
  sum(case when a.code = '4000' then l.credit else 0 end) as revenue_credit
from public.journal_lines l
join public.journal_entries e on e.id = l.journal_entry_id
join public.accounting_accounts a on a.id = l.account_id
where e.reference_type = 'INVOICE' and e.reference_id = 'SHIP-1' and e.status = 'POSTED';

\echo '--- T8: the whole ledger still balances (trial balance)'
select sum(debit)::numeric(18,2) as total_debit, sum(credit)::numeric(18,2) as total_credit,
       sum(debit) = sum(credit) as balanced
from public.accounting_trial_balance;

\echo '--- T9: an amendment that would drop Total Due below posted payments is refused'
do $$
begin
  perform public.amend_invoice('SHIP-1', 100000, 0, null, 'Too low');
  raise exception 'FAIL: the amendment was allowed';
exception when others then
  if sqlerrm like '%below the payments already posted%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: unexpected error %', sqlerrm; end if;
end $$;

\echo '--- T10: a finalized invoice is still immutable outside amend_invoice'
do $$
begin
  update public.shipments set invoice_amount = 999 where id = 'SHIP-1';
  raise exception 'FAIL: a finalized invoice was edited directly';
exception when others then
  if sqlerrm like '%immutable%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: unexpected error %', sqlerrm; end if;
end $$;

-- ---------------------------------------------------------------------------
-- T11: expense idempotency (bug 3).
-- ---------------------------------------------------------------------------
\echo '--- T11: the same expense key twice creates exactly one expense'
do $$
declare k uuid := gen_random_uuid();
begin
  perform public.record_expense(k, current_date, 'Internet / Phone', 'Office internet', 70000, 'TZS', '5090', 'Cash', '1000');
  perform public.record_expense(k, current_date, 'Internet / Phone', 'Office internet', 70000, 'TZS', '5090', 'Cash', '1000');
  perform public.record_expense(k, current_date, 'Internet / Phone', 'Office internet', 70000, 'TZS', '5090', 'Cash', '1000');
end $$;

select count(*) as expense_rows,
       (select count(*) from public.journal_entries where reference_type = 'EXPENSE') as expense_journals
from public.expenses;

\echo '--- T12: the same key with different details is rejected'
do $$
declare k uuid := gen_random_uuid();
begin
  perform public.record_expense(k, current_date, 'Marketing', 'Ads', 50000, 'TZS', '5100', 'Cash', '1000');
  perform public.record_expense(k, current_date, 'Marketing', 'Ads', 99999, 'TZS', '5100', 'Cash', '1000');
  raise exception 'FAIL: a reused key with different details was accepted';
exception when others then
  if sqlerrm like '%already used for a different expense%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: unexpected error %', sqlerrm; end if;
end $$;

\echo '--- T13: final ledger integrity'
select sum(debit) = sum(credit) as trial_balance_balanced from public.accounting_trial_balance;

\echo '--- T14: a payment against a VOIDED invoice journal is blocked by the new trigger'
do $$
declare v_entry uuid;
begin
  select accounting_journal_entry_id into v_entry from public.shipments where id = 'SHIP-1';
  perform public.void_accounting_entry(v_entry, 'Test void');
  -- The shipment still points at the (now voided) entry, which is exactly the
  -- hole the BEFORE INSERT trigger closes.
  perform public.record_payment('SHIP-1', 1000, 'TZS', 'Cash', current_date, null, gen_random_uuid(), '1000');
  raise exception 'FAIL: a payment was accepted against a voided invoice journal';
exception when others then
  if sqlerrm like '%invoice must be posted%' then raise notice 'PASS: %', sqlerrm;
  else raise exception 'FAIL: unexpected error %', sqlerrm; end if;
end $$;
