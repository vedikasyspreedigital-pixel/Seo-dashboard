import ExcelJS from "exceljs";

// Domain Intelligence: reads one tool's organic-keywords export (Semrush,
// Ubersuggest or Ahrefs; CSV or Excel) into plain Keyword / Volume / Position
// rows. Column names differ per tool and per export version, so headers are
// matched by name (first matching row in the first 15) rather than by
// position. Ahrefs CSVs are UTF-16 and tab-separated; Semrush/Ubersuggest are
// UTF-8 and comma-separated -- both are detected, not assumed.

export type KeywordSource = "semrush" | "ubersuggest" | "ahrefs";

export const SOURCE_LABELS: Record<KeywordSource, string> = {
  semrush: "SEMrush",
  ubersuggest: "Ubersuggest",
  ahrefs: "Ahrefs",
};

export interface KeywordRow {
  keyword: string;
  volume: number | null;
  /** null = not ranking / blank in the export. */
  position: number | null;
  /** The tool's own intent label(s) when its export has one (Semrush's "Keyword Intents"), e.g. "Informational, Transactional". */
  sourceIntent?: string | null;
  /** Ranking page, estimated monthly traffic and keyword difficulty (0-100), when the export has them -- for the competitor sheet. */
  url?: string | null;
  traffic?: number | null;
  difficulty?: number | null;
}

export interface KeywordExport {
  source: KeywordSource;
  rows: KeywordRow[];
  /** Rows dropped as exact duplicates (same keyword, case/space-insensitive) -- the best position is kept. */
  duplicatesRemoved: number;
}

export class KeywordExportError extends Error {}

const KEYWORD_HEADERS = ["keyword", "keywords", "search term", "query"];
// "previous position" / "position change" etc. must never be taken for the current position.
const POSITION_HEADERS = ["position", "current position", "current pos", "pos", "rank", "current rank", "ranking", "google position"];
const VOLUME_HEADERS = ["search volume", "volume", "avg. monthly searches", "monthly volume", "sv", "global volume"];
const INTENT_HEADERS = ["keyword intents", "keyword intent", "intents", "intent", "search intent"];
// "traffic (%)" / "traffic cost" must never be taken for the traffic estimate.
const URL_HEADERS = ["url", "current url", "ranking url", "landing page"];
const TRAFFIC_HEADERS = ["traffic", "organic traffic", "est. visits", "estimated traffic"];
const DIFFICULTY_HEADERS = ["keyword difficulty", "kd", "difficulty", "seo difficulty", "kd %"];
// Ahrefs exports intent as one true/false column per intent instead of a single label column.
const INTENT_FLAG_HEADERS = ["informational", "navigational", "commercial", "transactional"];
const INTENT_LABELS: Record<string, string> = {
  informational: "Informational",
  navigational: "Navigational",
  commercial: "Commercial",
  transactional: "Transactional",
};

/** "informational, transactional" -> "Informational, Transactional"; unknown/blank -> null. */
function toIntent(raw: unknown): string | null {
  const labels = String(raw ?? "")
    .split(/[,;/]/)
    .map((p) => INTENT_LABELS[p.trim().toLowerCase()])
    .filter((l): l is string => !!l);
  return labels.length > 0 ? [...new Set(labels)].join(", ") : null;
}

/** Ahrefs' true/false intent columns -> "Informational, Commercial"; none true -> null (gets a generated intent). */
function flaggedIntent(cells: unknown[], flags: { label: string; col: number }[]): string | null {
  const labels = flags.filter((f) => /^(true|1|yes)$/i.test(String(cells[f.col] ?? "").trim())).map((f) => f.label);
  return labels.length > 0 ? labels.join(", ") : null;
}

