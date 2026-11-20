import { customerSimulatorEnabled } from "@/lib/customer-simulator-policy";
import Link from "next/link";
import { requireUser } from "@/lib/auth";

export default async function AccountPage() {
  const user = await requireUser();
  return <main className="min-h-screen bg-background px-4 py-10 text-foreground">
    <section className="ui-panel mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold">Your Pronto account</h1>
      <p className="text-sm">Signed in as {user.email} ({user.role}).</p>
      <Link href="/client/inbox" className="block text-sm text-accent">Open business inbox</Link>
      {user.role === "operator" ? <p className="text-sm text-muted">Business conversations require a separate authorized business staff account. Administrative services remain protected by operator authentication.</p> : null}
      {customerSimulatorEnabled() && process.env.PRONTO_CUSTOMER_DEMO_ENABLED === "1" && process.env.NODE_ENV !== "production"
        ? <Link href="/demo/customer" className="block text-sm text-accent">Open customer simulator</Link> : null}
      <form action="/api/auth/logout" method="post"><button className="ui-button px-4 py-2">Log out</button></form>
    </section>
  </main>;
}
