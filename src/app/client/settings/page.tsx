import { SelfServeFrame } from "@/components/self-serve/frame";
import "@/components/self-serve/self-serve.css";
import { requireUser } from "@/lib/auth";
import { getWorkspaceUsage, usageMonth } from "@/lib/analytics/usage";
import { Header } from "@/components/self-serve/workspace";
import { getClient } from "@/lib/dashboard";
import { selfServeUIEnabled } from "@/lib/self-serve/settings";
import { notFound } from "next/navigation";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!selfServeUIEnabled()) notFound();
  const user = await requireUser("client");
  if (!user.clientId) notFound();
  const params = await searchParams;
  const requested = Array.isArray(params.month)
    ? params.month[0]
    : params.month;
  let month: string,
    invalid = false;
  try {
    month = usageMonth(requested).month;
  } catch {
    month = usageMonth().month;
    invalid = true;
  }
  const [usage, business] = await Promise.all([
    getWorkspaceUsage(user.clientId, month),
    getClient(user.clientId),
  ]);
  const n = (value: number) => value.toLocaleString("en-SG");
  return (
    <SelfServeFrame allowReadOnly>
      <Header
        title="Settings"
        description="Your workspace, account and recorded usage."
      />
      <section className="ss-panel">
        <h2>Workspace & account</h2>
        <dl className="ss-settings-details">
          <div>
            <dt>Business</dt>
            <dd>{business?.name ?? "Your business"}</dd>
          </div>
          <div>
            <dt>Signed in as</dt>
            <dd>{user.name}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd>{user.email}</dd>
          </div>
          <div>
            <dt>Account</dt>
            <dd>Business staff</dd>
          </div>
        </dl>
        <form action="/api/auth/logout" method="post">
          <button className="ss-secondary">Log out</button>
        </form>
      </section>
      <section className="ss-panel">
        <div className="ss-row ss-wrap">
          <h2>Workspace usage</h2>
          <a
            className="ss-secondary"
            href={`/api/client/usage?month=${month}&format=csv`}
            download
          >
            Export CSV
          </a>
        </div>
        <form className="ss-usage-period" action="/client/settings">
          <label className="ss-field">
            Usage month
            <input type="month" name="month" defaultValue={month} required />
          </label>
          <button className="ss-secondary">Show usage</button>
        </form>
        {invalid && (
          <p role="alert" className="ss-feedback ss-warning">
            Choose a valid month. Showing the current month instead.
          </p>
        )}
        <dl className="ss-usage-stats">
          <div>
            <dt>Pronto replies</dt>
            <dd>{n(usage.deliveredReplies)}</dd>
            <p>Delivered to customers</p>
          </div>
          <div>
            <dt>Model calls</dt>
            <dd>{n(usage.generationCalls)}</dd>
            <p>Reply decisions and internal work</p>
          </div>
          <div>
            <dt>Internal work</dt>
            <dd>{n(usage.internalCalls)}</dd>
            <p>Setup, planning, intake and analytics</p>
          </div>
        </dl>
        <h3>Provider-reported tokens</h3>
        <dl className="ss-settings-details">
          <div>
            <dt>Input tokens</dt>
            <dd>{n(usage.providerInputTokens)}</dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{n(usage.providerOutputTokens)}</dd>
          </div>
          <div>
            <dt>Reasoning tokens · included in output</dt>
            <dd>
              {usage.reasoningReportedCalls
                ? n(usage.reasoningTokens)
                : "Not reported"}
            </dd>
          </div>
        </dl>
        <p className="ss-muted">
          Reasoning usage reported for {n(usage.reasoningReportedCalls)} of{" "}
          {n(usage.generationCalls)} model calls. Missing detail is unknown;
          output already includes reported reasoning tokens.
        </p>
        <h3 className="ss-usage-heading">What used your allowance</h3>
        {usage.breakdown.length ? (
          <dl className="ss-settings-details">
            {usage.breakdown.map((row) => (
              <div key={row.purpose}>
                <dt>
                  {row.purpose}
                  {row.estimatedCalls > 0 && (
                    <small> · {n(row.estimatedCalls)} estimated</small>
                  )}
                </dt>
                <dd>{n(row.calls)} calls</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="ss-muted">No recorded model calls this month.</p>
        )}
        {usage.embeddingCalls > 0 && (
          <p className="ss-muted">
            Includes {n(usage.embeddingCalls)} knowledge-retrieval calls,
            separate from generation.
          </p>
        )}
        {usage.estimatedCalls > 0 && (
          <p className="ss-feedback ss-info">
            {n(usage.estimatedCalls)} calls have estimated usage (
            {n(usage.estimatedInputTokens)} input /{" "}
            {n(usage.estimatedOutputTokens)} output tokens). These are excluded
            from provider-reported totals.
          </p>
        )}
        <p className="ss-muted ss-usage-footnote">
          Metered usage for {month}, in UTC. Each delivered reply is counted
          once. This is a usage statement; billing rates have not been
          configured.
        </p>
      </section>
    </SelfServeFrame>
  );
}
