import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanExtractedText, extractText, FILE_ACCEPT, fileKind } from "./file-text";

// Counts when each reader loads, to show it happens only for its kind of file. The PDF
// reader is the real unpdf. The Word reader is mammoth's own browser build: the browser gets
// it through mammoth's package.json "browser" field, and it reads the { arrayBuffer } the
// browser has, where the Node entry vitest would load reads only paths and Buffers.
const loads = vi.hoisted(() => ({ unpdf: 0, mammoth: 0 }));
vi.mock("unpdf", async (importOriginal) => {
  loads.unpdf++;
  return importOriginal();
});
vi.mock("mammoth", async () => {
  loads.mammoth++;
  return vi.importActual<typeof import("mammoth")>("mammoth/mammoth.browser");
});

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const fixture = (name: string, type: string) =>
  new File([new Uint8Array(readFileSync(path.join(__dirname, "../test/fixtures", name)))], name, { type });

describe("PDF and Word files in Reference material (2026-09-26)", () => {
  // First in the file: no reader has loaded yet.
  it("loads the PDF reader for a PDF and the Word reader for a .docx, neither for a text file", async () => {
    await extractText(new File(["Bio"], "bio.txt", { type: "text/plain" }));
    expect(loads).toEqual({ unpdf: 0, mammoth: 0 });
    await extractText(fixture("reference.pdf", "application/pdf"));
    expect(loads).toEqual({ unpdf: 1, mammoth: 0 });
    await extractText(fixture("reference.docx", DOCX));
    expect(loads).toEqual({ unpdf: 1, mammoth: 1 });
  });

  it("tells the kind by the extension, in any case", () => {
    expect(fileKind("notes.txt", "")).toBe("text");
    expect(fileKind("README.MD", "")).toBe("text");
    expect(fileKind("post.Markdown", "")).toBe("text");
    expect(fileKind("CV.PDF", "")).toBe("pdf");
    expect(fileKind("Case study.Docx", "")).toBe("docx");
    expect(fileKind("old.DOC", "")).toBe("doc");
    expect(fileKind("photo.png", "")).toBe("unsupported");
    expect(fileKind("no extension", "")).toBe("unsupported");
    // The extension wins over a vague type.
    expect(fileKind("scan.pdf", "application/octet-stream")).toBe("pdf");
    expect(fileKind("cv.docx", "application/zip")).toBe("docx");
  });

  it("tells the kind by the MIME type when the name doesn't, in any case", () => {
    expect(fileKind("notes", "text/plain")).toBe("text");
    expect(fileKind("notes", "Text/Markdown")).toBe("text");
    expect(fileKind("table", "text/csv; charset=utf-8")).toBe("text");
    expect(fileKind("scan", "APPLICATION/PDF")).toBe("pdf");
    expect(fileKind("cv", DOCX.toUpperCase())).toBe("docx");
    expect(fileKind("old", "Application/MSWord")).toBe("doc");
    expect(fileKind("photo", "image/png")).toBe("unsupported");
    // RTF's text is markup.
    expect(fileKind("letter.rtf", "text/rtf")).toBe("unsupported");
  });

  it("the picker offers the text types, PDF and .docx, not .doc", () => {
    expect(FILE_ACCEPT.split(",")).toEqual([
      ".txt", ".md", ".markdown", "text/plain", "text/markdown", ".pdf", ".docx", "application/pdf", DOCX,
    ]);
  });

  it("cleans extracted text: line endings, spaces, blank lines, ends", () => {
    expect(cleanExtractedText("a\r\nb\rc")).toBe("a\nb\nc");
    expect(cleanExtractedText("Numbers:\t120 posts,   3 launches")).toBe("Numbers: 120 posts, 3 launches");
    expect(cleanExtractedText("a\n\n\n\nb\n\n\nc")).toBe("a\n\nb\n\nc");
    expect(cleanExtractedText("a  \n \t \n\t\n  b")).toBe("a\n\nb");
    expect(cleanExtractedText("a\n\nb")).toBe("a\n\nb");
    expect(cleanExtractedText("\n\n  Title  \n")).toBe("Title");
    expect(cleanExtractedText(" \r\n\t ")).toBe("");
  });

  it("reads a text file as it is", async () => {
    const text = "# Bio\r\n\r\n\r\n\r\nTwo  spaces\tand a tab";
    expect(await extractText(new File([text], "bio.md", { type: "text/markdown" }))).toBe(text);
  });

  it("reads a PDF's text", async () => {
    expect(await extractText(fixture("reference.pdf", "application/pdf"))).toBe("PostEcho reference: 120 posts in 2026.");
  });

  it("reads a Word file's text, cleaned", async () => {
    expect(await extractText(fixture("reference.docx", DOCX)))
      .toBe("PostEcho turns ideas into posts for X and LinkedIn.\n\nNumbers: 120 posts, 3 launches.");
  });

  it("says so when a PDF or a Word file has no text", async () => {
    await expect(extractText(fixture("scan.pdf", "application/pdf")))
      .rejects.toThrow("This PDF has no text to read — it may be a scan. Paste the text instead.");
    await expect(extractText(fixture("blank.docx", DOCX))).rejects.toThrow("This Word file has no text to read. Paste the text instead.");
  });

  it("says it couldn't read a broken PDF or Word file, the cause in the console", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(extractText(new File(["not a pdf"], "broken.pdf", { type: "application/pdf" })))
        .rejects.toThrow("Couldn't read this PDF. Paste the text instead.");
      await expect(extractText(new File(["not a docx"], "broken.docx", { type: DOCX })))
        .rejects.toThrow("Couldn't read this Word file. Paste the text instead.");
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
    }
  });

  it("an old .doc or another kind of file: what to do instead", async () => {
    await expect(extractText(new File(["x"], "old.doc", { type: "application/msword" })))
      .rejects.toThrow("Old .doc files can't be read: save it as .docx or PDF, or paste the text.");
    await expect(extractText(new File(["x"], "photo.png", { type: "image/png" })))
      .rejects.toThrow("Pick a .txt, .md, .pdf or .docx file, or paste the text.");
  });
});
