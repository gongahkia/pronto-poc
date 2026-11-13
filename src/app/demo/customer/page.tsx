import { requireUser } from "@/lib/auth";
import { assertDemoActor } from "@/lib/customer-demo";
import { CustomerSimulator } from "@/components/customer-simulator";
import { notFound } from "next/navigation";
import { DemoError } from "@/lib/customer-demo-boundary";
import { DemoFeedback } from "@/components/demo-feedback";
import {DemoQueuePump} from '@/components/demo-queue-pump';
import {requestDrivenDemoProcessing} from '@/lib/deployment-profile';

export default async function CustomerDemoPage() {
  const actor = await requireUser();
  try { await assertDemoActor(actor); }
  catch (error) { if (error instanceof DemoError && error.status < 500) notFound(); throw error; }
  return <>{requestDrivenDemoProcessing()&&<DemoQueuePump/>}<CustomerSimulator feedback={<DemoFeedback inline/>}/></>;
}
