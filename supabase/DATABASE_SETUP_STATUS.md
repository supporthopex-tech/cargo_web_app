# Hopex Express Cargo — database setup status

Date: 2026-10-03 (Asia/Dubai).

## Prepared locally

- 22 migrations, in filename order; source fingerprints are in setup-manifest.json.
- 3 staff Edge Function entrypoints configured in config.toml.
- Self-service signup disabled in local Auth configuration.
- Read-only post-setup checks in tests/hopex_readiness.sql.
- Configuration syntax and all 3 entrypoint paths verified locally.
- Required RPC names cross-checked against app callers and migration source.

## Remote status

The user chose manual setup in their own Supabase account. The dashboard-ready SQL,
first-Admin query, verification queries and standalone function code are in
manual-setup/. Follow manual-setup/ANZA_HAPA.md. No plugin connection is required
for the user to apply this package manually.

No organization, region or remote project has been selected. No database has been
created, linked or changed, and no SQL or function deployment has run remotely.
The first Admin's business email is still required. Do not send passwords in chat.

The combined SQL has passed a local PostgreSQL syntax parse. All 22 source
migration fingerprints match the setup manifest. This is static validation only;
remote SQL execution and business workflow verification remain outstanding.

## After connection

1. List the authenticated account's organizations and existing projects.
2. Resolve the intended organization/region and any creation cost shown by Supabase.
3. Create a separate Hopex Express Cargo project and record its actual reference.
4. Apply migrations to that confirmed new project and run schema/RLS checks.
5. Deploy the 3 functions with handler-based authentication settings.
6. Configure remote Auth signup settings and confirmed reset redirect URL.
7. Configure only the new project URL and publishable key in this app.
8. Create the first Admin through Auth, assign its role, and verify real workflows.

The parent accountant agent remains separate. Existing TCAST and Hopex projects
are not migration targets for this setup.
