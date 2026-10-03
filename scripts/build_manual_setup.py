"""Build a dashboard-ready setup kit from the app's actual migrations/functions."""
from pathlib import Path
import hashlib
import json
import re

root = Path(__file__).resolve().parents[1]
output = root / 'supabase' / 'manual-setup'
output.mkdir(parents=True, exist_ok=True)
manifest = json.loads((root / 'supabase/setup-manifest.json').read_text(encoding='utf-8-sig'))
migrations = sorted((root / 'supabase/migrations').glob('*.sql'))
assert [p.name for p in migrations] == [m['file'] for m in manifest['migrations']]

header = """-- HOPEX EXPRESS CARGO: NEW EMPTY SUPABASE PROJECT ONLY.
-- Paste the ENTIRE file into SQL Editor and Run once as postgres.
-- Includes all 22 migrations in order; no customer/payment/staff data import.
-- One transaction: an error rolls back this setup.
-- SQL syntax is checked locally; execution on your project is not yet verified.
begin;
do $hopex_guard$
begin
  if exists (select 1 from pg_tables where schemaname = 'public') then
    raise exception 'Hopex setup requires a NEW EMPTY project. Public tables already exist; nothing was applied.';
  end if;
  if to_regclass('auth.users') is null or to_regclass('storage.buckets') is null then
    raise exception 'Supabase Auth/Storage schemas are required.';
  end if;
end;
$hopex_guard$;
"""
sections = [header]
for index, (path, entry) in enumerate(zip(migrations, manifest['migrations']), 1):
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['sha256'], path.name
    content = path.read_text(encoding='utf-8-sig')
    # Only the last migration has its own top-level BEGIN/COMMIT.
    # Keep all PL/pgSQL BEGIN/END blocks intact.
    if path.name == '20261003090000_hopex_company_branding.sql':
        assert len(re.findall(r'^begin;\s*$', content, re.M | re.I)) == 1
        assert len(re.findall(r'^commit;\s*$', content, re.M | re.I)) == 1
        content = re.sub(r'^(?:begin|commit);\s*$', '', content, flags=re.M | re.I)
    sections.append(f'\n-- MIGRATION {index:02d}/22: {path.name}\n{content.rstrip()}\n')

ledger = []
for path in migrations:
    version, name = path.stem.split('_', 1)
    ledger.append(f"  ('{version}', '{name}')")
sections.append("\n-- All preceding migrations completed inside this transaction.\n"
    + 'insert into supabase_migrations.schema_migrations (version, name) values\n'
    + ',\n'.join(ledger) + '\non conflict (version) do nothing;\n'
    + "commit;\n\nselect 'HOPEX DATABASE SETUP COMPLETE' as status,\n"
    + '  company_name, tracking_prefix, packing_list_prefix\n'
    + "from public.company_settings where id = 'default';\n")
(output / '01_HOPEX_DATABASE.sql').write_text('\n'.join(sections), encoding='utf-8')

shared = (root / 'supabase/functions/_shared/supabase.ts').read_text(encoding='utf-8')
for name in manifest['functions']:
    source = (root / f'supabase/functions/{name}/index.ts').read_text(encoding='utf-8')
    code, count = re.subn(r'^import\s*\{.*?\}\s*from\s*"\.\./_shared/supabase\.ts";\s*',
                         '', source, count=1, flags=re.S)
    assert count == 1, name
    assert '../_shared/' not in code
    combined = f'// Hopex Express Cargo — paste as index.ts for {name}.\n' + shared + '\n' + code
    (output / f'{name}.ts').write_text(combined, encoding='utf-8')

(output / '03_VERIFY_DATABASE.sql').write_text(
    (root / 'supabase/tests/hopex_readiness.sql').read_text(encoding='utf-8'), encoding='utf-8')
print(f'Built SQL from {len(migrations)} verified migrations and 3 standalone Edge Functions.')
