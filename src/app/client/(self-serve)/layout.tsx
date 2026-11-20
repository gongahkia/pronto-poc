import { SelfServeFrame } from "@/components/self-serve/frame";
import "@/components/self-serve/self-serve.css";
export const dynamic = "force-dynamic";
export default function SelfServeLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <SelfServeFrame>{children}</SelfServeFrame>;
}
