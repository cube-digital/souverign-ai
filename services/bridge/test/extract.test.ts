import ExcelJS from "exceljs";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  ExtractError,
  extract,
  MAX_DOC_BYTES,
  MAX_TEXT_CHARS,
  segmentSources,
} from "../src/memory/extract.js";

const enc = (s: string) => new TextEncoder().encode(s);

async function pdfOf(pages: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const t of pages) {
    const page = doc.addPage();
    if (t) page.drawText(t, { x: 50, y: 700, size: 14 });
  }
  return doc.save();
}

async function docxOf(paragraphs: string[]): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("");
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  );
  return zip.generateAsync({ type: "uint8array" });
}

describe("extract", () => {
  it("extracts PDF text per page with p. N labels", async () => {
    const out = await extract(
      await pdfOf(["Alpha budget notes", "Beta launch plan"]),
      "plan.pdf",
      "application/pdf",
    );
    expect(out.kind).toBe("pdf");
    expect(out.segments.map((s) => [s.label, s.page, s.text])).toEqual([
      ["p. 1", 1, "Alpha budget notes"],
      ["p. 2", 2, "Beta launch plan"],
    ]);
    expect(out.truncated).toBe(false);
  });

  it("extracts DOCX paragraph text", async () => {
    const out = await extract(
      await docxOf(["First paragraph", "Second paragraph"]),
      "memo.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(out.kind).toBe("docx");
    expect(out.segments).toEqual([{ label: null, text: "First paragraph\n\nSecond paragraph" }]);
  });

  it("extracts XLSX per sheet as tab-separated rows", async () => {
    const wb = new ExcelJS.Workbook();
    const stock = wb.addWorksheet("Stock");
    stock.addRow(["item", "qty"]);
    stock.addRow(["apple", 3]);
    const prices = wb.addWorksheet("Prices");
    prices.addRow(["apple", 1.5]);
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const out = await extract(bytes, "inv.xlsx", "application/octet-stream");

    expect(out.kind).toBe("xlsx");
    expect(out.segments.map((s) => [s.sheet, s.label, s.text])).toEqual([
      ["Stock", "Stock", "item\tqty\napple\t3"],
      ["Prices", "Prices", "apple\t1.5"],
    ]);
  });

  it("passes .md text through as one unlabeled segment", async () => {
    const out = await extract(enc("# Title\r\n\r\nBody line  \r\n"), "n.md", "");
    expect(out).toEqual({
      kind: "text",
      segments: [{ label: null, text: "# Title\n\nBody line" }],
      chars: 18,
      truncated: false,
    });
  });

  it("refuses unsupported types with code unsupported", async () => {
    const err = await extract(new Uint8Array([137, 80, 78, 71]), "pic.png", "image/png").catch(
      (e: ExtractError) => e,
    );
    expect(err).toBeInstanceOf(ExtractError);
    expect(err.code).toBe("unsupported");
  });

  it("refuses files over 20 MiB with code too_large", async () => {
    expect(MAX_DOC_BYTES).toBe(20 * 1024 * 1024);
    const err = await extract(new Uint8Array(21 * 1024 * 1024), "big.txt", "text/plain").catch(
      (e: ExtractError) => e,
    );
    expect(err).toBeInstanceOf(ExtractError);
    expect(err.code).toBe("too_large");
  });

  it("truncates text over 300000 chars and flags it", async () => {
    const out = await extract(enc("a".repeat(MAX_TEXT_CHARS + 500)), "long.txt", "text/plain");
    expect(out.truncated).toBe(true);
    expect(out.chars).toBe(300_000);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0]?.text).toHaveLength(300_000);
  });

  it("refuses a scanned (text-less) PDF with code empty", async () => {
    const err = await extract(await pdfOf(["", ""]), "scan.pdf", "application/pdf").catch(
      (e: ExtractError) => e,
    );
    expect(err).toBeInstanceOf(ExtractError);
    expect(err.code).toBe("empty");
  });
});

describe("segmentSources", () => {
  it("names parts .pN/.sN with titled labels and keeps a single plain part bare", () => {
    expect(
      segmentSources("m1", "plan.pdf", [
        { label: "p. 1", page: 1, text: "one" },
        { label: "p. 2", page: 2, text: "two" },
      ]),
    ).toEqual([
      { id: "m1.p1", title: "plan.pdf · p. 1", text: "one" },
      { id: "m1.p2", title: "plan.pdf · p. 2", text: "two" },
    ]);
    expect(
      segmentSources("m2", "inv.xlsx", [
        { label: "Stock", sheet: "Stock", text: "a" },
        { label: "Prices", sheet: "Prices", text: "b" },
      ]),
    ).toEqual([
      { id: "m2.s1", title: "inv.xlsx · Stock", text: "a" },
      { id: "m2.s2", title: "inv.xlsx · Prices", text: "b" },
    ]);
    expect(segmentSources("m3", "n.md", [{ label: null, text: "t" }])).toEqual([
      { id: "m3", title: "n.md", text: "t" },
    ]);
  });
});
