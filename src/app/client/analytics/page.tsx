import {redirect} from 'next/navigation';
import {requireUser} from '@/lib/auth';
import {canViewBusinessConversation} from '@/lib/staff-permissions';
import {getClient} from '@/lib/dashboard';
import {getAnalyticsData} from '@/lib/analytics/data';
import {AppShell} from '@/components/shell';
import {AnalyticsDashboard} from '@/components/analytics-dashboard';
export default async function AnalyticsPage({searchParams}:{searchParams?:Promise<{period?:string}>}) {
 const user=await requireUser('client');if(!user.clientId)redirect('/access?reason=membership');
 if(!await canViewBusinessConversation(user,user.clientId))redirect('/access?reason=permission');
 const params=await searchParams??{};const period=['7','30','90'].includes(params.period??'')?params.period:'30';
 const [client,data]=await Promise.all([getClient(user.clientId),getAnalyticsData(user.clientId,period)]);
 if(!client)throw new Error('Business not found.');
 return <AppShell user={user} active="client" clientActive="analytics" workspaceName={client.name} workspaceProfile={client.business_profile}><AnalyticsDashboard key={`${data.days}:${data.snapshot?.id??'empty'}`} data={data}/></AppShell>;
}
