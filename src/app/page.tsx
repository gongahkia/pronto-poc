import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { signedInDestination } from "@/lib/auth-navigation";
import { guestAccessEnabled } from "@/lib/guest-policy";

export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? signedInDestination(user.role, guestAccessEnabled() && user.role === 'client' ? '/demo' : undefined) : guestAccessEnabled() ? "/enter" : "/login");
}
