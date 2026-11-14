import {NextResponse} from 'next/server';
import {getSessionUser} from '@/lib/auth';
import {assertInternalFeedbackActor} from '@/lib/feedback/authorization';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {query,transaction} from '@/lib/db';
import {assertSameOrigin} from '@/lib/http/csrf';
import {feedbackMutation,feedbackPath} from '@/lib/feedback/schema';
import type {FeedbackThread} from '@/lib/feedback/types';
const THREAD_LIMIT=100,COMMENT_LIMIT=50;
class ReplayedRequest extends Error{}
async function actor(){return assertInternalFeedbackActor(await getSessionUser());}
function failure(error:unknown){return NextResponse.json({error:error instanceof DemoError?error.message:'Could not save prototype feedback.'},{status:error instanceof DemoError?error.status:500});}
// No path means every prototype page, so reviewers see each other's comments workspace-wide.
export async function GET(request:Request){
 try{const user=await actor();const requested=new URL(request.url).searchParams.get('path');
  const parsed=requested===null?{success:true as const,data:null}:feedbackPath.safeParse(requested);
  if(!parsed.success)return NextResponse.json({error:'Choose a valid prototype page.'},{status:400});
  const result=await query<FeedbackThread>(`select t.id,t.page_path,t.anchor,t.status,t.created_at,t.updated_at,
   (select count(*)::int from demo_feedback_comments where client_id=t.client_id and thread_id=t.id) comment_count,
   (select coalesce(jsonb_agg(row_to_json(c) order by c.created_at,c.id),'[]'::jsonb) from
    (select id,author_user_id,author_name,body,created_at from demo_feedback_comments where client_id=t.client_id and thread_id=t.id order by created_at desc,id desc limit ${COMMENT_LIMIT})c) comments
   from demo_feedback_threads t where t.client_id=$1 and ($2::text is null or t.page_path=$2) order by t.updated_at desc,t.id desc limit ${THREAD_LIMIT+1}`,[DEMO_CLIENT_ID,parsed.data]);
  return NextResponse.json({viewerId:user.userId,threads:result.rows.slice(0,THREAD_LIMIT),hasMoreThreads:result.rows.length>THREAD_LIMIT},{headers:{'Cache-Control':'private, no-store'}});
 }catch(e){return failure(e);}
}
export async function POST(request:Request){
 const csrf=assertSameOrigin(request);if(csrf)return csrf;
 try{const user=await actor();const raw=await request.text();
  if(Buffer.byteLength(raw)>16384)return NextResponse.json({error:'Feedback request is too large.'},{status:413});
  let body:unknown;try{body=JSON.parse(raw);}catch{body=null;}
  const parsed=feedbackMutation.safeParse(body);
  if(!parsed.success)return NextResponse.json({error:'Add a comment of up to 3,000 characters on a valid page.'},{status:400});
  const input=parsed.data;
  const requestId=input.action==='status'?null:input.requestId;
  try{
  const id=await transaction(async db=>{
   let threadId:string;
   if(input.action==='create'){
    const row=await db.query<{id:string}>(`insert into demo_feedback_threads(client_id,page_path,anchor,created_by_user_id) values($1,$2,$3,$4) returning id`,[DEMO_CLIENT_ID,input.path,input.anchor,user.userId]);threadId=row.rows[0].id;
   }else{
    const found=await db.query<{id:string}>(`select id from demo_feedback_threads where client_id=$1 and id=$2 for update`,[DEMO_CLIENT_ID,input.threadId]);
    if(!found.rows[0])throw new DemoError('Feedback thread not found.',404);threadId=found.rows[0].id;
   }
   if(input.action==='status')await db.query(`update demo_feedback_threads set status=$3,updated_at=now() where client_id=$1 and id=$2`,[DEMO_CLIENT_ID,threadId,input.status]);
   else{
    // A repeated request ID means an earlier attempt already committed; roll back this one and return the original.
    const inserted=await db.query<{id:string}>(`insert into demo_feedback_comments(client_id,thread_id,author_user_id,author_name,body,request_id) values($1,$2,$3,$4,$5,$6)
     on conflict(client_id,request_id) where request_id is not null do nothing returning id`,[DEMO_CLIENT_ID,threadId,user.userId,user.name,input.body,requestId]);
    if(!inserted.rows[0])throw new ReplayedRequest();
    await db.query(`update demo_feedback_threads set updated_at=now() where client_id=$1 and id=$2`,[DEMO_CLIENT_ID,threadId]);
   }return threadId;
  });return NextResponse.json({id});
  }catch(e){
   if(e instanceof ReplayedRequest&&requestId){
    const prior=await query<{thread_id:string}>(`select thread_id from demo_feedback_comments where client_id=$1 and request_id=$2 and author_user_id=$3`,[DEMO_CLIENT_ID,requestId,user.userId]);
    if(prior.rows[0])return NextResponse.json({id:prior.rows[0].thread_id,replayed:true});
    return NextResponse.json({error:'This save request was already used. Reload and try again.'},{status:409});
   }
   throw e;
  }
 }catch(e){return failure(e);}
}
