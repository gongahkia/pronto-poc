import {LiveEvalBudget} from './live-eval-budget';

// Meter the actual worker requests, including SDK retries. This is intentionally
// restricted to the local Luna evaluation profile and the original shared cap.
export function budgetedLunaFetch(budget:LiveEvalBudget,nativeFetch:typeof fetch=globalThis.fetch):typeof fetch{
 let stopped=false;
 return async(resource,init)=>{
  if(stopped)throw new Error('The local evaluation transport stopped after a budget/accounting error.');
  const request=new Request(resource,init),url=new URL(request.url);
  if(!['https://api.openai.com','https://us.api.openai.com','https://eu.api.openai.com'].includes(url.origin)||
    url.pathname!=='/v1/responses'||url.search||request.method!=='POST')
   throw new Error('The bounded local worker permits only official OpenAI Responses requests.');
  const body=await request.clone().json();
  if(body.model!=='gpt-6-luna'||body.reasoning?.effort!=='low'||body.store!==false)
   throw new Error('The bounded local worker requires Luna, low effort and store=false.');
  body.service_tier='default';
  const serialized=JSON.stringify(body);
  let charge:string;
  try{charge=await budget.reserve(serialized,body.max_output_tokens);}
  catch(error){stopped=true;throw error;}
  // A timeout retains the reservation; the SDK may retry, with a new reserved
  // request. Never reuse a reservation for an unobserved provider response.
  const headers=new Headers(request.headers);headers.delete('content-length');
  const response=await nativeFetch(new Request(request,{body:serialized,headers,redirect:'error'}));
  const result=await response.clone().json().catch(()=>undefined);
  if(response.ok&&(!result?.id?.startsWith('resp_')||!result?.model?.startsWith('gpt-6-luna'))){
   stopped=true;throw new Error('Unexpected provider identity; the local evaluation transport is stopped.');
  }
  try{await budget.settle(charge,result?.usage);}
  catch(error){stopped=true;throw error;}
  return response;
 };
}
