-- enrollment extends text retrieval to explicitly prepared saved demos while
-- preserving the database marker and channel ownership checks for other tenants.
create table demo_business_knowledge_scopes (
  client_id uuid primary key references clients(id) on delete cascade,
  channel_id uuid not null unique references channels(id) on delete cascade,
  database_marker text not null check (
    database_marker = 'pronto:isolated-test-database:v1'
    or database_marker ~ '^pronto:protected-demo:v1:[0-9a-f-]{36}$'
  ),
  created_at timestamptz not null default now()
);

create function is_saved_demo_knowledge_scope(target uuid) returns boolean language sql stable as $$
  select exists (
    select 1 from demo_business_knowledge_scopes s
    join clients b on b.id=s.client_id
    join channels c on c.id=s.channel_id and c.client_id=s.client_id
    join pg_database d on d.datname=current_database()
    where s.client_id=target and c.kind='console'
      and c.settings->>'transport'='customer_simulator'
      and b.business_profile->'demoBusiness'->>'version'='1'
      and b.business_profile->>'approvedByRestaurant'='false'
      and b.business_profile->'demoBusiness'->>'channelId'=c.id::text
      and exists(select 1 from audit_logs a join users u on u.id=a.actor_user_id and u.role='operator' and u.client_id is null
        where a.client_id=b.id and a.target_id=b.id and a.action='demo.business_prepared'
          and a.metadata->>'profileHash'=b.business_profile->'demoBusiness'->>'profileHash')
      and shobj_description(d.oid,'pg_database')=s.database_marker
  )
$$;

alter table assistant_draft_chunks drop constraint assistant_draft_chunks_text_profile;
alter table assistant_draft_chunks add constraint assistant_draft_chunks_text_profile check (
  embedding is not null or (embedding_model='none' and embedding_dimensions=0
    and metadata @> '{"retrievalMode":"local_text","retrievalProfile":"postgres-fts-simple-v1"}'::jsonb)
);
alter table knowledge_chunks drop constraint knowledge_chunks_text_profile;
alter table knowledge_chunks add constraint knowledge_chunks_text_profile check (
  embedding is not null or (embedding_model='none' and embedding_dimensions=0
    and metadata @> '{"retrievalMode":"local_text","retrievalProfile":"postgres-fts-simple-v1"}'::jsonb)
);

create or replace function enforce_instagram_test_text_scope() returns trigger language plpgsql as $$
begin
  if new.embedding is null and new.client_id <> '00000000-0000-4000-8000-00000000a101'::uuid then
    if not is_saved_demo_knowledge_scope(new.client_id) and not (
      new.metadata @> '{"retrievalScope":"instagram_hosted_test"}'::jsonb and exists (
        select 1 from instagram_test_knowledge_scopes s
        join channels c on c.id=s.channel_id and c.client_id=s.client_id
        join pg_database d on d.datname=current_database()
        where s.client_id=new.client_id and c.kind='instagram'
          and c.settings->>'authMode'='unified_login' and c.encrypted_credentials is not null
          and shobj_description(d.oid,'pg_database')=s.database_marker
      )
    ) then
      raise exception 'Text knowledge requires explicit enrollment and verified database identity'
        using errcode='23514', constraint=TG_TABLE_NAME || '_instagram_text_scope';
    end if;
  end if;
  return new;
end;
$$;

alter table customer_demo_embeddings drop constraint customer_demo_embeddings_client_id_check;
alter table customer_demo_embeddings add constraint customer_demo_embeddings_client_id_check check (
  client_id='00000000-0000-4000-8000-00000000a101'::uuid or is_saved_demo_knowledge_scope(client_id)
);
