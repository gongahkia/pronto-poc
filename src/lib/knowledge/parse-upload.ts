import "server-only";
import mammoth from "mammoth";
import { readableHtmlText } from "@/lib/knowledge/html-text";

export const MAX_KNOWLEDGE_UPLOAD_BYTES = 8 * 1024 * 1024;

export type ParsedKnowledgeUpload = {
  title: string;
  sourceType: string;
  content: string;
  metadata: Record<string, unknown>;
};

export async function parseKnowledgeUpload(file: File, options: {maxBytes?:number} = {}): Promise<ParsedKnowledgeUpload> {
  if (!file.name || file.size === 0) {
    throw new Error("Uploaded file is empty.");
  }
  if (file.size > (options.maxBytes ?? MAX_KNOWLEDGE_UPLOAD_BYTES)) {
    throw new Error(`Uploaded file exceeds the ${(options.maxBytes ?? MAX_KNOWLEDGE_UPLOAD_BYTES)/1024/1024} MB limit.`);
  }

  const extension = extensionOf(file.name);
  const buffer = Buffer.from(await file.arrayBuffer());
  const baseMetadata = {
    filename: file.name,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
  };

  if (extension === "html" || extension === "htm") {
    return { title: titleFromFilename(file.name), sourceType: "upload_html",
      content: readableHtmlText(buffer.toString("utf8")), metadata: { ...baseMetadata, parser: "html_text" } };
  }

  if (extension === "txt" || extension === "md" || extension === "markdown") {
    return {
      title: titleFromFilename(file.name),
      sourceType: extension === "txt" ? "upload_txt" : "upload_markdown",
      content: normalizeExtractedText(buffer.toString("utf8")),
      metadata: { ...baseMetadata, parser: "utf8_text" },
    };
  }

  if (extension === "csv") {
    const rows = parseCsv(buffer.toString("utf8"));
    return {
      title: titleFromFilename(file.name),
      sourceType: "upload_csv",
      content: csvRowsToKnowledgeText(rows),
      metadata: { ...baseMetadata, parser: "internal_csv", rows: rows.length },
    };
  }

  if (extension === "docx") {
    const result = await mammoth.extractRawText({ buffer });
    return {
      title: titleFromFilename(file.name),
      sourceType: "upload_docx",
      content: normalizeExtractedText(result.value),
      metadata: {
        ...baseMetadata,
        parser: "mammoth",
        warnings: result.messages.map((message) => message.message),
      },
    };
  }

  if (extension === "pdf") {
    const { PDFParse }=await import("pdf-parse");
    const parser = new PDFParse({ data: buffer });
    try {
      const info = await boundedPdfOperation(parser.getInfo());
      if (info.total > 50) throw new Error("PDF exceeds the 50-page limit.");
      const result = await boundedPdfOperation(parser.getText());
      return {
        title: titleFromFilename(file.name),
        sourceType: "upload_pdf",
        content: normalizeExtractedText(result.text),
        metadata: {
          ...baseMetadata,
          parser: "pdf-parse",
          pages: result.total,
        },
      };
    } finally {
      await parser.destroy();
    }
  }

  throw new Error(
    "Unsupported file type. Upload PDF, DOCX, HTML, TXT, Markdown, or CSV.",
  );
}

function boundedPdfOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("PDF extraction timed out after 10 seconds.")), 10_000);
  })]).finally(() => clearTimeout(timer));
}

function extensionOf(filename: string): string {
  return filename.toLowerCase().split(".").pop() ?? "";
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ").trim() || filename;
}

function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (char === "," && !inQuotes) {
      row.push(cell.trim());
      cell = "";
      continue;
    }
    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell.trim());
      if (row.some(Boolean)) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(cell.trim());
  if (row.some(Boolean)) {
    rows.push(row);
  }

  return rows;
}

function csvRowsToKnowledgeText(rows: string[][]): string {
  if (!rows.length) {
    return "";
  }

  const [headers, ...dataRows] = rows;
  if (!dataRows.length) {
    return headers.join(" | ");
  }

  return dataRows
    .map((row, rowIndex) => {
      const fields = headers
        .map((header, index) => {
          const value = row[index];
          return value ? `${header || `Column ${index + 1}`}: ${value}` : null;
        })
        .filter(Boolean)
        .join("; ");
      return `Row ${rowIndex + 1}: ${fields}`;
    })
    .join("\n");
}
