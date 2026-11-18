import { execFileSync } from "node:child_process";
import { cp, readdir, rm } from "node:fs/promises";

execFileSync(process.execPath, ["node_modules/next/dist/bin/next", "build", "--webpack"], {
  stdio: "inherit", env: { ...process.env, PRONTO_LOW_MEMORY_BUILD: "1", NEXT_TELEMETRY_DISABLED: "1" },
});
await cp("public", ".next/standalone/public", { recursive: true });
await cp(".next/static", ".next/standalone/.next/static", { recursive: true });
// Next may trace local dotenv files; they are not deployment artifacts.
for (const name of await readdir(".next/standalone")) {
  if (name === ".env" || name.startsWith(".env."))
    await rm(`.next/standalone/${name}`, { force: true });
}
