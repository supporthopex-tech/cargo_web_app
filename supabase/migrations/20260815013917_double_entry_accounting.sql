-- TCAST double-entry accounting foundation.
-- Additive only: legacy invoices, payments and expenses remain intact. Historical
-- records are previewed before backfill; Production application requires a
-- separately reviewed dry run and explicit authorization.

set lock_timeout = '5s';
set statement_timeout = '60s';

create sequence if not exists public.journal_entry_number_seq;

create table if not exists public.accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  account_type text not null check (account_type in ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance text not null check (normal_balance in ('DEBIT','CREDIT')),
  parent_id uuid references public.accounting_accounts (id) on delete restrict,
  active boolean not null default true,
  system_account boolean not null default false,
  allow_manual_posting boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_accounts_name_check check (btrim(name) <> ''),
  constraint accounting_accounts_code_check check (btrim(code) <> '')
);

create index if not exists accounting_accounts_type_active_idx
  on public.accounting_accounts (account_type, active, code);
create index if not exists accounting_accounts_parent_idx
  on public.accounting_accounts (parent_id);

insert into public.accounting_accounts
  (code, name, account_type, normal_balance, system_account, allow_manual_posting)
values
  ('1000', 'Cash', 'ASSET', 'DEBIT', true, true),
  ('1010', 'Bank', 'ASSET', 'DEBIT', true, true),
  ('1100', 'Accounts Receivable', 'ASSET', 'DEBIT', true, false),
  ('1200', 'Other Current Assets', 'ASSET', 'DEBIT', false, true),
  ('2000', 'Accounts Payable', 'LIABILITY', 'CREDIT', true, false),
  ('2100', 'Other Liabilities', 'LIABILITY', 'CREDIT', false, true),
  ('3000', 'Owner''s Capital', 'EQUITY', 'CREDIT', true, true),
  ('3100', 'Retained Earnings', 'EQUITY', 'CREDIT', true, false),
  ('4000', 'Air Cargo Revenue', 'REVENUE', 'CREDIT', true, false),
  ('4010', 'Sea Cargo Revenue', 'REVENUE', 'CREDIT', true, false),
  ('4020', 'Clearing Revenue', 'REVENUE', 'CREDIT', false, true),
  ('4030', 'Other Service Revenue', 'REVENUE', 'CREDIT', false, true),
  ('4090', 'Other Income', 'REVENUE', 'CREDIT', true, true),
  ('5000', 'Office Rent', 'EXPENSE', 'DEBIT', false, true),
  ('5010', 'Staff Salaries', 'EXPENSE', 'DEBIT', false, true),
  ('5020', 'Transport Expense', 'EXPENSE', 'DEBIT', false, true),
  ('5030', 'Fuel Expense', 'EXPENSE', 'DEBIT', false, true),
  ('5040', 'Packing Materials', 'EXPENSE', 'DEBIT', false, true),
  ('5050', 'Airport Charges', 'EXPENSE', 'DEBIT', false, true),
  ('5060', 'Port Charges', 'EXPENSE', 'DEBIT', false, true),
  ('5070', 'Customs / Clearing Costs', 'EXPENSE', 'DEBIT', false, true),
  ('5080', 'Utilities', 'EXPENSE', 'DEBIT', false, true),
  ('5090', 'Internet / Phone', 'EXPENSE', 'DEBIT', false, true),
  ('5100', 'Marketing', 'EXPENSE', 'DEBIT', false, true),
  ('5110', 'Bank Charges', 'EXPENSE', 'DEBIT', false, true),
  ('5190', 'General Expenses', 'EXPENSE', 'DEBIT', false, true),
  ('5200', 'Other Expenses', 'EXPENSE', 'DEBIT', false, true)
