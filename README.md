# Hopex Express Cargo

Staff cargo and accounting app adapted from the supplied tcast-cargo-webapp-main.zip.
This folder is separate from the Hopex Accountant Agent in the parent workspace.

## Local preview

    pnpm install --frozen-lockfile
    npm run dev -- --host 127.0.0.1 --port 5173

The supplied pnpm lockfile remains the dependency source of truth. Some pnpm versions
report that the optional core-js build script was ignored; the app can build and test
without running that script.

    npm run typecheck
    npm test
    npm run build

## Branding

- Shared identity: src/config/brand.ts.
- Logo: existing Hopex Express Cargo asset from the user's Hopex project.
- Login, navigation, tracking, staff account text, PDFs, item stickers, favicon and
  installable app icons now use Hopex branding.
- Tracking: HOPEX-YYMMDD-XXXX; packing lists: PL-HOPEX-YYMMDD-XXX.
  Existing receipt numbering and accounting rules are retained.
- Contacts, tax details, bank details and document terms are blank until confirmed.
  Enter them in Settings after database setup.
- Authentication and navigation use a separate Hopex browser-storage namespace.
- src/data.ts is unused sample data, not live company records.

## New database

Follow supabase/README.md for the new, empty Hopex Supabase project. No existing
TCAST or Hopex database has been changed or connected. The new migration adds missing
company fields and seeds only the Hopex company-settings row, without business data.

Login, authenticated operations, deployed Edge Functions and migrations must be
verified against the new project after creation. The accountant agent's schema is
separate and has not been merged into this cargo schema.

See REBRANDING_REPORT.md for verification and remaining setup. No production deployment
was performed.
