# Status and accounting rollout runbook

This feature must be validated on an isolated non-production database before any production rollout. The known Supabase ref `pacxxkmttvvestwjskjq` is production and is not an allowed migration target for this branch.

## Preflight

1. Confirm the target project reference and its environment label.
2. Create and verify a provider backup or point-in-time recovery checkpoint.
3. Record shipment, item, packing allocation, QR, payment, expense and finalized-invoice row counts.
4. Run the two migrations in timestamp order inside an isolated QA database.
5. Execute `supabase/tests/phase1_status_migration_qa.sql`, then the complete seven-stage QA shipment workflow.
6. Review `accounting_backfill_preview()` before approving any historical posting plan. Missing historical FX is a blocker, never an invitation to invent a value.
7. Execute `supabase/tests/phase2_accounting_migration_qa.sql` and reconcile Accounts Receivable to outstanding finalized invoices.

## Recovery

Both migrations are additive and preserve legacy JSON status history and source financial records. If an apply fails, stop application writes, retain the failure logs without secrets, and restore the verified pre-migration backup. Do not reset the database and do not delete shipments, packing allocations, QR records, invoices, payments or expenses. A compensating migration must be reviewed before retrying.

## Release gate

Production remains blocked until migration tests, the lifecycle acceptance flow, public tracking privacy, Packing List/QR/pricing regressions, typecheck, unit tests and production build all pass against the isolated target.
