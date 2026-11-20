"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function InstagramProfileRefresh({conversationId,refreshAfter}:{conversationId:string;refreshAfter?:string}) {
  const router=useRouter();
  useEffect(()=>{
    if(refreshAfter && Date.parse(refreshAfter)>Date.now())return;
    const controller=new AbortController();
    void fetch(`/api/client/conversations/${conversationId}/profile`,{method:"POST",cache:"no-store",signal:controller.signal})
      .then(async response=>{if(response.ok && (await response.json()).status==="refreshed" && !controller.signal.aborted)router.refresh();})
      .catch(()=>{});
    return()=>controller.abort();
  },[conversationId,refreshAfter,router]);
  return null;
}
