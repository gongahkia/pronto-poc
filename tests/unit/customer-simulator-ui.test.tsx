import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, within,act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomerSimulator } from "@/components/customer-simulator";

const id="00000000-0000-4000-8000-000000000001";
const state = { now: "2026-10-25T05:00:00Z", sessions: [{ id, conversation_id: id, ai_mode: "mock", created_at: "2026-10-25T04:00:00Z" }],
  modelChoices: [{id:"groq-oss",available:false,detail:"Configure GROQ_API_KEY securely on the server."}],
  realAi: { available: false, detail: "Real AI is unavailable. Configure GROQ_API_KEY securely on the server." },
  session: null as null | { id: string; conversation_id: string; ai_mode: string; status: string }, messages: [] as unknown[], job: null as unknown, providerError:false };
const response = (value: unknown, status=200) => Promise.resolve(new Response(JSON.stringify(value), { status,headers:{"Content-Type":"application/json"} }));
beforeEach(() => { cleanup(); HTMLElement.prototype.scrollIntoView=vi.fn(); });

describe("customer simulator states", () => {
  it('allows another message during the pending quiet window and explains the staff review',async()=>{
    const snapshot={...state,session:{id,conversation_id:id,ai_mode:'mock',status:'active',staff_review_pending:true},
      job:{status:'pending',created_at:state.now}};
    vi.stubGlobal('fetch',vi.fn((url:string)=>response(url.includes('sessionId')?snapshot:state)));
    render(<CustomerSimulator/>);
    await userEvent.click(await screen.findByRole('button',{name:/Conversation 1/}));
    await userEvent.type(await screen.findByLabelText('Message PS.Cafe Raffles City'),'And when do you close?');
    expect((screen.getByRole('button',{name:'Send message'}) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/I can still answer other questions/)).toBeTruthy();
    expect(screen.getByText(/You can add another message before we reply/)).toBeTruthy();
  });
  it('lets a slow poll finish instead of repeatedly superseding its response',async()=>{
    vi.useFakeTimers();let finish!:(value:Response)=>void;
    const fetcher=vi.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockImplementation(()=>response(state));vi.stubGlobal('fetch',fetcher);
    try{
      render(<CustomerSimulator/>);await act(async()=>{await vi.advanceTimersByTimeAsync(7500);});expect(fetcher).toHaveBeenCalledTimes(1);
      await act(async()=>{finish(new Response(JSON.stringify(state)));await vi.advanceTimersByTimeAsync(0);});
      expect(screen.getByRole('button',{name:'Conversation 1'})).toBeTruthy();
      await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});expect(fetcher).toHaveBeenCalledTimes(2);
    }finally{cleanup();vi.useRealTimers();}
  });
  it("disables unconfigured models and removes mock and configured-provider options", async () => {
    const fetcher=vi.fn((url: string, options?: RequestInit) => options?.method==="POST"
      ? response({error:"Configure GROQ_API_KEY securely on the server."},503) : response(state));
    vi.stubGlobal("fetch",fetcher); render(<CustomerSimulator/>);
    await screen.findByText("Unavailable");
    await userEvent.click(screen.getByText("Model settings"));
    expect((screen.getByLabelText("AI model") as HTMLSelectElement).value).toBe("");
    for (const option of screen.getAllByRole("option").filter(option => option.getAttribute("value"))) {
      expect((option as HTMLOptionElement).disabled).toBe(true);
    }
    expect(screen.queryByRole("option", {name:/Mock|Configured real AI/})).toBeNull();
    expect((screen.getByRole("button",{name:"New conversation"}) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button",{name:"New conversation"}));
    expect(fetcher.mock.calls.some(call=>call[1]?.method==="POST")).toBe(false);
  });
  it("allows only a configured model to create a real conversation", async () => {
    const configured={...state,modelChoices:[
      {id:"groq-oss",available:false,detail:"Configure GROQ_API_KEY securely on the server."},
      {id:"gemini-flash",available:true,detail:"Configured."},
      {id:"gemini-lite",available:false,detail:"Not ready."}]};
    const fetcher=vi.fn((url:string, options?:RequestInit)=>options?.method==="POST"
      ? response({id},201) : response(configured));
    vi.stubGlobal("fetch",fetcher);render(<CustomerSimulator/>);
    await screen.findByText("Unavailable");
    await userEvent.click(screen.getByText("Model settings"));
    const mode=screen.getByLabelText("AI model");
    expect((screen.getByRole("option",{name:"Gemini 3.8 Flash"}) as HTMLOptionElement).disabled).toBe(false);
    expect((screen.getByRole("option",{name:/Groq GPT-OSS/}) as HTMLOptionElement).disabled).toBe(true);
    await userEvent.selectOptions(mode,"gemini-flash");
    await userEvent.click(screen.getByRole("button",{name:"New conversation"}));
    await waitFor(()=>expect(fetcher.mock.calls.some(call=>call[1]?.method==="POST")).toBe(true));
    expect(JSON.parse(String(fetcher.mock.calls.find(call=>call[1]?.method==="POST")?.[1]?.body)))
      .toMatchObject({action:"create",mode:"real",choice:"gemini-flash"});
  });
  it("keeps an unsuccessful send retry bound to the same idempotency key", async () => {
    const sent: Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn((url: string, options?:RequestInit) => {
      if(options?.method==="POST") {
        const body=JSON.parse(String(options.body)); sent.push(body);
        return sent.length===1 ? Promise.reject(new Error("Network interrupted")) : response({jobId:id},202);
      }
      return response(url.includes("sessionId") ? {...state,session:{id,conversation_id:id,ai_mode:"mock",status:"active"}} : state);
    }));
    render(<CustomerSimulator/>); await userEvent.click(await screen.findByRole("button",{name:/Conversation 1/}));
    const input=await screen.findByLabelText("Message PS.Cafe Raffles City");
    await waitFor(()=>expect((input as HTMLTextAreaElement).disabled).toBe(false));
    await userEvent.type(input,"What time do you close?"); await userEvent.click(screen.getByRole("button",{name:"Send message"}));
    await screen.findByText("Network interrupted"); await userEvent.click(screen.getByRole("button",{name:/^Retry$/}));
    await waitFor(()=>expect(sent).toHaveLength(2)); expect(sent[1].requestId).toBe(sent[0].requestId);
  });
  it("renders delivered replies, booking links, a slow queue and explicit human ownership", async () => {
    const snapshot={...state,session:{id,conversation_id:id,ai_mode:"mock",status:"escalated"},
      job:{status:"processing",created_at:"2026-10-25T04:00:00Z"},messages:[
        {id:"customer",body:"Can I book?",sender:"customer",created_at:state.now,generation_mode:null},
        {id:"business",body:"Please check https://www.chope.co/singapore-restaurants/restaurant/ps-cafe-raffles-city",sender:"business",created_at:state.now,generation_mode:"mock"}]};
    vi.stubGlobal("fetch",vi.fn((url:string)=>response(url.includes("sessionId")?snapshot:state)));
    render(<CustomerSimulator/>); await userEvent.click(await screen.findByRole("button",{name:/Conversation 1/}));
    await screen.findByText(/Our team is handling your enquiry/);
    expect(screen.getByText(/Our reply is taking longer/)).toBeTruthy();
    expect(screen.getByRole("link",{name:/https:\/\/www.chope.co/}).getAttribute("rel")).toContain("noopener");
    expect(screen.queryByText(/mock response/)).toBeNull();
  });
  it("disables the old composer while creating another conversation and sends only to the new session", async () => {
    const nextId="00000000-0000-4000-8000-000000000002";
    let finishCreate!: (response: Response) => void;
    const sent: Record<string,unknown>[]=[];
    vi.stubGlobal("fetch",vi.fn((url:string, options?:RequestInit) => {
      if(options?.method==="POST") {
        const body=JSON.parse(String(options.body));
        if(body.action==="create") return new Promise<Response>(resolve=>{finishCreate=resolve;});
        sent.push(body); return response({jobId:nextId},202);
      }
      const selected=url.includes(nextId)?nextId:id;
      const configured={...state,modelChoices:[{id:"groq-oss",available:true,detail:"Configured."}]};
      return response(url.includes("sessionId")?{...configured,session:{id:selected,conversation_id:selected,ai_mode:"real",status:"active"}}:configured);
    }));
    render(<CustomerSimulator/>); await userEvent.click(await screen.findByRole("button",{name:/Conversation 1/}));
    const input=screen.getByLabelText("Message PS.Cafe Raffles City") as HTMLTextAreaElement;
    await waitFor(()=>expect(input.disabled).toBe(false));
    await userEvent.click(screen.getByRole("button",{name:"New conversation"}));
    expect(input.disabled).toBe(true);
    finishCreate(new Response(JSON.stringify({id:nextId}),{status:201}));
    await waitFor(()=>expect(input.disabled).toBe(false));
    await userEvent.type(input,"A new enquiry"); await userEvent.click(screen.getByRole("button",{name:"Send message"}));
    await waitFor(()=>expect(sent).toHaveLength(1)); expect(sent[0].sessionId).toBe(nextId);
  });
  it("shows a delivery failure instead of presenting a saved but undelivered answer", async () => {
    const snapshot={...state,session:{id,conversation_id:id,ai_mode:"mock",status:"active"},
      job:{status:"completed",created_at:state.now,delivery_status:"failed"}};
    vi.stubGlobal("fetch",vi.fn((url:string)=>response(url.includes("sessionId")?snapshot:state)));
    render(<CustomerSimulator/>); await userEvent.click(await screen.findByRole("button",{name:/Conversation 1/}));
    await screen.findByText(/reply has not been delivered/);
    expect(screen.queryByText(/PS.Cafe assistant/)).toBeNull();
  });
  it("keeps provider diagnostics out of the customer chat",async()=>{
    const snapshot={...state,session:{id,conversation_id:id,ai_mode:"real",status:"active",ai_selection:"groq-oss",
      ai_configuration:{provider:"groq",model:"openai/gpt-oss-20b",embeddingProvider:"gemini",embeddingModel:"gemini-embedding-2"}},
      messages:[{id:"fixture",body:"Injected UI fixture, not external inference.",sender:"business",created_at:state.now,
        generation_mode:"real",response_provider:"groq",response_model:"openai/gpt-oss-20b"},
        {id:"human",body:"Our team has reviewed your enquiry.",sender:"human",created_at:state.now,generation_mode:null}]};
    vi.stubGlobal("fetch",vi.fn((url:string)=>response(url.includes("sessionId")?snapshot:state)));
    render(<CustomerSimulator/>);await userEvent.click(await screen.findByRole("button",{name:/Conversation 1/}));
    const history=within(screen.getByLabelText("Message history"));
    await history.findByText("Our team has reviewed your enquiry.");
    expect(history.getByText("Our team")).toBeTruthy();
    expect(history.queryByText(/real model response|groq|demo/i)).toBeNull();
    expect(screen.queryByText(/real model response|groq \/ openai/)).toBeNull();
    expect(screen.getByText("Model settings").closest("details")!.open).toBe(false);
    expect(screen.queryByText(/Real AI requested|Selected:|Retrieval:|AI owns this conversation/)).toBeNull();
    expect((screen.getByLabelText("AI model") as HTMLSelectElement).value).toBe("");
  });
});
