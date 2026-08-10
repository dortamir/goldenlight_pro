-- Allow authenticated clients to supply the purchase report UUID
-- while keeping all backend-controlled fields protected.

revoke insert on table public.purchase_reports from authenticated;

grant insert (
  id,
  user_id,
  receipt_path,
  original_filename
)
on table public.purchase_reports
to authenticated;