alter table conversations
  add column instagram_profile jsonb not null default '{}'::jsonb
    check (jsonb_typeof(instagram_profile) = 'object'),
  add column instagram_profile_refresh_after timestamptz not null default '1970-01-01',
  add column instagram_profile_lease_token uuid,
  add column instagram_profile_lease_until timestamptz;
