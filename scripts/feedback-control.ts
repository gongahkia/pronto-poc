import {mkdir,open,lstat} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {migrationContext,type MigrationContext} from './huddle-migration/context';
import {exportCurrent,pause,resume,state} from './huddle-migration/operations';
import {sha256} from './huddle-migration/legacy';

const [command,...argv] = process.argv.slice(2),args = new Map<string,string>();
for(let index=0;index<argv.length;index+=2) {
  if(!['--database-id','--actor-id','--target-fingerprint','--out','--diagnostic-out'].includes(argv[index]) || !argv[index+1] || argv[index+1].startsWith('--') || args.has(argv[index])) throw new Error('Use unique named operator options with explicit values.');
  args.set(argv[index],argv[index+1]);
}
const required = (key:string) => {const value = args.get('--'+key);if(!value) throw new Error('Missing --'+key+'.');return value;};
if(!['status','readonly','resume','export'].includes(command)) throw new Error('Choose status, readonly, resume or export. One-off legacy migration commands are retired.');
async function privateWrite(path:string,bytes:string | Uint8Array) {
  const target = resolve(path);await mkdir(dirname(target),{recursive:true,mode:0o700});if((await lstat(dirname(target))).isSymbolicLink()) throw new Error('Output parent cannot be a symbolic link.');
  const file = await open(target,'wx',0o600);try {await file.writeFile(bytes);await file.sync();} finally {await file.close();}
}
let ctx:MigrationContext | undefined;
try {
  ctx = await migrationContext({databaseId:required('database-id'),actorId:required('actor-id'),fingerprint:args.get('--target-fingerprint')});
  const current = await state(ctx);if(!current.activated_at) throw new Error('Review control requires an already verified, activated store.');
  let result:unknown;
  if(command === 'status') result = {targetFingerprint:ctx.fingerprint,mode:current.mode,activatedAt:current.activated_at,environment:current.migration_environment};
  else if(command === 'readonly') result = await pause(ctx);
  else if(command === 'resume') result = await resume(ctx);
  else {const bytes = await exportCurrent(ctx);await privateWrite(required('out'),bytes);result = {complete:true,sha256:sha256(bytes),bytes:bytes.length};}
  console.log(JSON.stringify(result));
} catch(error) {
  console.error('Feedback control failed. Existing feedback and the writer gate were retained; verify operator identity, target and private inputs.');process.exitCode = 1;
  if(args.has('--diagnostic-out')) await privateWrite(required('diagnostic-out'),String(error instanceof Error ? error.stack : error)+'\n');
} finally {await ctx?.close();}
