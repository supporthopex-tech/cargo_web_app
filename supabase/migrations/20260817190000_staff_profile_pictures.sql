-- Staff profile pictures.
--
-- Adds one nullable column to the existing staff_profiles table (the path
-- of the currently-active photo, not a URL — the bucket is private, so a
-- signed URL is minted on demand by the frontend and never persisted) and
-- a new private Storage bucket with its own RLS policies.
--
-- Ownership boundary is enforced by Storage RLS itself, not just by what
-- buttons the UI shows: a staff member may only write to their own
-- "{user_id}/profile.{ext}" object; an Admin may write to any staff
-- member's — mirroring the exact "self OR Admin" shape already used by
-- staff_profiles' own "staff can update own profile" /
-- "admins can update any profile" policies (see 0001_shipments_and_auth.sql).
-- MIME type and file size are enforced at the bucket level (native Storage
-- feature), so a client-side check is only ever a fast-fail convenience,
-- never the real gate.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.staff_profiles
  add column if not exists avatar_path text;

-- ---------------------------------------------------------------------------
-- Bucket: private (public = false). Every read/write already requires an
-- authenticated Supabase session in this app (see 0001's RLS comment on why
-- the anon/publishable key has no table access at all) — a public bucket
-- would be the first exception to that, so this stays private and reads go
-- through short-lived signed URLs instead.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'staff-profile-images', 'staff-profile-images', false,
  2097152, -- 2 MB
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Any active staff member can read any profile photo (a colleague's photo
-- is not sensitive data, and every screen that shows staff — Staff
-- Management, the sidebar/topbar avatar — needs to resolve photos for
-- users other than the viewer). Uploads/replaces/removals stay restricted
-- to the object's own folder, or an Admin.
drop policy if exists "staff can read profile images" on storage.objects;
create policy "staff can read profile images" on storage.objects
  for select to authenticated
  using (bucket_id = 'staff-profile-images' and public.is_active_staff());

drop policy if exists "staff can upload own profile image" on storage.objects;
create policy "staff can upload own profile image" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and name ~ '^[0-9a-fA-F-]{36}/profile\.(jpg|jpeg|png|webp)$'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  );

drop policy if exists "staff can replace own profile image" on storage.objects;
create policy "staff can replace own profile image" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  )
  with check (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and name ~ '^[0-9a-fA-F-]{36}/profile\.(jpg|jpeg|png|webp)$'
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  );

drop policy if exists "staff can remove own profile image" on storage.objects;
create policy "staff can remove own profile image" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'staff-profile-images'
    and public.is_active_staff()
    and ((storage.foldername(name))[1] = (select auth.uid())::text or public.is_staff_admin())
  );
