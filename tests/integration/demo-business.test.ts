import {getAssistantDraft,publishAssistantDraft} from '@/lib/assistant-drafts';
import {approveConfiguration} from '@/lib/managed-approvals';
import {submitKnowledgeSource,reviewSourceSubmission,stageApprovedSourceSubmission} from '@/lib/knowledge/submissions';
import {hasOnlyProtectedDemoKnowledge} from '@/lib/knowledge/protected-demo';
import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {getPool} from '@/lib/db';
import {enterTenantContext} from '@/lib/tenant-context';
import {parseDemoBusinessProfile,demoBusinessProfileHash,demoBusinessEnvironment} from '@/lib/demo-business-profile';
import {prepareDemoBusiness,planDemoBusinessActivation,savedDemoBusinessIds} from '@/lib/demo-business-provisioning';
import {assertSavedDemoWorkspaces} from '@/lib/demo-business-preflight';
import {createGuestReviewer} from '@/lib/guest-access';
import {createDemoSession,getDemoState,sendDemoMessage} from '@/lib/customer-demo';
import {retrieveKnowledgeText} from '@/lib/knowledge/retrieve';
import {processInboundJob} from '@/lib/channels/inbox-worker';
import {FreeTierProvider,freeProviderApiKey} from '@/lib/llm/free-providers';
import {withAiExecutionProfile} from '@/lib/llm/execution-mode';
import {flushRetryableOutboundMessages} from '@/lib/channels/outbox';
import original from '../../config/demo-businesses/ps-cafe.json';
import example from '../../config/demo-businesses/example-business.json';

