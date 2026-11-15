import {NextResponse} from 'next/server';
import {isCollaborationError} from '@huddle/host';
import {DemoError} from '@/lib/customer-demo-boundary';
import {assertSameOrigin} from '@/lib/http/csrf';
import {updateFeedbackReviewerName} from '@/lib/feedback/profile';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function POST(request:Request){
 const csrf=assertSameOrigin(request);if(csrf)return csrf;
 try{return NextResponse.json(await updateFeedbackReviewerName(request),{headers:{'Cache-Control':'no-store'}});}
 catch(value){const status=value instanceof DemoError?value.status:503,message=value instanceof DemoError||isCollaborationError(value)?value.message:'Could not update your name. Please retry.';return NextResponse.json({error:message},{status,headers:{'Cache-Control':'no-store'}});}
}
