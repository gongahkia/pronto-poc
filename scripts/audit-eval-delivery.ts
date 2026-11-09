import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyTestDatabase} from './test-db-safety';
import {query,getPool} from '../src/lib/db';
import {plainMessageText} from '../src/lib/message-text';
import {writeEvalArtifact} from './eval-artifacts';

const arg=(key:string)=>{const index=process.argv.indexOf(key);return index<0?undefined:process.argv[index+1];};
const paths=arg('--reports')?.split(',');if(!paths?.length)throw new Error('Use --reports <candidate.json>,<website.json>,<stress.json>. This is a read-only database audit.');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const failures:string[]=[],reportHashes:{path:string;hash:string}[]=[];
let turns=0,verifiedReplies=0,verifiedSilentTurns=0;
await verifyTestDatabase();
try{
 for(const input of paths){
  const path=resolve(input);if(!path.startsWith(resolve('output/live-eval')+'/'))throw new Error('Audit local evaluation reports only.');
  const raw=await readFile(path,'utf8'),report=JSON.parse(raw);
  if(!report.complete||report.runStatus!=='completed')throw new Error('Audit complete reports only.');
  reportHashes.push({path,hash:hash(raw)});
  const captures=JSON.parse(await readFile(resolve(dirname(path),'calls.json'),'utf8')) as {responseId?:string;caseId:string;round?:number;turn:number;instructions:string;outputText?:string}[];
  for(const row of report.observations){
   turns++;
   const key=`${report.runId}/${row.caseId}/${row.round??1}/${row.turn}`;
   const inbound=await query<{id:string}>(`select id from messages where client_id=$1 and conversation_id=$2 and sender_role='customer' and body=$3 and metadata->'raw'->>'evalRunId'=$4`,
    ['00000000-0000-4000-8000-00000000a101',row.conversationId,row.customer,report.runId]);
   if(inbound.rows.length!==1){failures.push(`${key}: cannot uniquely locate the original synthetic inbound`);continue;}
   const customerMessageId=inbound.rows[0].id;
   const messages=await query<{body:string;metadata:{providerResponseId?:string;responseProvider?:string;responseModel?:string;generationMode?:string;citedChunkIds?:string[]}}>(
    `select body,metadata from messages where client_id=$1 and conversation_id=$2 and sender_role='agent' and metadata->>'customerMessageId'=$3 order by created_at,id`,
    ['00000000-0000-4000-8000-00000000a101',row.conversationId,customerMessageId]);
   if(row.outcome==='skipped'){
    if(messages.rows.length)failures.push(`${key}: a human-owned turn has an agent message`);else verifiedSilentTurns++;
    continue;
   }
   if(messages.rows.length!==1){failures.push(`${key}: expected exactly one persisted agent reply`);continue;}
   const message=messages.rows[0],metadata=message.metadata;
   const capture=captures.find(call=>call.responseId===metadata.providerResponseId&&call.caseId===row.caseId&&(call.round??1)===(row.round??1)&&call.turn===row.turn);
   if(!capture||metadata.responseProvider!=='openai'||metadata.responseModel!=='gpt-6-luna'||metadata.generationMode!=='real'){
    failures.push(`${key}: delivered message lacks its own matching genuine generation`);continue;
   }
   const draft=JSON.parse(capture.outputText??'{}');
   if(message.body!==row.answer||message.body!==plainMessageText(String(draft.answer??'')).trim())failures.push(`${key}: stored reply differs from its own captured model draft`);
   const actualContext=new Set([...capture.instructions.matchAll(/chunk_id="([^"]+)"/g)].map(match=>match[1]));
   if((metadata.citedChunkIds??[]).some(id=>!actualContext.has(id)))failures.push(`${key}: delivered citation was absent from that exact generation's prompt`);
   const delivery=await query<{body:string;status:string}>(`select body,status from outbound_messages where client_id=$1 and channel_id=$2 and metadata->>'customerMessageId'=$3`,
    ['00000000-0000-4000-8000-00000000a101','00000000-0000-4000-8000-00000000a106',customerMessageId]);
   if(delivery.rows.length!==1||delivery.rows[0].status!=='sent'||delivery.rows[0].body!==message.body)failures.push(`${key}: outbox evidence does not match the exact reply`);
   verifiedReplies++;
  }
 }
 const summary={complete:true,kind:'Read-only persisted reply and outbox audit; each reply is matched to its own provider response ID, draft and source context, not a union across repair calls.',
  reportHashes,turns,verifiedReplies,verifiedSilentTurns,failures,passed:failures.length===0};
 await writeEvalArtifact(resolve('output/live-eval/hardening-delivery-audit.json'),JSON.stringify(summary,null,2)+'\n');
 console.log(JSON.stringify(summary));if(failures.length)process.exitCode=1;
}finally{await getPool().end();}