on conflict (code) do update set
  name = excluded.name,
  account_type = excluded.account_type,
  normal_balance = excluded.normal_balance,
  system_account = excluded.system_account;

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  entry_number text not null unique,
  entry_date date not null,
  description text not null,
  reference_type text not null,
  reference_id text not null,
  currency text not null check (currency in ('USD','TZS','AED')),
  exchange_rate numeric(18,6) not null check (exchange_rate > 0),
  original_amount numeric(18,2) not null check (original_amount >= 0),
  base_amount numeric(18,2) not null check (base_amount >= 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','POSTED','VOIDED')),
  reversal_of uuid references public.journal_entries (id) on delete restrict,
  correction_reason text,
  created_by uuid references public.staff_profiles (id) on delete set null,
  posted_by uuid references public.staff_profiles (id) on delete set null,
  voided_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  posted_at timestamptz,
  voided_at timestamptz,
  constraint journal_entries_description_check check (btrim(description) <> '')
);

create unique index if not exists journal_entries_posted_reference_idx
  on public.journal_entries (reference_type, reference_id)
  where status = 'POSTED' and reversal_of is null;
create index if not exists journal_entries_date_status_idx
  on public.journal_entries (status, entry_date, id);
create index if not exists journal_entries_reference_idx
  on public.journal_entries (reference_type, reference_id);
create index if not exists journal_entries_created_by_idx
  on public.journal_entries (created_by);

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_entry_id uuid not null references public.journal_entries (id) on delete restrict,
  account_id uuid not null references public.accounting_accounts (id) on delete restrict,
  description text,
  debit numeric(18,2) not null default 0 check (debit >= 0),
  credit numeric(18,2) not null default 0 check (credit >= 0),
  original_debit numeric(18,2) not null default 0 check (original_debit >= 0),
  original_credit numeric(18,2) not null default 0 check (original_credit >= 0),
  created_at timestamptz not null default now(),
  constraint journal_lines_one_side_check check (
    (debit > 0 and credit = 0) or (credit > 0 and debit = 0)
  )
);

create index if not exists journal_lines_entry_idx
  on public.journal_lines (journal_entry_id);
create index if not exists journal_lines_account_entry_idx
  on public.journal_lines (account_id, journal_entry_id);

alter table public.shipments
  add column if not exists accounting_journal_entry_id uuid
    references public.journal_entries (id) on delete restrict;

alter table public.payment_records
  add column if not exists status text not null default 'POSTED',
  add column if not exists receiving_account_id uuid
    references public.accounting_accounts (id) on delete restrict,
  add column if not exists exchange_rate numeric(18,6),
  add column if not exists reporting_amount numeric(18,2),
  add column if not exists accounting_journal_entry_id uuid
    references public.journal_entries (id) on delete restrict;

alter table public.expenses
  add column if not exists expense_number text,
  add column if not exists payee text,
  add column if not exists payment_method text,
  add column if not exists expense_account_id uuid
    references public.accounting_accounts (id) on delete restrict,
  add column if not exists payment_account_id uuid
    references public.accounting_accounts (id) on delete restrict,
  add column if not exists exchange_rate numeric(18,6),
  add column if not exists reporting_amount numeric(18,2),
  add column if not exists status text not null default 'DRAFT',
  add column if not exists accounting_journal_entry_id uuid
    references public.journal_entries (id) on delete restrict,
  add column if not exists receipt_storage_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_records_accounting_status_check'
      and conrelid = 'public.payment_records'::regclass
  ) then
    alter table public.payment_records add constraint payment_records_accounting_status_check
      check (status in ('DRAFT','POSTED','VOIDED'));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'expenses_accounting_status_check'
      and conrelid = 'public.expenses'::regclass
  ) then
    alter table public.expenses add constraint expenses_accounting_status_check
      check (status in ('DRAFT','POSTED','VOIDED'));
  end if;
end $$;

create unique index if not exists expenses_expense_number_idx
  on public.expenses (expense_number) where expense_number is not null;
create index if not exists payment_records_accounting_entry_idx
  on public.payment_records (accounting_journal_entry_id);
create index if not exists expenses_accounting_entry_idx
  on public.expenses (accounting_journal_entry_id);
create index if not exists expenses_accounts_date_idx
  on public.expenses (expense_account_id, date);

