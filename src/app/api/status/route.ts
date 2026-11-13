import {NextResponse} from 'next/server';
import {getServiceStatus} from '@/lib/service-status';
export const dynamic='force-dynamic';
export async function GET(){
 const report=await getServiceStatus();
 return NextResponse.json(report,{status:report.status==='operational'?200:503,headers:{'Cache-Control':'no-store'}});
}
