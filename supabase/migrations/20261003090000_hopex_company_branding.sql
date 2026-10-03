-- Hopex: add the company fields already used by the imported app.
-- Intended for the NEW, empty Hopex project after all earlier migrations.
begin;

-- The imported staff-profile reader includes these optional fields.
-- Existing server access continues to use staff roles and RLS.
alter table public.staff_profiles
  add column if not exists permissions_mode text not null default 'ROLE_DEFAULT',
  add column if not exists permissions text[] not null default '{}';

alter table public.company_settings
  add column if not exists short_name text not null default '',
  add column if not exists logo_path text not null default '',
  add column if not exists whatsapp text not null default '',
  add column if not exists dubai_address text not null default '',
  add column if not exists dubai_phone text not null default '',
  add column if not exists dubai_email text not null default '',
  add column if not exists tanzania_address text not null default '',
  add column if not exists tanzania_phone text not null default '',
  add column if not exists tanzania_email text not null default '',
  add column if not exists registration_number text not null default '',
  add column if not exists iban text not null default '',
  add column if not exists payment_instructions text not null default '',
  add column if not exists invoice_footer text not null default '',
  add column if not exists receipt_footer text not null default '',
  add column if not exists quote_footer text not null default '',
  add column if not exists packing_list_footer text not null default '',
  add column if not exists powered_by_text text not null default '',
  add column if not exists tracking_prefix text not null default 'HOPEX',
  add column if not exists packing_list_prefix text not null default 'PL-HOPEX',
  add column if not exists primary_color text not null default '#0c1c35',
  add column if not exists secondary_color text not null default '#0a84d3',
  add column if not exists accent_color text not null default '#2f80ed';

-- No contacts, bank details, staff or customer records are invented or copied.
insert into public.company_settings (
  id, company_name, short_name, business_type, default_currency,
  default_origin, default_destination_country, supported_destination_cities
) values (
  'default', 'Hopex Express Cargo', 'HOPEX CARGO',
  'International Cargo & Freight Forwarding', 'TZS', 'Dubai, UAE', 'Tanzania',
  array['Dar es Salaam','Zanzibar','Arusha','Dodoma','Mwanza','Mbeya',
        'Morogoro','Tanga','Kigoma','Tabora','Mtwara','Iringa','Moshi','Songea','Other']
)
on conflict (id) do nothing;

insert into supabase_migrations.schema_migrations (version, name)
values ('20261003090000', 'hopex_company_branding')
on conflict (version) do nothing;

commit;