create table if not exists public.other_income (
  id uuid primary key default gen_random_uuid(),
  income_number text not null unique,
  income_date date not null,
  income_account_id uuid not null references public.accounting_accounts (id) on delete restrict,
  receiving_account_id uuid not null references public.accounting_accounts (id) on delete restrict,
  description text not null check (btrim(description) <> ''),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null check (currency in ('USD','TZS','AED')),
  exchange_rate numeric(18,6) not null check (exchange_rate > 0),
  reporting_amount numeric(18,2) not null check (reporting_amount > 0),
  reference text,
  status text not null default 'DRAFT' check (status in ('DRAFT','POSTED','VOIDED')),
  accounting_journal_entry_id uuid references public.journal_entries (id) on delete restrict,
  created_by uuid not null references public.staff_profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create index if not exists other_income_date_status_idx
  on public.other_income (status, income_date);
create index if not exists other_income_accounts_idx
  on public.other_income (income_account_id, receiving_account_id);

create or replace function public.accounting_reporting_amount(
  p_currency text,
  p_amount numeric,
  p_exchange_rate numeric
)
returns numeric
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_amount <= 0 then raise exception 'Amount must be greater than zero.'; end if;
  if p_currency = 'USD' then return round(p_amount, 2); end if;
  if p_currency not in ('TZS', 'AED') then raise exception 'Unsupported currency %.', p_currency; end if;
  if p_exchange_rate is null or p_exchange_rate <= 0 then
    raise exception 'A positive historical exchange-rate snapshot is required for %.', p_currency;
  end if;
  return round(p_amount / p_exchange_rate, 2);
end;
$$;

create or replace function public.guard_journal_posting()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_debit numeric(18,2);
  v_credit numeric(18,2);
begin
  if new.status = 'POSTED' and old.status is distinct from 'POSTED' then
    select coalesce(sum(debit), 0), coalesce(sum(credit), 0)
    into v_debit, v_credit
    from public.journal_lines
    where journal_entry_id = new.id;
    if v_debit <= 0 or v_debit <> v_credit then
      raise exception 'Posted journal % is not balanced. Debit %, Credit %.', new.entry_number, v_debit, v_credit;
    end if;
    new.posted_at := coalesce(new.posted_at, now());
  end if;
  if old.status in ('POSTED', 'VOIDED') and new.status = 'DRAFT' then
    raise exception 'A posted or voided journal cannot return to Draft.';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_journal_posting() from public, anon, authenticated;
drop trigger if exists trg_guard_journal_posting on public.journal_entries;
create trigger trg_guard_journal_posting
  before update of status on public.journal_entries
  for each row execute function public.guard_journal_posting();

create or replace function public.guard_posted_journal_lines()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_entry_id uuid := case when tg_op = 'DELETE' then old.journal_entry_id else new.journal_entry_id end;
begin
  if exists (
    select 1 from public.journal_entries
    where id = v_entry_id and status in ('POSTED', 'VOIDED')
  ) then
    raise exception 'Posted journal lines are immutable.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_posted_journal_lines() from public, anon, authenticated;
drop trigger if exists trg_guard_posted_journal_lines on public.journal_lines;
create trigger trg_guard_posted_journal_lines
  before insert or update or delete on public.journal_lines
  for each row execute function public.guard_posted_journal_lines();

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
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select name, role into v_actor_name, v_role
  from public.staff_profiles
  where id = v_actor and active and not must_change_password;
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

  v_exchange_rate := case v_shipment.invoice_currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end;
  v_base_amount := public.accounting_reporting_amount(
    v_shipment.invoice_currency, v_shipment.invoice_amount, v_exchange_rate
  );
  select id into v_ar from public.accounting_accounts where code = '1100' and active;
  select id into v_revenue from public.accounting_accounts
    where code = case when v_shipment.shipment_type = 'Air Cargo' then '4000' else '4010' end and active;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_shipment.invoice_finalized_at::date,
    'Cargo invoice ' || coalesce(v_shipment.invoice_number, v_shipment.tracking_number),
    'INVOICE', p_shipment_id, v_shipment.invoice_currency, v_exchange_rate,
    v_shipment.invoice_amount, v_base_amount, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_ar, 'Accounts receivable', v_base_amount, 0, v_shipment.invoice_amount, 0),
    (v_entry.id, v_revenue, 'Cargo revenue', 0, v_base_amount, 0, v_shipment.invoice_amount);

  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.shipments set accounting_journal_entry_id = v_entry.id where id = p_shipment_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('INVOICE_POSTED', 'shipment', p_shipment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_entry;
end;
$$;

revoke all on function public.post_invoice_accounting(text) from public, anon;
grant execute on function public.post_invoice_accounting(text) to authenticated;

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
  v_entry public.journal_entries%rowtype;
begin
  select name into v_actor_name from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_actor_name is null then raise exception 'An active staff session is required.'; end if;
  if p_receiving_account_code not in ('1000','1010') then raise exception 'Payments may be received into Cash or Bank only.'; end if;

  select * into v_payment from public.payment_records where id = p_payment_id for update;
  if v_payment.id is null then raise exception 'Payment not found.'; end if;
  if v_payment.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_payment.accounting_journal_entry_id;
    return v_entry;
  end if;
  select * into v_shipment from public.shipments where id = v_payment.shipment_id;
  if v_shipment.accounting_journal_entry_id is null then
    raise exception 'The related invoice must be posted before receiving payment.';
  end if;
  if v_payment.currency is distinct from v_shipment.invoice_currency then
    raise exception 'Payment currency must match invoice currency %.', v_shipment.invoice_currency;
  end if;
  select coalesce(sum(amount), 0) into v_previously_paid
  from public.payment_records
  where shipment_id = v_payment.shipment_id and id <> v_payment.id and status = 'POSTED';
  if v_previously_paid + v_payment.amount > v_shipment.invoice_amount + 0.01 then
    raise exception 'Payment exceeds the outstanding invoice balance.';
  end if;
  v_exchange_rate := coalesce(v_payment.exchange_rate, case v_payment.currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end);
  v_base_amount := public.accounting_reporting_amount(v_payment.currency, v_payment.amount, v_exchange_rate);
  select id into v_receiving from public.accounting_accounts where code = p_receiving_account_code and active;
  select id into v_ar from public.accounting_accounts where code = '1100' and active;

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
  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.payment_records set
    status = 'POSTED', receiving_account_id = v_receiving,
    exchange_rate = v_exchange_rate, reporting_amount = v_base_amount,
    accounting_journal_entry_id = v_entry.id
  where id = p_payment_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('PAYMENT_POSTED', 'payment', p_payment_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_entry;
end;
$$;

revoke all on function public.post_payment_accounting(text, text) from public, anon;
grant execute on function public.post_payment_accounting(text, text) to authenticated;

create or replace function public.post_expense_accounting(
  p_expense_id text,
  p_expense_account_code text,
  p_payment_account_code text default '1010'
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_expense public.expenses%rowtype;
  v_expense_account uuid;
  v_payment_account uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_entry public.journal_entries%rowtype;
begin
  select name, role into v_actor_name, v_role from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_role not in ('Admin','Manager') then raise exception 'Expense posting requires Manager or Admin access.'; end if;
  if p_payment_account_code not in ('1000','1010') then raise exception 'Expenses may be paid from Cash or Bank only.'; end if;

  select * into v_expense from public.expenses where id = p_expense_id for update;
  if v_expense.id is null then raise exception 'Expense not found.'; end if;
  if v_expense.accounting_journal_entry_id is not null then
    select * into v_entry from public.journal_entries where id = v_expense.accounting_journal_entry_id;
    return v_entry;
  end if;
  select id into v_expense_account from public.accounting_accounts
    where code = p_expense_account_code and account_type = 'EXPENSE' and active;
  if v_expense_account is null then raise exception 'A valid active expense account is required.'; end if;
  select id into v_payment_account from public.accounting_accounts
    where code = p_payment_account_code and account_type = 'ASSET' and active;

  v_exchange_rate := coalesce(v_expense.exchange_rate, case v_expense.currency
    when 'USD' then 1
    when 'TZS' then (select usd_to_tzs from public.exchange_rates where rate_date <= v_expense.date::date order by rate_date desc limit 1)
    when 'AED' then (select usd_to_aed from public.exchange_rates where rate_date <= v_expense.date::date order by rate_date desc limit 1)
  end);
  v_base_amount := public.accounting_reporting_amount(v_expense.currency, v_expense.amount, v_exchange_rate);

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_expense.date::date, v_expense.description, 'EXPENSE', p_expense_id,
    v_expense.currency, v_exchange_rate, v_expense.amount, v_base_amount, v_actor
  ) returning * into v_entry;
  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_expense_account, v_expense.description, v_base_amount, 0, v_expense.amount, 0),
    (v_entry.id, v_payment_account, 'Expense payment', 0, v_base_amount, 0, v_expense.amount);
  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.expenses set
    status = 'POSTED', expense_account_id = v_expense_account,
    payment_account_id = v_payment_account, exchange_rate = v_exchange_rate,
    reporting_amount = v_base_amount, accounting_journal_entry_id = v_entry.id,
    expense_number = coalesce(expense_number, 'EXP-' || to_char(v_expense.date::date, 'YYMMDD') || '-' || right(v_expense.id, 4))
  where id = p_expense_id;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('EXPENSE_POSTED', 'expense', p_expense_id, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_entry;
end;
$$;

revoke all on function public.post_expense_accounting(text, text, text) from public, anon;
grant execute on function public.post_expense_accounting(text, text, text) to authenticated;

create or replace function public.create_other_income(
  p_income_date date,
  p_income_account_code text,
  p_receiving_account_code text,
  p_description text,
  p_amount numeric,
  p_currency text,
  p_exchange_rate numeric,
  p_reference text default null
)
returns public.other_income
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_income_account uuid;
  v_receiving_account uuid;
  v_reporting numeric(18,2);
  v_entry public.journal_entries%rowtype;
  v_income public.other_income%rowtype;
begin
  select name, role into v_actor_name, v_role from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_role not in ('Admin','Manager') then raise exception 'Other income posting requires Manager or Admin access.'; end if;
  select id into v_income_account from public.accounting_accounts
    where code = p_income_account_code and account_type = 'REVENUE' and active and allow_manual_posting;
  select id into v_receiving_account from public.accounting_accounts
    where code = p_receiving_account_code and account_type = 'ASSET' and active;
  if v_income_account is null or v_receiving_account is null then raise exception 'Valid income and receiving accounts are required.'; end if;
  v_reporting := public.accounting_reporting_amount(p_currency, p_amount, p_exchange_rate);

  insert into public.other_income (
    income_number, income_date, income_account_id, receiving_account_id,
    description, amount, currency, exchange_rate, reporting_amount,
    reference, status, created_by
  ) values (
    'OIN-' || to_char(p_income_date, 'YYMMDD') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    p_income_date, v_income_account, v_receiving_account, btrim(p_description),
    p_amount, p_currency, p_exchange_rate, v_reporting, nullif(btrim(p_reference), ''), 'DRAFT', v_actor
  ) returning * into v_income;
  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    p_income_date, btrim(p_description), 'OTHER_INCOME', v_income.id::text,
    p_currency, p_exchange_rate, p_amount, v_reporting, v_actor
  ) returning * into v_entry;
  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_receiving_account, btrim(p_description), v_reporting, 0, p_amount, 0),
    (v_entry.id, v_income_account, btrim(p_description), 0, v_reporting, 0, p_amount);
  update public.journal_entries set status = 'POSTED', posted_by = v_actor where id = v_entry.id returning * into v_entry;
  update public.other_income set status = 'POSTED', accounting_journal_entry_id = v_entry.id where id = v_income.id returning * into v_income;
  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('OTHER_INCOME_POSTED', 'other_income', v_income.id::text, v_actor, v_actor_name,
    jsonb_build_object('journal_entry_id', v_entry.id, 'entry_number', v_entry.entry_number));
  return v_income;
