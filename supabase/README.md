# Hopex Express Cargo - new database setup

Preparation for a NEW, EMPTY Hopex Supabase project. No migrations were executed
remotely. Do not apply this setup to the source TCAST project or an existing Hopex
production project.

## 1. Project identity

Create the project under the business's chosen Supabase organization and region.
Record its project name, reference and URL before applying anything. Database
passwords and secret/service-role keys must stay outside browser files.

## 2. Schema

Apply EVERY file in migrations/ in ascending filename order, starting with
0001_shipments_and_auth.sql and ending with
20261003090000_hopex_company_branding.sql (22 files in this delivery).
The initial file alone is insufficient: later files define items, pricing,
staff management, inventory, journals, payments and financial RPCs.

The final Hopex migration adds company fields referenced by the supplied code,
optional staff-profile fields read by the client, and the default company row.
Contacts, bank details and tax identifiers remain blank. No business records or
Auth users are copied.

Legacy migration comments and rollout notes describe the source app's history;
they are not target-project instructions for this Hopex app.

## 3. Staff authentication functions

The application calls these functions, so Auth tables alone are insufficient:

- staff-login: username/email login and reset requests; accepts pre-session calls,
  then validates credentials itself.
- staff-admin: create/update/disable staff; validates the caller's session and
  Admin role before using server credentials.
- complete-password-change: completes required first-login password changes.

Deploy the code from functions/ to the NEW project and verify gateway/auth settings
for the chosen publishable key. Server credentials belong only in the functions
environment. Set STAFF_PORTAL_URL to the confirmed Hopex portal URL for password-reset
redirects, and configure matching Auth Site URL and allowed redirect URLs. No portal
domain is invented or inherited from TCAST.

The local config.toml specifies verify_jwt=false for pre-session staff-login,
and verify_jwt=true for staff-admin and complete-password-change. These two
handlers also verify the user token through Auth and enforce staff access checks.
See the official
[authorization-header guidance](https://supabase.com/docs/guides/functions/auth-headers).
Apply these gateway settings when deploying through a connector as well.
Disable public user signups in the remote project's Auth settings; the local
enable_signup=false setting does not configure a remote project by itself.

For manual dashboard setup, use manual-setup/ANZA_HAPA.md and the combined
01_HOPEX_DATABASE.sql, then deploy the 3 standalone function files in that folder.

## 4. First administrator

Create the first user through Supabase Authentication with the business's actual
email and chosen password. After the trigger creates staff_profiles, assign that
specific profile the Admin role through the dashboard. Do this before using Staff
Roles; ordinary staff cannot promote themselves. Subsequent staff use the app's
Admin-only Edge Function.

## 5. Browser configuration

Copy .env.example to .env.local inside THIS app folder and fill only:

    VITE_SUPABASE_URL=https://<NEW_HOPEX_PROJECT_REF>.supabase.co
    VITE_SUPABASE_PUBLISHABLE_KEY=<NEW_HOPEX_PUBLISHABLE_KEY>

Restart the server after changing configuration. Never use a secret/service_role
key as a VITE_ variable. The parent accountant agent has separate configuration
and was not connected to this database.

## 6. Validation before live use

1. Run read-only migration drift checks. Inspect the final Hopex migration and
   its ledger entry separately.
   Then run tests/hopex_readiness.sql for the new company identity, required
   columns, financial RPCs, RLS flags and private avatar bucket.
2. Verify unauthenticated clients cannot read protected business tables.
3. Verify staff login, active-user checks and required password change.
4. Save company settings with confirmed contacts and bank details.
5. Create a test customer and shipment; inspect Hopex invoice, receipt and sticker.
6. Verify invoice posting, payment recording, journals, balances and refresh.
7. Verify public tracking exposes only permitted fields.
8. Test Admin staff management and password reset delivery/redirect handling.

Run fixture SQL QA only on an isolated test database. SQL execution, financial
workflows, email delivery and production/device QA remain unverified until the new
project exists. Fix and test source-app gaps before accepting live business data.
