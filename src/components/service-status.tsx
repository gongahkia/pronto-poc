'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {Activity,ArrowLeft,CheckCircle2,AlertTriangle,HelpCircle} from 'lucide-react';
import type {ServiceStatus as Report} from '@/lib/service-status';
const date=(value:string)=>new Intl.DateTimeFormat('en-SG',{timeZone:'Asia/Singapore',dateStyle:'medium',timeStyle:'medium'}).format(new Date(value))+' SGT';
export function ServiceStatusLink(){return <Link prefetch={false} href="/status" className="ui-button inline-flex items-center gap-2 px-3 py-2 text-sm"><Activity size={16} aria-hidden="true"/>Service status</Link>;}
export function ServiceStatus(){
 const [report,setReport]=useState<Report|null>(null),[error,setError]=useState(false),[checking,setChecking]=useState(false);const busy=useRef(false);
 const refresh=useCallback(async()=>{if(busy.current)return;busy.current=true;setChecking(true);
  try{const response=await fetch('/api/status',{cache:'no-store',signal:AbortSignal.timeout(15000)});const body=await response.json();
   if(!Array.isArray(body.checks)||!body.checkedAt)throw Error('Invalid status response');setReport(body);setError(false);
  }catch{setError(true);}finally{busy.current=false;setChecking(false);}},[]);
 useEffect(()=>{const start=setTimeout(()=>void refresh(),0);const wake=()=>{if(document.visibilityState==='visible')void refresh();};
  const timer=setInterval(wake,30000);window.addEventListener('focus',wake);document.addEventListener('visibilitychange',wake);
  return()=>{clearTimeout(start);clearInterval(timer);window.removeEventListener('focus',wake);document.removeEventListener('visibilitychange',wake);};},[refresh]);
 return <main className="min-h-screen bg-surface-subtle px-4 py-8 text-foreground"><section className="mx-auto max-w-2xl space-y-5">
  <Link href="/" className="inline-flex items-center gap-2 text-sm text-accent"><ArrowLeft size={16}/>Back to Pronto</Link>
  <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-accent">Pronto</p><h1 className="mt-1 text-2xl font-semibold">Service status</h1></div>
   <button onClick={()=>void refresh()} disabled={checking} className="ui-button px-3 py-2 text-sm">{checking?'Checking…':'Check now'}</button></div>
  <p className="text-sm leading-6 text-muted">Automatic updates every 30 seconds. These checks read configuration and saved processing results; they do not send an AI request or spend provider credits.</p>
  {error?<p role="alert" className="rounded-lg border border-danger/25 bg-danger-bg p-4 text-sm">Could not reach the status service. Reconnecting automatically. Any results below are from the previous check.</p>:null}
  {report?<><p role="status" className={`rounded-lg border p-4 font-medium ${report.status==='operational'?'border-success/25 bg-success-bg text-success':'border-warning/25 bg-warning-bg text-foreground'}`}>
    {report.status==='operational'?'Service checks passed':report.status==='unavailable'?'Service unavailable':'Service needs attention'}</p>
   <div className="ui-panel divide-y divide-line">{report.checks.map(check=>{const Icon=check.state==='ok'?CheckCircle2:check.state==='unknown'?HelpCircle:AlertTriangle;
    return <article key={check.id} className="flex gap-3 p-4"><Icon size={20} aria-hidden="true" className={`mt-0.5 shrink-0 ${check.state==='ok'?'text-success':check.state==='unknown'?'text-muted':'text-warning'}`}/>
     <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><h2 className="font-semibold">{check.name}</h2><span className="text-xs text-muted">{check.state==='ok'?'Passed':check.state==='unknown'?'Observation only':'Needs attention'}</span></div>
      <p className="mt-1 text-sm leading-6 text-muted">{check.detail}</p>{check.observedAt&&<p className="mt-1 text-xs tabular-nums text-muted">Last observation: {date(check.observedAt)}</p>}
      {check.code&&<p className="mt-1 font-mono text-xs text-muted">{check.code}</p>}</div></article>;})}</div>
   <p className="text-xs tabular-nums text-muted">Last checked: {date(report.checkedAt)}{report.revision&&<> · Revision {report.revision.slice(0,7)}</>}</p></>:!error?<p role="status" className="ui-panel p-5 text-sm text-muted">Checking service…</p>:null}
  <p className="text-sm text-muted">A working web page does not guarantee a working AI reply. A failed saved message can remain stopped after the provider recovers; use <strong>Try again</strong> in that conversation.</p>
 </section></main>;
}
