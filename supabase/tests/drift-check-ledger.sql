-- ===========================================================================
-- TCAST Cargo — ledger cross-check (READ ONLY)
-- ===========================================================================
-- Run this after 20260912085000_migration_ledger.sql has been applied. It
-- compares what the ledger records against the migrations this repository
-- contains, so a database that is ahead of (or behind) the code shows up as a
-- row. A clean database returns only 'ok' rows. Writes nothing.
-- ===========================================================================

with repo(version) as (
  values ('0001'),('20260808172013'),('20260808173840'),('20260809145324'),
         ('20260811093520'),('20260811153000'),('20260815013914'),('20260815013917'),
         ('20260816112517'),('20260817182455'),('20260817184710'),('20260817190000'),
         ('20260817193000'),('20260817200000'),('20260819120000'),('20260819130000'),
         ('20260911090000'),('20260911091000'),('20260911092000'),('20260912085000'),
         ('20260912090000')
)
select
  coalesce(repo.version, ledger.version) as version,
  ledger.name,
  case
    when ledger.version is null then 'NOT RECORDED — migration not applied, or applied before the ledger existed'
    when repo.version is null then 'DATABASE AHEAD OF REPOSITORY — recorded here but no such migration in the repo'
    else 'ok'
  end as state,
  ledger.applied_at
from repo
full outer join supabase_migrations.schema_migrations as ledger
  on ledger.version = repo.version
order by 1;
