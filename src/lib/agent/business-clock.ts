export function businessClock(profile: Record<string, unknown>, now = new Date()): string {
  let timeZone = typeof profile.timezone === "string" ? profile.timezone : "UTC";
  try { new Intl.DateTimeFormat("en", { timeZone }).format(now); }
  catch { timeZone = "UTC"; }
  const date = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  return `${date} ${time} (${timeZone})`;
}
