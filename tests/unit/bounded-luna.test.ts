import {describe,expect,it,afterEach,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {boundedLunaCall} from '../../scripts/bounded-luna';
import {LiveEvalBudget} from '../../scripts/live-eval-budget';
const folders:string[]=[];
afterEach(async()=>{for(const folder of folders.splice(0))await rm(folder,{recursive:true,force:true});});
async function setup(){const folder=await mkdtemp(join(tmpdir(),'pronto-review-budget-'));folders.push(folder);return new LiveEvalBudget(join(folder,'budget.json'));}
const request={instructions:'Test reviewer',data:{customer:'Synthetic'},schema:{type:'object'},name:'pronto_semantic_review',apiKey:'synthetic-key',baseUrl:'https://us.api.openai.com/v1'};
describe('bounded critic transport',()=>{
 it('reserves before sending and settles only verified provider usage',async()=>{
  const budget=await setup();
  const fetchImpl=vi.fn(async(_url:RequestInfo|URL,init?:RequestInit)=>{
   expect((await budget.summary()).uncertainRequests).toBe(1);
   const body=JSON.parse(String(init?.body));
   expect(body).toMatchObject({model:'gpt-6-luna',reasoning:{effort:'low'},store:false,max_output_tokens:1000,service_tier:'default'});
   return Response.json({id:'response',model:'gpt-6-luna',usage:{input_tokens:100,output_tokens:50},output:[{type:'message',content:[{type:'output_text',text:'{}'}]}]});
  });
  const result=await boundedLunaCall({...request,budget,fetchImpl});
  expect(result.responseId).toBe('response');expect((await budget.summary()).uncertainRequests).toBe(0);
  expect(JSON.stringify(result)).not.toContain('synthetic-key');
 });
 it('rejects nonofficial endpoints before either reserving or sending',async()=>{
  const budget=await setup(),fetchImpl=vi.fn();
  await expect(boundedLunaCall({...request,budget,fetchImpl,baseUrl:'https://evil.example/v1'})).rejects.toThrow('official');
  expect(fetchImpl).not.toHaveBeenCalled();expect((await budget.summary()).requests).toBe(0);
 });
 it('retains a failed request reservation and never retries a provider error',async()=>{
  const budget=await setup(),fetchImpl=vi.fn(async()=>new Response('{}',{status:429}));
  await expect(boundedLunaCall({...request,budget,fetchImpl})).rejects.toThrow('429');
  expect(fetchImpl).toHaveBeenCalledTimes(1);expect((await budget.summary()).uncertainRequests).toBe(1);
 });
 it('serializes concurrent ledger updates without dropping reservations',async()=>{
  const budget=await setup();await Promise.all(Array.from({length:12},()=>budget.reserve('{}',1000)));
  expect((await budget.summary()).requests).toBe(12);
 });
});