end;
$$;

revoke all on function public.create_other_income(date, text, text, text, numeric, text, numeric, text) from public, anon;
grant execute on function public.create_other_income(date, text, text, text, numeric, text, numeric, text) to authenticated;

create or replace function public.guard_posted_accounting_document()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'POSTED'
     and coalesce(current_setting('app.accounting_void_authorized', true), 'false') <> 'true' then
    raise exception 'Posted accounting records are immutable. Use void_accounting_entry() with a correction reason.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

revoke all on function public.guard_posted_accounting_document() from public, anon, authenticated;
drop trigger if exists trg_guard_posted_payment on public.payment_records;
create trigger trg_guard_posted_payment before update or delete on public.payment_records
  for each row execute function public.guard_posted_accounting_document();
drop trigger if exists trg_guard_posted_expense on public.expenses;
create trigger trg_guard_posted_expense before update or delete on public.expenses
  for each row execute function public.guard_posted_accounting_document();
drop trigger if exists trg_guard_posted_other_income on public.other_income;
create trigger trg_guard_posted_other_income before update or delete on public.other_income
  for each row execute function public.guard_posted_accounting_document();

create or replace function public.void_accounting_entry(
  p_journal_entry_id uuid,
  p_reason text
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_role text;
  v_original public.journal_entries%rowtype;
  v_reversal public.journal_entries%rowtype;
begin
  select name, role into v_actor_name, v_role
  from public.staff_profiles
  where id = v_actor and active and not must_change_password;
  if v_role not in ('Admin','Manager') then
    raise exception 'Voiding a posted entry requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then
    raise exception 'A correction reason is required.';
  end if;

  select * into v_original from public.journal_entries
  where id = p_journal_entry_id for update;
  if v_original.id is null then raise exception 'Journal entry not found.'; end if;
  if v_original.status <> 'POSTED' then raise exception 'Only a posted journal can be voided.'; end if;
  if v_original.reversal_of is not null then raise exception 'A reversal entry cannot be voided again.'; end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, reversal_of,
    correction_reason, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    current_date, 'Reversal: ' || v_original.description, 'REVERSAL', v_original.id::text,
    v_original.currency, v_original.exchange_rate, v_original.original_amount,
    v_original.base_amount, v_original.id, btrim(p_reason), v_actor
  ) returning * into v_reversal;

  insert into public.journal_lines (
    journal_entry_id, account_id, description, debit, credit, original_debit, original_credit
  )
  select v_reversal.id, account_id, 'Reversal: ' || coalesce(description, v_original.description),
    credit, debit, original_credit, original_debit
  from public.journal_lines where journal_entry_id = v_original.id;

  update public.journal_entries set status = 'POSTED', posted_by = v_actor
  where id = v_reversal.id returning * into v_reversal;
  perform set_config('app.accounting_void_authorized', 'true', true);
  update public.journal_entries
  set status = 'VOIDED', voided_by = v_actor, voided_at = now(), correction_reason = btrim(p_reason)
  where id in (v_original.id, v_reversal.id);

  if v_original.reference_type = 'PAYMENT' then
    update public.payment_records set status = 'VOIDED' where id = v_original.reference_id;
  elsif v_original.reference_type = 'EXPENSE' then
    update public.expenses set status = 'VOIDED' where id = v_original.reference_id;
  elsif v_original.reference_type = 'OTHER_INCOME' then
    update public.other_income set status = 'VOIDED' where id::text = v_original.reference_id;
  end if;

  insert into public.business_audit_log (action, entity_type, entity_id, actor_id, actor_name, details)
  values ('ACCOUNTING_ENTRY_VOIDED', 'journal_entry', v_original.id::text, v_actor, v_actor_name,
    jsonb_build_object('reason', btrim(p_reason), 'reversal_entry_id', v_reversal.id));
  select * into v_reversal from public.journal_entries where id = v_reversal.id;
  return v_reversal;
