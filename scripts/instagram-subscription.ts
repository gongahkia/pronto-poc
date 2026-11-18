import { parseArgs } from "node:util";
import { manageInstagramSubscription } from "../src/lib/channels/instagram-subscription";
import { readPrivateInstagramSetup } from "./instagram-setup-files";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "setup-file": { type: "string" } } });
  if (positionals.length !== 1 || !["inspect", "subscribe"].includes(positionals[0]) || !values["setup-file"])
    throw new Error("Use instagram:subscription inspect|subscribe --setup-file PRIVATE_CONNECTION_JSON");
  const report = await manageInstagramSubscription(process.env, await readPrivateInstagramSetup(values["setup-file"]),
    { subscribe: positionals[0] === "subscribe" });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed" || report.status === "uncertain") process.exitCode = 1;
} catch {
  console.error("Instagram subscription command failed. Use inspect|subscribe --setup-file with a private setup file. Credentials and raw errors withheld; no automatic retry.");
  process.exitCode = 1;
}
