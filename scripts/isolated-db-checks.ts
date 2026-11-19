import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {disposablePostgres} from './test-fixtures/postgres';

if(process.env.DATABASE_URL || process.env.PRONTO_TEST_DATABASE_URL)throw new Error('This command creates its own disposable database. Unset existing database URL variables.');
const args=process.argv.slice(2),evaluation=args.length===1 && args[0]==='--eval';
const file=args.length===2 && args[0]==='--test-file' ? args[1] : undefined;
if(args.length && !evaluation && (!file || !/^tests\/(?:unit|integration)\/[a-z0-9/-]+\.test\.tsx?$/.test(file)))
 throw new Error('Use --eval, --test-file tests/unit|integration/name.test.ts, or no arguments for the database suite.');
const runId=randomUUID(),output=resolve('output/isolated-db',runId);
await mkdir(output,{recursive:true,mode:0o700});
const fixture=await disposablePostgres();
const env:NodeJS.ProcessEnv={...process.env,NODE_ENV:'test',DATABASE_URL:fixture.connectionString,PRONTO_TEST_DATABASE_URL:fixture.connectionString,
 PRONTO_PREFLIGHT_IGNORE_DOTENV:'1',PRONTO_ENFORCE_TENANT_SQL:'1',PRONTO_USE_MOCK_AI:'1',
 PRONTO_DEPLOYMENT_PROFILE:'',PRONTO_DEMO_PROCESSING_MODE:'',PRONTO_CUSTOMER_DEMO_ENABLED:'',PRONTO_DEMO_INSTAGRAM_ENABLED:'',
 PRONTO_DEMO_CLIENT_ID:undefined,PRONTO_DEMO_CHANNEL_ID:undefined,PRONTO_DEMO_SLUG:undefined,PRONTO_DEMO_SEED:undefined,
 PRONTO_CHOPE_LIVE_READS:'0',CHOPE_LIVE_READ_APPROVED:'0',
 PRONTO_SECRETS_KEY:'disposable-test-secrets-key-with-more-than-32-characters',AUTH_SECRET:'disposable-test-auth-secret-with-more-than-32-characters',
 APP_BASE_URL:'http://localhost:3000'};
let passed=false;
async function command(name:string,argv:string[]){
 console.log(`${name}: running on a newly owned marked PostgreSQL fixture…`);
 const log=createWriteStream(join(output,name+'.log'),{mode:0o600});
 const child=spawn('pnpm',argv,{env,stdio:['ignore','pipe','pipe'],detached:true});
 child.stdout.pipe(log,{end:false});child.stderr.pipe(log,{end:false});
 const timer=setTimeout(()=>{if(child.pid && child.exitCode===null && child.signalCode===null)process.kill(-child.pid,'SIGKILL');},15*60*1000);
 try{await new Promise<void>((done,fail)=>{child.once('error',fail);child.once('close',code=>code===0?done():fail(new Error(`${name} failed; inspect ${join(output,name+'.log')}.`)));});}
 finally{clearTimeout(timer);if(child.pid && child.exitCode===null && child.signalCode===null)process.kill(-child.pid,'SIGKILL');await new Promise<void>(done=>log.end(done));}
}
try{
 await command('migrate',['migrate:test']);await command('migrate-repeat',['migrate:test']);await command('seed',['seed:test']);
 await command(evaluation?'eval':'database',evaluation?['eval']:['test:db',...(file?[file]:[])]);
 passed=true;
}finally{
 await fixture.close();
 await writeFile(join(output,'result.json'),JSON.stringify({runId,status:passed?'passed':'failed',cleanup:true,evaluation,file})+'\n',{mode:0o600});
 console.log(`Disposable database run ${runId}: ${passed?'passed':'failed'}; owned fixture cleaned up.`);
}
