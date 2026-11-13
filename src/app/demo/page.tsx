import Link from 'next/link';
import {ArrowRight, MessagesSquare, Store} from 'lucide-react';
import {notFound,redirect} from 'next/navigation';
import {getSessionUser} from '@/lib/auth';
import {assertDemoActor} from '@/lib/customer-demo';
import {DemoError} from '@/lib/customer-demo-boundary';
import {guestAccessEnabled,isGuestEmail} from '@/lib/guest-policy';
import {ServiceStatusLink} from '@/components/service-status';
import {enterTenantContext} from '@/lib/tenant-context';

export const dynamic = 'force-dynamic';
const views=[
 {href:'/demo/customer',title:'Guest / customer',description:'Ask the restaurant questions and experience replies from Pronto.',action:'Open customer chat',Icon:MessagesSquare},
 {href:'/client/inbox',title:'Client / business',description:'Review the inbox, reply as the business and manage restaurant knowledge.',action:'Open business inbox',Icon:Store},
];

export default async function DemoEntryPage({searchParams}:{searchParams:Promise<{error?:string}>}) {
  if(!guestAccessEnabled())notFound();
  const user=await getSessionUser();
  if(user){
    if(user.role!=='client')redirect('/access?reason=business-role');
    enterTenantContext(user);
    try { await assertDemoActor(user); }
    catch (error) { if (error instanceof DemoError && error.status < 500) notFound(); throw error; }
  }
  const {error}=await searchParams;
  return <main className="flex min-h-screen items-center justify-center bg-surface-subtle px-4 py-10 text-foreground">
    <section className="w-full max-w-2xl" aria-labelledby="demo-heading">
      <p className="mb-2 text-sm font-semibold text-accent">Pronto prototype</p>
      <h1 id="demo-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">How would you like to try Pronto?</h1>
      <p className="mb-6 mt-3 text-sm leading-6 text-muted">{user?`Welcome, ${user.name}. `:''}Explore PS.Cafe Raffles City from either side of the conversation.</p>
      {error&&<p role="alert" className="mb-4 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
      <form action="/api/auth/guest" method="post">
        {!user&&<div className="mb-5 max-w-sm"><label className="block text-sm font-medium" htmlFor="reviewer-name">Your name <span className="font-normal text-muted">(optional)</span></label>
          <input id="reviewer-name" name="name" maxLength={40} autoComplete="name" placeholder="e.g. Keith" className="ui-input mt-2 w-full px-3 py-2 text-sm"/>
          <p className="mt-2 text-xs leading-5 text-muted">Used to identify your feedback. No account or password needed.</p></div>}
        <div className="grid gap-4 sm:grid-cols-2">
          {views.map(({href,title,description,action,Icon})=>{
            const content=<><Icon size={24} aria-hidden="true" className="mb-4 text-accent"/><h2 className="text-lg font-semibold">{title}</h2>
              <p className="mb-6 mt-2 flex-1 text-sm leading-6 text-muted">{description}</p><span className="flex items-center gap-2 text-sm font-semibold text-accent">{action} <ArrowRight size={16} aria-hidden="true"/></span></>;
            const className='ui-panel group flex w-full flex-col p-6 text-left transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent';
            return user?<Link key={href} href={href} prefetch={false} className={className}>{content}</Link>:
              <button key={href} type="submit" name="next" value={href} className={className}>{content}</button>;
          })}
        </div>
      </form>
      <p className="mt-5 text-sm leading-6 text-muted">You can switch demo views at any time. Both views share the same synthetic workspace; nothing is sent to real customers.</p>
      {user&&<form action="/api/auth/logout" method="post" className="mt-4"><button className="text-sm text-accent underline underline-offset-4">{isGuestEmail(user.email) ? 'Reset demo session' : 'Sign out'}</button></form>}
      <div className="mt-4"><ServiceStatusLink/></div>
    </section>
  </main>;
}
