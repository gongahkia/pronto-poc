import {randomUUID} from "node:crypto";
import {afterAll,afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {getPool} from "@/lib/db";
import {enterTenantContext} from "@/lib/tenant-context";
import {encryptedChannelCredentialValues} from "@/lib/channels/credentials";
import {refreshInstagramConversationProfile} from "@/lib/channels/instagram-profile";
import {ingestInboundMessage} from "@/lib/channels/inbox";
const suite=process.env.PRONTO_RUN_DB_TESTS==="1"?describe:describe.skip;
suite("customer profiles on isolated PostgreSQL",()=>{
  let client:string,channel:string,conversation:string;
  const sender="123", http=vi.fn();
  beforeEach(async()=>{
    enterTenantContext({role:"operator",clientId:null});vi.stubEnv("PRONTO_DEPLOYMENT_PROFILE","");vi.stubEnv("PRONTO_HOSTED_INSTAGRAM","");vi.stubEnv("META_GRAPH_VERSION","v27.0");
    client=randomUUID();channel=randomUUID();conversation=randomUUID();http.mockReset();vi.stubGlobal("fetch",http);
    await getPool().query("insert into clients(id,name,slug,vertical,brand_voice) values($1::uuid,'Profile fixture',$1::text,'fnb','Helpful')",[client]);
    const encrypted=encryptedChannelCredentialValues({accessToken:"fixture-token",igUserId:"456"});
    await getPool().query(`insert into channels(id,client_id,kind,name,status,external_id,settings,encrypted_credentials,credentials_encryption_nonce,credentials_encryption_tag)
      values($1,$2,'instagram','Profile fixture','active','456','{"authMode":"unified_login"}',$3,$4,$5)`,[channel,client,encrypted.encryptedCredentials,encrypted.nonce,encrypted.tag]);
    await getPool().query("insert into conversations(id,client_id,channel_id,external_thread_id,customer_handle) values($1,$2,$3,$4,$4)",[conversation,client,channel,sender]);
  });
  afterEach(async()=>{await getPool().query("delete from clients where id=$1",[client]);vi.unstubAllEnvs();vi.unstubAllGlobals();});
  afterAll(()=>getPool().end());
  const current=async()=>(await getPool().query("select * from conversations where id=$1 and client_id=$2",[conversation,client])).rows[0];
  it("coalesces concurrent lookups and keeps routing and display details across ingestion",async()=>{
    let release!:(response:Response)=>void;http.mockImplementation(()=>new Promise<Response>(done=>{release=done;}));
    const first=refreshInstagramConversationProfile(client,conversation);await vi.waitFor(()=>expect(http).toHaveBeenCalledTimes(1));
    expect(await refreshInstagramConversationProfile(client,conversation)).toBe("cached");
    release(Response.json({id:sender,name:"Keith",username:"keibtang"}));expect(await first).toBe("refreshed");
    expect(await refreshInstagramConversationProfile(client,conversation)).toBe("cached");expect(http).toHaveBeenCalledTimes(1);
    await ingestInboundMessage({channelId:channel,channelKind:"instagram",externalMessageId:"fixture",externalThreadId:sender,customerHandle:sender,text:"Hi",raw:{}});
    const row=await current();expect(row.instagram_profile).toEqual({name:"Keith",username:"keibtang"});expect(row.external_thread_id).toBe(sender);expect(row.customer_handle).toBe(sender);expect(row.customer_name).toBeNull();
  });
  it("never fetches a foreign conversation and refuses an expired lease result",async()=>{
    expect(await refreshInstagramConversationProfile(randomUUID(),conversation)).toBe("not_found");expect(http).not.toHaveBeenCalled();
    let release!:(response:Response)=>void;http.mockImplementation(()=>new Promise<Response>(done=>{release=done;}));
    const pending=refreshInstagramConversationProfile(client,conversation);await vi.waitFor(()=>expect(http).toHaveBeenCalledTimes(1));
    await getPool().query("update conversations set instagram_profile_lease_token=$3 where id=$1 and client_id=$2",[conversation,client,randomUUID()]);
    release(Response.json({id:sender,username:"stale"}));expect(await pending).toBe("unavailable");expect((await current()).instagram_profile).toEqual({});
  });
  it("preserves a cached profile after a provider failure and backs off retries",async()=>{
    await getPool().query("update conversations set instagram_profile=$3 where id=$1 and client_id=$2",[conversation,client,{name:"Saved",username:"saved"}]);
    http.mockResolvedValue(new Response("private upstream error",{status:403}));
    expect(await refreshInstagramConversationProfile(client,conversation)).toBe("unavailable");expect(await refreshInstagramConversationProfile(client,conversation)).toBe("cached");
    expect(http).toHaveBeenCalledTimes(1);expect((await current()).instagram_profile).toEqual({name:"Saved",username:"saved"});
  });
});
