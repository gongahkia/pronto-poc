import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchInstagramCustomerProfile } from "@/lib/channels/instagram-profile";
import { parseInstagramProfile, instagramPhotoUrl, customerDisplayName, customerDisplayHandle } from "@/lib/channels/instagram-profile-data";

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe("Instagram customer profile decoding",()=>{
  beforeEach(()=>vi.stubEnv("META_GRAPH_VERSION","v27.0"));
  it("uses the configured graph host and header token, without exposing it in a URL",async()=>{
    const http=vi.fn(async()=>Response.json({id:"123",name:"Keith",username:"keibtang",follower_count:0,is_verified_user:false}));vi.stubGlobal("fetch",http);
    expect(await fetchInstagramCustomerProfile({senderId:"123",token:"private-token",direct:false})).toEqual({name:"Keith",username:"keibtang",followerCount:0,verified:false});
    const [url,options]=http.mock.calls[0] as unknown as [URL,RequestInit];
    expect(url.origin).toBe("https://graph.facebook.com");expect(url.pathname).toBe("/v27.0/123");expect(url.href).not.toContain("private-token");
    expect(options).toMatchObject({redirect:"error",cache:"no-store",headers:{Authorization:"Bearer private-token"}});
    expect(options.signal).toBeInstanceOf(AbortSignal);
    await fetchInstagramCustomerProfile({senderId:"123",token:"private-token",direct:true});
    expect(String((http.mock.calls[1] as unknown[])[0])).toMatch(/^https:\/\/graph.instagram.com/);
  });
  it("rejects a mismatched sender, oversized response and malformed profile",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>Response.json({id:"456",username:"other"})));
    await expect(fetchInstagramCustomerProfile({senderId:"123",token:"secret",direct:false})).rejects.toThrow("identity mismatch");
    vi.stubGlobal("fetch",vi.fn(async()=>new Response("x".repeat(40000))));
    await expect(fetchInstagramCustomerProfile({senderId:"123",token:"secret",direct:false})).rejects.toThrow("too large");
    expect(parseInstagramProfile({username:"https://evil.invalid",follower_count:-1})).toBeNull();
    expect(parseInstagramProfile({name:null,username:"customer",follower_count:"4",is_verified_user:"true"})).toEqual({username:"customer"});
  });
  it("accepts only bounded HTTPS Meta CDN images and whitelisted fields",()=>{
    expect(instagramPhotoUrl("https://scontent.cdninstagram.com/avatar.jpg?oh=signature")).toBeTruthy();
    for(const value of ["http://scontent.cdninstagram.com/a","https://cdninstagram.com.evil.invalid/a","https://localhost/a","https://fbcdn.net/a?access_token=secret","https://user:secret@fbcdn.net/a"])expect(instagramPhotoUrl(value)).toBeUndefined();
    expect(parseInstagramProfile({username:"customer",access_token:"secret",email:"private@example.invalid",profile_pic:"https://evil.invalid/a"})).toEqual({username:"customer"});
  });
  it("changes display identity without changing or guessing transport identity",()=>{
    const identity={channel_kind:"instagram",customer_name:null,customer_handle:"123",instagram_profile:{name:"Keith",username:"keibtang"}};
    expect(customerDisplayName(identity)).toBe("Keith");expect(customerDisplayHandle(identity)).toBe("@keibtang");expect(identity.customer_handle).toBe("123");
    expect(customerDisplayName({...identity,instagram_profile:{}})).toBe("123");
    expect(customerDisplayName({...identity,channel_kind:"email"})).toBe("123");
  });
});
