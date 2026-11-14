import {NextResponse} from 'next/server';
import {getSessionUser} from '@/lib/auth';
import {assertInternalFeedbackActor} from '@/lib/feedback/authorization';
import {DEMO_CLIENT_ID,DemoError} from '@/lib/customer-demo-boundary';
import {exportCompleteFeedback,exportFeedback} from '@/lib/feedback/export';
import {z} from 'zod';
import {assertFeedbackEnabled} from '@/lib/feedback/state';
export async function GET(request:Request){
 try{
  await assertInternalFeedbackActor(await getSessionUser());assertFeedbackEnabled();
  const params=new URL(request.url).searchParams;
  const parsed=z.object({status:z.enum(['open','all']),cursor:z.string().uuid().optional(),complete:z.enum(['1']).optional()}).refine(v=>!(v.complete&&v.cursor)).safeParse({status:params.get('status')??'open',cursor:params.get('cursor')??undefined,complete:params.get('complete')??undefined});
  if(!parsed.success)return NextResponse.json({error:'Invalid feedback export options.'},{status:400});
  const includeResolved=parsed.data.status==='all';
  const data=parsed.data.complete?await exportCompleteFeedback(DEMO_CLIENT_ID,{includeResolved}):await exportFeedback(DEMO_CLIENT_ID,{includeResolved,cursor:parsed.data.cursor});
  return new Response(JSON.stringify(data,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="pronto-feedback.json"','Cache-Control':'private, no-store'}});
 }catch(error){return NextResponse.json({error:error instanceof DemoError?error.message:'Could not export feedback.'},{status:error instanceof DemoError?error.status:500});}
}
