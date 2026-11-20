alter table channels add constraint channels_id_client_unique unique(id,client_id);
create table selfserve_settings (
 client_id uuid primary key references clients(id) on delete cascade,
 enabled boolean not null default false,
 industry text not null default 'restaurant' check(industry in ('restaurant','dental')),
 version bigint not null default 1,
 rules_revision bigint not null default 0,
 voice jsonb not null default '{"mode":"preset","preset_id":"small","custom_notes":[]}',
 handovers jsonb not null default '{}',
 alerts jsonb not null default '{"whatsapp_enabled":false,"email_enabled":false}',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table selfserve_sources (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 type text not null check(type in ('text','file','url')),label text not null,
 status text not null default 'processing' check(status in ('processing','ready','failed')),
 revision integer not null default 1,raw_text text,url text,file_meta jsonb,
 extracted_text text,segments jsonb,transient_file jsonb,
 error text,model text,prompt_version text,
 legacy_source_id uuid references knowledge_sources(id) on delete set null,
 deleted_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(id,client_id),unique(client_id,legacy_source_id)
);
create table selfserve_rules (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 source_id uuid not null,text text not null check(length(trim(text))>0),ref text not null,topic text,
 position integer not null,edited_by_owner boolean not null default false,
 checked boolean not null default false,revision integer not null default 1,evidence text,
 model text,prompt_version text,deleted_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(id,client_id),foreign key(source_id,client_id) references selfserve_sources(id,client_id) on delete cascade
);
create table selfserve_conflicts (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 rule_a uuid not null,rule_b uuid not null,topic text,explanation text,
 status text not null default 'open' check(status in ('open','resolved')),
 resolved_by text check(resolved_by in ('keep','edit','delete','source_removed')),resolved_at timestamptz,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 check(rule_a<rule_b),unique(client_id,rule_a,rule_b),
 foreign key(rule_a,client_id) references selfserve_rules(id,client_id) on delete cascade,
 foreign key(rule_b,client_id) references selfserve_rules(id,client_id) on delete cascade
);
create table selfserve_voice_sessions (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 actor_id uuid not null references users(id),method text not null check(method in ('conversation','upload')),
 industry text not null check(industry in ('restaurant','dental')),
 status text not null default 'collecting' check(status in ('collecting','extracting','review','analysing','ready','saved','discarded','failed')),
 revision integer not null default 1,replies jsonb not null default '[]',upload_meta jsonb not null default '[]',
 transient_file jsonb,review_text text,speaker_options jsonb not null default '[]',selected_speaker text,
 draft_notes jsonb not null default '[]',error text,model text,prompt_version text,
 expires_at timestamptz not null default now()+interval '1 hour',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(id,client_id)
);
create table selfserve_jobs (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 actor_id uuid not null references users(id),kind text not null check(kind in ('source','rule','voice_extract','voice_analyse','handovers','preview')),
 target_id uuid not null,revision integer not null,payload jsonb not null default '{}',result jsonb,
 status text not null default 'pending' check(status in ('pending','processing','ready','failed','cancelled')),
 attempts integer not null default 0,available_at timestamptz not null default now(),lease_until timestamptz,lease_token uuid,
 error text,model text,prompt_version text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(client_id,kind,target_id,revision)
);
create index selfserve_jobs_pending on selfserve_jobs(client_id,available_at) where status in ('pending','processing');
create index selfserve_rules_source on selfserve_rules(client_id,source_id) where deleted_at is null;
create index selfserve_conflicts_open on selfserve_conflicts(client_id,rule_a,rule_b) where status='open';
create table selfserve_owner_replies (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 channel_id uuid not null,external_message_id text not null,external_thread_id text not null,
 occurred_at timestamptz not null,created_at timestamptz not null default now(),
 unique(channel_id,external_message_id),foreign key(channel_id,client_id) references channels(id,client_id)
);
create table selfserve_alert_deliveries (
 id uuid primary key default gen_random_uuid(),client_id uuid not null references clients(id) on delete cascade,
 escalation_id uuid not null references escalations(id) on delete cascade,kind text not null check(kind in ('whatsapp','email')),
 destination text not null,status text not null check(status in ('sending','sent','failed','uncertain')),
 error text,provider_message_id text,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(client_id,escalation_id,kind)
);
