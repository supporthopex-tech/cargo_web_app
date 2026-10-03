-- Normalized cargo extra charges with audited, double-entry posting.
-- Additive and idempotent: no existing shipment, payment, expense or journal
-- rows are deleted or rewritten by this migration.

set lock_timeout = '5s';
set statement_timeout = '60s';

create table if not exists public.cargo_extra_charges (
  id uuid primary key default gen_random_uuid(),
  shipment_id text references public.shipments (id) on delete set null,
  shipment_id_snapshot text,
  shipment_tracking_snapshot text,
  charge_type text not null check (charge_type in (
    'export_packing', 'pickup', 'forklift', 'warehouse',
    'dg_packing', 'supplier_payment', 'other'
  )),
  custom_label text,
  charge_direction text not null check (charge_direction in (
    'billable_to_customer', 'company_expense'
  )),
  amount numeric(18,2) not null check (amount > 0),
  currency text not null default 'TZS' check (currency in ('TZS','USD','AED')),
  charge_date date not null default current_date,
  note text,
  payment_method text,
  status text not null default 'ACTIVE' check (status in ('ACTIVE','DELETED')),
  idempotency_key uuid,
  exchange_rate numeric(18,6),
  reporting_amount numeric(18,2),
  accounting_journal_entry_id uuid references public.journal_entries (id) on delete restrict,
  created_by uuid references public.staff_profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_by uuid references public.staff_profiles (id) on delete set null,
  deleted_at timestamptz,
  deletion_reason text,
  constraint cargo_extra_charges_custom_label_check check (
    charge_type <> 'other' or nullif(btrim(custom_label), '') is not null
  ),
  constraint cargo_extra_charges_supplier_direction_check check (
    charge_type <> 'supplier_payment' or charge_direction = 'company_expense'
  ),
  constraint cargo_extra_charges_payment_method_check check (
    payment_method is null or nullif(btrim(payment_method), '') is not null
  )
);

-- A deleted/reversed charge is retained for audit even if an otherwise-empty
-- shipment is later hard-deleted. Active charges block that deletion; the
-- trigger below snapshots identity before this SET NULL relationship fires.
alter table public.cargo_extra_charges
  add column if not exists shipment_id_snapshot text,
  add column if not exists shipment_tracking_snapshot text,
  alter column shipment_id drop not null;
alter table public.cargo_extra_charges
  drop constraint if exists cargo_extra_charges_shipment_id_fkey;
alter table public.cargo_extra_charges
  add constraint cargo_extra_charges_shipment_id_fkey
  foreign key (shipment_id) references public.shipments (id) on delete set null;

create unique index if not exists cargo_extra_charges_idempotency_idx
  on public.cargo_extra_charges (idempotency_key)
  where idempotency_key is not null;
create index if not exists cargo_extra_charges_shipment_status_idx
  on public.cargo_extra_charges (shipment_id, status, charge_date, created_at);
create index if not exists cargo_extra_charges_direction_date_idx
  on public.cargo_extra_charges (charge_direction, charge_date, id);
create index if not exists cargo_extra_charges_accounting_entry_idx
  on public.cargo_extra_charges (accounting_journal_entry_id);

alter table public.cargo_extra_charges enable row level security;
revoke all on table public.cargo_extra_charges from anon, authenticated;
grant select on table public.cargo_extra_charges to authenticated;

drop policy if exists "active staff can read cargo extra charges" on public.cargo_extra_charges;
drop policy if exists "active staff can read authorized cargo extra charges" on public.cargo_extra_charges;
create policy "active staff can read authorized cargo extra charges"
  on public.cargo_extra_charges for select to authenticated
  using (
    (select public.is_active_staff())
    and (
      charge_direction = 'billable_to_customer'
      or (select public.staff_role()) in ('Admin','Manager')
    )
  );

