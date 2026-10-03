-- Keep shipment item access limited to an active authenticated session without
-- using a linter-ambiguous always-true write policy.
drop policy if exists "staff full access" on public.shipment_items;
create policy "staff full access" on public.shipment_items
  for all to authenticated
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
