-- Keep the existing auth.users -> staff_profiles trigger compatible with the
-- required staff username introduced by staff management.
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  requested_username text;
  fallback_username text;
  resolved_username text;
begin
  requested_username := lower(btrim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  fallback_username := regexp_replace(lower(split_part(new.email, '@', 1)), '[^a-z0-9._-]', '', 'g');

  if requested_username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'
    and not exists (
      select 1 from public.staff_profiles profile
      where lower(profile.username) = requested_username
    ) then
    resolved_username := requested_username;
  else
    if fallback_username !~ '^[a-z0-9][a-z0-9._-]{2,31}$' then
      fallback_username := 'staff-' || left(new.id::text, 8);
    end if;

    fallback_username := left(fallback_username, 32);
    if exists (
      select 1 from public.staff_profiles profile
      where lower(profile.username) = fallback_username
    ) then
      fallback_username := left(fallback_username, 23) || '-' || left(new.id::text, 8);
    end if;
    resolved_username := fallback_username;
  end if;

  insert into public.staff_profiles (id, email, username, name, initials, role)
  values (
    new.id,
    new.email,
    resolved_username,
    coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
    coalesce(new.raw_user_meta_data ->> 'initials', upper(left(split_part(new.email, '@', 1), 2))),
    'Operations Staff'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
