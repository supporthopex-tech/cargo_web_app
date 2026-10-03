-- Run only after the accounting migration has been applied to an isolated QA DB.
-- The transaction always rolls back and never fabricates historical FX values.
begin;

do $$
declare
  missing_accounts text[];
  unbalanced_entries bigint;
  orphan_lines bigint;
begin
  select array_agg(required.code order by required.code) into missing_accounts
  from (values ('1000'),('1010'),('1100'),('2000'),('3000'),('4000'),('4010'),('4090'),('5200')) required(code)
  where not exists (select 1 from public.accounting_accounts account where account.code = required.code);
  if missing_accounts is not null then raise exception 'Required accounts missing: %', missing_accounts; end if;

  select count(*) into unbalanced_entries
  from (
    select entry.id
    from public.journal_entries entry
    join public.journal_lines line on line.journal_entry_id = entry.id
    where entry.status = 'POSTED'
    group by entry.id
    having round(sum(line.debit), 2) <> round(sum(line.credit), 2) or sum(line.debit) <= 0
  ) invalid;
  if unbalanced_entries <> 0 then raise exception '% posted journals are unbalanced', unbalanced_entries; end if;

  select count(*) into orphan_lines
  from public.journal_lines line
  where not exists (select 1 from public.journal_entries entry where entry.id = line.journal_entry_id)
     or not exists (select 1 from public.accounting_accounts account where account.id = line.account_id);
  if orphan_lines <> 0 then raise exception '% orphan journal lines found', orphan_lines; end if;

  if exists (select 1 from public.payment_records where status = 'POSTED' and accounting_journal_entry_id is null and reporting_amount is not null) then
    raise exception 'A newly posted payment is missing its journal entry';
  end if;
  if exists (select 1 from public.expenses where status = 'POSTED' and accounting_journal_entry_id is null and reporting_amount is not null) then
    raise exception 'A newly posted expense is missing its journal entry';
  end if;
end $$;

select public.accounting_backfill_preview();

-- Recovery: all accounting objects are additive. On failure, rollback this
-- transaction. Before a future remote apply, take a provider backup and review
-- accounting_backfill_preview(); do not invent FX or delete financial records.
rollback;
