import { parseArgs } from "node:util";
import { prepareInstagramSetup } from "../src/lib/channels/instagram-setup";
import { writeInstagramSetupFiles } from "./instagram-setup-files";

try {
  const { values } = parseArgs({ options: {
    "client-id": { type: "string" }, "channel-id": { type: "string" }, "callback-origin": { type: "string" },
  } });
  if (!values["client-id"] || !values["channel-id"] || !values["callback-origin"]) {
    throw new Error("Use pnpm instagram:prepare --client-id UUID --channel-id UUID --callback-origin https://YOUR-HOST");
  }
  const bundle = await prepareInstagramSetup(process.env, { clientId: values["client-id"],
    channelId: values["channel-id"], callbackOrigin: values["callback-origin"] });
  const directory = await writeInstagramSetupFiles(bundle);
  console.log(`Private setup files written to ${directory}. No database or Meta changes made.\nSubmit channel-form.json through the authenticated operator CLI; share only keith-private.txt privately after the callback is reachable.`);
} catch {
  console.error("Instagram preparation failed. Use --client-id UUID --channel-id UUID --callback-origin https://YOUR-HOST. Check .env and private output permissions. No credentials or raw errors displayed.");
  process.exitCode = 1;
}
