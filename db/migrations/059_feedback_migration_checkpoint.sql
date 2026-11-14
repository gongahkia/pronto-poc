-- migration checkpoints survive an interrupted operator process; no source data is removed.
alter table prototype_feedback_state
 add column target_fingerprint text,
 add column restore_verified_at timestamptz,
 add column migration_preview_id text,
 add column migration_digest text,
 add column migration_request_key text,
 add column migration_environment text,
 add column migration_origin text,
 add column migration_actor_id uuid,
 add column migration_attempts jsonb not null default '[]'::jsonb;
