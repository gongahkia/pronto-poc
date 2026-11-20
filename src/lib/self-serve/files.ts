import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import yauzl from "yauzl";
import { parseKnowledgeUpload, parseCsv } from "@/lib/knowledge/parse-upload";
import {
  encryptedChannelCredentialValues,
  decryptChannelCredentials,
} from "@/lib/channels/credentials";
export class DocumentError extends Error {}
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export type Segment = { ref: string; text: string };
export type PrivateFile = { name: string; type: string; data: string };
export function sealFile(file: PrivateFile) {
  const e = encryptedChannelCredentialValues(file);
  return {
    credentials: {},
    encrypted_credentials: e.encryptedCredentials,
    credentials_encryption_nonce: e.nonce,
    credentials_encryption_tag: e.tag,
  };
}
export function openFile(value: unknown): PrivateFile {
  const file = decryptChannelCredentials(
    value as Parameters<typeof decryptChannelCredentials>[0],
  ).credentials;
  if (
    typeof file.name !== "string" ||
    typeof file.type !== "string" ||
    typeof file.data !== "string"
  )
    throw new DocumentError(
      "The temporary upload is unavailable. Upload it again.",
    );
  return { name: file.name, type: file.type, data: file.data };
}
export async function validateArchive(buffer: Buffer) {
  await new Promise<void>((done, fail) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        fail(new DocumentError("This archive could not be read."));
        return;
      }
      let count = 0,
        total = 0,
        closed = false;
      const stop = (message: string) => {
        if (!closed) {
          closed = true;
          zip.close();
          fail(new DocumentError(message));
        }
      };
      zip.on("error", () => stop("This archive could not be read."));
      zip.on("entry", (entry: yauzl.Entry) => {
        count++;
        total += entry.uncompressedSize;
        if (
          count > 1000 ||
          total > 60 * 1024 * 1024 ||
          entry.uncompressedSize > 30 * 1024 * 1024 ||
          entry.generalPurposeBitFlag & 1 ||
          /(?:^|\/)\.\.(?:\/|$)|^\/|\\/.test(entry.fileName)
        ) {
          stop(
            "This archive exceeds safe processing limits or contains unsafe entries.",
          );
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            stop("This archive could not be read.");
            return;
          }
          let actual = 0;
          stream.on("data", (chunk) => {
            actual += chunk.length;
            if (actual > entry.uncompressedSize || actual > 30 * 1024 * 1024) {
              stream.destroy();
              stop("This archive expands beyond its declared size.");
            }
          });
          stream.on("error", () => stop("This archive could not be read."));
          stream.on("end", () => {
            if (!closed) zip.readEntry();
          });
        });
      });
      zip.on("end", () => {
        if (!closed) {
          closed = true;
          done();
        }
      });
      zip.readEntry();
    }),
  );
}
const exec = promisify(execFile);
async function run(
  binary: string,
  args: string[],
  deadline = Date.now() + 90000,
) {
  try {
    return (
      await exec(binary, args, {
        timeout: Math.max(1, Math.min(90000, deadline - Date.now())),
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env, OMP_THREAD_LIMIT: "1" },
      })
    ).stdout;
  } catch {
    throw new DocumentError(
      "This file could not be converted within the processing limit. Try a text version.",
    );
  }
}
export async function extractFile(file: PrivateFile): Promise<Segment[]> {
  const bytes = Buffer.from(file.data, "base64");
  if (!bytes.length || bytes.length > MAX_SOURCE_BYTES)
    throw new DocumentError("Choose a nonempty file of up to 25 MB.");
  const deadline = Date.now() + 110000;
  const command = (binary: string, args: string[]) => {
    if (Date.now() >= deadline)
      throw new DocumentError(
        "File processing timed out. Try a smaller source.",
      );
    return run(binary, args, deadline);
  };
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const allowed = [
    "pdf",
    "doc",
    "docx",
    "txt",
    "md",
    "csv",
    "xlsx",
    "jpg",
    "jpeg",
    "png",
    "webp",
    "heic",
  ];
  if (!allowed.includes(ext))
    throw new DocumentError("Unsupported document or image format.");
  if (["docx", "xlsx"].includes(ext)) await validateArchive(bytes);
  if (ext === "xlsx") {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes as never);
    const segments: Segment[] = [];
    workbook.eachSheet((sheet) =>
      sheet.eachRow((row, index) => {
        if (segments.length >= 10000)
          throw new DocumentError("This spreadsheet contains too many rows.");
        segments.push({
          ref: `${sheet.name}, row ${index}`,
          text:
            row.values instanceof Array
              ? row.values
                  .slice(1)
                  .map((cell) =>
                    typeof cell === "object" && cell !== null
                      ? "result" in cell
                        ? String(cell.result)
                        : "text" in cell
                          ? String(cell.text)
                          : JSON.stringify(cell)
                      : String(cell ?? ""),
                  )
                  .join(" | ")
              : "",
        });
      }),
    );
    return boundSegments(segments);
  }
  const dir = await mkdtemp(join(tmpdir(), "pronto-document-"));
  try {
    const input = join(dir, randomUUID() + "." + ext);
    await writeFile(input, bytes, { mode: 0o600 });
    if (ext === "csv")
      return boundSegments(
        parseCsv(bytes.toString("utf8")).map((row, index) => ({
          ref: `row ${index + 1}`,
          text: row.join(" | "),
        })),
      );
    if (ext === "doc")
      return boundSegments([
        { ref: "document", text: await command("antiword", [input]) },
      ]);
    if (["jpg", "jpeg", "png", "webp", "heic"].includes(ext)) {
      const valid =
        ext === "png"
          ? bytes
              .subarray(0, 8)
              .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : ext === "jpg" || ext === "jpeg"
            ? bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
            : ext === "webp"
              ? bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP"
              : bytes.subarray(4, 8).toString() === "ftyp" &&
                /^(heic|heix|hevc|hevx|mif1|msf1)$/.test(
                  bytes.subarray(8, 12).toString(),
                );
      if (!valid)
        throw new DocumentError(
          "The image contents do not match a supported image format.",
        );
      const dimensions = (
        await command("identify", [
          "-limit",
          "memory",
          "48MiB",
          "-limit",
          "map",
          "64MiB",
          "-ping",
          "-format",
          "%w %h",
          input + "[0]",
        ])
      )
        .trim()
        .split(/\s+/)
        .map(Number);
      if (
        dimensions.length !== 2 ||
        dimensions.some((n) => !Number.isFinite(n) || n < 1) ||
        dimensions[0] * dimensions[1] > 40_000_000
      )
        throw new DocumentError(
          "Image resolution exceeds the processing limit.",
        );
      const image = join(dir, "image.png");
      await command("convert", [
        "-limit",
        "memory",
        "48MiB",
        "-limit",
        "map",
        "64MiB",
        input + "[0]",
        "-resize",
        "2400x2400>",
        image,
      ]);
      return boundSegments([
        {
          ref: "image",
          text: await command("tesseract", [
            image,
            "stdout",
            "-l",
            "eng+chi_sim+tam",
          ]),
        },
      ]);
    }
    if (ext === "pdf") {
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        throw new DocumentError("Malformed PDF.");
      const info = await command("pdfinfo", [input]);
      const count = Number(info.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!Number.isInteger(count) || count < 1 || count > 50)
        throw new DocumentError("PDFs must contain 1–50 readable pages.");
      const text = await command("pdftotext", ["-layout", input, "-"]);
      const pagesText = text.split("\f");
      const segments: Segment[] = Array.from({ length: count }, (_, index) => ({
        ref: `p. ${index + 1}`,
        text: pagesText[index] ?? "",
      }));
      if (segments.some((segment) => segment.text.trim().length < 20)) {
        await command("pdftoppm", [
          "-scale-to",
          "2000",
          "-png",
          "-r",
          "100",
          input,
          join(dir, "page"),
        ]);
        const pages = (await readdir(dir))
          .filter((name) => /^page-\d+\.png$/.test(name))
          .sort(
            (a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]),
          );
        for (let index = 0; index < pages.length; index++)
          if (
            !segments[index]?.text.trim() ||
            segments[index].text.trim().length < 20
          )
            segments[index] = {
              ref: `p. ${index + 1}`,
              text: await command("tesseract", [
                join(dir, pages[index]),
                "stdout",
                "-l",
                "eng+chi_sim+tam",
              ]),
            };
      }
      return boundSegments(segments);
    }
    const parsed = await parseKnowledgeUpload(
      new File([new Uint8Array(bytes)], file.name, { type: file.type }),
      { maxBytes: MAX_SOURCE_BYTES },
    );
    return boundSegments([
      { ref: ext === "csv" ? "CSV rows" : "document", text: parsed.content },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export function boundSegments(segments: Segment[]) {
  const clean = segments
    .map((s) => ({ ...s, text: s.text.trim() }))
    .filter((s) => s.text);
  if (clean.reduce((n, s) => n + s.text.length, 0) > 200000)
    throw new DocumentError(
      "This source contains more than 200,000 characters. Split it into smaller sources.",
    );
  return clean;
}
export async function extractChatArchive(file: PrivateFile) {
  const buffer = Buffer.from(file.data, "base64");
  await validateArchive(buffer);
  return new Promise<PrivateFile[]>((done, fail) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        fail(new DocumentError("Could not read chat export."));
        return;
      }
      const files: PrivateFile[] = [];
      zip.on("error", fail);
      zip.on("entry", (entry) => {
        if (!entry.fileName.toLowerCase().endsWith(".txt")) {
          zip.readEntry();
          return;
        }
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) {
            zip.close();
            fail(new DocumentError("Could not read chat export."));
            return;
          }
          const chunks: Buffer[] = [];
          stream.on("data", (b) => chunks.push(b));
          stream.on("error", fail);
          stream.on("end", () => {
            files.push({
              name: entry.fileName.split("/").pop()!,
              type: "text/plain",
              data: Buffer.concat(chunks).toString("base64"),
            });
            zip.readEntry();
          });
        });
      });
      zip.on("end", () => done(files));
      zip.readEntry();
    }),
  );
}
