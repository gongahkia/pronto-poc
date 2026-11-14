-- preserve legacy tables; the default state admits no feedback writer.
create table prototype_feedback_state (
 client_id uuid primary key,
 mode text not null default 'maintenance' check(mode in ('maintenance','legacy','active','readonly')),
 source_dataset_id uuid not null default gen_random_uuid(),
 backup_sha256 text check(backup_sha256 ~ '^[a-f0-9]{64}$'),
 migration_job_id text,
 source_digest text check(source_digest ~ '^[a-f0-9]{64}$'),
 verified_at timestamptz,
 activated_at timestamptz,
 updated_at timestamptz not null default now()
);
insert into prototype_feedback_state(client_id) select id from clients where id='00000000-0000-4000-8000-00000000a101';

-- pinned @huddle/host 0.2.0 PostgreSQL schema 1; never adopt an unidentified schema.
do $$ begin
 if exists(select 1 from pg_namespace where nspname='huddle') then
  raise exception 'Inventory the existing huddle schema before applying migration 058';
 end if;
end $$;
create schema huddle;
create table huddle.meta(key text primary key,value text not null);
do $$
declare collection text; index_name text; fields text;
begin
 foreach collection in array array['scopes','threads','comments','history','events','requests','uploads','previews','jobs','provenance'] loop
  execute format('create table huddle.%I(scope_key text collate "C" not null,workspace text not null,environment text not null,id text collate "C" not null,sort_time text collate "C" not null,thread_id text collate "C",status text,page text,page_key text collate "C",actor_id text,actor_key text collate "C",expires_at bigint,data text not null,primary key(scope_key,id))',collection);
  for index_name,fields in select * from (values ('order','sort_time,id'),('thread','thread_id,sort_time,id'),('status','status,sort_time,id'),('page','page_key,sort_time,id'),('actor','actor_key,expires_at')) indexes(name,columns) loop
   execute format('create index %I on huddle.%I(scope_key,%s)',collection||'_'||index_name,collection,fields);
  end loop;
 end loop;
end $$;
insert into huddle.meta(key,value) values ('schema','1'),('dataset',gen_random_uuid()::text),('cursor_secret',encode(gen_random_bytes(32),'hex'));

-- older deployed feedback writers do not yet acquire the application lock.
create function prototype_feedback_write_guard() returns trigger language plpgsql set search_path=pg_catalog,public as $$
declare current_mode text; guarded boolean;
begin
 guarded := case when TG_OP='INSERT' then NEW.client_id='00000000-0000-4000-8000-00000000a101'::uuid
                 when TG_OP='DELETE' then OLD.client_id='00000000-0000-4000-8000-00000000a101'::uuid
                 else NEW.client_id='00000000-0000-4000-8000-00000000a101'::uuid or OLD.client_id='00000000-0000-4000-8000-00000000a101'::uuid end;
 if guarded then
  perform pg_advisory_xact_lock_shared(hashtextextended('pronto:feedback:00000000-0000-4000-8000-00000000a101',0));
  select mode into current_mode from public.prototype_feedback_state where client_id='00000000-0000-4000-8000-00000000a101';
  if current_mode is distinct from 'legacy' then raise exception 'Prototype feedback writes are paused or have moved to the new store' using errcode='55000';end if;
 end if;
 if TG_OP='DELETE' then return OLD;end if;return NEW;
end $$;
create trigger prototype_feedback_threads_write_guard before insert or update or delete on demo_feedback_threads for each row execute function prototype_feedback_write_guard();
create trigger prototype_feedback_comments_write_guard before insert or update or delete on demo_feedback_comments for each row execute function prototype_feedback_write_guard();
