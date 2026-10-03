-- Add the bank account holder name so invoices can show "Account Name"
-- alongside the existing Bank Name / Bank Account / Bank SWIFT fields.
-- Additive only: existing rows default to '' and keep working unchanged.

alter table public.company_settings
  add column if not exists bank_account_name text not null default '';
