-- AFTER running 01_HOPEX_DATABASE.sql:
-- Create the first user in Authentication > Users > Add user.
-- Set its email/password there; copy its User UID below. Confirm its email.
-- Replace PUT_AUTH_USER_UUID_HERE before running this query.
-- Bootstrap only: promotes exactly one existing Auth user, never all users.
begin;
do $hopex_first_admin$
declare
  target_user_id uuid := 'PUT_AUTH_USER_UUID_HERE'::uuid;
begin
  if not exists (
    select 1 from public.company_settings
    where id = 'default' and company_name = 'Hopex Express Cargo'
  ) then
    raise exception 'This is not the prepared Hopex Express Cargo database.';
  end if;
  if exists (select 1 from public.staff_profiles where role = 'Admin' and active) then
    raise exception 'An active Admin already exists. Use Staff Management for subsequent users.';
  end if;
  if not exists (
    select 1 from auth.users where id = target_user_id and email_confirmed_at is not null
  ) then
    raise exception 'Create and confirm this exact Auth user first.';
  end if;
  update public.staff_profiles
  set role = 'Admin', active = true, must_change_password = false,
      disabled_at = null, updated_at = now()
  where id = target_user_id;
  if not found then
    raise exception 'The Auth user has no staff profile. Check the Auth trigger.';
  end if;
end;
$hopex_first_admin$;
commit;

select id, email, username, role, active
from public.staff_profiles
where role = 'Admin' and active;