const dbDescribe=process.env.PRONTO_RUN_DB_TESTS==='1'?describe:describe.skip;
const first=parseDemoBusinessProfile(original),second=parseDemoBusinessProfile(example);
const operator='00000000-0000-4000-8000-00000000d101';
const asActor=(u:Awaited<ReturnType<typeof createGuestReviewer>>)=>({userId:u.id,clientId:u.client_id,role:u.role,email:u.email,name:u.name});
const select=(profile:typeof first)=>{for(const [key,value]of Object.entries(demoBusinessEnvironment(profile.identity)))vi.stubEnv(key,value);};
dbDescribe('separate saved demo businesses',()=>{
 beforeEach(async()=>{
  vi.stubEnv('PRONTO_CUSTOMER_DEMO_ENABLED','1');
  enterTenantContext({role:'operator',clientId:null});
  await getPool().query("insert into users(id,email,name,role,password_hash) values($1,'saved-business-operator@demo.invalid','Saved business operator','operator','!') on conflict(id) do nothing",[operator]);
  await getPool().query('delete from clients where id=any($1::uuid[])',[[first.identity.clientId,second.identity.clientId]]);
 });
 afterEach(async()=>{
  enterTenantContext({role:'operator',clientId:null});vi.restoreAllMocks();vi.unstubAllEnvs();
  await getPool().query('delete from clients where id=any($1::uuid[])',[[first.identity.clientId,second.identity.clientId]]);
  await getPool().query('delete from users where id=$1',[operator]);
 });
 afterAll(async()=>{await getPool().end();});
 const prepare=(profile:typeof first)=>prepareDemoBusiness(profile,operator,demoBusinessProfileHash(profile));

 it('prepares idempotently, preserves edited settings and refuses changed or occupied profiles',async()=>{
  await expect(prepareDemoBusiness(first,operator,'stale')).rejects.toThrow(/Profile changed/);
  await expect(prepareDemoBusiness(first,randomUUID(),demoBusinessProfileHash(first))).rejects.toThrow(/named demo operator/);
  expect(await prepare(first)).toMatchObject({created:true});
  await getPool().query("update clients set brand_voice='Locally reviewed voice' where id=$1",[first.identity.clientId]);
  expect(await prepare(first)).toMatchObject({created:false,preserved:true});
  expect((await getPool().query('select brand_voice from clients where id=$1',[first.identity.clientId])).rows[0].brand_voice).toBe('Locally reviewed voice');
  expect(await prepare(second)).toMatchObject({created:true});
  const edited=structuredClone(second);edited.knowledge[0].content+=' Changed fact.';
  await expect(prepare(edited)).rejects.toThrow(/different profile/);
  const collision=structuredClone(second);collision.identity.clientId=randomUUID();
  await expect(prepare(collision)).rejects.toThrow(/occupied/);
  expect(await savedDemoBusinessIds()).toEqual(expect.arrayContaining([first.identity.clientId,second.identity.clientId]));
 });

 it('keeps history and facts separate through A → B → A, using the real durable pipeline with a canned model',async()=>{
  await prepare(first);await prepare(second);
  const guestA=asActor(await createGuestReviewer('Business A guest','test-a'));
  const chatA=await createDemoSession(guestA,'mock');
  await getPool().query(`insert into messages(client_id,conversation_id,channel_id,external_message_id,sender_role,body)
   values($1,$2,$3,'saved-a-history','customer','Original business A history')`,[first.identity.clientId,chatA.conversationId,first.identity.channelId]);
  select(second);
  await expect(createDemoSession(guestA,'mock')).rejects.toThrow(/Forbidden/);
  const guestB=asActor(await createGuestReviewer('Business B guest','test-b'));
  expect(guestB.clientId).toBe(second.identity.clientId);
  vi.stubEnv('GROQ_API_KEY','synthetic-not-live');vi.stubEnv('PRONTO_DEMO_REAL_AI_APPROVED','1');vi.stubEnv('PRONTO_GROQ_FREE_TIER_CONFIRMED','1');
  const profile={mode:'real' as const,provider:'groq' as const,model:'openai/gpt-oss-20b',embeddingProvider:'none' as const,embeddingModel:'none',retrievalMode:'local_text' as const,syntheticDemo:true};
  expect(await withAiExecutionProfile(profile,async()=>freeProviderApiKey('groq',second.identity.clientId))).toBe('synthetic-not-live');
  await expect(withAiExecutionProfile(profile,async()=>freeProviderApiKey('groq',first.identity.clientId))).rejects.toThrow(/selected synthetic/);
  vi.spyOn(FreeTierProvider.prototype,'generateGroundedAnswer').mockImplementation(async input=>{
   expect(input.clientId).toBe(second.identity.clientId);
   expect(input.retrievedChunks.every(chunk=>chunk.client_id===second.identity.clientId)).toBe(true);
   return {action:'answer',answer:"We're open from 7:00am to 3:00pm daily.",confidence:0.99,reasonCode:'grounded_answer',reasonDetail:'Canned provider; no external call.',citedChunkIds:[input.retrievedChunks[0].id],actualModel:input.responseModel};
  });
  const chatB=await createDemoSession(guestB,'real','groq-oss');
  await expect(getDemoState(guestB,chatA.id)).rejects.toThrow(/not found/);
  const chunks=await retrieveKnowledgeText(second.identity.clientId,'opening hours');
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every(chunk=>chunk.client_id===second.identity.clientId)).toBe(true);
  expect(chunks.map(chunk=>chunk.content).join(' ')).toContain('7:00am');
  expect(chunks.map(chunk=>chunk.content).join(' ')).not.toContain('PS.Cafe');
  expect(await retrieveKnowledgeText(first.identity.clientId,'opening hours')).toEqual([]);
  const job=await sendDemoMessage(guestB,{sessionId:chatB.id,requestId:randomUUID(),text:'What are your opening hours?'});
  expect(await processInboundJob({jobId:job.jobId})).toMatchObject({outcome:'answered'});
  await flushRetryableOutboundMessages();
  const stateB=await getDemoState(guestB,chatB.id);
  expect(stateB.messages).toHaveLength(2);
  expect(String(stateB.messages[1].body)).toContain('7:00am');
  select(first);
  const stateA=await getDemoState(guestA,chatA.id);
  expect(stateA.messages).toHaveLength(1);
  expect(stateA.messages[0].body).toBe('Original business A history');
  expect((await getPool().query('select client_id from conversations where id=$1',[chatB.conversationId])).rows[0].client_id).toBe(second.identity.clientId);
 });

 it('plans without changing the active business and requires explicit Instagram detachment',async()=>{
  await prepare(first);await prepare(second);
  await expect(planDemoBusinessActivation(second,operator)).resolves.toMatchObject({historyRetained:true,restartRequired:true,credentialsCopied:false,environment:demoBusinessEnvironment(second.identity)});
  vi.stubEnv('PRONTO_DEMO_INSTAGRAM_ENABLED','1');
  await expect(planDemoBusinessActivation(second,operator)).rejects.toThrow(/Instagram remains bound/);
  expect((await planDemoBusinessActivation(second,operator,true)).environment.PRONTO_DEMO_INSTAGRAM_ENABLED).toBe('0');
  expect(process.env.PRONTO_DEMO_INSTAGRAM_ENABLED).toBe('1');
  expect((await getPool().query('select count(*)::int n from channels where client_id=any($1::uuid[]) and kind<>\'console\'',[[first.identity.clientId,second.identity.clientId]])).rows[0].n).toBe(0);
  // The ordinary seeded tenant is deliberately ineligible for the protected boundary.
  await expect(assertSavedDemoWorkspaces([operator])).rejects.toThrow(/Only prepared/);
 });

 it('keeps new-business knowledge drafts private until exact-revision approval and publication',async()=>{
  await prepare(first);await prepare(second);select(second);
  const staff=asActor(await createGuestReviewer('Studio editor','studio-editor'));
  const reviewer=asActor(await createGuestReviewer('Studio reviewer','studio-reviewer'));
  const clientId=second.identity.clientId;
  const op={userId:operator,clientId:null,role:'operator' as const,email:'saved-business-operator@demo.invalid',name:'Operator'};
  const submission=await submitKnowledgeSource({actor:staff,clientId,sourceType:'text',title:'Studio equipment',content:'Guests may borrow a violet umbrella from the studio desk.'});
  expect(await retrieveKnowledgeText(clientId,'violet umbrella')).toEqual([]);
  await expect(stageApprovedSourceSubmission({actor:op,clientId,submissionId:submission.id,expectedRevision:1})).rejects.toThrow(/business approval/);
  await reviewSourceSubmission({actor:reviewer,clientId,submissionId:submission.id,expectedRevision:1,decision:'approve',note:'Reviewed fictional studio fact.'});
  await stageApprovedSourceSubmission({actor:op,clientId,submissionId:submission.id,expectedRevision:1});
  expect(await retrieveKnowledgeText(clientId,'violet umbrella')).toEqual([]);
  await expect(publishAssistantDraft(clientId,operator)).rejects.toThrow(/business approval/);
  const draft=await getAssistantDraft(clientId);
  await approveConfiguration({actor:reviewer,clientId,kind:'assistant',targetId:clientId,revision:String(draft!.edit_version),evidence:'Reviewed exact studio revision.'});
  await publishAssistantDraft(clientId,operator);
  expect((await retrieveKnowledgeText(clientId,'violet umbrella')).map(chunk=>chunk.client_id)).toEqual([clientId]);
  expect(await retrieveKnowledgeText(first.identity.clientId,'violet umbrella')).toEqual([]);
  expect(await hasOnlyProtectedDemoKnowledge({query:(text,values)=>getPool().query(text,values)},clientId)).toBe(true);
 });

 it('validates both saved workspaces together and rejects forged or wrong-database text enrollment',async()=>{
  await prepare(first);await prepare(second);
  const db=await getPool().connect();
  try{
   await db.query('begin');
   // remove only the ordinary seed inside a rollback-only transaction so the
   // production preflight sees an otherwise empty synthetic deployment.
   await db.query("delete from clients where id='00000000-0000-4000-8000-000000000001'");
   await db.query("update users set email='seed-operator@demo.invalid' where id='00000000-0000-4000-8000-000000000101'");
   const allowed=[operator,'00000000-0000-4000-8000-000000000101'];
   expect(await assertSavedDemoWorkspaces(allowed,db)).toMatchObject({businesses:2,activeClientId:first.identity.clientId});
   select(second);
   expect(await assertSavedDemoWorkspaces(allowed,db)).toMatchObject({businesses:2,activeClientId:second.identity.clientId});
   await db.query("update demo_business_knowledge_scopes set database_marker='pronto:protected-demo:v1:00000000-0000-4000-8000-000000000099' where client_id=$1",[second.identity.clientId]);
   await expect(db.query('update knowledge_chunks set content=content where client_id=$1',[second.identity.clientId])).rejects.toThrow(/explicit enrollment/);
  }finally{await db.query('rollback');db.release();}
  const seedSource=(await getPool().query("select id from knowledge_sources where client_id='00000000-0000-4000-8000-000000000001' limit 1")).rows[0].id;
  await expect(getPool().query(`insert into knowledge_chunks(source_id,client_id,chunk_index,content,token_estimate,embedding,embedding_model,embedding_dimensions,metadata)
   values($1,'00000000-0000-4000-8000-000000000001',999,'Forged text scope',5,null,'none',0,
   '{"retrievalMode":"local_text","retrievalProfile":"postgres-fts-simple-v1","retrievalScope":"instagram_hosted_test"}')`,[seedSource])).rejects.toThrow(/explicit enrollment/);
 });

 it('blocks switching while delivery work remains unresolved without modifying that work',async()=>{
  await prepare(first);await prepare(second);
  const actor=asActor(await createGuestReviewer('Pending work','test-work'));
  const chat=await createDemoSession(actor,'mock');
  const job=await sendDemoMessage(actor,{sessionId:chat.id,requestId:randomUUID(),text:'Hello'});
  await expect(planDemoBusinessActivation(second,operator)).rejects.toThrow(/pending, in-flight/);
  expect((await getPool().query('select status from inbound_jobs where id=$1',[job.jobId])).rows[0].status).toBe('pending');
  await getPool().query("update inbound_jobs set status='dead' where id=$1",[job.jobId]);
  await expect(planDemoBusinessActivation(second,operator)).resolves.toMatchObject({historyRetained:true});
 });
});