end;
$$;

revoke all on function public.void_accounting_entry(uuid, text) from public, anon;
grant execute on function public.void_accounting_entry(uuid, text) to authenticated;

-- Preview legacy rows before any accounting backfill. No financial values are
-- invented: non-USD records without a saved FX snapshot are explicitly blocked.
create or replace function public.accounting_backfill_preview()
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select jsonb_build_object(
    'invoiceCandidates', (select count(*) from public.shipments where invoice_finalized_at is not null and accounting_journal_entry_id is null),
    'invoiceBlockedMissingFx', (select count(*) from public.shipments where invoice_finalized_at is not null and accounting_journal_entry_id is null and ((invoice_currency = 'TZS' and usd_to_tzs_rate_used is null) or (invoice_currency = 'AED' and usd_to_aed_rate_used is null))),
    'paymentCandidates', (select count(*) from public.payment_records where accounting_journal_entry_id is null),
    'paymentBlockedMissingFx', (select count(*) from public.payment_records payment join public.shipments shipment on shipment.id = payment.shipment_id where payment.accounting_journal_entry_id is null and ((payment.currency = 'TZS' and shipment.usd_to_tzs_rate_used is null) or (payment.currency = 'AED' and shipment.usd_to_aed_rate_used is null))),
    'expenseCandidates', (select count(*) from public.expenses where accounting_journal_entry_id is null),
    'expenseBlockedMissingFx', (select count(*) from public.expenses expense where expense.accounting_journal_entry_id is null and expense.currency <> 'USD' and not exists (select 1 from public.exchange_rates rate where rate.rate_date <= expense.date::date))
  )
