'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { ArrowRight,ArrowUpRight,BarChart3,CheckCheck,Clock3,GitBranch,Layers3,MessageSquare,RefreshCw,Sparkles } from 'lucide-react';
import { Badge } from '@/components/badge';
import type { AnalyticsData,Sentiment } from '@/lib/analytics/types';
const number=(value:number)=>value.toLocaleString('en-SG');
const human=(value:string)=>value.replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
const sentiments:Sentiment[]=['positive','neutral','negative','mixed','unclear'];
const sentimentTone=(value:Sentiment)=>value==='negative'?'red':value==='positive'?'green':value==='mixed'?'amber':'neutral';
export function AnalyticsDashboard({data}:{data:AnalyticsData}) {
 const router=useRouter();const [pending,setPending]=useState(false);const [error,setError]=useState('');
 const [topic,setTopic]=useState('');const [sentiment,setSentiment]=useState<Sentiment|''>('');const [evidence,setEvidence]=useState<string[]>([]);
 const snapshot=data.snapshot;const insight=snapshot?.payload;const stale=Boolean(snapshot&&snapshot.fingerprint!==data.fingerprint);
 const attempted=useRef('');const [retry,setRetry]=useState(0);
 useEffect(()=>{
  const key=`${data.days}:${data.fingerprint}:${retry}`;
  if(!data.sample.length||snapshot?.fingerprint===data.fingerprint||attempted.current===key)return;
  const abort=new AbortController();let active=true;
  async function update(){attempted.current=key;setPending(true);setError('');try{
   const response=await fetch('/api/client/analytics/synthesis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:String(data.days)}),signal:abort.signal});
   const body=await response.json();
   if(response.status===409){
    for(let i=0;i<25;i++){
     await new Promise(resolve=>setTimeout(resolve,2000));if(!active)return;
     const check=await fetch(`/api/client/analytics/synthesis?days=${data.days}&fingerprint=${data.fingerprint}`,{cache:'no-store',signal:abort.signal});
     const state=await check.json();
     if(state.status==='ready'){router.refresh();return;}
     if(state.status==='failed'||!check.ok)throw Error('Insights could not finish updating. Try again.');
     // Another period may have held the workspace-wide generation lease.
     if(state.status==='missing'&&!state.busy){
      const resumed=await fetch('/api/client/analytics/synthesis',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({days:String(data.days)}),signal:abort.signal});
      if(resumed.ok){router.refresh();return;}
      if(resumed.status!==409)throw Error('Insights could not finish updating. Try again.');
     }
    }throw Error('Insights are still updating. Try again shortly.');
   }
   if(!response.ok)throw Error(body.error??'Could not generate insights.');router.refresh();
  }catch(e){if(active)setError(e instanceof Error?e.message:'Could not generate insights.');}
  finally{if(active)setPending(false);}}
  const start=setTimeout(()=>void update(),0);
  return()=>{active=false;clearTimeout(start);abort.abort();};
 },[data.days,data.fingerprint,data.sample.length,snapshot?.fingerprint,retry,router]);
 function showEvidence(ids:string[]){setEvidence(ids);setTopic('');setSentiment('');document.getElementById('insight-evidence')?.scrollIntoView({behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}
 const classified=new Map(insight?.conversations.map(c=>[c.id,c])??[]);
 const visible=data.sample.filter(c=>{const analysis=classified.get(c.id);return (!topic||analysis?.topicId===topic)&&(!sentiment||analysis?.sentiment===sentiment)&&(!evidence.length||evidence.includes(c.id));});
 return <div className="space-y-5">
  <div className="flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold">Insights</h1>
   <p className="mt-1 text-sm text-muted">Understand customer needs, spot patterns and improve your replies.</p></div>
   <div className="flex flex-wrap gap-2" aria-label="Analysis period">{[7,30,90].map(days=><Link key={days} href={`/client/analytics?period=${days}`} aria-current={data.days===days?'page':undefined}
    className={`${data.days===days?'ui-primary-button':'ui-button'} px-3 py-2 text-sm`}>{days} days</Link>)}</div></div>
  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
   <Metric icon={<MessageSquare size={17}/>} title="Conversations" value={number(data.totals.conversations)} detail={`${number(data.totals.customerMessages)} customer messages`}/>
   <Metric icon={<CheckCheck size={17}/>} title="Assistant completed" value={number(data.totals.assistantCompleted)} detail={data.totals.conversations?`${Math.round(data.totals.assistantCompleted/data.totals.conversations*100)}% of active conversations`:'No conversations yet'}/>
   <Metric icon={<GitBranch size={17}/>} title="Needs your team" value={number(data.totals.needsTeam)} detail="Currently awaiting human review"/>
   <Metric icon={<Clock3 size={17}/>} title="Median first reply" value={data.totals.firstReplySeconds===null?'—':data.totals.firstReplySeconds<60?`${Math.round(data.totals.firstReplySeconds)}s`:`${Math.round(data.totals.firstReplySeconds/60)}m`} detail={data.totals.csatResponses?`CSAT ${data.totals.csatAverage?.toFixed(1)}/5 · ${data.totals.csatResponses} ratings`:'No customer satisfaction ratings yet'}/>
  </div>
  <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
   <ActivityChart data={data}/>
   <section className="ui-panel p-5"><h2 className="flex items-center gap-2 font-semibold"><MessageSquare size={17} className="text-accent" aria-hidden="true"/>Channels</h2>
    <p className="mt-1 text-xs leading-5 text-muted">Conversation volume and current team workload.</p>
    <div className="mt-5 space-y-4">{data.channels.map(channel=><Link key={channel.kind} href={`/client/inbox?channel=${encodeURIComponent(channel.kind)}`} className="group block rounded-md focus-visible:outline-2 focus-visible:outline-accent">
     <div className="flex justify-between gap-3 text-sm"><span>{channel.kind==='console'?'Customer chat':human(channel.kind)}</span><span className="tabular-nums">{channel.conversations}</span></div>
     <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface"><div className="h-full rounded-full bg-accent" style={{width:`${channel.conversations/Math.max(1,data.totals.conversations)*100}%`}}/></div>
     <p className="mt-1 flex justify-between gap-3 text-xs text-muted"><span>{channel.needsTeam} need your team</span><span className="inline-flex items-center gap-1 text-accent opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">Open inbox<ArrowUpRight size={13}/></span></p>
    </Link>)}{!data.channels.length&&<p className="text-sm text-muted">Channel activity will appear after your first conversation.</p>}</div>
   </section>
  </div>
  <section className="ui-panel overflow-hidden"><div className="flex flex-wrap items-start justify-between gap-4 border-b border-line p-5"><div><h2 className="flex items-center gap-2 text-lg font-semibold"><Sparkles size={19} className="text-accent" aria-hidden="true"/>Conversation synthesis</h2>
   <p className="mt-1 text-sm text-muted">Model analysis with evidence from your saved conversations.</p></div>
   {pending&&<span role="status" className="inline-flex items-center gap-2 text-sm text-muted"><RefreshCw size={15} className="animate-spin" aria-hidden="true"/>Updating insights…</span>}
   {error&&!pending&&<button type="button" onClick={()=>setRetry(value=>value+1)} className="ui-button px-3 py-2 text-sm">Retry analysis</button>}</div>
   <div className="space-y-3 p-5">
    {error&&<p role="alert" className="rounded-md bg-danger-bg p-3 text-sm text-danger">{error}</p>}
    {pending&&<p role="status" className="text-sm text-muted">Grouping topics and reviewing the evidence. This can take up to a minute.</p>}
    {insight?<><p className="max-w-5xl whitespace-pre-line text-sm leading-7">{insight.summary}</p>
     <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted"><span>{snapshot.sample_count} of {data.totals.conversations} conversations analysed</span><span>{snapshot.provider} / {snapshot.model}</span><span>{new Date(snapshot.created_at).toLocaleString('en-SG',{dateStyle:'medium',timeStyle:'short',timeZone:'UTC'})} UTC</span>{stale&&<Badge tone="amber">New activity</Badge>}</div>
</>:
     <div className="py-3"><p className="font-medium">Your customer insights</p><p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Insights appear automatically from your recent conversations and are saved for your next visit.</p></div>}
   </div>
  </section>
  {insight&&<>
   <div className="grid items-start gap-5 lg:grid-cols-2">
    <section className="ui-panel p-5"><div className="flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-semibold"><Layers3 size={18} className="text-accent" aria-hidden="true"/>Customer intent clusters</h2>{topic&&<button type="button" onClick={()=>setTopic('')} className="text-xs text-accent">Clear</button>}</div>
     <p className="mt-1 text-xs text-muted">Select a topic to inspect its conversations.</p><div className="mt-4 space-y-2">{insight.topics.map(item=><button key={item.id} type="button" aria-pressed={topic===item.id}
      onClick={()=>{setTopic(topic===item.id?'':item.id);setEvidence([]);}} className={`block w-full rounded-lg p-3 text-left transition-colors ${topic===item.id?'bg-accent-soft outline-1 outline-accent/30':'hover:bg-surface'}`}>
      <span className="flex justify-between gap-3 text-sm font-medium"><span>{item.name}</span><span className="tabular-nums">{item.conversationIds.length}</span></span>
      <span className="mt-1 block text-xs leading-5 text-muted">{item.description}</span><span className="mt-2 block h-1.5 rounded-full bg-surface"><span className="block h-full rounded-full bg-accent" style={{width:`${item.conversationIds.length/Math.max(1,insight.conversations.length)*100}%`}}/></span>
     </button>)}</div>
    </section>
    <div className="space-y-5"><section className="ui-panel p-5"><h2 className="font-semibold">Customer sentiment</h2><p className="mt-1 text-xs leading-5 text-muted">Inferred from customer messages, separate from measured satisfaction.</p>
     <div className="mt-4 flex flex-wrap gap-2">{sentiments.map(value=>{const count=insight.conversations.filter(c=>c.sentiment===value).length;return <button key={value} type="button" disabled={!count} aria-pressed={sentiment===value}
       onClick={()=>{setSentiment(sentiment===value?'':value);setEvidence([]);}} className={`rounded-full px-3 py-2 text-sm ${sentiment===value?'bg-accent text-white':'border border-line hover:bg-surface'}`}>
       {human(value)} <span className="ml-1 tabular-nums">{count}</span></button>;})}</div>
    </section><HandoffReasons handoffs={data.handoffs}/></div>
   </div>
   <div className="grid items-start gap-5 lg:grid-cols-2"><section className="ui-panel p-5"><h2 className="font-semibold">Recommended improvements</h2><p className="mt-1 text-xs text-muted">Suggestions to review, with supporting conversations.</p>
    <div className="mt-4 divide-y divide-line">{insight.recommendations.map((item,i)=><div key={i} className="space-y-2 py-4 first:pt-0"><div className="flex items-start justify-between gap-3"><h3 className="text-sm font-medium">{item.title}</h3><Badge tone={item.priority==='high'?'amber':'neutral'}>{human(item.priority)}</Badge></div>
     <p className="text-sm leading-6 text-muted">{item.detail}</p><EvidenceButton ids={item.conversationIds} show={showEvidence}/></div>)}{!insight.recommendations.length&&<p className="py-2 text-sm text-muted">No evidence-backed improvements identified in this sample.</p>}</div>
   </section><section className="ui-panel p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-semibold">Knowledge opportunities</h2><Link href="/client/knowledge" className="inline-flex items-center gap-1 text-xs text-accent">Review knowledge<ArrowUpRight size={14} aria-hidden="true"/></Link></div>
    <p className="mt-1 text-xs leading-5 text-muted">Questions the model identified as needing clearer approved information.</p><div className="mt-4 divide-y divide-line">{insight.knowledgeGaps.map((item,i)=><div key={i} className="space-y-2 py-4 first:pt-0"><p className="text-sm leading-6">{item.question}</p><EvidenceButton ids={item.conversationIds} show={showEvidence}/></div>)}
    {!insight.knowledgeGaps.length&&<p className="py-3 text-sm leading-6 text-muted">No clear knowledge gaps identified in the analysed conversations.</p>}</div>
   </section></div>
  </>}
  <section id="insight-evidence" className="ui-panel scroll-mt-5 overflow-hidden"><div className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-5"><div><h2 className="font-semibold">Conversations behind the insights</h2><p className="mt-1 text-xs text-muted">{visible.length} of {data.sample.length} sampled conversations{topic?` · ${insight?.topics.find(t=>t.id===topic)?.name}`:''}{sentiment?` · ${human(sentiment)}`:''}</p></div>
   {(topic||sentiment||evidence.length>0)&&<button type="button" onClick={()=>{setTopic('');setSentiment('');setEvidence([]);}} className="ui-button px-3 py-2 text-sm">Clear filters</button>}</div>
   <div className="divide-y divide-line">{visible.map(conversation=>{const analysis=classified.get(conversation.id);
    const quote=conversation.messages.find(m=>m.role==='customer'&&(!analysis||analysis.evidenceMessageIds.includes(m.id)));
    return <Link key={conversation.id} href={`/client/conversations/${conversation.id}`} className="group block p-5 hover:bg-surface-hover"><div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{conversation.customer}</span><span className="text-xs text-muted">{conversation.channel==='console'?'Customer chat':human(conversation.channel)}</span>
     {conversation.needsTeam&&<Badge tone="amber">Needs your team</Badge>}{conversation.assistantCompleted&&<Badge tone="green">Assistant completed</Badge>}{analysis&&<Badge tone={sentimentTone(analysis.sentiment)}>{human(analysis.sentiment)}</Badge>}
     <ArrowRight size={16} className="ml-auto text-muted group-hover:text-accent" aria-hidden="true"/></div>
     {analysis&&<p className="mt-2 text-sm leading-6">{analysis.summary}</p>}{quote&&<blockquote className="mt-2 border-l-2 border-line pl-3 text-xs leading-5 text-muted">{quote.body.slice(0,210)}{quote.body.length>210?'…':''}</blockquote>}
    </Link>;})}{!visible.length&&<p className="p-5 text-sm text-muted">No conversations match these filters.</p>}</div>
  </section>
  <p className="text-xs leading-5 text-muted">Last {data.days} calendar days, in UTC. Assistant completed means the current enquiry has a delivered assistant reply and no pending customer message or team handoff. It does not imply customer-confirmed resolution.</p>
 </div>;
}
function Metric({icon,title,value,detail}:{icon:ReactNode;title:string;value:string;detail:string}){return <section className="ui-panel p-5"><h2 className="flex items-center gap-2 text-sm font-medium text-muted"><span className="text-accent" aria-hidden="true">{icon}</span>{title}</h2><p className="mt-3 text-3xl font-semibold tabular-nums">{value}</p><p className="mt-2 text-xs leading-5 text-muted">{detail}</p></section>;}
function EvidenceButton({ids,show}:{ids:string[];show:(ids:string[])=>void}){return <button type="button" onClick={()=>show(ids)} className="inline-flex items-center gap-1 text-xs text-accent">{ids.length} supporting conversation{ids.length===1?'':'s'}<ArrowRight size={13} aria-hidden="true"/></button>;}
function HandoffReasons({handoffs}:{handoffs:AnalyticsData['handoffs']}){return <section className="ui-panel p-5"><h2 className="font-semibold">Handoff drivers</h2><p className="mt-1 text-xs leading-5 text-muted">Recorded reasons for bringing in your team during this period.</p><div className="mt-4 divide-y divide-line">{handoffs.map(row=><div key={row.reason} className="flex justify-between gap-3 py-2 text-sm"><span>{human(row.reason)}</span><span className="tabular-nums">{row.count}</span></div>)}{!handoffs.length&&<p className="text-sm text-muted">No handoffs recorded in this period.</p>}</div></section>;}
function ActivityChart({data}:{data:AnalyticsData}){
 const max=Math.max(1,...data.daily.flatMap(d=>[d.customers,d.replies]));const width=720;const plot=660;const step=plot/data.daily.length;
 return <section className="ui-panel p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 font-semibold"><BarChart3 size={18} className="text-accent" aria-hidden="true"/>Conversation activity</h2><p className="mt-1 text-xs text-muted">{number(data.totals.deliveredReplies)} Pronto replies delivered during this period.</p></div>
  <div className="flex gap-3 text-xs text-muted"><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-accent"/>Customer messages</span><span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-success"/>Pronto replies</span></div></div>
  <svg viewBox={`0 0 ${width} 205`} role="img" aria-label={`Daily activity: ${data.totals.customerMessages} customer messages and ${data.totals.deliveredReplies} delivered replies`} className="mt-6 block w-full overflow-visible">
   {[0,0.5,1].map(value=><g key={value}><line x1="35" x2="705" y1={165-value*140} y2={165-value*140} stroke="var(--line)" strokeDasharray={value?'3 4':undefined}/><text x="25" y={169-value*140} textAnchor="end" fill="var(--muted)" fontSize="11">{Math.round(value*max)}</text></g>)}
   {data.daily.map((day,index)=><g key={day.date}><title>{`${day.date}: ${day.customers} customer messages, ${day.replies} Pronto replies`}</title>
    <rect x={40+index*step} y={165-day.customers/max*140} width={Math.max(1,step*0.35)} height={day.customers/max*140} rx="2" fill="var(--accent)"/>
    <rect x={40+index*step+step*0.4} y={165-day.replies/max*140} width={Math.max(1,step*0.35)} height={day.replies/max*140} rx="2" fill="var(--success)"/></g>)}
   <text x="35" y="192" fill="var(--muted)" fontSize="11">{data.daily[0]?.date}</text><text x="705" y="192" textAnchor="end" fill="var(--muted)" fontSize="11">{data.daily.at(-1)?.date}</text>
  </svg>
  <table className="sr-only"><caption>Daily conversation activity in UTC</caption><thead><tr><th>Date</th><th>Customer messages</th><th>Pronto replies</th></tr></thead><tbody>{data.daily.map(day=><tr key={day.date}><td>{day.date}</td><td>{day.customers}</td><td>{day.replies}</td></tr>)}</tbody></table>
 </section>;
}
