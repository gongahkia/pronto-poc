import {query,transaction,type Queryable} from '@/lib/db';
import {recordAuditLog} from '@/lib/audit';
import {chunkText} from '@/lib/knowledge/chunk';
import {LOCAL_TEXT_RETRIEVAL_PROFILE} from '@/lib/llm/demo-models';
import {assertCustomerDemoEnabled} from '@/lib/customer-demo-boundary';
import {protectedDemoDeployment,protectedDemoConfiguration} from '@/lib/deployment-profile';
import {demoBusinessScope,LEGACY_DEMO_SCOPE} from '@/lib/demo-business';
import {demoBusinessEnvironment,demoBusinessProfileHash,type DemoBusinessProfile} from '@/lib/demo-business-profile';

export async function assertDemoBusinessOperator(actorId:string,db:Queryable={query}){
 await assertCustomerDemoEnabled(db);
 const actor=(await db.query<{id:string}>("select id from users where id=$1 and role='operator' and client_id is null",[actorId])).rows[0];
 if(!actor||protectedDemoDeployment()&&!protectedDemoConfiguration().allowedUserIds.includes(actor.id))
  throw new Error('An existing named demo operator is required.');
}

// Only legacy identity or an operator-audited prepared workspace is eligible for
// the saved-demo boundary. Ordinary tenants are never adopted by a profile flag.
export async function savedDemoBusinessIds(db:Queryable={query}){
 const rows=await db.query<{id:string}>(`select c.id from clients c where
  (c.id=$1 and c.slug=$2 and c.business_profile->>'demoSeed'=$3)
  or (c.business_profile->'demoBusiness'->>'version'='1'
   and c.business_profile->>'approvedByRestaurant'='false'
   and exists(select 1 from audit_logs a join users u on u.id=a.actor_user_id and u.role='operator'
    where a.client_id=c.id and a.action='demo.business_prepared' and a.target_id=c.id
     and a.metadata->>'profileHash'=c.business_profile->'demoBusiness'->>'profileHash'))`,
 [LEGACY_DEMO_SCOPE.clientId,LEGACY_DEMO_SCOPE.slug,LEGACY_DEMO_SCOPE.seed]);
 return rows.rows.map(row=>row.id);
}

export async function prepareDemoBusiness(profile:DemoBusinessProfile,actorId:string,expectedHash:string){
 const hash=demoBusinessProfileHash(profile),scope=profile.identity;
 if(hash!==expectedHash)throw new Error('Profile changed; review its current plan and exact hash before preparing it.');
 return transaction(async db=>{
  await assertDemoBusinessOperator(actorId,db);
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['pronto:demo-business:'+scope.clientId]);
  const existing=(await db.query<{slug:string;business_profile:Record<string,unknown>}>(
   'select slug,business_profile from clients where id=$1 for update',[scope.clientId])).rows[0];
  if(existing){
   if(existing.slug!==scope.slug||existing.business_profile.demoSeed!==scope.seed||!(await savedDemoBusinessIds(db)).includes(scope.clientId))
    throw new Error('This identity is occupied by another business. Nothing was overwritten.');
   const saved=existing.business_profile.demoBusiness as {profileHash?:string}|undefined;
   if(saved?.profileHash&&saved.profileHash!==hash)throw new Error('This business was prepared from a different profile. Use its existing approval workflow to edit it; nothing was overwritten.');
   return {created:false,clientId:scope.clientId,preserved:true};
  }
  const collision=await db.query(`select 1 from clients where slug=$1 union all select 1 from channels where id=$2
   union all select 1 from knowledge_sources where id=any($3::uuid[])`,[scope.slug,scope.channelId,profile.knowledge.map(source=>source.id)]);
  if(collision.rowCount)throw new Error('A slug, channel or source identity is already occupied. Choose distinct identities.');
  await db.query(`insert into clients(id,name,slug,vertical,status,brand_voice,business_profile)
   values($1,$2,$3,$4,'pilot',$5,$6::jsonb)`,[scope.clientId,profile.name,scope.slug,profile.vertical,profile.voice.content,
   JSON.stringify({demoSeed:scope.seed,timezone:profile.timezone,approvedByRestaurant:false,
    demoBusiness:{version:1,profileHash:hash},demoPresentation:profile.presentation,
    chopeAvailability:{enabled:false},reservationPolicy:{directBooking:false,liveAvailability:false}})]);
  await db.query(`insert into channels(id,client_id,kind,name,status,settings) values($1,$2,'console','Customer demo','active','{"transport":"customer_simulator"}')`,[scope.channelId,scope.clientId]);
  await db.query(`insert into agent_configs(client_id,prompt_preamble,retrieval_threshold)
   values($1,'Unofficial demonstration. Answer only from approved business sources. Do not invent policies or claim booking, payment or refund actions.',0.05)`,[scope.clientId]);
  await db.query(`insert into brand_voice_documents(client_id,title,content,attributes,source_notes) values($1,$2,$3,$4,$5)`,
   [scope.clientId,profile.voice.title,profile.voice.content,profile.voice.attributes??{},profile.voice.sourceNotes??null]);
  for(const example of profile.voice.examples)await db.query(`insert into brand_voice_examples(client_id,customer_message,ideal_response,notes,is_active)
   values($1,$2,$3,$4,$5)`,[scope.clientId,example.customerMessage,example.idealResponse,example.notes,example.active]);
  for(const source of profile.knowledge){
   const metadata={demoSeed:true,approvedByRestaurant:false,reviewStatus:source.reviewStatus,sourceUrl:source.url??null,
    secondaryUrl:source.secondaryUrl??null,demoBusinessProfileHash:hash};
   await db.query(`insert into knowledge_sources(id,client_id,title,source_type,content,metadata) values($1,$2,$3,'curated_demo',$4,$5)`,
    [source.id,scope.clientId,source.title,source.content,metadata]);
   for(const [index,chunk]of chunkText(source.content,{maxCharacters:900,overlap:120}).entries())await db.query(`insert into knowledge_chunks
    (source_id,client_id,chunk_index,content,token_estimate,embedding,embedding_model,embedding_dimensions,metadata)
    values($1,$2,$3,$4,$5,null,'none',0,$6)`,[source.id,scope.clientId,index,chunk.content,chunk.tokenEstimate,
    {...metadata,retrievalMode:'local_text',retrievalProfile:LOCAL_TEXT_RETRIEVAL_PROFILE}]);
  }
  await recordAuditLog({clientId:scope.clientId,actorUserId:actorId,action:'demo.business_prepared',targetType:'client',targetId:scope.clientId,
   metadata:{profileHash:hash,unofficialDemo:true,sourceCount:profile.knowledge.length,externalCredentialsCopied:false}},db);
  return {created:true,clientId:scope.clientId,preserved:true};
 });
}

