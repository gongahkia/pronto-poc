import { SelfServeFrame } from "@/components/self-serve/frame";
import { ServiceStatus } from "@/components/service-status";
import "@/components/self-serve/self-serve.css";

export const dynamic = "force-dynamic";
export default function WorkspaceStatusPage() {
  return (
    <SelfServeFrame allowReadOnly>
      <ServiceStatus embedded />
    </SelfServeFrame>
  );
}
