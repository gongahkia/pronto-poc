import {z} from 'zod';

export const LEGACY_DEMO_SCOPE = {clientId:'00000000-0000-4000-8000-00000000a101',
 channelId:'00000000-0000-4000-8000-00000000a106',slug:'ps-cafe-raffles-city-demo',seed:'ps-cafe-raffles-city-v1'} as const;
const identitySchema=z.object({clientId:z.uuid().transform(id=>id.toLowerCase()),channelId:z.uuid().transform(id=>id.toLowerCase()),
 slug:z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),seed:z.string().regex(/^[a-z0-9][a-z0-9_-]{0,99}$/)})
 .refine(value=>value.clientId!==value.channelId,'Business and console channel identities must differ.');
export type DemoBusinessScope=z.infer<typeof identitySchema>;

// Read server configuration per operation; imports never capture a tenant from
// another test or deployment. A partial override must never select the default.
export function demoBusinessScope(env:Record<string,string|undefined>=process.env):DemoBusinessScope {
 const values={clientId:env.PRONTO_DEMO_CLIENT_ID,channelId:env.PRONTO_DEMO_CHANNEL_ID,
  slug:env.PRONTO_DEMO_SLUG,seed:env.PRONTO_DEMO_SEED};
 if(Object.values(values).every(value=>value===undefined))return {...LEGACY_DEMO_SCOPE};
 const result=identitySchema.safeParse(values);
 if(!result.success)throw new Error('Set all four valid demo business identity settings, or omit all four to retain the original demo.');
 return result.data;
}

export const demoPresentationSchema=z.object({name:z.string().trim().min(1).max(100),
 assistantLabel:z.string().trim().min(1).max(120),description:z.string().trim().max(160),
 logoPath:z.string().regex(/^\/brands\/(?:[a-z0-9_-]+\/)*[a-z0-9_-]+\.(?:webp|png|jpg|jpeg|svg)$/i).nullable()}).strict();
export type DemoBusinessPresentation=z.infer<typeof demoPresentationSchema>;

export function businessPresentation(client:{name:string;business_profile?:Record<string,unknown>}):DemoBusinessPresentation {
 const profile=client.business_profile??{},configured=demoPresentationSchema.partial().safeParse(profile.demoPresentation??{});
 if(!configured.success)throw new Error('Business presentation settings are invalid.');
 const name=client.name.replace(/\s+\((?:unofficial )?demo\)$/,'');
 const legacy=profile.demoSeed===LEGACY_DEMO_SCOPE.seed;
 return demoPresentationSchema.parse({name,assistantLabel:legacy?'PS.Cafe assistant':`${name} assistant`,
  description:'Business enquiries',logoPath:legacy?'/brands/ps-cafe-logo.webp':null,
  ...(legacy?{description:'Restaurant enquiries'}:{}),...configured.data});
}
