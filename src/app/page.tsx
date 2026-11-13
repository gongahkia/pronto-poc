import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { signedInDestination } from "@/lib/auth-navigation";
import { guestAccessEnabled } from "@/lib/guest-policy";
import {DEMO_CLIENT_ID} from '@/lib/customer-demo-boundary';

export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? signedInDestination(user.role, guestAccessEnabled() && user.role === 'client' && user.clientId === DEMO_CLIENT_ID ? '/demo' : undefined) : guestAccessEnabled() ? "/demo" : "/login");
}
