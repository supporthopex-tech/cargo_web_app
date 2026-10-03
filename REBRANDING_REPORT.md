# Hopex Express Cargo — taarifa ya mabadiliko

## Mahali pa app

Cargo app ipo kwenye folder `hopex-cargo-webapp/` ndani ya workspace ya
`Ai accouuntant`. App ya AI accountant iliyopo kwenye parent folder haijabadilishwa.
ZIP ya asili kwenye Downloads imehifadhiwa.

## Kilichobadilishwa

- Jina: **Hopex Express Cargo**, pamoja na logo iliyopo kwenye project ya Hopex.
- Login, modal headings, tracking, item identity na staff-account messages.
- Invoice/receipt PDF logo fallback na logo za item stickers.
- Browser title, favicon, manifest, icons na service-worker cache ya Hopex.
- Rangi za branding: navy, blue na white; accents za zamani za orange zimebadilishwa.
- Tracking prefix `HOPEX`; packing-list prefix `PL-HOPEX`, zikitumia settings.
- Browser authentication/navigation storage imetenganishwa kwa namespace ya Hopex.
- Faili za branding zilizokosekana kwenye ZIP zimeongezwa.
- Type interfaces zisizolingana na code iliyopo zimepangwa; password fields za
  staff zimeainishwa, role ya zamani kwenye database imetambuliwa, na fixtures
  za lifecycle zinatumia jina la role lililopo kwenye model.
- Password-reset redirect ya TCAST imeondolewa; function inatumia STAFF_PORTAL_URL.
- Nyaraka za setup zimeandikwa kwa database mpya ya Hopex.

Contacts, address, bank details na tax information bado ziko wazi mpaka zithibitishwe.
Sample data kwenye src/data.ts haitumiki kwenye app wala haijaingizwa database.

## Database

Kuna migrations 22: schema 21 kutoka ZIP na migration mpya ya Hopex yenye missing
company fields, optional staff-profile fields, na company-settings row ya Hopex.
Schema ya accountant agent haijaunganishwa na cargo schema.

Hakuna database mpya iliyoundwa au migration iliyoendeshwa remotely. Hakuna data
ya TCAST iliyohamishwa. Configuration ya browser bado ni blank.
Hatua zinazofuata zipo kwenye `supabase/README.md`.

## Uhakiki uliopita

- Typecheck: PASS.
- Logic tests: **62/62 PASS**.
- Production build: PASS; kuna warning ya bundle size iliyorithiwa.
- Browser login: 320, 375, 768 na 1440px; logo imeonekana, hakuna horizontal overflow.
- Public tracking layout: 320px; layout pekee, hakuna live shipment iliyothibitishwa.
- Dashboard: synthetic Admin state kwa 375/1440px; hakuna real login/database.
- Item sticker markup: Hopex name/logo na tracking reference zimethibitishwa.
- Browser page errors: 0 katika probes hizi.
- Hakuna active TCAST text au project URL kwenye runtime source/config iliyokaguliwa.

Screenshots zipo kwenye `screenshots/`. Synthetic dashboard screenshots ni QA tu.

## Bado haijathibitishwa

SQL execution, Edge Function deployment, real authentication, payments, invoice
posting, staff-management writes na password-reset delivery zinahitaji new project.
PDF rendering/printing na installable-app/device QA zinahitaji ukaguzi wa mwisho.

Source ZIP ina maeneo ya kukagua kabla ya live accounting: expense store bado
hutumia insert/post hatua mbili badala ya RPC ya record_expense iliyopo kwenye SQL;
staff UI pia ina legacy Operations Staff label wakati client model hutumia Staff.
Mabadiliko haya hayajafanya redesign ya financial au permission workflows.

Hakuna production deployment au commit iliyofanywa.
