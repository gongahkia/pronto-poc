import OpenAI from 'openai';
import { envApiKeyForProvider } from './credentials';
import { freeProviderApiKey } from './free-providers';
import { demoModelChoices } from './demo-models';
import { LlmConfigurationError, normalizeProviderError } from './errors';
import type { LlmTokenUsage } from './types';

type Input = { signal?: AbortSignal; clientId: string; provider: string; model: string; instructions: string; data: string; schema: Record<string,unknown> };
export async function generateStructuredInsights(input: Input): Promise<{ value: unknown; usage?: LlmTokenUsage; responseId: string; actualModel: string }> {
  const free = input.provider==='groq' || input.provider==='gemini';
  if(!['openai','azure','anthropic','groq','gemini'].includes(input.provider))throw new LlmConfigurationError(input.provider,'Analytics requires a real model.');
  if(free&&!demoModelChoices.some(choice=>choice.provider===input.provider&&choice.model===input.model))throw new Error('Unsupported analytics model.');
  const key = free ? freeProviderApiKey(input.provider as 'groq'|'gemini',input.clientId) : envApiKeyForProvider(input.provider);
  if(!key)throw new LlmConfigurationError(input.provider,'The analytics model has no configured API key.');
  try {
    if(input.provider==='anthropic'){
      const response=await fetch(`${process.env.ANTHROPIC_BASE_URL??'https://api.anthropic.com'}/v1/messages`,{method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},signal:input.signal?AbortSignal.any([input.signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),
        body:JSON.stringify({model:input.model,max_tokens:4000,system:input.instructions,messages:[{role:'user',content:input.data}],
          tools:[{name:'conversation_insights',description:'Return evidence-based conversation analytics.',input_schema:input.schema}],tool_choice:{type:'tool',name:'conversation_insights'}})});
      if(!response.ok)throw {status:response.status};
      const body=await response.json() as {id:string;model:string;content?:{type:string;input?:unknown}[];usage?:{input_tokens:number;output_tokens:number}};
      return {value:body.content?.find(item=>item.type==='tool_use')?.input,responseId:body.id,actualModel:body.model,
        ...(body.usage?{usage:{inputTokens:body.usage.input_tokens,outputTokens:body.usage.output_tokens}}:{})};
    }
    const azure=process.env.AZURE_OPENAI_ENDPOINT?.trim().replace(/\/+$/,'');
    if(input.provider==='azure'&&!azure)throw new LlmConfigurationError('azure','Azure endpoint is missing.');
    const baseURL=input.provider==='groq'?'https://api.groq.com/openai/v1/' : input.provider==='gemini'?'https://generativelanguage.googleapis.com/v1beta/openai/'
      :input.provider==='azure'?`${azure}${azure?.endsWith('/openai/v1')?'':'/openai/v1'}/`:process.env.OPENAI_BASE_URL;
    const client=new OpenAI({apiKey:key,baseURL,maxRetries:0,timeout:45000});
    if(free){
      const response=await client.chat.completions.create({model:input.model,messages:[{role:'system',content:input.instructions},{role:'user',content:input.data}],
        ...(input.provider==='gemini'?{max_tokens:4000}:{max_completion_tokens:4000}),reasoning_effort:'low',
        response_format:{type:'json_schema',json_schema:{name:'conversation_insights',strict:true,schema:input.schema}}},{signal:input.signal});
      const choice=response.choices[0];
      // Preserve usage even if output is truncated: validation happens after recording the call.
      let value:unknown;try{value=JSON.parse(choice?.message.content??'');}catch{value=null;}
      return {value:choice?.finish_reason==='stop'?value:null,responseId:response.id,actualModel:response.model.replace(/^models\//,''),
        ...(response.usage?{usage:{inputTokens:response.usage.prompt_tokens,outputTokens:response.usage.completion_tokens,
          ...(response.usage.completion_tokens_details?.reasoning_tokens!==undefined?{reasoningTokens:response.usage.completion_tokens_details.reasoning_tokens}:{})}}:{})};
    }
    const response=await client.responses.create({model:input.model,instructions:input.instructions,input:input.data,store:false,max_output_tokens:4000,
      text:{format:{type:'json_schema',name:'conversation_insights',strict:true,schema:input.schema}}},{signal:input.signal});
    let value:unknown;try{value=JSON.parse(response.output_text);}catch{value=null;}
    return {value:response.status==='completed'?value:null,responseId:response.id,actualModel:response.model,
      ...(response.usage?{usage:{inputTokens:response.usage.input_tokens,outputTokens:response.usage.output_tokens,
        ...(response.usage.output_tokens_details?.reasoning_tokens!==undefined?{reasoningTokens:response.usage.output_tokens_details.reasoning_tokens}:{})}}:{})};
  } catch(error){throw normalizeProviderError(input.provider,error);}
}
