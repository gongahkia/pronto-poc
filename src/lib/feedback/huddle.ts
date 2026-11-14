import 'server-only';
import {CollaborationError,ReviewStore,type Directory,type Scope} from '@huddle/host';
import {PostgresBackend,type PostgresPool} from '@huddle/host/postgres';
import {createNextHandler} from '@huddle/host/next';
import {getSessionUserFromToken,type SessionUser} from '@/lib/auth';
import {SESSION_COOKIE_NAME} from '@/lib/session-token';
import {NextRequest} from 'next/server';
import {getPool} from '@/lib/db';
import {DemoError,DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';
import {huddleReviewConfig} from '@/lib/huddle-config';
import {assertSameOrigin} from '@/lib/http/csrf';
import {assertInternalFeedbackActor,internalFeedbackUserIds} from './authorization';
import {assertFeedbackEnabled,lockFeedbackTransaction} from './state';

const checkScope = (scope:Scope) => {
  const config = huddleReviewConfig();
  if(!config) throw new CollaborationError('unavailable','Internal feedback is disabled.');
  if(scope.workspace !== DEMO_CLIENT_ID || scope.environment !== config.environment) throw new CollaborationError('forbidden','This feedback scope is not available.');
};
function authorization(loadSession:() => Promise<SessionUser | null>) {return async (scope:Scope,signal:AbortSignal) => {
  signal.throwIfAborted();
  try {const actor = await assertInternalFeedbackActor(await loadSession()); checkScope(scope); signal.throwIfAborted(); return {actor:{id:actor.userId,name:actor.name},capabilities:{mentions:true,assignment:true,directory:true}};}
  catch(error) {if(error instanceof DemoError) throw new CollaborationError(error.status === 401 ? 'unauthenticated' : error.status === 403 ? 'forbidden' : 'unavailable',error.message); throw error;}
};}
const directory:Directory = {
  async lookup(scope,ids,signal) {checkScope(scope);signal.throwIfAborted();const approved = internalFeedbackUserIds();const selected = ids.filter(id => approved.includes(id.toLowerCase()));if(selected.length !== ids.length) return [];
    const result = await getPool().query<{id:string;name:string}>(`select id::text,name from users where id=any($1::uuid[]) and lower(email) not like '%@guest.invalid' and (role='operator' or (role='client' and client_id=$2)) order by id`,[selected,DEMO_CLIENT_ID]);signal.throwIfAborted();return result.rows;},
  async list(scope,input,signal) {checkScope(scope);if(input.cursor) throw new CollaborationError('validation','The internal directory has one bounded page.'); const members = await directory.lookup(scope,internalFeedbackUserIds(),signal), search = input.search?.toLocaleLowerCase();return {items:members.filter(member => !search || member.name.toLocaleLowerCase().includes(search)),nextCursor:null};},
};
const pool:PostgresPool = {async connect() {
  const client = await getPool().connect();
  return {async query(text,values) {const result = await client.query(text,values);if(/^BEGIN(?:\s|$)/.test(text)) {await lockFeedbackTransaction(client,'huddle',text.includes('READ ONLY'));}return result;},release:destroy => client.release(destroy),on:(event,listener) => client.on(event,listener),removeListener:(event,listener) => client.removeListener(event,listener)};
}};
let pendingBackend:Promise<PostgresBackend> | undefined;
async function backend() {
  if(!pendingBackend) pendingBackend = PostgresBackend.open(pool,{schema:'huddle',beforeQuery:({scope}) => {if(scope) checkScope(scope);}}).catch(error => {pendingBackend = undefined;throw error;});
  return pendingBackend;
}
export const handleFeedback = createNextHandler({basePath:'/api/demo/feedback/v2',timeoutMs:120000,
  async api(request,signal) {
    const cookie = new NextRequest(request.url,{headers:request.headers}).cookies.get(SESSION_COOKIE_NAME)?.value, authorize = authorization(() => getSessionUserFromToken(cookie));
    // fail before opening storage for an anonymous/guest request.
    const config = huddleReviewConfig(); await authorize({workspace:DEMO_CLIENT_ID,environment:config?.environment ?? ''},signal); assertFeedbackEnabled();
    return new ReviewStore(await backend(),authorize,directory);
  },
  verifyMutation(request) {if(assertSameOrigin(request)) throw new CollaborationError('forbidden','Cross-origin feedback mutation rejected.');},
});