create or replace function public.guard_and_snapshot_cargo_charges_on_shipment_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.cargo_extra_charges as charge
    where charge.shipment_id = old.id and charge.status = 'ACTIVE'
  ) then
    raise exception 'This shipment has active cargo charges and cannot be deleted. Delete the charges or void the shipment instead.';
  end if;
  update public.cargo_extra_charges
  set shipment_id_snapshot = old.id,
      shipment_tracking_snapshot = old.tracking_number,
      updated_at = now()
  where shipment_id = old.id;
  return old;
end;
$$;

revoke all on function public.guard_and_snapshot_cargo_charges_on_shipment_delete() from public, anon, authenticated;
drop trigger if exists trg_guard_snapshot_cargo_charges_on_shipment_delete on public.shipments;
create trigger trg_guard_snapshot_cargo_charges_on_shipment_delete
  before delete on public.shipments
  for each row execute function public.guard_and_snapshot_cargo_charges_on_shipment_delete();

-- Internal helper. Only the three guarded CRUD RPCs below may invoke it.
create or replace function public.post_cargo_extra_charge_accounting(
  p_charge_id uuid
)
returns public.journal_entries
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_charge public.cargo_extra_charges%rowtype;
  v_shipment public.shipments%rowtype;
  v_debit_account uuid;
  v_credit_account uuid;
  v_exchange_rate numeric(18,6);
  v_base_amount numeric(18,2);
  v_debit_code text;
  v_credit_code text;
  v_entry public.journal_entries%rowtype;
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor
    and profile.active
    and not profile.must_change_password;

  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;

  select * into v_charge
  from public.cargo_extra_charges
  where id = p_charge_id
  for update;
  if v_charge.id is null or v_charge.status <> 'ACTIVE' then
    raise exception 'Cargo charge not found.';
  end if;

  if v_charge.accounting_journal_entry_id is not null then
    select * into v_entry
    from public.journal_entries
    where id = v_charge.accounting_journal_entry_id and status = 'POSTED';
    if v_entry.id is not null then return v_entry; end if;
  end if;

  select * into v_shipment
  from public.shipments
  where id = v_charge.shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if v_charge.currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Charge currency must match the shipment invoice currency.';
  end if;

  v_exchange_rate := case v_charge.currency
    when 'USD' then 1
    when 'TZS' then v_shipment.usd_to_tzs_rate_used
    when 'AED' then v_shipment.usd_to_aed_rate_used
  end;
  if v_exchange_rate is null or v_exchange_rate <= 0 then
    raise exception 'The shipment needs a valid invoice exchange-rate snapshot before this charge can be posted.';
  end if;
  v_base_amount := public.accounting_reporting_amount(v_charge.currency, v_charge.amount, v_exchange_rate);

  if v_charge.charge_direction = 'billable_to_customer' then
    v_debit_code := '1100';
    v_credit_code := case v_shipment.shipment_type when 'Air Cargo' then '4000' when 'Sea Cargo' then '4010' else '4030' end;
  else
    v_debit_code := case v_charge.charge_type
      when 'export_packing' then '5040'
      when 'dg_packing' then '5040'
      when 'pickup' then '5020'
      when 'forklift' then '5020'
      when 'warehouse' then '5190'
      else '5200'
    end;
    v_credit_code := case when v_charge.payment_method = 'Cash' then '1000' else '1010' end;
  end if;

  select id into v_debit_account from public.accounting_accounts where code = v_debit_code and active;
  select id into v_credit_account from public.accounting_accounts where code = v_credit_code and active;
  if v_debit_account is null or v_credit_account is null then
    raise exception 'Required accounting accounts are not configured.';
  end if;

  insert into public.journal_entries (
    entry_number, entry_date, description, reference_type, reference_id,
    currency, exchange_rate, original_amount, base_amount, created_by
  ) values (
    'TJE-' || to_char(current_date, 'YYYY') || '-' || lpad(nextval('public.journal_entry_number_seq')::text, 6, '0'),
    v_charge.charge_date,
    case when v_charge.charge_direction = 'billable_to_customer'
      then 'Billable cargo charge'
      else 'Cargo company expense'
    end || ': ' || coalesce(nullif(btrim(v_charge.custom_label), ''), replace(initcap(v_charge.charge_type), '_', ' ')),
    'EXTRA_CHARGE', v_charge.id::text, v_charge.currency, v_exchange_rate,
    v_charge.amount, v_base_amount, v_actor
  ) returning * into v_entry;

  insert into public.journal_lines
    (journal_entry_id, account_id, description, debit, credit, original_debit, original_credit)
  values
    (v_entry.id, v_debit_account, 'Cargo extra charge debit', v_base_amount, 0, v_charge.amount, 0),
    (v_entry.id, v_credit_account, 'Cargo extra charge credit', 0, v_base_amount, 0, v_charge.amount);

  update public.journal_entries
  set status = 'POSTED', posted_by = v_actor
  where id = v_entry.id
  returning * into v_entry;

  update public.cargo_extra_charges
  set exchange_rate = v_exchange_rate,
      reporting_amount = v_base_amount,
      accounting_journal_entry_id = v_entry.id,
      updated_by = v_actor,
      updated_at = now()
  where id = v_charge.id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_POSTED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object(
      'shipment_id', v_charge.shipment_id,
      'direction', v_charge.charge_direction,
      'amount', v_charge.amount,
      'currency', v_charge.currency,
      'journal_entry_id', v_entry.id
    )
  );

  return v_entry;
