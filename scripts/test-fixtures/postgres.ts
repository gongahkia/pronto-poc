import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {closeSync,openSync} from 'node:fs';
import {access,lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
const exec = promisify(execFile);
async function waitAtMost(promise:Promise<unknown>,ms:number) {let timer:ReturnType<typeof setTimeout> | undefined;try {await Promise.race([promise,new Promise<void>(done => {timer = setTimeout(done,ms);})]);} finally {if(timer) clearTimeout(timer);}}
export async function disposablePostgres() {
  if(process.version !== 'v24.21.0') throw new Error('Use Node 24.21.0 for disposable database verification.');
  const bin = resolve(process.env.PRONTO_TEST_PG_BIN || 'output/runtime/pronto-postgres-18.6-vector-0.8.7/bin');
  for(const program of ['postgres','initdb','pg_dump','pg_restore']) await access(join(bin,program));
  if((await exec(join(bin,'postgres'),['--version'])).stdout.trim() !== 'postgres (PostgreSQL) 18.6') throw new Error('The fixture requires PostgreSQL 18.6 with pgcrypto/pgvector.');
  const listener = createServer();await new Promise<void>((done,fail) => {listener.once('error',fail);listener.listen(0,'127.0.0.1',done);}); const address = listener.address();if(!address || typeof address === 'string') throw new Error('No loopback fixture port.');const port = address.port;await new Promise<void>(done => listener.close(() => done()));
  const directory = await mkdtemp(join(tmpdir(),'pronto-feedback-pg-')), data = join(directory,'data'), socket = join(directory,'socket'), nonce = randomUUID(), marker = join(directory,'fixture.json'), password = randomUUID()+randomUUID(), user = 'pronto_feedback_fixture';
  await mkdir(socket,{mode:0o700});await writeFile(marker,JSON.stringify({kind:'pronto-feedback-disposable-postgres',nonce,directory}),{mode:0o600});await writeFile(join(directory,'password'),password,{mode:0o600});
  async function markerVerified() {const saved = JSON.parse(await readFile(marker,'utf8'));if((await lstat(directory)).isSymbolicLink() || saved.kind !== 'pronto-feedback-disposable-postgres' || saved.nonce !== nonce || saved.directory !== directory) throw new Error('Refusing to clean up an unverified feedback fixture.');}
  try {await exec(join(bin,'initdb'),['-D',data,`--username=${user}`,'--auth-local=trust','--auth-host=scram-sha-256',`--pwfile=${join(directory,'password')}`,'--encoding=UTF8','--locale=C','--locale-provider=libc'],{timeout:30000,maxBuffer:2*1024*1024});}
  catch(error) {await markerVerified();await rm(directory,{recursive:true,force:true});throw error;}
  const log = openSync(join(directory,'postgres.log'),'w',0o600), child = spawn(join(bin,'postgres'),['-D',data,'-h','127.0.0.1','-k',socket,'-p',String(port),'-c',`pronto.fixture_nonce=${nonce}`,'-c','max_connections=50','-c','shared_buffers=32MB'],{stdio:['ignore',log,log]});closeSync(log);
  let spawnError:Error | undefined;child.once('error',error => {spawnError = error;});const exited = new Promise<void>(done => {child.once('exit',() => done());child.once('error',() => done());});
  const admin = new Pool({host:'127.0.0.1',port,user,password,database:'postgres',connectionTimeoutMillis:1000,max:2});admin.on('error',() => {});
  let pool:Pool | undefined, closing:Promise<void> | undefined;
  async function verify() {await markerVerified();const row = (await admin.query("select current_setting('pronto.fixture_nonce') nonce,current_setting('server_version') version")).rows[0];if(row.nonce !== nonce) throw new Error('Connected PostgreSQL is not this task-owned fixture.');return String(row.version);}
  async function close() {
    if(!closing) closing = (async () => {await markerVerified();const ending = Promise.all([admin.end(),pool?.end()]);await waitAtMost(ending,3000);if(child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');await waitAtMost(exited,5000);if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');await exited;await ending;await markerVerified();await rm(directory,{recursive:true,force:true});})();return closing;
  }
  try {
    let version:string | undefined;for(let attempt=0;attempt<100;attempt++) {if(spawnError || child.exitCode !== null || child.signalCode !== null) throw new Error('Owned PostgreSQL failed to start; inspect its private fixture log.');try {version = await verify();break;} catch {await delay(50);}}if(!version) throw new Error('Owned PostgreSQL did not become ready.');
    await admin.query('create database pronto_test');await admin.query("comment on database pronto_test is 'pronto:isolated-test-database:v1'");
    const url = new URL('postgres://127.0.0.1/pronto_test');url.port = String(port);url.username = user;url.password = password;pool = new Pool({connectionString:url.href,max:4});pool.on('error',() => {});
    return {pool,connectionString:url.href,version,nonce,verify,close,directory,bin};
  } catch(error) {await close();throw error;}
}