export async function planDemoBusinessActivation(profile:DemoBusinessProfile,actorId:string,detachInstagram=false){
 await assertDemoBusinessOperator(actorId);
 const target=profile.identity,current=demoBusinessScope();
 const row=(await query<{slug:string;business_profile:Record<string,unknown>}>(
  'select slug,business_profile from clients where id=$1',[target.clientId])).rows[0];
 if(!row||row.slug!==target.slug||row.business_profile.demoSeed!==target.seed||!(await savedDemoBusinessIds()).includes(target.clientId))
  throw new Error('Prepare the target business before planning activation.');
 const channel=(await query(`select id from channels where id=$1 and client_id=$2 and kind='console'
  and status='active' and settings->>'transport'='customer_simulator'`,[target.channelId,target.clientId])).rows[0];
 if(!channel)throw new Error('The target console channel is not prepared.');
 const ready=(await query<{ready:boolean}>(`select exists(select 1 from agent_configs where client_id=$1)
  and exists(select 1 from knowledge_sources s join knowledge_chunks k on k.source_id=s.id and k.client_id=s.client_id
   where s.client_id=$1 and coalesce(s.metadata->>'archived','false')<>'true'
    and coalesce(s.metadata->>'reviewStatus','') not ilike '%conflict%') ready`,[target.clientId])).rows[0];
 if(!ready?.ready)throw new Error('The target business needs agent configuration and available published knowledge before activation.');
 const work=(await query<{busy:number}>(`select ((select count(*) from inbound_jobs where client_id=$1 and status in ('pending','processing','failed'))+
  (select count(*) from outbound_messages where client_id=$1 and status in ('pending','sending','failed','uncertain')))::int busy`,[current.clientId])).rows[0];
 const switching=current.clientId!==target.clientId;
 if(switching&&work.busy)throw new Error('Current business has pending, in-flight, failed or uncertain work. Drain or reconcile it before switching. Nothing was changed.');
 const hasInstagram=process.env.PRONTO_DEMO_INSTAGRAM_ENABLED==='1';
 if(switching&&hasInstagram&&!detachInstagram)throw new Error('Instagram remains bound to the current business. Use --detach-instagram for a console-only switch, or prepare an explicitly approved target binding.');
 return {current,target,alreadyActive:!switching,environment:{...demoBusinessEnvironment(target),
  ...(switching&&hasInstagram?{PRONTO_DEMO_INSTAGRAM_ENABLED:'0'}:{})},restartRequired:true,
  historyRetained:true,credentialsCopied:false,oldSessions:'Retained under the original business; sign out and enter the demo again after switching.'};
}