end;
$$;

revoke all on function public.post_cargo_extra_charge_accounting(uuid) from public, anon, authenticated;

create or replace function public.create_cargo_extra_charge(
  p_shipment_id text,
  p_charge_type text,
  p_custom_label text,
  p_charge_direction text,
  p_amount numeric,
  p_currency text,
  p_charge_date date,
  p_note text,
  p_payment_method text,
  p_idempotency_key uuid
)
returns public.cargo_extra_charges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_shipment public.shipments%rowtype;
  v_charge public.cargo_extra_charges%rowtype;
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;
  if p_idempotency_key is null then raise exception 'An idempotency key is required.'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_idempotency_key::text, 0));
  select charge.* into v_charge
  from public.cargo_extra_charges as charge
  where charge.idempotency_key = p_idempotency_key;
  if v_charge.id is not null then return v_charge; end if;

  if p_charge_type not in ('export_packing','pickup','forklift','warehouse','dg_packing','supplier_payment','other') then
    raise exception 'Unsupported cargo charge type.';
  end if;
  if p_charge_direction not in ('billable_to_customer','company_expense') then
    raise exception 'Unsupported cargo charge direction.';
  end if;
  if p_charge_type = 'supplier_payment' and p_charge_direction <> 'company_expense' then
    raise exception 'Supplier Payment must be a company expense.';
  end if;
  if p_charge_type = 'other' and nullif(btrim(p_custom_label), '') is null then
    raise exception 'A custom label is required for Other cargo charges.';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Charge amount must be greater than zero.'; end if;
  if p_charge_date is null then raise exception 'Charge date is required.'; end if;

  select * into v_shipment from public.shipments where id = p_shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;
  if v_shipment.voided_at is not null then raise exception 'Cargo charges cannot be added to a voided shipment.'; end if;
  if p_currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Charge currency must match the shipment invoice currency.';
  end if;

  insert into public.cargo_extra_charges (
    shipment_id, charge_type, custom_label, charge_direction, amount,
    currency, charge_date, note, payment_method, idempotency_key, created_by, updated_by
  ) values (
    p_shipment_id, p_charge_type, nullif(btrim(p_custom_label), ''), p_charge_direction, p_amount,
    p_currency, p_charge_date, nullif(btrim(p_note), ''),
    case when p_charge_direction = 'company_expense' then coalesce(nullif(btrim(p_payment_method), ''), 'Bank Transfer') else null end,
    p_idempotency_key, v_actor, v_actor
  ) returning * into v_charge;

  perform public.post_cargo_extra_charge_accounting(v_charge.id);
  select charge.* into v_charge
  from public.cargo_extra_charges as charge
  where charge.id = v_charge.id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_CREATED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object('shipment_id', p_shipment_id, 'direction', p_charge_direction)
  );
  return v_charge;
