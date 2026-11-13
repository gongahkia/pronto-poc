import { BotMessageSquare } from "lucide-react";
import { getSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { safeReturnTo, signedInDestination } from "@/lib/auth-navigation";
import {guestAccessEnabled} from '@/lib/guest-policy';
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';

export const dynamic='force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string }>;
}) {
  const params = await searchParams;
  const returnTo = safeReturnTo(params.next);
  const user = await getSessionUser();
  if(guestAccessEnabled() && (!user || user.role==='client' && user.clientId===DEMO_CLIENT_ID)) redirect('/demo');
  if (user) {
    redirect(signedInDestination(user.role, returnTo));
  }
  return (
    <main className="flex min-h-screen items-center justify-center bg-surface-subtle px-4 py-10 text-foreground">
      <div className="grid w-full max-w-5xl items-center gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(20rem,0.9fr)] lg:gap-16">
        <section className="max-w-xl">
          <div className="mb-8 flex items-center gap-3 text-lg font-semibold">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-accent text-white"><BotMessageSquare size={22} aria-hidden="true" /></span>
            Pronto
          </div>
          <h1 className="text-3xl font-semibold leading-tight tracking-tight sm:text-4xl">Customer service grounded in your business.</h1>
          <ul className="mt-7 grid gap-3 text-sm sm:grid-cols-3 lg:grid-cols-1">
            <li className="rounded-lg border border-line bg-panel px-4 py-3">Answers from your business information</li>
            <li className="rounded-lg border border-line bg-panel px-4 py-3">Customer messages in one inbox</li>
            <li className="rounded-lg border border-line bg-panel px-4 py-3">Human handoff when a question needs care</li>
          </ul>
        </section>
        <section className="ui-panel w-full p-6 sm:p-8" aria-labelledby="sign-in-heading">
          <h2 id="sign-in-heading" className="text-xl font-semibold">Sign in</h2>
          <p className="mb-6 mt-1 text-sm text-muted">Open your Pronto workspace.</p>
          {params.error ? (
            <p className="mb-4 rounded-md border border-danger/25 bg-danger-bg px-3 py-2 text-sm text-danger">
              Invalid email or password.
            </p>
          ) : null}
          <form action="/api/auth/login" method="post" className="space-y-4">
          {returnTo ? <input type="hidden" name="next" value={returnTo}/> : null}
          <label className="block text-sm font-medium">
            Email
            <input
              name="email"
              type="email"
              autoComplete="username"
              required
              className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-accent"
              placeholder="you@example.com"
            />
          </label>
          <label className="block text-sm font-medium">
            Password
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              className="mt-1 w-full rounded-md border border-line px-3 py-2 outline-none focus:border-accent"
              placeholder="Password"
            />
          </label>
          <button className="w-full rounded-md bg-accent px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-dark">
            Sign in
          </button>
          </form>
        </section>
      </div>
    </main>
  );
}