$$;

revoke all on function public.accounting_backfill_preview() from public, anon;
grant execute on function public.accounting_backfill_preview() to authenticated;

create or replace view public.accounting_trial_balance
with (security_invoker = true)
as
select
  account.id as account_id,
  account.code,
  account.name,
  account.account_type,
  coalesce(sum(case when entry.id is not null then line.debit else 0 end), 0)::numeric(18,2) as debit,
  coalesce(sum(case when entry.id is not null then line.credit else 0 end), 0)::numeric(18,2) as credit,
  (
    coalesce(sum(case when entry.id is not null then line.debit else 0 end), 0)
    - coalesce(sum(case when entry.id is not null then line.credit else 0 end), 0)
  )::numeric(18,2) as balance
from public.accounting_accounts as account
left join public.journal_lines as line on line.account_id = account.id
left join public.journal_entries as entry on entry.id = line.journal_entry_id and entry.status = 'POSTED'
where account.active
group by account.id, account.code, account.name, account.account_type;

alter table public.accounting_accounts enable row level security;
alter table public.journal_entries enable row level security;
alter table public.journal_lines enable row level security;
alter table public.other_income enable row level security;

grant select on public.accounting_accounts, public.journal_entries, public.journal_lines, public.other_income to authenticated;
grant select on public.accounting_trial_balance to authenticated;