end;
$$;

create or replace function public.update_cargo_extra_charge(
  p_charge_id uuid,
  p_charge_type text,
  p_custom_label text,
  p_charge_direction text,
  p_amount numeric,
  p_currency text,
  p_charge_date date,
  p_note text,
  p_payment_method text,
  p_reason text
)
returns public.cargo_extra_charges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_charge public.cargo_extra_charges%rowtype;
  v_shipment public.shipments%rowtype;
  v_amount_paid numeric(18,2);
  v_other_billable numeric(18,2);
  v_total_due numeric(18,2);
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'An edit reason is required.'; end if;

  select * into v_charge from public.cargo_extra_charges where id = p_charge_id for update;
  if v_charge.id is null or v_charge.status <> 'ACTIVE' then raise exception 'Cargo charge not found.'; end if;
  select * into v_shipment from public.shipments where id = v_charge.shipment_id for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if p_charge_type not in ('export_packing','pickup','forklift','warehouse','dg_packing','supplier_payment','other') then
    raise exception 'Unsupported cargo charge type.';
  end if;
  if p_charge_direction not in ('billable_to_customer','company_expense') then
    raise exception 'Unsupported cargo charge direction.';
  end if;
  if p_charge_type = 'supplier_payment' and p_charge_direction <> 'company_expense' then
    raise exception 'Supplier Payment must be a company expense.';
  end if;
  if p_charge_type = 'other' and nullif(btrim(p_custom_label), '') is null then
    raise exception 'A custom label is required for Other cargo charges.';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Charge amount must be greater than zero.'; end if;
  if p_charge_date is null then raise exception 'Charge date is required.'; end if;
  if p_currency is distinct from coalesce(v_shipment.invoice_currency, v_shipment.currency) then
    raise exception 'Charge currency must match the shipment invoice currency.';
  end if;

  -- An edit may reduce the customer-facing balance (for example by converting
  -- a billable charge into a company expense). Never permit that change to
  -- make already-posted receipts exceed the newly calculated Total Due.
  select coalesce(sum(payment.amount), 0) into v_amount_paid
  from public.payment_records as payment
  where payment.shipment_id = v_charge.shipment_id and payment.status = 'POSTED';
  select coalesce(sum(other_charge.amount), 0) into v_other_billable
  from public.cargo_extra_charges as other_charge
  where other_charge.shipment_id = v_charge.shipment_id
    and other_charge.id <> v_charge.id
    and other_charge.status = 'ACTIVE'
    and other_charge.charge_direction = 'billable_to_customer';
  v_total_due := coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0)
    + v_other_billable
    + case when p_charge_direction = 'billable_to_customer' then p_amount else 0 end;
  if v_amount_paid > v_total_due + 0.01 then
    raise exception 'This charge change would make posted payments exceed the shipment total due.';
  end if;

  if v_charge.accounting_journal_entry_id is not null and exists (
    select 1 from public.journal_entries where id = v_charge.accounting_journal_entry_id and status = 'POSTED'
  ) then
    perform public.void_accounting_entry(v_charge.accounting_journal_entry_id, btrim(p_reason));
  end if;

  update public.cargo_extra_charges
  set charge_type = p_charge_type,
      custom_label = nullif(btrim(p_custom_label), ''),
      charge_direction = p_charge_direction,
      amount = p_amount,
      currency = p_currency,
      charge_date = p_charge_date,
      note = nullif(btrim(p_note), ''),
      payment_method = case when p_charge_direction = 'company_expense'
        then coalesce(nullif(btrim(p_payment_method), ''), 'Bank Transfer') else null end,
      exchange_rate = null,
      reporting_amount = null,
      accounting_journal_entry_id = null,
      updated_by = v_actor,
      updated_at = now()
  where id = p_charge_id
  returning * into v_charge;

  perform public.post_cargo_extra_charge_accounting(v_charge.id);
  select charge.* into v_charge
  from public.cargo_extra_charges as charge
  where charge.id = p_charge_id;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_UPDATED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object('shipment_id', v_charge.shipment_id, 'reason', btrim(p_reason))
  );
  return v_charge;
