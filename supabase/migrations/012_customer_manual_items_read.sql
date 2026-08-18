-- Customer read access to public.receipt_manual_items.
--
-- Admin already has full read access to this table (see the
-- "Admins can view manual receipt items" policy in
-- 011_receipt_manual_items.sql, unchanged by this migration). This adds the
-- MINIMUM additional access: a customer may read manual items only for a
-- purchase report they own, verified through an ownership check on
-- purchase_reports.user_id. This is purely additive - Postgres combines
-- multiple SELECT policies for the same table with OR, so the existing
-- admin policy is untouched and a customer still cannot list another
-- customer's manual items under any circumstance.
--
-- No INSERT/UPDATE/DELETE policy or grant is added for authenticated here -
-- public.save_manual_receipt_items() (migration 011) remains the only
-- writer, and it already requires public.is_admin(). A customer session
-- gets read-only access to their own rows and nothing else.
create policy "Customers can view manual items for their own reports"
  on public.receipt_manual_items
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.purchase_reports pr
      where pr.id = receipt_manual_items.purchase_report_id
        and pr.user_id = auth.uid()
    )
  );

-- created_by identifies which ADMIN entered the data - it must never reach
-- a customer. receipt_manual_items' existing SELECT grant (migration 011)
-- is a whole-table grant (`grant select on table ... to authenticated`),
-- which automatically covers this column too; without this explicit
-- revoke, a customer reading their own now-visible row would also be able
-- to select created_by. This mirrors the same carve-out already used for
-- purchase_reports.reviewed_by (see 010_purchase_report_review.sql). The
-- admin's own JS query never selects this column either, so this has no
-- effect on the existing admin manual-entry workflow.
revoke select (created_by) on public.receipt_manual_items from authenticated;
