// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FreeTierProvider } from "@/lib/llm/free-providers";
import { withAiExecutionProfile } from "@/lib/llm/execution-mode";
import { normalizeProviderError } from "@/lib/llm/errors";
import type { GenerateAnswerInput } from "@/lib/llm/types";

const base: GenerateAnswerInput = { clientId:"00000000-0000-4000-8000-00000000a101",clientName:"Synthetic cafe",
  brandVoice:"Clear",promptPreamble:"Public demonstration",customerMessage:"When do you close?",recentMessages:[],
  retrievedChunks:[],responseModel:"gemini-3.8-flash",maxOutputTokens:256,timeoutMs:1000 };
const decision={action:"answer",answer:"The public demo closes at 10pm.",confidence:0.9,reasonCode:"grounded_answer",reasonDetail:"Public source",citedChunkIds:["source-chunk"]};
const real=<T>(run:()=>T)=>withAiExecutionProfile({mode:"real",syntheticDemo:true},run);
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});

beforeEach(()=>{
  for(const name of ["GEMINI_API_KEY","GROQ_API_KEY"])vi.stubEnv(name,"synthetic-provider-key-never-used-live");
  for(const name of ["PRONTO_DEMO_REAL_AI_APPROVED","PRONTO_GEMINI_FREE_TIER_CONFIRMED","PRONTO_GROQ_FREE_TIER_CONFIRMED"])vi.stubEnv(name,"1");
});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});