end;
$$;

create or replace function public.delete_cargo_extra_charge(
  p_charge_id uuid,
  p_reason text
)
returns public.cargo_extra_charges
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := (select auth.uid());
  v_actor_name text;
  v_actor_role text;
  v_charge public.cargo_extra_charges%rowtype;
  v_shipment public.shipments%rowtype;
  v_amount_paid numeric(18,2);
  v_other_billable numeric(18,2);
begin
  select profile.name, profile.role
  into v_actor_name, v_actor_role
  from public.staff_profiles as profile
  where profile.id = v_actor and profile.active and not profile.must_change_password;
  if v_actor_role not in ('Admin','Manager') then
    raise exception 'Changing cargo charges requires Manager or Admin access.';
  end if;
  if nullif(btrim(p_reason), '') is null then raise exception 'A deletion reason is required.'; end if;

  select * into v_charge from public.cargo_extra_charges where id = p_charge_id for update;
  if v_charge.id is null or v_charge.status <> 'ACTIVE' then raise exception 'Cargo charge not found.'; end if;

  select shipment.* into v_shipment
  from public.shipments as shipment
  where shipment.id = v_charge.shipment_id
  for update;
  if v_shipment.id is null then raise exception 'Shipment not found.'; end if;

  if v_charge.charge_direction = 'billable_to_customer' then
    select coalesce(sum(payment.amount), 0) into v_amount_paid
    from public.payment_records as payment
    where payment.shipment_id = v_charge.shipment_id and payment.status = 'POSTED';
    select coalesce(sum(other_charge.amount), 0) into v_other_billable
    from public.cargo_extra_charges as other_charge
    where other_charge.shipment_id = v_charge.shipment_id
      and other_charge.id <> v_charge.id
      and other_charge.status = 'ACTIVE'
      and other_charge.charge_direction = 'billable_to_customer';
    if v_amount_paid > coalesce(v_shipment.invoice_amount, v_shipment.total_amount, 0) + v_other_billable + 0.01 then
      raise exception 'This charge cannot be deleted because posted payments would exceed the shipment total due.';
    end if;
  end if;

  if v_charge.accounting_journal_entry_id is not null and exists (
    select 1 from public.journal_entries where id = v_charge.accounting_journal_entry_id and status = 'POSTED'
  ) then
    perform public.void_accounting_entry(v_charge.accounting_journal_entry_id, btrim(p_reason));
  end if;

  update public.cargo_extra_charges
  set status = 'DELETED', deleted_by = v_actor, deleted_at = now(),
      deletion_reason = btrim(p_reason), updated_by = v_actor, updated_at = now()
  where id = p_charge_id
  returning * into v_charge;

  insert into public.business_audit_log
    (action, entity_type, entity_id, actor_id, actor_name, details)
  values (
    'CARGO_EXTRA_CHARGE_DELETED', 'cargo_extra_charge', v_charge.id::text,
    v_actor, v_actor_name,
    jsonb_build_object('shipment_id', v_charge.shipment_id, 'reason', btrim(p_reason))
  );
  return v_charge;
end;
$$;

revoke all on function public.create_cargo_extra_charge(text, text, text, text, numeric, text, date, text, text, uuid) from public, anon;
revoke all on function public.update_cargo_extra_charge(uuid, text, text, text, numeric, text, date, text, text, text) from public, anon;
revoke all on function public.delete_cargo_extra_charge(uuid, text) from public, anon;
grant execute on function public.create_cargo_extra_charge(text, text, text, text, numeric, text, date, text, text, uuid) to authenticated;
grant execute on function public.update_cargo_extra_charge(uuid, text, text, text, numeric, text, date, text, text, text) to authenticated;
grant execute on function public.delete_cargo_extra_charge(uuid, text) to authenticated;
