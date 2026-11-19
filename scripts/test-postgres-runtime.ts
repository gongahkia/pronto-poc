import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {access,lstat,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {availableParallelism} from 'node:os';
const exec = promisify(execFile), version = '18.6', pgSha = '555610c24d53e4316da5b7d3fc25c279d96856d5e0e23ee308c328c5fa881d9f';
const vectorVersion = '0.8.7', vectorCommit = 'f37c13f68b57d2c3472b2214fbcff699d6d34876', vectorSha = '83d673c3b287cddbf3879f86215f043f2c2b56c69d37b2a77504910db1ed6e56';
const root = resolve('output/runtime'), target = join(root,'pronto-postgres-18.6-vector-0.8.7'), marker = join(target,'pronto-runtime.json'), nonce = randomUUID();
if(process.version !== 'v24.21.0') throw new Error('Use the pinned Node 24.21.0 runtime for test PostgreSQL.');
await mkdir(root,{recursive:true});
let exists = false;try {await access(target);exists = true;} catch { /* create only a new owned runtime */ }
async function verify() {
  const saved = JSON.parse(await readFile(marker,'utf8'));
  if((await lstat(target)).isSymbolicLink() || saved.kind !== 'pronto-feedback-postgres-runtime' || saved.pgSha !== pgSha || saved.vectorSha !== vectorSha || !saved.complete) throw new Error('Refusing an unidentified or incomplete fixture runtime.');
  if((await exec(join(target,'bin/postgres'),['--version'])).stdout.trim() !== `postgres (PostgreSQL) ${version}`) throw new Error('PostgreSQL fixture version mismatch.');
  const control = await readFile(join(target,'share/extension/vector.control'),'utf8');if(!control.includes(`default_version = '${vectorVersion}'`)) throw new Error('pgvector fixture version mismatch.');
  for(const name of ['pgcrypto','vector']) await access(join(target,`lib/${name}.${process.platform === 'darwin' ? 'dylib' : 'so'}`));
}
if(exists) {await verify();console.log(`Verified private PostgreSQL ${version} / pgvector ${vectorVersion}: ${target}/bin`);}
else {
  for(const program of ['make','cc','bison','flex','pkg-config']) try {await exec(program,['--version']);} catch {throw new Error(`Fixture runtime needs ${program}; install build prerequisites explicitly.`);}
  const work = await mkdtemp(join(root,'pronto-pg-build-'));await mkdir(target,{mode:0o700});
  const record = {kind:'pronto-feedback-postgres-runtime',version,pgSha,vectorVersion,vectorCommit,vectorSha,nonce,complete:false};await writeFile(marker,JSON.stringify(record),{mode:0o600});
  async function source(url:string,path:string,sha:string) {const response = await fetch(url,{signal:AbortSignal.timeout(120000)});if(!response.ok) throw new Error('Fixture source download failed.');const bytes = Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex') !== sha) throw new Error('Fixture source checksum mismatch.');await writeFile(path,bytes,{mode:0o600});await exec('tar',['-xf',path,'-C',work]);}
  try {
    console.log('Preparing pinned private PostgreSQL, pgcrypto and pgvector; no database is started.');
    await source(`https://ftp.postgresql.org/pub/source/v${version}/postgresql-${version}.tar.bz2`,join(work,'postgres.tar.bz2'),pgSha);
    await source(`https://codeload.github.com/pgvector/pgvector/tar.gz/${vectorCommit}`,join(work,'vector.tar.gz'),vectorSha);
    const cwd = join(work,`postgresql-${version}`), options = {cwd,maxBuffer:16*1024*1024}, jobs = String(Math.min(4,availableParallelism()));
    await exec('./configure',[`--prefix=${target}`,'--without-icu','--without-readline','--without-zlib','--with-ssl=openssl'],options);
    await exec('make',['-s','-j',jobs],options);await exec('make',['-s','install'],options);
    await exec('make',['-s','-C','contrib/pgcrypto','install'],options);
    const vectorOptions = {cwd:join(work,`pgvector-${vectorCommit}`),maxBuffer:16*1024*1024};
    await exec('make',['-s','-j',jobs,`PG_CONFIG=${join(target,'bin/pg_config')}`,'OPTFLAGS='],vectorOptions);
    await exec('make',['-s','install',`PG_CONFIG=${join(target,'bin/pg_config')}`,'OPTFLAGS='],vectorOptions);
    await writeFile(marker,JSON.stringify({...record,complete:true}),{mode:0o600});await verify();console.log(`Built private PostgreSQL ${version} / pgvector ${vectorVersion}: ${target}/bin`);
  } catch(error) {const saved = JSON.parse(await readFile(marker,'utf8'));if(saved.nonce === nonce) await rm(target,{recursive:true,force:true});throw error;}
  finally {await rm(work,{recursive:true,force:true});}
}
