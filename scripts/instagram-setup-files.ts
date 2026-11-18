import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { prepareInstagramSetup } from "../src/lib/channels/instagram-setup";

export async function readPrivateInstagramSetup(path: string): Promise<unknown> {
  const file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 64_000)
      throw new Error("Instagram setup must be a private, owned regular file under 64 KB (chmod 600).");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}

export async function writeInstagramSetupFiles(bundle: Awaited<ReturnType<typeof prepareInstagramSetup>>, project = process.cwd()) {
  const root = await realpath(project), parent = resolve(root, "output/instagram-setup");
  for (const path of [join(root, "output"), parent]) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
      throw new Error("Instagram setup output must use owned directories, without symlinks or shared write access.");
  }
  const directory = await mkdtemp(join(parent, "setup-"));
  for (const [name, content] of [
    ["channel-form.json", JSON.stringify(bundle.form, null, 2) + "\n"],
    ["connection.json", JSON.stringify(bundle.connection, null, 2) + "\n"],
    ["keith-private.txt", bundle.handoff],
  ]) {
    const file = await open(join(directory, name), "wx", 0o600);
    try { await file.writeFile(content); } finally { await file.close(); }
  }
  return directory;
}
