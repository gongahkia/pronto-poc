import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {parseDemoBusinessProfile,demoBusinessProfileHash,demoBusinessEnvironment} from '../src/lib/demo-business-profile';
import {prepareDemoBusiness,planDemoBusinessActivation,savedDemoBusinessIds,assertDemoBusinessOperator} from '../src/lib/demo-business-provisioning';
import {enterTenantContext} from '../src/lib/tenant-context';
import {getPool} from '../src/lib/db';
import {z} from 'zod';

const {values,positionals}=parseArgs({allowPositionals:true,options:{profile:{type:'string'},'actor-id':{type:'string'},
 'profile-hash':{type:'string'},'env-out':{type:'string'},'detach-instagram':{type:'boolean'}}});
const command=positionals[0];
let databaseUsed=false;
async function readProfile(path:string){
 const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const stat=await file.stat();if(!stat.isFile()||stat.size>512*1024)throw new Error('Choose a regular business profile JSON file under 512 KiB.');
  return parseDemoBusinessProfile(JSON.parse(await file.readFile('utf8')));
 }finally{await file.close();}
}
async function writeEnvironment(path:string,environment:Record<string,string>){
 const file=await open(path,'wx',0o600);
 try{await file.writeFile(Object.entries(environment).map(([key,value])=>`${key}=${value}`).join('\n')+'\n');await file.sync();}
 finally{await file.close();}
}
try{
 if(positionals.length!==1||!['plan','prepare','activation-plan','list'].includes(command))throw new Error('Use plan, prepare, activation-plan or list with named options.');
 if(values['actor-id']&&!z.uuid().safeParse(values['actor-id']).success)throw new Error('Use a valid existing operator UUID for --actor-id.');
 if(values['env-out']&&command!=='activation-plan'||values['detach-instagram']&&command!=='activation-plan'||values['profile-hash']&&command!=='prepare')
  throw new Error('Use --profile-hash only with prepare; --env-out and --detach-instagram only with activation-plan.');
 if(command==='list'&&values.profile)throw new Error('List does not accept a profile.');
 enterTenantContext({role:'operator',clientId:null});
 if(command==='list'){
  databaseUsed=true;
  if(!values['actor-id'])throw new Error('Provide --actor-id for an existing demo operator.');
  await assertDemoBusinessOperator(values['actor-id']);
  console.log(JSON.stringify({businessIds:await savedDemoBusinessIds()},null,2));
 }else{
  if(!values.profile)throw new Error('Provide --profile JSON_FILE.');
  const profile=await readProfile(values.profile),hash=demoBusinessProfileHash(profile);
  if(command==='plan')console.log(JSON.stringify({identity:profile.identity,name:profile.name,profileHash:hash,
   sourceCount:profile.knowledge.length,environment:demoBusinessEnvironment(profile.identity),writes:false,
   credentialsIncluded:false,activationRequiresDatabaseChecks:true},null,2));
  else{
   databaseUsed=true;
   if(!values['actor-id'])throw new Error('Provide --actor-id for an existing demo operator.');
   if(command==='prepare'){
    if(!values['profile-hash'])throw new Error('Review plan first, then provide its exact --profile-hash.');
    console.log(JSON.stringify(await prepareDemoBusiness(profile,values['actor-id'],values['profile-hash']),null,2));
   }else{
    const plan=await planDemoBusinessActivation(profile,values['actor-id'],values['detach-instagram']);
    if(values['env-out'])await writeEnvironment(values['env-out'],plan.environment);
    console.log(JSON.stringify(plan,null,2));
   }
  }
 }
}catch(error){console.error(error instanceof Error&&!(error as {code?:string}).code?error.message:'Demo business operation failed. Existing businesses and credentials were retained.');process.exitCode=1;}
finally{if(databaseUsed)await getPool().end();}
