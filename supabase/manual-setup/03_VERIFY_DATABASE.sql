-- READ ONLY: run after ALL migrations on the confirmed new Hopex project.
-- This reports schema readiness; it does not replace authenticated workflow QA.

select id, company_name, short_name, tracking_prefix, packing_list_prefix
from public.company_settings
where id = 'default';

select version, name
from supabase_migrations.schema_migrations
where version = '20261003090000';

with required_columns(table_name, column_name) as (values
  ('company_settings', 'short_name'),
  ('company_settings', 'logo_path'),
  ('company_settings', 'tracking_prefix'),
  ('company_settings', 'packing_list_prefix'),
  ('company_settings', 'invoice_footer'),
  ('company_settings', 'receipt_footer'),
  ('company_settings', 'bank_account_name'),
  ('staff_profiles', 'username'),
  ('staff_profiles', 'active'),
  ('staff_profiles', 'must_change_password'),
  ('staff_profiles', 'permissions_mode'),
  ('staff_profiles', 'permissions')
)
select required_columns.*,
  exists (
    select 1 from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = required_columns.table_name
      and c.column_name = required_columns.column_name
  ) as present
from required_columns;

with required_functions(function_name) as (values
  ('track_shipment'), ('record_payment'), ('record_expense'),
  ('post_invoice_accounting'), ('transition_shipment_status_confirmed'),
  ('void_accounting_entry')
)
select function_name,
  exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = function_name
  ) as present
from required_functions;

select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;

select name as avatar_bucket, public as publicly_accessible
from storage.buckets
where id = 'staff-profile-images';
