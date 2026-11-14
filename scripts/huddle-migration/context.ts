import {Pool,type PoolClient} from 'pg';
import {databaseConnectionOptions} from '../../src/lib/db';
import {protectedDemoConfiguration,protectedDemoDeployment} from '../../src/lib/deployment-profile';
import {DEMO_CLIENT_ID} from '../../src/lib/customer-demo-boundary';
import {assertInternalFeedbackActor} from '../../src/lib/feedback/authorization';
import {feedbackLock} from '../../src/lib/feedback/state';
import type {SessionUser} from '../../src/lib/session-token';
import {sha256,canonical} from './legacy';

export async function migrationContext(input:{databaseId:string;actorId:string;fingerprint?:string}) {
  if(!process.env.DATABASE_URL) throw new Error('An explicit DATABASE_URL is required; no local default or dotenv file is loaded.');
  const protectedMode = protectedDemoDeployment(), config = protectedMode ? protectedDemoConfiguration() : undefined;
  const databaseId = config?.databaseId ?? process.env.PRONTO_HUDDLE_FIXTURE_NONCE;
  if(!databaseId || input.databaseId !== databaseId) throw new Error('The reviewed database ID does not match protected configuration or the owned fixture nonce.');
  const url = new URL(process.env.DATABASE_URL), origin = new URL(process.env.APP_BASE_URL ?? '');
  if(!['http:','https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Choose the explicit application origin without credentials, path or query.');
  if(!protectedMode && (process.env.DATABASE_URL !== process.env.PRONTO_TEST_DATABASE_URL || !['127.0.0.1','localhost','::1'].includes(url.hostname) || url.pathname !== '/pronto_test' || !url.port)) throw new Error('Local migration accepts only the explicitly identified owned fixture.');
  const marker = config?.marker ?? 'pronto:isolated-test-database:v1';
  const fingerprint = sha256(canonical({host:url.hostname,port:url.port || '5432',database:url.pathname,marker,origin:origin.origin}));
  const pool = new Pool({...databaseConnectionOptions(),max:4,connectionTimeoutMillis:5000,statement_timeout:120000,query_timeout:125000});pool.on('error',() => {});
  async function actor(db:Pool | PoolClient = pool) {
    const identity = (await db.query("select shobj_description(oid,'pg_database') marker,current_setting('pronto.fixture_nonce',true) nonce from pg_database where datname=current_database()" )).rows[0];
    if(identity?.marker !== marker || !protectedMode && identity.nonce !== databaseId) throw new Error('Database identity changed; migration refused.');
    const row = (await db.query<{id:string;email:string;name:string;role:SessionUser['role'];client_id:string|null}>('select id::text,email,name,role,client_id::text from users where id=$1',[input.actorId])).rows[0];
    return assertInternalFeedbackActor(row ? {userId:row.id,email:row.email,name:row.name,role:row.role,clientId:row.client_id} : null,db);
  }
  async function locked<T>(run:(db:PoolClient,signal:AbortSignal) => Promise<T>) {
    if(input.fingerprint !== fingerprint) throw new Error('Mutation requires the exact target fingerprint returned by status.');
    const db = await pool.connect();let held = false, discard = false;
    try {
      await actor(db);held = (await db.query('select pg_try_advisory_lock(hashtextextended($1,0)) held',[feedbackLock])).rows[0].held;
      if(!held) throw new Error('Feedback is busy; no mode change was made. Retry deliberately after in-flight feedback finishes.');
      return await run(db,AbortSignal.timeout(5*60*1000));
    } finally {
      if(held) try {if(!(await db.query('select pg_advisory_unlock(hashtextextended($1,0)) released',[feedbackLock])).rows[0].released) discard = true;} catch {discard = true;}
      db.release(discard);
    }
  }
  try {await actor();} catch(error) {await pool.end();throw error;}
  return {pool,databaseId,workspaceId:DEMO_CLIENT_ID,origin:origin.origin,fingerprint,actor,locked,close:() => pool.end()};
}
export type MigrationContext = Awaited<ReturnType<typeof migrationContext>>;
