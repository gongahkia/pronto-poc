import {LiveEvalBudget} from './live-eval-budget';
export type LunaCapture={responseId:string;model:string;usage:Record<string,unknown>;outputText:string;durationMs:number};
export async function boundedLunaCall(input:{budget:LiveEvalBudget;instructions:string;data:unknown;schema:Record<string,unknown>;name:string;
  fetchImpl?:typeof fetch;apiKey?:string;baseUrl?:string}):Promise<LunaCapture>{
  const apiKey=input.apiKey??process.env.OPENAI_API_KEY?.trim();
  if(!apiKey)throw new Error('The local OpenAI key is not configured.');
  const base=new URL(input.baseUrl??process.env.OPENAI_BASE_URL??'https://api.openai.com/v1');
  if(!['https://api.openai.com','https://us.api.openai.com','https://eu.api.openai.com'].includes(base.origin)||base.pathname.replace(/\/$/,'')!=='/v1'||base.search||base.hash||base.username||base.password)
    throw new Error('Semantic reviews require an official OpenAI Responses endpoint.');
  const body=JSON.stringify({model:'gpt-6-luna',reasoning:{effort:'low'},service_tier:'default',store:false,max_output_tokens:1000,
    instructions:input.instructions,input:JSON.stringify(input.data),text:{format:{type:'json_schema',name:input.name,strict:true,schema:input.schema}}});
  const charge=await input.budget.reserve(body,1000),start=Date.now();
  const response=await (input.fetchImpl??fetch)(`${base.origin}/v1/responses`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(25000),
    headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'},body});
  if(!response.ok)throw new Error(`Semantic review provider HTTP ${response.status}; reservation retained.`);
  const result=await response.json();
  await input.budget.settle(charge,result.usage);
  if(result.model!=='gpt-6-luna'||typeof result.id!=='string')throw new Error('The reviewer provider identity was not verified.');
  const outputText=(result.output??[]).filter((part:{type:string})=>part.type==='message').flatMap((part:{content?:{type:string;text?:string}[]})=>part.content??[])
    .filter((part:{type:string})=>part.type==='output_text').map((part:{text:string})=>part.text).join('\n');
  return {responseId:result.id,model:result.model,usage:result.usage,outputText,durationMs:Date.now()-start};
}