const norm = (s: unknown) =>
  String(s ?? "")
    .replace(/^﻿/, "")
    .replace(/^"|"$/g, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

export const keywordKey = (keyword: string) => keyword.trim().toLowerCase().replace(/\s+/g, " ");

export async function readKeywordExport(source: KeywordSource, buffer: Buffer, fileName: string): Promise<KeywordExport> {
  if (/\.xls$/i.test(fileName)) throw new KeywordExportError(`"${fileName}" is an old .xls file -- export as .xlsx or .csv instead.`);
  const table = /\.xlsx$/i.test(fileName) ? await readXlsx(buffer) : readCsv(buffer);

  let headerIndex = -1;
  let cols = { keyword: -1, position: -1, volume: -1, intent: -1, url: -1, traffic: -1, difficulty: -1 };
  let intentFlags: { label: string; col: number }[] = [];
  for (let i = 0; i < Math.min(table.length, 15); i++) {
    const cells = table[i].map(norm);
    const keyword = cells.findIndex((c) => KEYWORD_HEADERS.includes(c));
    if (keyword < 0) continue;
    headerIndex = i;
    cols = {
      keyword,
      position: firstHeader(cells, POSITION_HEADERS),
      volume: firstHeader(cells, VOLUME_HEADERS),
      intent: firstHeader(cells, INTENT_HEADERS),
      url: firstHeader(cells, URL_HEADERS),
      traffic: firstHeader(cells, TRAFFIC_HEADERS),
      difficulty: firstHeader(cells, DIFFICULTY_HEADERS),
    };
    if (cols.intent < 0) {
      intentFlags = INTENT_FLAG_HEADERS.map((h) => ({ label: INTENT_LABELS[h], col: cells.indexOf(h) })).filter((f) => f.col >= 0);
    }
    break;
  }
  const label = SOURCE_LABELS[source];
  if (headerIndex < 0) throw new KeywordExportError(`No "Keyword" column found in the ${label} file "${fileName}".`);
  if (cols.position < 0) throw new KeywordExportError(`No "Position" column found in the ${label} file "${fileName}".`);

  const byKey = new Map<string, KeywordRow>();
  let duplicatesRemoved = 0;
  for (const cells of table.slice(headerIndex + 1)) {
    const keyword = String(cells[cols.keyword] ?? "").trim().replace(/\s+/g, " ");
    if (!keyword) continue;
    const row: KeywordRow = {
      keyword,
      position: toNumber(cells[cols.position]),
      volume: cols.volume >= 0 ? toNumber(cells[cols.volume]) : null,
      sourceIntent: cols.intent >= 0 ? toIntent(cells[cols.intent]) : flaggedIntent(cells, intentFlags),
      url: cols.url >= 0 ? String(cells[cols.url] ?? "").trim() || null : null,
      traffic: cols.traffic >= 0 ? toNumber(cells[cols.traffic]) : null,
      difficulty: cols.difficulty >= 0 ? toNumber(cells[cols.difficulty]) : null,
    };
    const key = keywordKey(keyword);
    const existing = byKey.get(key);
    if (existing) {
      duplicatesRemoved++;
      if (rankOf(row) < rankOf(existing)) byKey.set(key, row);
    } else {
      byKey.set(key, row);
    }
  }
  if (byKey.size === 0) throw new KeywordExportError(`The ${label} file "${fileName}" has no keyword rows.`);

  return { source, rows: sortByPosition([...byKey.values()]), duplicatesRemoved };
}

/** Best position first; not-ranking (blank) last; ties by higher volume. */
export function sortByPosition<T extends KeywordRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => rankOf(a) - rankOf(b) || (b.volume ?? -1) - (a.volume ?? -1) || a.keyword.localeCompare(b.keyword));
}

const rankOf = (r: KeywordRow) => r.position ?? Number.POSITIVE_INFINITY;

function firstHeader(cells: string[], candidates: string[]): number {
  for (const candidate of candidates) {
    const i = cells.indexOf(candidate);
    if (i >= 0) return i;
  }
  return -1;
}

/** "1,200" -> 1200, "12.0" -> 12, "-" / "" / "n/a" -> null. */
function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const text = String(raw ?? "").replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  return Number(text);
}

async function readXlsx(buffer: Buffer): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw new KeywordExportError("Couldn't open the Excel file -- is it a real .xlsx?");
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = (row.values as unknown[]).slice(1); // exceljs rows are 1-based
    rows.push(values.map(cellValue));
  });
  return rows;
}

function cellValue(v: unknown): unknown {
  if (v && typeof v === "object") {
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.result !== undefined) return o.result;
    if (o.text !== undefined) return o.text;
  }
  return v;
}

function readCsv(buffer: Buffer): string[][] {
  let text: string;
  if (buffer[0] === 0xff && buffer[1] === 0xfe) text = buffer.subarray(2).toString("utf16le");
  else if (buffer[0] === 0xfe && buffer[1] === 0xff) text = swapBytes(buffer.subarray(2)).toString("utf16le");
  else text = buffer.toString("utf8").replace(/^﻿/, "");

  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = [",", "\t", ";"].reduce((best, d) => (count(firstLine, d) > count(firstLine, best) ? d : best), ",");
  return parseDelimited(text, delimiter);
}

function swapBytes(b: Buffer): Buffer {
  const out = Buffer.from(b);
  for (let i = 0; i + 1 < out.length; i += 2) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  return out;
}

const count = (s: string, ch: string) => s.split(ch).length - 1;

/** RFC 4180: quoted fields may contain the delimiter, newlines and doubled quotes. */
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}
