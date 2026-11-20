import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";
const mocks=vi.hoisted(()=>({user:vi.fn(),permission:vi.fn(),refresh:vi.fn()}));
vi.mock("@/lib/auth",()=>({getSessionUser:mocks.user}));
vi.mock("@/lib/staff-permissions",()=>({canViewBusinessConversation:mocks.permission}));
vi.mock("@/lib/channels/instagram-profile",()=>({refreshInstagramConversationProfile:mocks.refresh}));
import {POST} from "@/app/api/client/conversations/[conversationId]/profile/route";
const id="445c45ac-53e6-4270-a7e7-3db00662aa3b", context={params:Promise.resolve({conversationId:id})};
const request=(origin="http://localhost:3000",body?:string)=>new Request("http://localhost:3000/api/client/conversations/"+id+"/profile",{method:"POST",headers:{Origin:origin},body});
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("APP_BASE_URL","http://localhost:3000");mocks.user.mockResolvedValue({role:"client",clientId:"business"});mocks.permission.mockResolvedValue(true);mocks.refresh.mockResolvedValue("refreshed");});
afterEach(()=>vi.unstubAllEnvs());
describe("customer profile refresh authorization",()=>{
  it("requires same origin, a business identity and conversation access",async()=>{
    expect((await POST(request("https://foreign.invalid"),context)).status).toBe(403);
    mocks.user.mockResolvedValue(null);expect((await POST(request(),context)).status).toBe(401);
    mocks.user.mockResolvedValue({role:"operator",clientId:null});expect((await POST(request(),context)).status).toBe(403);
    mocks.user.mockResolvedValue({role:"client",clientId:"business"});mocks.permission.mockResolvedValue(false);expect((await POST(request(),context)).status).toBe(403);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("binds lookup to the actor and rejects browser-supplied IDs and bodies",async()=>{
    expect((await POST(request(),context)).status).toBe(200);expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith("business",id);
    expect((await POST(request("http://localhost:3000",JSON.stringify({clientId:"foreign",senderId:"999"})),context)).status).toBe(400);
    expect((await POST(request(),{params:Promise.resolve({conversationId:"invalid"})})).status).toBe(404);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    mocks.refresh.mockResolvedValue("not_found");expect((await POST(request(),context)).status).toBe(404);
  });
});
