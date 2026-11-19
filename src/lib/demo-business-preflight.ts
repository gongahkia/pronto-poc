import {z} from 'zod';
import {query,type Queryable} from '@/lib/db';
import {demoBusinessScope,LEGACY_DEMO_SCOPE} from '@/lib/demo-business';
import {savedDemoBusinessIds} from '@/lib/demo-business-provisioning';
import {hasOnlyProtectedDemoKnowledge} from '@/lib/knowledge/protected-demo';
import {isGuestEmail} from '@/lib/guest-policy';
import type {Channel} from '@/lib/types';

// A disabled Instagram binding may remain as history, but only the exact
// configured account/channel and testers remain eligible for this boundary.
function retainedInstagramBinding(){
 const values=[process.env.PRONTO_DEMO_INSTAGRAM_CHANNEL_ID,process.env.PRONTO_DEMO_INSTAGRAM_ACCOUNT_ID,process.env.PRONTO_DEMO_INSTAGRAM_SENDER_IDS];
 if(values.every(value=>!value))return null;
 return z.object({channelId:z.uuid(),accountId:z.string().regex(/^\d+$/),senderIds:z.array(z.string().regex(/^\d+$/)).min(1).max(5)})
  .parse({channelId:values[0],accountId:values[1],senderIds:values[2]?.split(',').map(id=>id.trim())});
}

export async function assertSavedDemoWorkspaces(allowedUserIds:string[],db:Queryable={query}){
 const scope=demoBusinessScope(),saved=await savedDemoBusinessIds(db),instagram=retainedInstagramBinding();
 const clients=(await db.query<{id:string;slug:string;business_profile:Record<string,unknown>}>('select id,slug,business_profile from clients')).rows;
 const selected=clients.find(client=>client.id===scope.clientId);
 if(!selected||selected.slug!==scope.slug||selected.business_profile.demoSeed!==scope.seed||
  clients.some(client=>!saved.includes(client.id)||client.business_profile.approvedByRestaurant!==false))
  throw new Error('Only prepared, unofficial saved demo businesses may be present; the selected identity must match.');
 const consoleChannels=new Map(clients.map(client=>[client.id,client.id===LEGACY_DEMO_SCOPE.clientId?LEGACY_DEMO_SCOPE.channelId:
  (client.business_profile.demoBusiness as {channelId?:string}|undefined)?.channelId]));
 if(consoleChannels.get(scope.clientId)!==scope.channelId)throw new Error('The selected console channel must match its saved business.');
 const channels=(await db.query<Channel>('select id,client_id,kind,status,settings,external_id from channels')).rows;
 const validConsole=(channel:Channel)=>saved.includes(channel.client_id)&&channel.id===consoleChannels.get(channel.client_id)&&
  channel.kind==='console'&&channel.settings.transport==='customer_simulator';
 const validInstagram=(channel:Channel)=>Boolean(instagram&&saved.includes(channel.client_id)&&channel.id===instagram.channelId&&
  channel.kind==='instagram'&&channel.external_id===instagram.accountId&&channel.settings.authMode==='unified_login');
 if(!channels.some(channel=>channel.id===scope.channelId&&validConsole(channel)&&channel.status==='active')||
  channels.some(channel=>!validConsole(channel)&&!validInstagram(channel)))
  throw new Error('Only saved demo consoles and the explicitly configured Instagram binding may be present.');
 if(process.env.PRONTO_DEMO_INSTAGRAM_ENABLED==='1'&&!channels.some(channel=>validInstagram(channel)&&channel.client_id===scope.clientId&&channel.status==='active'))
  throw new Error('Instagram cannot follow a business switch without an explicit matching binding.');
 const conversations=(await db.query<{client_id:string;channel_id:string;customer_handle:string|null;external_thread_id:string}>(
  'select client_id,channel_id,customer_handle,external_thread_id from conversations')).rows;
 if(conversations.some(conversation=>{
  const channel=channels.find(channel=>channel.id===conversation.channel_id&&channel.client_id===conversation.client_id);
  return !channel||!(validConsole(channel)?conversation.customer_handle?.startsWith('demo:'):
   validInstagram(channel)&&instagram?.senderIds.includes(conversation.external_thread_id));
 }))throw new Error('A conversation is outside its saved demo business or approved tester scope.');
 const users=(await db.query<{id:string;client_id:string|null;role:string;email:string}>('select id,client_id,role,email from users')).rows;
 if(users.some(user=>!(/\.(test|invalid)$/i.test(user.email))||
  (user.role==='client'?!user.client_id||!saved.includes(user.client_id):user.role!=='operator'||user.client_id!==null)||
  !(user.role==='client'&&isGuestEmail(user.email))&&!allowedUserIds.includes(user.id))||
  allowedUserIds.some(id=>!users.some(user=>user.id===id)))throw new Error('Demo account allowlist does not match saved accounts.');
 for(const clientId of saved)if(!await hasOnlyProtectedDemoKnowledge(db,clientId))
  throw new Error('Saved knowledge must retain curated or reviewed publication provenance.');
 const integrations=await db.query<{count:number}>('select count(*)::int count from integration_credentials');
 if(integrations.rows[0].count)throw new Error('Protected demo must not contain external integration credentials.');
 return {businesses:clients.length,activeClientId:scope.clientId};
}
