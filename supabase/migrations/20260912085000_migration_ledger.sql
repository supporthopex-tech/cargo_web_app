-- A ledger of which migrations this database has actually had applied.
--
-- Until now nothing recorded that, because migrations are pasted into the SQL
-- Editor by hand. The result was silent drift: the 20260911* release was live
-- in Production while its pull request was still a draft, and nothing in the
-- database or the repository could tell you so.
--
-- This creates the same table the Supabase CLI uses
-- (supabase_migrations.schema_migrations), so `supabase db push` will later
-- skip anything already recorded here, and backfills it by DETECTING what is
-- present rather than assuming. Every migration from here on ends with one
-- insert into this table -- see supabase/README.md.
--
-- Safe to run more than once. It creates nothing else and changes no data.

set lock_timeout = '5s';
set statement_timeout = '60s';

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text,
  applied_at timestamptz not null default now()
);

-- Nothing outside the dashboard/service role has any business reading this.
alter table supabase_migrations.schema_migrations enable row level security;
revoke all on table supabase_migrations.schema_migrations from public, anon, authenticated;

comment on table supabase_migrations.schema_migrations is
  'One row per applied migration, keyed by the filename timestamp. Every migration in supabase/migrations must record itself here as its last statement.';

-- Backfill from evidence. Each entry names a sentinel object that only exists
-- once that migration has run, so a database that skipped one is not marked as
-- having it.
do $$
declare
  v_migration record;
  v_present boolean;
begin
  for v_migration in
    select * from (values
      ('0001',           'shipments_and_auth',                      $q$select to_regclass('public.shipments') is not null$q$),
      ('20260808172013', 'shipping_rates_fx_and_invoice_snapshots', $q$select to_regclass('public.shipping_rates') is not null$q$),
      ('20260808173840', 'harden_shipment_item_policy',             $q$select exists (select 1 from pg_policies where schemaname='public' and tablename='shipment_items' and policyname='staff full access')$q$),
      ('20260809145324', 'item_qr_packing_allocations',             $q$select to_regclass('public.packing_boxes') is not null$q$),
      ('20260811093520', 'staff_management_and_active_access',      $q$select to_regclass('public.staff_management_audit') is not null$q$),
      ('20260811153000', 'fix_staff_auth_trigger_username',         $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='handle_new_auth_user' and p.prosrc like '%username%')$q$),
      ('20260815013914', 'shipment_status_lifecycle',               $q$select to_regclass('public.shipment_status_history') is not null$q$),
      ('20260815013917', 'double_entry_accounting',                 $q$select to_regclass('public.accounting_accounts') is not null$q$),
      ('20260816112517', 'add_bank_account_name',                   $q$select exists (select 1 from information_schema.columns where table_schema='public' and table_name='company_settings' and column_name='bank_account_name')$q$),
      ('20260817182455', 'close_packing_list',                      $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='close_packing_list')$q$),
      ('20260817184710', 'storage_inventory',                       $q$select to_regclass('public.item_returns') is not null$q$),
      ('20260817190000', 'staff_profile_pictures',                  $q$select exists (select 1 from information_schema.columns where table_schema='public' and table_name='staff_profiles' and column_name='avatar_path')$q$),
      ('20260817193000', 'controlled_deletion_archive',             $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='archive_customer')$q$),
      ('20260817200000', 'stage5_integration_review',               $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='void_shipment')$q$),
      ('20260819120000', 'shipment_delete_and_payment_refund',      $q$select to_regclass('public.payment_refunds') is not null$q$),
      ('20260819130000', 'partial_packing_dispatch',                $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='dispatch_packing_list_with_status')$q$),
      ('20260911090000', 'cargo_extra_charges',                     $q$select to_regclass('public.cargo_extra_charges') is not null$q$),
      ('20260911091000', 'atomic_payment_recording',                $q$select to_regclass('public.payment_receipt_counters') is not null$q$),
      ('20260911092000', 'status_transition_confirmation',          $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='transition_shipment_status_confirmed')$q$),
      ('20260912090000', 'invoice_repair_discount_and_expense_idempotency', $q$select exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='repost_invoice_accounting')$q$)
    ) as t(version, name, probe)
  loop
    execute v_migration.probe into v_present;
    if v_present then
      insert into supabase_migrations.schema_migrations (version, name)
      values (v_migration.version, v_migration.name)
      on conflict (version) do nothing;
    end if;
  end loop;
end;
$$;

insert into supabase_migrations.schema_migrations (version, name)
values ('20260912085000', 'migration_ledger')
on conflict (version) do nothing;