describe("bounded Gemini and Groq adapters using injected transport",()=>{
  it.each([['gemini','gemini-3.8-flash','generativelanguage.googleapis.com'],['groq','openai/gpt-oss-20b','api.groq.com'],['gemini','gemini-3.5-flash-lite','generativelanguage.googleapis.com']] as const)("%s validates structured output and preserves provider usage",async(provider,model,host)=>{
    const fetch=vi.fn(async()=>response({id:"synthetic-response-id",model,choices:[{finish_reason:"stop",message:{content:JSON.stringify(decision)}}],usage:{prompt_tokens:120,completion_tokens:40}}));
    vi.stubGlobal("fetch",fetch);
    const result=await real(()=>new FreeTierProvider(provider).generateGroundedAnswer({...base,responseModel:model}));
    expect(result).toMatchObject({...decision,usage:{inputTokens:120,outputTokens:40}});
    const [resource,options]=fetch.mock.calls[0] as unknown as [Request|string,RequestInit];
    expect(new URL(resource instanceof Request ? resource.url : String(resource)).hostname).toBe(host);
    const body=resource instanceof Request ? await resource.json() : JSON.parse(String(options.body));
    expect(body.model).toBe(model);expect(body.response_format.json_schema.strict).toBe(true);
    expect(body[provider==="gemini"?"max_tokens":"max_completion_tokens"]).toBe(256);
    expect(body.tools).toBeUndefined();expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([429,401,503])("normalizes HTTP %i without payload/key leakage or retry",async status=>{
    const fetch=vi.fn(async()=>response({error:{message:"PRIVATE PROMPT synthetic-provider-key-never-used-live",type:"api_error"}},status));vi.stubGlobal("fetch",fetch);
    const error=await real(()=>new FreeTierProvider("groq").generateGroundedAnswer({...base,responseModel:"openai/gpt-oss-20b"})).catch(e=>e);
    expect(error.status).toBe(status);expect(error.code).toBe(status===429?"rate_limited":status===401?"authentication":"unavailable");
    expect(error.message).not.toMatch(/PRIVATE|synthetic-provider-key/);expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("requires a key, explicit opt-in and account-side free-tier confirmation",async()=>{
    vi.stubEnv("GEMINI_API_KEY","");await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toThrow(/GEMINI_API_KEY/);
    vi.stubEnv("GEMINI_API_KEY","synthetic");vi.stubEnv("PRONTO_GEMINI_FREE_TIER_CONFIRMED","0");
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toThrow(/FREE_TIER_CONFIRMED/);
    vi.stubEnv("PRONTO_GEMINI_FREE_TIER_CONFIRMED","1");vi.stubEnv("PRONTO_DEMO_REAL_AI_APPROVED","0");
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toThrow(/REAL_AI_APPROVED/);
  });
  it("rejects arbitrary models and nonsynthetic/cross-tenant requests before transport",async()=>{
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer({...base,responseModel:"paid-or-unknown-model"}))).rejects.toThrow(/allowlist/);
    await expect(new FreeTierProvider("gemini").generateGroundedAnswer(base)).rejects.toThrow(/synthetic/);
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer({...base,clientId:"other-tenant"}))).rejects.toThrow(/synthetic/);
  });
  it.each(["invalid json",JSON.stringify({...decision,citedChunkIds:[],answer:"No citations"}),JSON.stringify({...decision,confidence:7})])("fails safely for malformed or ungrounded output",async text=>{
    vi.stubGlobal("fetch",async()=>response({model:base.responseModel,choices:[{finish_reason:"stop",message:{content:text}}]}));
    if(text.includes("No citations"))expect(await real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).toMatchObject({action:"escalate",reasonCode:"ungrounded_answer"});
    else await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toMatchObject({code:"malformed_response",retryable:true});
  });
  it("rejects truncated output and recognizes timeouts",async()=>{
    vi.stubGlobal("fetch",async()=>response({model:base.responseModel,choices:[{finish_reason:"length",message:{content:JSON.stringify(decision)}}]}));
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toMatchObject({code:"output_truncated",retryable:true});
    expect(normalizeProviderError("gemini",new DOMException("private detail","TimeoutError"))).toMatchObject({code:"timeout"});
  });
  it('does not retry explicit refusals or unsupported tool finishes',async()=>{
    for(const choice of [{finish_reason:'stop',message:{content:null,refusal:'Refused'}},{finish_reason:'tool_calls',message:{content:null}}]){
      vi.stubGlobal('fetch',async()=>response({model:base.responseModel,choices:[choice]}));
      await expect(real(()=>new FreeTierProvider('gemini').generateGroundedAnswer(base))).rejects.toMatchObject({code:'invalid_response',retryable:false});
    }
  });
  it("preserves a model-generated greeting grounded in the assistant's operating identity",async()=>{
    const greeting={...decision,answer:"Hello! Welcome to Synthetic cafe. How can I help?",citedChunkIds:[]};
    vi.stubGlobal("fetch",async()=>response({id:"actual-response-id",model:base.responseModel,
      choices:[{finish_reason:"stop",message:{content:JSON.stringify(greeting)}}]}));
    expect(await real(()=>new FreeTierProvider("gemini").generateGroundedAnswer({...base,customerMessage:"Hi",conversationalTurn:true})))
      .toMatchObject({action:"answer",answer:greeting.answer,providerResponseId:"actual-response-id",citedChunkIds:[]});
  });
  it("rejects a returned model that differs from the requested allowlisted model",async()=>{
    vi.stubGlobal("fetch",async()=>response({model:"unexpected-paid-model",choices:[{finish_reason:"stop",message:{content:JSON.stringify(decision)}}]}));
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toMatchObject({code:"invalid_response"});
  });
  it("aborts a slow provider request at its bound without retry",async()=>{
    const fetch=vi.fn((resource:Request|string,options?:RequestInit)=>new Promise<Response>((_resolve,reject)=>{
      const signal=resource instanceof Request?resource.signal:options?.signal;
      signal?.addEventListener("abort",()=>reject(new DOMException("Aborted","AbortError")),{once:true});
    }));vi.stubGlobal("fetch",fetch);
    await expect(real(()=>new FreeTierProvider("gemini").generateGroundedAnswer(base))).rejects.toMatchObject({code:"timeout"});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("uses separate 1536-dimensional document/query requests without Embedding 1 task_type",async()=>{
    const fetch=vi.fn(async()=>response({embedding:{values:Array(1536).fill(0.01)}}));vi.stubGlobal("fetch",fetch);
    const provider=new FreeTierProvider("gemini");
    expect(await real(()=>provider.embed(["Public fact A","Public fact B"],"gemini-embedding-2",{clientId:base.clientId,embeddingTask:"document"}))).toHaveLength(2);
    await real(()=>provider.embed(["Question"],"gemini-embedding-2",{clientId:base.clientId,embeddingTask:"query"}));
    const calls=fetch.mock.calls as unknown as [string,RequestInit][];
    expect(calls).toHaveLength(3);const bodies=calls.map(([,init])=>JSON.parse(String(init.body)));
    expect(bodies[0]).toEqual({content:{parts:[{text:"title: none | text: Public fact A"}]},output_dimensionality:1536});
    expect(bodies[2].content.parts[0].text).toBe("task: question answering | query: Question");
    expect(calls[0][0]).not.toContain("key=");expect(calls[0][1].redirect).toBe("error");
  });
  it.each([Array(768).fill(1),Array(1536).fill(0),[1,2,3]])("rejects incompatible embedding vectors",async vector=>{
    vi.stubGlobal("fetch",async()=>response({embedding:{values:vector}}));
    await expect(real(()=>new FreeTierProvider("gemini").embed(["Public fact"],"gemini-embedding-2",{clientId:base.clientId}))).rejects.toMatchObject({code:"invalid_response"});
  });
  it("stops embedding on quota exhaustion and does not use Groq as an embedder",async()=>{
    const fetch=vi.fn(async()=>response({},429));vi.stubGlobal("fetch",fetch);
    await expect(real(()=>new FreeTierProvider("gemini").embed(["A","B"],"gemini-embedding-2",{clientId:base.clientId}))).rejects.toMatchObject({code:"rate_limited"});
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(real(()=>new FreeTierProvider("groq").embed(["A"],"gemini-embedding-2"))).rejects.toThrow(/embeddings/);
  });
});

it("uses a native structured query schema for reservation planning and retains actual provider evidence",async()=>{
 const query={intent:"booking",outlet:"current",date:"2026-10-31",time:"19:00",partySize:4,children:0,confidence:0.98,reasonDetail:"Customer supplied Saturday 7pm for four."};
 const fetch=vi.fn(async()=>response({id:"actual-extraction-id",model:base.responseModel,
   choices:[{finish_reason:"stop",message:{content:JSON.stringify(query)}}],usage:{prompt_tokens:200,completion_tokens:70}}));
 vi.stubGlobal("fetch",fetch);
 const result=await real(()=>new FreeTierProvider("gemini").generateGroundedAnswer({...base,conversationalTurn:true,
  reservationExtraction:{now:"2026-10-26 15:00 SGT",calendar:["2026-10-31 Saturday"]}}));
 expect(JSON.parse(result.answer!)).toEqual({intent:"booking",outlet:"current",date:"2026-10-31",time:"19:00",partySize:4,children:0});
 expect(result).toMatchObject({providerResponseId:"actual-extraction-id",usage:{inputTokens:200,outputTokens:70}});
 const [resource,options]=fetch.mock.calls[0] as unknown as [Request|string,RequestInit];
 const body=resource instanceof Request?await resource.json():JSON.parse(String(options.body));
 expect(body.response_format.json_schema.schema.properties.intent.enum).toContain("availability");
 expect(body.response_format.json_schema.schema.required).toContain("date");
});
