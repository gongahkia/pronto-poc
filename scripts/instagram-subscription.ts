import { parseArgs } from "node:util";
import { manageInstagramSubscription } from "../src/lib/channels/instagram-subscription";
import { readPrivateInstagramSetup } from "./instagram-setup-files";

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { "setup-file": { type: "string" } } });
  if (positionals.length !== 1 || !["inspect", "subscribe"].includes(positionals[0]) ||
      positionals[0] === "subscribe" && !values["setup-file"])
    throw new Error("Use instagram:subscription inspect, or subscribe --setup-file PRIVATE_CONNECTION_JSON");
  const setup = values["setup-file"] ? await readPrivateInstagramSetup(values["setup-file"]) : undefined;
  const report = await manageInstagramSubscription(process.env, setup,
    { subscribe: positionals[0] === "subscribe" });
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "failed" || report.status === "uncertain") process.exitCode = 1;
} catch {
  console.error("Instagram subscription command failed. Use inspect|subscribe --setup-file with a private setup file. Credentials and raw errors withheld; no automatic retry.");
  process.exitCode = 1;
}
