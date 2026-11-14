import {readdir,readFile} from 'node:fs/promises';
import {getPool} from '../../src/lib/db';
import {verifyTestDatabase} from '../test-db-safety';
// reproduce the reviewed source release only on this invocation's new database.
await verifyTestDatabase();const pool = getPool();
try {
  if(!process.env.PRONTO_HUDDLE_FIXTURE_NONCE || (await pool.query("select current_setting('pronto.fixture_nonce',true) nonce")).rows[0].nonce !== process.env.PRONTO_HUDDLE_FIXTURE_NONCE) throw new Error('The pre-migration schema requires the owned fixture.');
  const db = await pool.connect();try {
    await db.query('create table if not exists schema_migrations(filename text primary key,applied_at timestamptz not null default now())');
    const files = (await readdir('db/migrations')).filter(file => /^\d{3}_.*\.sql$/.test(file) && file < '058_').sort();if(files.at(-1) !== '057_issue_scoped_handoffs.sql') throw new Error('Reviewed legacy migration inventory changed.');
    for(const file of files) {if((await db.query('select 1 from schema_migrations where filename=$1',[file])).rowCount) continue;await db.query('begin');try {await db.query(await readFile('db/migrations/'+file,'utf8'));await db.query('insert into schema_migrations(filename) values($1)',[file]);await db.query('commit');} catch(error) {await db.query('rollback');throw error;}}
    console.log('Owned source fixture migrations 001–057 verified; feedback installation remains unapplied.');
  } finally {db.release();}
} finally {await pool.end();}
