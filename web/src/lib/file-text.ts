/**
 * The text of a file picked in Settings' Reference material, read in the
 * browser (owner, 2026-09-26: "PDF e Word nei Reference"): .txt/.md files,
 * PDFs and Word (.docx) files. Only the text goes on to the server; the file
 * itself is never uploaded or kept (components/settings/references-section.tsx).
 *
 * The PDF reader (unpdf, a build of Mozilla's PDF.js) and the Word reader
 * (mammoth) are large, so they load with import() only when such a file is
 * picked, never with the page.
 */

export type FileKind = "text" | "pdf" | "docx" | "doc" | "unsupported";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The file picker's accept list: the text types, PDF and Word (.docx). An old .doc isn't offered. */
export const FILE_ACCEPT = [
  ".txt", ".md", ".markdown", "text/plain", "text/markdown",
  ".pdf", ".docx", "application/pdf", DOCX_TYPE,
].join(",");

const KIND_BY_EXTENSION = new Map<string, FileKind>([
  ["txt", "text"], ["md", "text"], ["markdown", "text"],
  ["pdf", "pdf"], ["docx", "docx"], ["doc", "doc"],
]);
const KIND_BY_TYPE = new Map<string, FileKind>([
  ["application/pdf", "pdf"], [DOCX_TYPE, "docx"], ["application/msword", "doc"],
]);

const OLD_DOC = "Old .doc files can't be read: save it as .docx or PDF, or paste the text.";
const UNSUPPORTED = "Pick a .txt, .md, .pdf or .docx file, or paste the text.";
const PDF_NO_TEXT = "This PDF has no text to read — it may be a scan. Paste the text instead.";
const DOCX_NO_TEXT = "This Word file has no text to read. Paste the text instead.";

/**
 * What a picked file is: by its extension first, then by its MIME type, both
 * in any case. Any other text/* type reads as text, as before, except RTF,
 * whose "text" is markup.
 */
export function fileKind(name: string, type: string): FileKind {
  const extension = /\.([^.]+)$/.exec(name.trim())?.[1].toLowerCase();
  const byExtension = extension ? KIND_BY_EXTENSION.get(extension) : undefined;
  if (byExtension) return byExtension;
  const mime = type.split(";")[0].trim().toLowerCase();
  const byType = KIND_BY_TYPE.get(mime);
  if (byType) return byType;
  if (mime.startsWith("text/") && mime !== "text/rtf") return "text";
  return "unsupported";
}

/**
 * The text of a picked file: a text file as it is; a PDF's or a Word file's
 * text cleaned up (cleanExtractedText). Throws an Error whose message can be
 * shown as it is: an old .doc, a kind it can't read, a PDF or a Word file
 * with no text (a scan), or a file its reader couldn't open.
 */
export async function extractText(file: File): Promise<string> {
  const kind = fileKind(file.name, file.type);
  if (kind === "doc") throw new Error(OLD_DOC);
  if (kind === "unsupported") throw new Error(UNSUPPORTED);
  if (kind === "text") return read(() => file.text(), "Couldn't read this file. Pick it again, or paste the text.");
  if (kind === "pdf") {
    const text = cleanExtractedText(await read(() => pdfText(file), "Couldn't read this PDF. Paste the text instead."));
    if (!text) throw new Error(PDF_NO_TEXT);
    return text;
  }
  const text = cleanExtractedText(await read(() => docxText(file), "Couldn't read this Word file. Paste the text instead."));
  if (!text) throw new Error(DOCX_NO_TEXT);
  return text;
}

/**
 * Plain text from a reader's output: \n line endings; each run of spaces and
 * tabs within a line one space, none at a line's ends; at most one blank line
 * in a row; nothing before or after it all.
 */
export function cleanExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Runs a reader; a failure (a broken file, a reader that didn't load) becomes the message given, the cause in the console. */
async function read(reader: () => Promise<string>, failure: string): Promise<string> {
  try {
    return await reader();
  } catch (e) {
    console.error(e);
    throw new Error(failure, { cause: e });
  }
}

/** All the pages' text, merged (unpdf's serverless PDF.js runs in the page: no worker to set up). */
async function pdfText(file: File): Promise<string> {
  const { extractText: readPdf } = await import("unpdf");
  const { text } = await readPdf(new Uint8Array(await file.arrayBuffer()), { mergePages: true });
  return text;
}

/**
 * The document's raw text, a blank line after each paragraph. mammoth's
 * package.json "browser" field gives the browser the build that reads an
 * ArrayBuffer (its Node entry reads paths and Buffers).
 */
async function docxText(file: File): Promise<string> {
  const { default: mammoth } = await import("mammoth");
  const { value } = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return value;
}
