import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import type {PoolClient} from 'pg';
import {ReviewStore} from '@huddle/host';
import {PostgresBackend} from '@huddle/host/postgres';
import type {FeedbackSnapshot,ImportMapping,Scope} from '@huddle/browser';
import type {FeedbackMode} from '../../src/lib/feedback/state';
import {huddleReviewConfig} from '../../src/lib/huddle-config';
import type {MigrationContext} from './context';
import {compareLegacy,convertLegacy,readLegacy,sha256,sourceDigest,validateBackup} from './legacy';

type State = {mode:FeedbackMode;source_dataset_id:string;backup_sha256:string|null;source_digest:string|null;restore_verified_at:Date|null;target_fingerprint:string|null;migration_job_id:string|null;migration_preview_id:string|null;migration_digest:string|null;migration_request_key:string|null;migration_environment:string|null;migration_origin:string|null;migration_actor_id:string|null;activated_at:Date|null};
export async function state(ctx:MigrationContext,db:PoolClient | MigrationContext['pool'] = ctx.pool) {
  const row = (await db.query<State>('select * from prototype_feedback_state where client_id=$1',[ctx.workspaceId])).rows[0];
  if(!row) throw new Error('The additive feedback schema/state is not installed for this workspace.');return row;
}
export const backup = (ctx:MigrationContext) => readLegacy(ctx.pool,{workspaceId:ctx.workspaceId,datasetId:ctx.databaseId,origin:ctx.origin});
export function inspectRecovery(bytes:Uint8Array,receipt:unknown,ctx:MigrationContext) {
  const source = validateBackup(JSON.parse(Buffer.from(bytes).toString('utf8'))), proof = receipt as Record<string,unknown>;
  if(source.workspaceId !== ctx.workspaceId || source.datasetId !== ctx.databaseId || !proof || proof.schema !== 'pronto.feedback.backup-restore.v1' || proof.complete !== true || proof.cleanup !== true || proof.backupSha256 !== sha256(bytes) || proof.sourceDigest !== sourceDigest(source) || proof.sourceDatasetId !== ctx.databaseId || proof.workspaceId !== ctx.workspaceId || !Number.isFinite(Date.parse(String(proof.restoredAt)))) throw new Error('A complete backup and matching successful private recovery receipt for this exact source are required.');
  return source;
}
export async function install(ctx:MigrationContext,bytes:Uint8Array,receipt:unknown) {
  const source = inspectRecovery(bytes,receipt,ctx), files = ['058_host_backed_feedback.sql','059_feedback_migration_checkpoint.sql'];
  return ctx.locked(async db => {
    const migrationLock = (await db.query("select pg_try_advisory_lock(hashtextextended('pronto:migrations',0)) held")).rows[0].held;
    if(!migrationLock) throw new Error('Another schema migration is running; installation refused.');
    try {
      const inventory = (await readdir(new URL('../../db/migrations/',import.meta.url))).filter(name => name.endsWith('.sql')).sort(), applied = new Set((await db.query<{filename:string}>('select filename from schema_migrations')).rows.map(row => row.filename));
      if(inventory.some(name => name < files[0] && !applied.has(name)) || files.some(name => applied.has(name))) throw new Error('Install requires the reviewed pre-058 baseline; an existing or partly installed schema needs explicit inventory.');
      await db.query('begin');
      try {
        await db.query("set local lock_timeout='5s'");await db.query('lock table demo_feedback_threads,demo_feedback_comments in access exclusive mode');
        // the table lock covers legacy SQL that predates the advisory-lock guard.
        const current = await readLegacy(ctx.pool,{workspaceId:ctx.workspaceId,datasetId:ctx.databaseId,origin:ctx.origin},db);
        if(sourceDigest(current) !== sourceDigest(source)) throw new Error('The source changed after its initial backup; restore a fresh backup before additive installation.');
        for(const file of files) {await db.query(await readFile(new URL('../../db/migrations/'+file,import.meta.url),'utf8'));await db.query('insert into schema_migrations(filename) values($1)',[file]);}
        await db.query('commit');return {installed:files,mode:'maintenance',backupSha256:sha256(bytes)};
      } catch(error) {await db.query('rollback').catch(() => {});throw error;}
    } finally {await db.query("select pg_advisory_unlock(hashtextextended('pronto:migrations',0))");}
  });
}
function frozen(row:State) {if(row.mode !== 'maintenance' || row.activated_at) throw new Error('Legacy migration requires pre-cutover maintenance; active/read-only feedback cannot be remigrated.');}
async function unchanged(ctx:MigrationContext,row:State) {
  if(row.source_dataset_id !== ctx.databaseId || row.target_fingerprint !== ctx.fingerprint || !row.backup_sha256 || !row.restore_verified_at || !row.source_digest || sourceDigest(await backup(ctx)) !== row.source_digest) throw new Error('Source/backup/target changed or recovery was not verified; preserve the current store and prepare a fresh reviewed backup.');
}
export async function pause(ctx:MigrationContext) {
  return ctx.locked(async db => {const row = await state(ctx,db), mode = row.activated_at ? 'readonly' : 'maintenance';await db.query('update prototype_feedback_state set mode=$2,updated_at=now() where client_id=$1',[ctx.workspaceId,mode]);return {mode};});
}
export async function prepare(ctx:MigrationContext,bytes:Uint8Array,receipt:unknown) {
  const source = inspectRecovery(bytes,receipt,ctx);
  return ctx.locked(async db => {
    const row = await state(ctx,db);frozen(row);
    if(sourceDigest(await backup(ctx)) !== sourceDigest(source)) throw new Error('Backup differs from the now-paused source; create and restore a final backup.');
    if(row.migration_preview_id || row.migration_job_id || row.backup_sha256 && (row.backup_sha256 !== sha256(bytes) || row.source_dataset_id !== ctx.databaseId)) throw new Error('A checkpoint already exists; resume it instead of replacing its source.');
    await db.query('update prototype_feedback_state set source_dataset_id=$2,backup_sha256=$3,source_digest=$4,target_fingerprint=$5,restore_verified_at=now(),updated_at=now() where client_id=$1',[ctx.workspaceId,ctx.databaseId,sha256(bytes),sourceDigest(source),ctx.fingerprint]);
    return {prepared:true,counts:source.counts,sourceDigest:sourceDigest(source),backupSha256:sha256(bytes)};
  });
}
async function store(ctx:MigrationContext,scope:Scope) {
  const backend = await PostgresBackend.open(ctx.pool,{schema:'huddle',beforeQuery:({scope:selected}) => {if(selected && (selected.workspace !== scope.workspace || selected.environment !== scope.environment)) throw new Error('Migration storage scope differs from its reviewed target.');}});
  return new ReviewStore(backend,async (selected,signal) => {signal.throwIfAborted();if(selected.workspace !== scope.workspace || selected.environment !== scope.environment) throw new Error('Migration scope rejected.');const actor = await ctx.actor();return {actor:{id:actor.userId,name:actor.name},capabilities:{mentions:false,assignment:false,directory:false}};},undefined,{limits:{maxBytes:64*1024*1024,maxRecords:1000000,maxDepth:64},batchSize:100,timeoutMs:120000});
}
function configured(ctx:MigrationContext,row?:State) {
  const config = huddleReviewConfig();if(!config || row && (row.migration_environment !== config.environment || row.migration_origin !== ctx.origin)) throw new Error('Feedback configuration differs from the saved migration target.');return {workspace:ctx.workspaceId,environment:config.environment};
}
export async function preview(ctx:MigrationContext,previousPreview?:string) {
  return ctx.locked(async (db,signal) => {
    const row = await state(ctx,db);frozen(row);await unchanged(ctx,row);if(row.migration_preview_id && previousPreview !== row.migration_preview_id || previousPreview && previousPreview !== row.migration_preview_id) throw new Error('A preview is already checkpointed; inspect/resume its exact key. Replacing staging requires its explicit previous preview ID. Published records and provenance are retained.');
    const scope = configured(ctx), api = await store(ctx,scope), source = await backup(ctx), bytes = Buffer.from(JSON.stringify(convertLegacy(source)));
    const mapping:ImportMapping = {environmentMap:{'legacy-pronto':scope.environment},originMap:source.origin === ctx.origin ? {} : {[source.origin]:ctx.origin},identityMap:{}};
    const staged = await api.stageImport(scope,(async function*() {yield bytes;})(),signal), result = await api.previewImport(scope,{...staged,mapping},signal);
    if(result.conflicts.length) throw new Error('Destination conflicts require review; no checkpoint or published source record was overwritten.');
    const key = randomUUID(), actor = await ctx.actor();await db.query('update prototype_feedback_state set migration_attempts=migration_attempts || $8::jsonb,migration_job_id=null,verified_at=null,migration_preview_id=$2,migration_digest=$3,migration_request_key=$4,migration_environment=$5,migration_origin=$6,migration_actor_id=$7,updated_at=now() where client_id=$1',[ctx.workspaceId,result.id,result.digest,key,scope.environment,ctx.origin,actor.userId,JSON.stringify(row.migration_preview_id ? [{previewId:row.migration_preview_id,digest:row.migration_digest,requestKey:row.migration_request_key,jobId:row.migration_job_id,replacedAt:new Date().toISOString()}] : [])]);
    return {...result,idempotencyKey:key};
  });
}
export async function execute(ctx:MigrationContext,input:{previewId:string;digest:string;idempotencyKey:string;maxBatches:number}) {
  if(!Number.isInteger(input.maxBatches) || input.maxBatches < 1 || input.maxBatches > 2000) throw new Error('Choose 1–2000 acknowledged batches for this invocation.');
  return ctx.locked(async (db,signal) => {
    const row = await state(ctx,db);frozen(row);await unchanged(ctx,row);const scope = configured(ctx,row), actor = await ctx.actor();
    if(row.migration_actor_id !== actor.userId || input.previewId !== row.migration_preview_id || input.digest !== row.migration_digest || input.idempotencyKey !== row.migration_request_key) throw new Error('Resume requires the exact checkpointed actor, preview, digest and request key.');
    const api = await store(ctx,scope);let result;
    for(let batch=0;batch<input.maxBatches;batch++) {
      signal.throwIfAborted();result = await api.executeImport(scope,{previewId:input.previewId,digest:input.digest,idempotencyKey:input.idempotencyKey},signal);
      await db.query('update prototype_feedback_state set migration_job_id=$2,verified_at=null,updated_at=now() where client_id=$1',[ctx.workspaceId,result.id]);
      if(result.state === 'failed') throw new Error('Migration encountered a destination conflict; committed records were retained. Inspect the host-backed job before continuing.');if(result.state === 'complete') break;
    }
    return result!;
  });
}
async function destination(ctx:MigrationContext,scope:Scope,signal:AbortSignal) {
  const download = await (await store(ctx,scope)).export({workspace:scope.workspace,environments:[scope.environment]},'json',signal), chunks:Buffer[] = [];let size = 0;
  for await(const bytes of download.chunks) {size += bytes.byteLength;if(size > 64*1024*1024) throw new Error('Complete destination exceeds 64 MiB; use the bounded streaming export workflow.');chunks.push(Buffer.from(bytes));}
  return Buffer.concat(chunks);
}
async function parity(ctx:MigrationContext,db:PoolClient,signal:AbortSignal) {
  const row = await state(ctx,db);frozen(row);await unchanged(ctx,row);const scope = configured(ctx,row);
  if(!row.migration_job_id) throw new Error('No acknowledged migration job is checkpointed.');
  const progress = await (await store(ctx,scope)).importProgress(scope,row.migration_job_id,signal);if(progress.state !== 'complete' || progress.rejected.length) throw new Error('Import job is not complete.');
  const result = compareLegacy(await backup(ctx),JSON.parse((await destination(ctx,scope,signal)).toString('utf8')) as FeedbackSnapshot,scope.environment,ctx.origin);
  await db.query('update prototype_feedback_state set verified_at=now(),updated_at=now() where client_id=$1',[ctx.workspaceId]);return result;
}
export const verify = (ctx:MigrationContext) => ctx.locked((db,signal) => parity(ctx,db,signal));
export async function activate(ctx:MigrationContext) {
  return ctx.locked(async (db,signal) => {const result = await parity(ctx,db,signal);await ctx.actor(db);await db.query("update prototype_feedback_state set mode='active',activated_at=now(),updated_at=now() where client_id=$1",[ctx.workspaceId]);return {...result,mode:'active'};});
}
export async function resume(ctx:MigrationContext) {
  return ctx.locked(async (db,signal) => {
    const row = await state(ctx,db);if(!row.activated_at || row.mode !== 'readonly' || row.target_fingerprint !== ctx.fingerprint) throw new Error('Resume requires this previously activated target in read-only mode.');
    const scope = configured(ctx,row), current = JSON.parse((await destination(ctx,scope,signal)).toString('utf8')) as FeedbackSnapshot;
    await ctx.actor(db);await db.query("update prototype_feedback_state set mode='active',updated_at=now() where client_id=$1",[ctx.workspaceId]);return {mode:'active',complete:true,counts:current.counts,originalActivatedAt:row.activated_at};
  });
}
export async function exportCurrent(ctx:MigrationContext) {await ctx.actor();return destination(ctx,configured(ctx),AbortSignal.timeout(120000));}
