import {createHash} from 'node:crypto';
import {z} from 'zod';
import {demoPresentationSchema,type DemoBusinessScope} from '@/lib/demo-business';
import {normalizeVoiceDraft} from '@/lib/voice-draft';

const publicUrl=z.url().refine(value=>{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password;});
const sourceSchema=z.object({id:z.uuid(),title:z.string().trim().min(1).max(200),content:z.string().trim().min(1).max(16000),
 url:publicUrl.optional(),secondaryUrl:publicUrl.optional(),reviewStatus:z.enum(['public_fact','public_fact_with_dietary_caution','policy_conflict_withheld'])}).strict();
const schema=z.object({version:z.literal(1),unofficialDemo:z.literal(true),
 identity:z.object({clientId:z.uuid(),channelId:z.uuid(),slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),seed:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)}).strict(),
 name:z.string().trim().min(1).max(100),vertical:z.enum(['fnb','retail','services','hospitality','other']),
 timezone:z.string().refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}}),
 presentation:demoPresentationSchema,voice:z.unknown(),knowledge:z.array(sourceSchema).min(1).max(30)}).strict();

export function parseDemoBusinessProfile(value:unknown){
 const parsed=schema.safeParse(value);
 if(!parsed.success)throw new Error('Invalid demo business profile. Use version 1, an unofficial demo identity, presentation, voice and bounded curated sources; credentials are not profile fields.');
 const profile=parsed.data,ids=[profile.identity.clientId,profile.identity.channelId,...profile.knowledge.map(source=>source.id)].map(id=>id.toLowerCase());
 if(new Set(ids).size!==ids.length)throw new Error('Business, channel and source IDs must be distinct.');
 if(profile.name!==profile.presentation.name)throw new Error('The business and presentation names must match.');
 const voice=normalizeVoiceDraft(profile.voice);
 return {...profile,identity:{...profile.identity,clientId:profile.identity.clientId.toLowerCase(),channelId:profile.identity.channelId.toLowerCase()},voice};
}
export type DemoBusinessProfile=ReturnType<typeof parseDemoBusinessProfile>;
export function demoBusinessProfileHash(profile:DemoBusinessProfile){return createHash('sha256').update(JSON.stringify(profile)).digest('hex');}
export function demoBusinessEnvironment(identity:DemoBusinessScope){return {
 PRONTO_DEMO_CLIENT_ID:identity.clientId,PRONTO_DEMO_CHANNEL_ID:identity.channelId,PRONTO_DEMO_SLUG:identity.slug,PRONTO_DEMO_SEED:identity.seed};}
