# Payment, shipment-status and extra-charge rollout

Apply and verify this change on an isolated Supabase QA project before production. The repository does not contain credentials for, and this work must not be used to connect directly to, the production database.

## Migration order

1. Take a verified Supabase backup/PITR checkpoint and record row counts for `shipments`, `payment_records`, `expenses`, `journal_entries`, and `journal_lines`.
2. Apply `migrations/20260911090000_cargo_extra_charges.sql`.
3. Apply `migrations/20260911091000_atomic_payment_recording.sql`.
4. Apply `migrations/20260911092000_status_transition_confirmation.sql`.
5. Run `tests/phase6_payment_status_extra_charges_qa.sql`. It uses an active Admin and an existing posted invoice when available, and rolls back every QA-created row.
6. Deploy the matching web-app branch only after the SQL succeeds. The app queries `cargo_extra_charges` during startup, so deploying the UI before the migrations would produce a partial-data warning.

## Two-session receipt concurrency check

In two SQL Editor tabs connected to the isolated QA project, use the same eligible shipment but different UUID idempotency keys. Execute both calls at nearly the same time as an authenticated test staff user:

```sql
select public.record_payment(
  '<shipment-id>', 1, 'USD', 'Bank Transfer', current_date,
  'Concurrency QA A', gen_random_uuid(), '1010'
);
```

Change the note to `Concurrency QA B` in the second tab. Confirm both returned payment rows are `POSTED`, their `receipt_number` values differ, and `shipments.amount_paid` equals the sum of all POSTED payments. Refund or otherwise reverse these QA payments through the normal audited workflow; do not delete posted rows.

## Acceptance verification

- Submit one payment and confirm exactly one row, one posted journal, the refreshed shipment total, and a receipt generated from the returned row.
- Rapid-click the payment action and retry the same request key; confirm only one payment exists.
- Force an overpayment or invalid currency; confirm no payment, journal, counter increment, success toast, or printed receipt survives the failed transaction.
- Change shipment status, refresh, and confirm `shipments.status`, `shipment_status_history`, the UI, and public `track_shipment()` output agree. Force a forbidden transition and confirm all four remain unchanged.
- Add Pickup and Supplier Payment charges. Confirm Pickup can be billable, Supplier Payment is a company expense, only billable charges increase Total Due, and both journals balance.
- Edit and delete a charge. Confirm the old journal is reversed, the new/remaining financial summary is authoritative, and reducing Total Due below posted payments is rejected.

Production remains blocked until the rollback QA, two-session concurrency test, authenticated desktop/mobile UI pass, customer tracking compatibility check, unit tests, typecheck, and production build all pass in the isolated environment.
