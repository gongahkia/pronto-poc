import {notFound,redirect} from 'next/navigation';
import {guestAccessEnabled} from '@/lib/guest-policy';

export const dynamic='force-dynamic';

// Keep previously shared entry links working without a separate name step.
export default async function EnterDemoPage({searchParams}:{searchParams:Promise<{error?:string}>}){
 if(!guestAccessEnabled())notFound();
 const {error}=await searchParams;
 redirect(error?`/demo?${new URLSearchParams({error})}`:'/demo');
}
