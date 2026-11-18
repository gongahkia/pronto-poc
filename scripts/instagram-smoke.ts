import { checkInstagramTestCredentials } from "../src/lib/channels/instagram-smoke";

const args = process.argv.slice(2);
if (args.length > 1 || args.length === 1 && args[0] !== "--read") {
  console.error("Usage: pnpm instagram:smoke [--read]");
  process.exitCode = 1;
} else {
  try {
    const report = await checkInstagramTestCredentials(process.env, { live: args[0] === "--read" });
    console.log(JSON.stringify(report, null, 2));
    if (report.status === "failed") process.exitCode = 1;
  } catch {
    console.error("Instagram smoke check failed unexpectedly; credentials and raw errors withheld.");
    process.exitCode = 1;
  }
}
