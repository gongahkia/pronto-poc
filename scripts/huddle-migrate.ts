import {mkdir,open,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {migrationContext,type MigrationContext} from './huddle-migration/context';
import {activate,backup,execute,exportCurrent,install,pause,prepare,preview,resume,state,verify} from './huddle-migration/operations';
import {sha256} from './huddle-migration/legacy';

// explicit arguments/configuration only: never read a dotenv file or print connection details.
const [command,...argv] = process.argv.slice(2), args = new Map<string,string>();
for(let index=0;index<argv.length;index+=2) {if(!/^--[a-z-]+$/.test(argv[index]) || !argv[index+1] || argv[index+1].startsWith('--') || args.has(argv[index])) throw new Error('Use unique --option VALUE arguments.');args.set(argv[index],argv[index+1]);}
const required = (key:string) => {const value = args.get('--'+key);if(!value) throw new Error('Missing --'+key+'.');return value;};
async function privateRead(path:string,limit=32*1024*1024) {const handle = await open(resolve(path),constants.O_RDONLY | constants.O_NOFOLLOW);try {const stat = await handle.stat();if(!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077 || stat.size > limit) throw new Error('Use an owned private regular input file within the configured byte bound.');const bytes = await handle.readFile();if(bytes.length > limit) throw new Error('Input changed beyond the configured bound.');return bytes;} finally {await handle.close();}}
async function privateWrite(path:string,bytes:string | Uint8Array) {const target = resolve(path);await mkdir(dirname(target),{recursive:true,mode:0o700});if((await lstat(dirname(target))).isSymbolicLink()) throw new Error('Output parent cannot be a symbolic link.');const handle = await open(target,'wx',0o600);try {await handle.writeFile(bytes);await handle.sync();} finally {await handle.close();}}
if(!['status','backup','install','pause','prepare','preview','execute','verify','activate','readonly','resume','export'].includes(command)) throw new Error('Choose status, backup, install, pause, prepare, preview, execute, verify, activate, readonly, resume or export. Schema changes require deliberate install with a matching restored backup.');
let ctx:MigrationContext | undefined;
try {
  ctx = await migrationContext({databaseId:required('database-id'),actorId:required('actor-id'),fingerprint:args.get('--target-fingerprint')});
  let result:unknown;
  if(command === 'status') {const installed = (await ctx.pool.query("select to_regclass('public.prototype_feedback_state') is not null installed")).rows[0].installed;result = {targetFingerprint:ctx.fingerprint,databaseId:ctx.databaseId,schemaInstalled:installed,state:installed ? await state(ctx) : null};}
  else if(command === 'backup') {const source = await backup(ctx), bytes = JSON.stringify(source)+'\n';await privateWrite(required('out'),bytes);result = {schema:source.schema,complete:true,counts:source.counts,backupSha256:sha256(bytes)};}
  else if(command === 'pause' || command === 'readonly') result = await pause(ctx);
  else if(command === 'prepare') result = await prepare(ctx,await privateRead(required('backup')),JSON.parse((await privateRead(required('restore-receipt'),1024*1024)).toString('utf8')));
  else if(command === 'install') {
    const prerequisites = args.get('--apply-prerequisites');if(prerequisites !== undefined && prerequisites !== '056-057') throw new Error('Only the reviewed 056-057 prerequisite set can be approved.');
    result = await install(ctx,await privateRead(required('backup')),JSON.parse((await privateRead(required('restore-receipt'),1024*1024)).toString('utf8')),{applyPrerequisites:prerequisites === '056-057'});
  }
  else if(command === 'preview') {const plan = await preview(ctx,args.get('--replace-preview'));await privateWrite(required('out'),JSON.stringify(plan)+'\n');result = {id:plan.id,counts:plan.counts,conflicts:plan.conflicts.length,expiresAt:plan.expiresAt,historicalAuthors:plan.historicalAuthors.length};}
  else if(command === 'execute') {const row = await state(ctx), saved = args.has('--preview') ? JSON.parse((await privateRead(required('preview'),1024*1024)).toString('utf8')) : {id:row.migration_preview_id,digest:row.migration_digest,idempotencyKey:row.migration_request_key};result = await execute(ctx,{previewId:saved.id,digest:saved.digest,idempotencyKey:saved.idempotencyKey,maxBatches:Number(required('max-batches'))});}
  else if(command === 'verify') result = await verify(ctx);
  else if(command === 'activate') result = await activate(ctx);
  else if(command === 'resume') result = await resume(ctx);
  else if(command === 'export') {const bytes = await exportCurrent(ctx);await privateWrite(required('out'),bytes);result = {complete:true,sha256:sha256(bytes),bytes:bytes.length};}
  console.log(JSON.stringify(result));
} catch(error) {
  // database/SDK exceptions can contain source content or a connection URL.
  console.error('Feedback operation failed. The writer gate and committed records were retained. Review identity, private inputs and checkpoint status before retrying.');process.exitCode = 1;
  if(args.has('--diagnostic-out')) await privateWrite(required('diagnostic-out'),String(error instanceof Error ? error.stack : error)+'\n');
} finally {await ctx?.close();}
