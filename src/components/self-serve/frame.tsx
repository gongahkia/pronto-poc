import { DemoQueuePump } from "@/components/demo-queue-pump";
import { demoBusinessScope } from "@/lib/demo-business";
import { requestDrivenDemoProcessing } from "@/lib/deployment-profile";
import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { query } from "@/lib/db";
import { hasStaffCapability } from "@/lib/staff-permissions";
import { selfServeUIEnabled } from "@/lib/self-serve/settings";
import { snapshot } from "@/lib/self-serve/store";
import { SelfServeWorkspace } from "@/components/self-serve/workspace";
export async function SelfServeFrame({
  children,
}: {
  children: React.ReactNode;
}) {
  if (!selfServeUIEnabled()) notFound();
  const user = await requireUser("client");
  if (!user.clientId) notFound();
  if (!(await hasStaffCapability(user, user.clientId, "knowledge.approve")))
    return (
      <main className="p-8">
        <h1>Workspace access required</h1>
        <p>
          Ask your business owner for permission to manage business knowledge.
        </p>
      </main>
    );
  const business = (
    await query<{ name: string }>("select name from clients where id=$1", [
      user.clientId,
    ])
  ).rows[0];
  return (
    <>
      {user.clientId === demoBusinessScope().clientId &&
        requestDrivenDemoProcessing() && <DemoQueuePump />}
      <SelfServeWorkspace
        name={business?.name ?? "Your business"}
        initial={JSON.parse(JSON.stringify(await snapshot(user.clientId)))}
      >
        {children}
      </SelfServeWorkspace>
    </>
  );
}
