import {it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {LiveEvalBudget} from '../../scripts/live-eval-budget';
import {budgetedLunaFetch} from '../../scripts/luna-budget-transport';
const folders:string[]=[];
afterEach(async()=>{for(const path of folders.splice(0))await rm(path,{recursive:true,force:true});});
async function setup(){const folder=await mkdtemp(join(tmpdir(),'pronto-worker-budget-'));folders.push(folder);const path=join(folder,'budget.json');return {budget:new LiveEvalBudget(path),path};}
const body={model:'gpt-6-luna',reasoning:{effort:'low'},store:false,max_output_tokens:1000,input:'Synthetic customer enquiry'};
const init={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)};
it('reserves worker requests before HTTP and settles actual provider usage',async()=>{
 const {budget}=await setup();
 const fetchImpl=vi.fn(async(request:RequestInfo|URL)=>{
  expect((await budget.summary()).uncertainRequests).toBe(1);
  expect(await (request as Request).json()).toMatchObject({service_tier:'default',reasoning:{effort:'low'}});
  return Response.json({id:'resp_synthetic',model:'gpt-6-luna',usage:{input_tokens:100,output_tokens:50}});
 });
 await budgetedLunaFetch(budget,fetchImpl)('https://us.api.openai.com/v1/responses',init);
 expect((await budget.summary()).uncertainRequests).toBe(0);
});
it('blocks an exhausted allowance before any HTTP request',async()=>{
 const {budget,path}=await setup();await writeFile(path,JSON.stringify({limitUsd:5,charges:[{id:'prior',reservedUsd:5}]}));
 const fetchImpl=vi.fn();await expect(budgetedLunaFetch(budget,fetchImpl)('https://us.api.openai.com/v1/responses',init)).rejects.toThrow('exhausted');
 expect(fetchImpl).not.toHaveBeenCalled();
});
it('blocks other providers and models without reserving or sending',async()=>{
 const {budget}=await setup(),fetchImpl=vi.fn(),guard=budgetedLunaFetch(budget,fetchImpl);
 await expect(guard('https://evil.example/v1/responses',init)).rejects.toThrow('official');
 await expect(guard('https://us.api.openai.com/v1/responses',{...init,body:JSON.stringify({...body,model:'another-model'})})).rejects.toThrow('Luna');
 expect(fetchImpl).not.toHaveBeenCalled();expect((await budget.summary()).requests).toBe(0);
});
it('keeps unknown usage reserved after a worker timeout',async()=>{
 const {budget}=await setup(),fetchImpl=vi.fn(async()=>{throw new Error('Synthetic timeout');});
 await expect(budgetedLunaFetch(budget,fetchImpl)('https://us.api.openai.com/v1/responses',init)).rejects.toThrow('timeout');
 expect((await budget.summary()).uncertainRequests).toBe(1);
});
