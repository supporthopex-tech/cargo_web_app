-- ===========================================================================
-- TCAST Cargo — migration drift check (READ ONLY)
-- ===========================================================================
-- Returns one row per migration in supabase/migrations, saying whether this
-- database actually has it. Each check probes for an object that only exists
-- once that migration has run, so it reports what is true rather than what was
-- intended. Writes nothing.
--
-- Run it in Supabase Dashboard -> SQL Editor. Read the result top to bottom:
-- every row up to the last APPLIED should be APPLIED, with no MISSING in
-- between. A MISSING row followed by an APPLIED row means migrations were run
-- out of order and the schema needs attention before anything else is applied.
--
-- Once 20260912085000_migration_ledger.sql has been applied, also run
-- drift-check-ledger.sql to compare this against what the ledger records.
-- ===========================================================================

select
  version,
  case when applied then 'APPLIED' else 'MISSING' end as state,
  name
from (values
  ('0001',           to_regclass('public.shipments') is not null, 'shipments_and_auth'),
  ('20260808172013', to_regclass('public.shipping_rates') is not null, 'shipping_rates_fx_and_invoice_snapshots'),
  ('20260808173840', exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'shipment_items' and policyname = 'staff full access'), 'harden_shipment_item_policy'),
  ('20260809145324', to_regclass('public.packing_boxes') is not null, 'item_qr_packing_allocations'),
  ('20260811093520', to_regclass('public.staff_management_audit') is not null, 'staff_management_and_active_access'),
  ('20260811153000', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'handle_new_auth_user' and p.prosrc like '%username%'), 'fix_staff_auth_trigger_username'),
  ('20260815013914', to_regclass('public.shipment_status_history') is not null, 'shipment_status_lifecycle'),
  ('20260815013917', to_regclass('public.accounting_accounts') is not null, 'double_entry_accounting'),
  ('20260816112517', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'company_settings' and column_name = 'bank_account_name'), 'add_bank_account_name'),
  ('20260817182455', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'close_packing_list'), 'close_packing_list'),
  ('20260817184710', to_regclass('public.item_returns') is not null, 'storage_inventory'),
  ('20260817190000', exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'staff_profiles' and column_name = 'avatar_path'), 'staff_profile_pictures'),
  ('20260817193000', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'archive_customer'), 'controlled_deletion_archive'),
  ('20260817200000', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'void_shipment'), 'stage5_integration_review'),
  ('20260819120000', to_regclass('public.payment_refunds') is not null, 'shipment_delete_and_payment_refund'),
  ('20260819130000', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'dispatch_packing_list_with_status'), 'partial_packing_dispatch'),
  ('20260911090000', to_regclass('public.cargo_extra_charges') is not null, 'cargo_extra_charges'),
  ('20260911091000', to_regclass('public.payment_receipt_counters') is not null, 'atomic_payment_recording'),
  ('20260911092000', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'transition_shipment_status_confirmed'), 'status_transition_confirmation'),
  ('20260912085000', to_regclass('supabase_migrations.schema_migrations') is not null, 'migration_ledger'),
  ('20260912090000', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'repost_invoice_accounting'), 'invoice_repair_discount_and_expense_idempotency')
) as t(version, applied, name)
order by version;