drop policy if exists "financial roles read accounts" on public.accounting_accounts;
create policy "financial roles read accounts" on public.accounting_accounts for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));
drop policy if exists "admins manage accounts" on public.accounting_accounts;
create policy "admins manage accounts" on public.accounting_accounts for all to authenticated
  using ((select public.staff_role()) = 'Admin')
  with check ((select public.staff_role()) = 'Admin');

drop policy if exists "financial roles read journals" on public.journal_entries;
create policy "financial roles read journals" on public.journal_entries for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));
drop policy if exists "financial roles read journal lines" on public.journal_lines;
create policy "financial roles read journal lines" on public.journal_lines for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));
drop policy if exists "financial roles read other income" on public.other_income;
create policy "financial roles read other income" on public.other_income for select to authenticated
  using ((select public.staff_role()) in ('Admin','Manager'));

-- Active staff remains a restrictive gate; accounting role policies above
-- further narrow these tables to Manager/Admin.
do $$
declare
  protected_table text;
begin
  foreach protected_table in array array[
    'accounting_accounts', 'journal_entries', 'journal_lines', 'other_income'
  ] loop
    execute format('drop policy if exists "active staff access gate" on public.%I', protected_table);
    execute format(
      'create policy "active staff access gate" on public.%I as restrictive for all to authenticated using ((select public.is_active_staff())) with check ((select public.is_active_staff()))',
      protected_table
    );
  end loop;
end $$;

insert into public.business_audit_log (
  action, entity_type, entity_id, actor_name, details
)
values (
  'ACCOUNTING_SCHEMA_INSTALLED', 'system', 'double_entry_accounting', 'Migration',
  jsonb_build_object('reporting_currency', 'USD', 'backfill_applied', false)
);
