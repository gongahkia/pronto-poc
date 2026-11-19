-- Enrollment is an owner-operated deployment capability, not business approval.
-- Runtime roles receive SELECT only; ordinary tenants retain their vector checks.
create table instagram_test_knowledge_scopes (
  client_id uuid primary key references clients(id) on delete cascade,
  channel_id uuid not null unique references channels(id) on delete cascade,
  database_marker text not null check (database_marker ~ '^pronto:instagram-hosted:v1:[0-9a-f-]{36}$'),
  created_at timestamptz not null default now()
);

alter table assistant_draft_chunks drop constraint assistant_draft_chunks_text_profile;
alter table assistant_draft_chunks add constraint assistant_draft_chunks_text_profile check (
  embedding is not null or (
    (client_id = '00000000-0000-4000-8000-00000000a101'::uuid
      or metadata @> '{"retrievalScope":"instagram_hosted_test"}'::jsonb)
    and embedding_model = 'none' and embedding_dimensions = 0
    and metadata @> '{"retrievalMode":"local_text","retrievalProfile":"postgres-fts-simple-v1"}'::jsonb
  )
);
alter table knowledge_chunks drop constraint knowledge_chunks_text_profile;
alter table knowledge_chunks add constraint knowledge_chunks_text_profile check (
  embedding is not null or (
    (client_id = '00000000-0000-4000-8000-00000000a101'::uuid
      or metadata @> '{"retrievalScope":"instagram_hosted_test"}'::jsonb)
    and embedding_model = 'none' and embedding_dimensions = 0
    and metadata @> '{"retrievalMode":"local_text","retrievalProfile":"postgres-fts-simple-v1"}'::jsonb
  )
);

create function enforce_instagram_test_text_scope() returns trigger language plpgsql as $$
begin
  if new.embedding is null and new.client_id <> '00000000-0000-4000-8000-00000000a101'::uuid then
    if not exists (
      select 1 from instagram_test_knowledge_scopes s
      join channels c on c.id=s.channel_id and c.client_id=s.client_id
      join pg_database d on d.datname=current_database()
      where s.client_id=new.client_id and c.kind='instagram'
        and c.settings->>'authMode'='unified_login' and c.encrypted_credentials is not null
        and shobj_description(d.oid,'pg_database')=s.database_marker
    ) then
      raise exception 'Instagram test text knowledge requires explicit enrollment and verified database identity'
        using errcode='23514', constraint=TG_TABLE_NAME || '_instagram_text_scope';
    end if;
  end if;
  return new;
end;
$$;
create trigger assistant_draft_chunks_instagram_text_scope before insert or update on assistant_draft_chunks
  for each row execute function enforce_instagram_test_text_scope();
create trigger knowledge_chunks_instagram_text_scope before insert or update on knowledge_chunks
  for each row execute function enforce_instagram_test_text_scope();
