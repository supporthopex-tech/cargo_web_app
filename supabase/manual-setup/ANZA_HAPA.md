# Hopex Express Cargo — setup mwenyewe kwenye Supabase

## 1. Database

Fungua project MPYA, tupu ya Hopex Express Cargo. Usitumie project ya TCAST au
database nyingine yenye tables zilizopo.

Nenda SQL Editor → New query. Fungua `01_HOPEX_DATABASE.sql`, copy code YOTE,
paste kwenye query na bonyeza Run. Chagua database role ya `postgres`.
Faili ina migrations 22 kwa mpangilio na transaction moja.

Ikifaulu utaona `HOPEX DATABASE SETUP COMPLETE`, jina Hopex Express Cargo,
tracking prefix HOPEX na packing-list prefix PL-HOPEX.
Ikiwa kuna error, hifadhi ujumbe wote wa error na utume kwa Codex.
Usiendelee na hatua za login mpaka database setup ifanikiwe.

Code imekaguliwa kwa PostgreSQL syntax; haijaendeshwa kwenye project yako.
Syntax check haithibitishi schema dependencies, permissions au financial workflows.

## 2. Functions za login na staff

SQL pekee haitoshi kuendesha login ya app. Nenda Edge Functions → Deploy a new
function → Via Editor. Tengeneza functions hizi kwa majina SAHIHI:

| Jina la function | Code ya kuweka kwenye index.ts | Verify JWT |
| --- | --- | --- |
| staff-login | staff-login.ts | OFF |
| staff-admin | staff-admin.ts | ON |
| complete-password-change | complete-password-change.ts | ON |

Copy code YOTE ya kila faili kwenye editor ya function yake, kisha Deploy.
Faili hizi zina helper code ndani yake; hazihitaji kuweka folder ya _shared.
Weka Verify JWT kwenye settings/details za function husika.
staff-admin na complete-password-change pia hukagua user na staff profile ndani ya
code; login hukagua email/username na password kabla ya kurudisha session.

SUPABASE_URL na keys za server hutumiwa kwenye mazingira ya Edge Functions.
Usiweke secret/service_role key kwenye frontend. Kwa password-reset redirect,
weka secret `STAFF_PORTAL_URL` yenye URL halisi ya portal, kisha weka URL hiyo
pia kwenye Auth Site URL/allowed redirects. Usibuni domain.

Maelekezo rasmi:
[Dashboard functions](https://supabase.com/docs/guides/functions/quickstart-dashboard),
[JWT settings](https://supabase.com/docs/guides/functions/auth-headers).

## 3. Admin wa kwanza

Nenda Authentication → Users → Add user. Weka email yako halisi na password
utakayotumia; hakikisha email imeconfirmed. Copy User UID ya account hiyo.

Fungua `02_FIRST_ADMIN.sql`, badilisha `PUT_AUTH_USER_UUID_HERE` kwa UID hiyo,
kisha run code yote kwenye SQL Editor. Query inampa user huyo mmoja role ya Admin.
Haibadilishi password. Hii ni bootstrap ya Admin wa kwanza pekee; Admin akishakuwepo,
tumia Staff Management ya app kwa accounts nyingine.

Zima public user signups kwenye Auth settings; staff huongezwa na Admin.

## 4. Uhakiki

Run `03_VERIFY_DATABASE.sql` kwenye SQL Editor. Company iwe Hopex Express Cargo;
required columns/functions ziwe `present = true`; business tables ziwe na
`rowsecurity = true`; avatar bucket iwe `publicly_accessible = false`.
Ukaguzi huu haujaribu real login, RLS kwa kila role au financial workflows.

## 5. Kuunganisha app

Chukua Project URL na publishable key kutoka Supabase. Weka kwenye `.env.local`
ndani ya folder ya hopex-cargo-webapp:

```dotenv
VITE_SUPABASE_URL=https://PROJECT_REF_YAKO.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=PUBLISHABLE_KEY_YAKO
```

Restart app baada ya kubadilisha configuration. Tumia email/password ya Admin
uliyeunda. Thibitisha real login, settings, shipment, invoice, payment na refresh
kwenye data ya majaribio kabla ya kutumia records halisi za biashara.

Unaweza kumpa Codex Project URL na publishable key akuunganishe app; usitume
database password, secret key au service_role key kwenye chat.
