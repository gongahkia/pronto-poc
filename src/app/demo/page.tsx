import Link from 'next/link';
import {ArrowRight, MessagesSquare, Store} from 'lucide-react';
import {notFound} from 'next/navigation';
import {requireUser} from '@/lib/auth';
import {assertDemoActor} from '@/lib/customer-demo';
import {DemoError} from '@/lib/customer-demo-boundary';
import {isGuestEmail} from '@/lib/guest-policy';

export const dynamic = 'force-dynamic';

export default async function DemoEntryPage() {
  const user = await requireUser('client');
  try { await assertDemoActor(user); }
  catch (error) { if (error instanceof DemoError && error.status < 500) notFound(); throw error; }
  return <main className="flex min-h-screen items-center justify-center bg-surface-subtle px-4 py-10 text-foreground">
    <section className="w-full max-w-2xl" aria-labelledby="demo-heading">
      <p className="mb-2 text-sm font-semibold text-accent">Pronto prototype</p>
      <h1 id="demo-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">How would you like to try Pronto?</h1>
      <p className="mb-6 mt-3 text-sm leading-6 text-muted">Welcome, {user.name}. Explore PS.Cafe Raffles City from either side of the conversation.</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/demo/customer" prefetch={false} className="ui-panel group flex flex-col p-6 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
          <MessagesSquare size={24} aria-hidden="true" className="mb-4 text-accent"/>
          <h2 className="text-lg font-semibold">Guest / customer</h2>
          <p className="mb-6 mt-2 flex-1 text-sm leading-6 text-muted">Ask the restaurant questions and experience replies from Pronto.</p>
          <span className="flex items-center gap-2 text-sm font-semibold text-accent">Open customer chat <ArrowRight size={16} aria-hidden="true"/></span>
        </Link>
        <Link href="/client/inbox" prefetch={false} className="ui-panel group flex flex-col p-6 transition-colors hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-accent">
          <Store size={24} aria-hidden="true" className="mb-4 text-accent"/>
          <h2 className="text-lg font-semibold">Client / business</h2>
          <p className="mb-6 mt-2 flex-1 text-sm leading-6 text-muted">Review the inbox, reply as the business and manage restaurant knowledge.</p>
          <span className="flex items-center gap-2 text-sm font-semibold text-accent">Open business inbox <ArrowRight size={16} aria-hidden="true"/></span>
        </Link>
      </div>
      <p className="mt-5 text-sm leading-6 text-muted">You can switch demo views at any time. Both views share the same synthetic workspace; nothing is sent to real customers.</p>
      <form action="/api/auth/logout" method="post" className="mt-4"><button className="text-sm text-accent underline underline-offset-4">{isGuestEmail(user.email) ? 'Use a different name' : 'Sign out'}</button></form>
    </section>
  </main>;
}
