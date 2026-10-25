import { extname } from "node:path";

export const MAX_DOC_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 300_000;
export type DocKind = "pdf" | "docx" | "xlsx" | "text";
export type Segment = { label: string | null; page?: number; sheet?: string; text: string };
export type Extracted = {
  kind: DocKind;
  segments: Segment[];
  chars: number;
  truncated: boolean;
  /** never set; lets callers narrow `Extracted | ExtractError` by reading `.code` */
  code?: undefined;
};
export type ExtractCode = "unsupported" | "too_large" | "empty" | "failed";
export class ExtractError extends Error {
  constructor(
    readonly code: ExtractCode,
    message: string = code,
  ) {
    super(message);
  }
}

export const MAX_PDF_PAGES = 500;
export const MAX_ZIP_ENTRIES = 10_000;
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;

/** Reads only the zip central directory; throws too_large for bombs or malformed directories. */
export function checkZip(bytes: Uint8Array): void {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= Math.max(0, bytes.byteLength - 22 - 65_535); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ExtractError("failed", "not a zip archive");
  const count = dv.getUint16(eocd + 10, true);
  if (count > MAX_ZIP_ENTRIES || count === 0xffff) throw new ExtractError("too_large");
  let pos = dv.getUint32(eocd + 16, true);
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.byteLength || dv.getUint32(pos, true) !== 0x02014b50)
      throw new ExtractError("failed", "bad zip directory");
    const size = dv.getUint32(pos + 24, true);
    if (size === 0xffffffff) throw new ExtractError("too_large");
    total += size;
    if (total > MAX_UNZIPPED_BYTES) throw new ExtractError("too_large");
    pos +=
      46 +
      dv.getUint16(pos + 28, true) +
      dv.getUint16(pos + 30, true) +
      dv.getUint16(pos + 32, true);
  }
}

export const SCANNED_PDF_MESSAGE = "Scanned PDFs need OCR, which is not supported yet";

const MIME: Record<string, DocKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/plain": "text",
  "text/markdown": "text",
};
const EXT: Record<string, DocKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".txt": "text",
  ".md": "text",
  ".markdown": "text",
};

export function docKind(name: string, mime: string): DocKind | null {
  return (
    EXT[extname(name).toLowerCase()] ?? MIME[mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? null
  );
}

const tidy = (t: string): string =>
  t
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v !== "object") return String(v);
  const o = v as { text?: unknown; result?: unknown; richText?: { text: string }[] };
  if (Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
  if (o.text !== undefined) return cellText(o.text);
  if (o.result !== undefined) return cellText(o.result);
  return "";
}

export async function extract(bytes: Uint8Array, name: string, mime: string): Promise<Extracted> {
  if (bytes.byteLength > MAX_DOC_BYTES) throw new ExtractError("too_large");
  const kind = docKind(name, mime);
  if (!kind) throw new ExtractError("unsupported");
  let segments: Segment[] = [];
  if (kind === "docx" || kind === "xlsx") checkZip(bytes);
  try {
    if (kind === "pdf") {
      const { extractText, getDocumentProxy } = await import("unpdf");
      const pdf = await getDocumentProxy(new Uint8Array(bytes));
      if (pdf.numPages > MAX_PDF_PAGES) throw new ExtractError("too_large");
      const { text } = await extractText(pdf, { mergePages: false });
      segments = (text as string[]).map((t, i) => ({
        label: `p. ${i + 1}`,
        page: i + 1,
        text: tidy(t),
      }));
    } else if (kind === "docx") {
      const mammoth = (await import("mammoth")).default;
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      segments = [{ label: null, text: tidy(value) }];
    } else if (kind === "xlsx") {
      const ExcelJS = (await import("exceljs")).default;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
      wb.eachSheet((ws) => {
        const rows: string[] = [];
        ws.eachRow({ includeEmpty: false }, (row) => {
          const cells = (row.values as unknown[]).slice(1).map(cellText);
          rows.push(cells.join("\t").trimEnd());
        });
        segments.push({ label: ws.name, sheet: ws.name, text: tidy(rows.join("\n")) });
      });
    } else {
      segments = [{ label: null, text: tidy(new TextDecoder("utf-8").decode(bytes)) }];
    }
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    throw new ExtractError("failed", (e as Error).message.slice(0, 200));
  }
  const out: Segment[] = [];
  let chars = 0;
  let truncated = false;
  for (const s of segments) {
    if (!s.text) continue;
    if (chars + s.text.length > MAX_TEXT_CHARS) {
      const room = MAX_TEXT_CHARS - chars;
      if (room > 0) out.push({ ...s, text: s.text.slice(0, room) });
      chars = MAX_TEXT_CHARS;
      truncated = true;
      break;
    }
    out.push(s);
    chars += s.text.length;
  }
  if (out.length === 0)
    throw new ExtractError("empty", kind === "pdf" ? SCANNED_PDF_MESSAGE : "empty");
  return { kind, segments: out, chars, truncated };
}

/** One memory source per segment: `<base>` alone, or `<base>.p<N>` / `<base>.s<N>` with titled parts. */
export function segmentSources(
  base: string,
  name: string,
  segments: Segment[],
): { id: string; title: string; text: string }[] {
  if (segments.length === 1 && !segments[0]?.page && !segments[0]?.sheet) {
    return [{ id: base, title: name, text: (segments[0] as Segment).text }];
  }
  return segments.map((s, i) =>
    s.page
      ? { id: `${base}.p${s.page}`, title: `${name} · p. ${s.page}`, text: s.text }
      : {
          id: `${base}.s${i + 1}`,
          title: `${name} · ${s.sheet ?? s.label ?? i + 1}`,
          text: s.text,
        },
  );
}
