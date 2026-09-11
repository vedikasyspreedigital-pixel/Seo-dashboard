import { createWorker, PSM } from "tesseract.js";

// Turns a rasterized report page into rows of {keyword, valueTokens[]}.
//
// Empirically (verified against the real sample PDF this feature was built
// against), tesseract's automatic page segmentation (PSM 3 -- the only mode
// that reliably found every row at all; see the PSM comment below) does NOT
// keep each table row as one text line. Because of the table's vertical
// borders, it instead groups content into per-COLUMN blocks: one block
// containing the entire keyword column (one line per row, top to bottom),
// and one or more separate blocks containing the rank-value columns' digits
// (fewer, noisier lines -- isolated digit clusters are harder to segment
// than natural-language text, and a few rows' values fragment into small
// stray blocks of their own). Word bounding boxes within a line are ALSO
// unreliable here (some balloon to span almost the entire row width), so
// this never buckets by x-position -- it matches lines ACROSS blocks by
// vertical (y) overlap instead: "whichever value-block line sits at
// roughly the same height as this keyword line is that row's data", then
// classifies that line's tokens into rank values purely by token shape
// (numeric, or a "Not in 100"-looking run).
//
// This is a genuine best-effort against real-world bordered grid tables,
// not a guarantee -- verified to correctly extract MOST but not all rows
// of the actual sample report, which is exactly why the baseline
// upload flow shows a mandatory extraction preview before storing anything
// (see parseBaselinePdf.ts / the /baselines/preview API route): a wrong or
// missing value here is meant to be caught by a human glancing at the
// preview table, not silently trusted.

const NOISE_TOKEN = /^[|[\]~_.,;:'"`\-•=]+$/;
const NUMERIC_TOKEN = /^\d+$/;
const NOT_START = /^not/i;

function isNoise(text: string): boolean {
  return NOISE_TOKEN.test(text);
}

export interface BBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface OcrWord {
  text: string;
  bbox: BBox;
}

export interface OcrLine {
  words: OcrWord[];
  bbox: BBox;
}

export interface OcrBlock {
  bbox: BBox;
  lines: OcrLine[];
}

/** Groups tokens into one value per rank column -- handles a rank split across multiple OCR tokens (e.g. "Not" "in" "100", or "Notin100" as one). */
export function extractValueTokens(tokens: string[]): string[] {
  const values: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (NUMERIC_TOKEN.test(token)) {
      values.push(token);
      i++;
      continue;
    }
    if (NOT_START.test(token)) {
      const phraseTokens = [token];
      let j = i + 1;
      while (j < tokens.length && j < i + 3 && !/100/.test(phraseTokens.join(" "))) {
        phraseTokens.push(tokens[j]);
        j++;
      }
      values.push(phraseTokens.join(" "));
      i = j;
      continue;
    }
    i++; // unrecognized stray fragment -- skip, don't let it poison a value
  }
  return values;
}

/** Groups the header line's date-phrase tokens (e.g. "31st","August","2026","17th",...) into whole phrases, splitting after each 4-digit year. */
export function groupDatePhrases(tokens: string[]): string[] {
  const phrases: string[] = [];
  let current: string[] = [];
  for (const token of tokens) {
    current.push(token);
    if (/^\d{4}$/.test(token)) {
      phrases.push(current.join(" "));
      current = [];
    }
  }
  if (current.length > 0) phrases.push(current.join(" "));
  return phrases;
}

function lineTokens(line: OcrLine): string[] {
  return line.words.map((w) => w.text).filter((t) => !isNoise(t));
}

function yCenter(bbox: BBox): number {
  return (bbox.y0 + bbox.y1) / 2;
}

function yOverlaps(a: BBox, b: BBox): boolean {
  return a.y0 <= b.y1 && b.y0 <= a.y1;
}

export interface OcrRow {
  keyword: string;
  values: string[];
}

export interface OcrPageResult {
  /** Non-null only on the page where a "Keyword" header line was actually found. */
  headerDatePhrases: string[] | null;
  rows: OcrRow[];
}

/**
 * Pure assembly logic, separated from the tesseract call so it's unit
 * testable with synthetic block/line/word fixtures (real OCR is slow and
 * its exact output isn't guaranteed stable across tesseract.js versions --
 * this is what should actually be verified in CI).
 */
export function assembleRowsFromBlocks(blocks: OcrBlock[]): OcrPageResult {
  const allLines = blocks.flatMap((b) => b.lines);

  // The FIRST token must be "Keyword" -- matching it anywhere in the line
  // false-positives on this exact report's own title line ("Client Keyword
  // Ranking Report"), which also contains the word but isn't the header.
  let headerLineIndex = -1;
  for (let i = 0; i < allLines.length; i++) {
    const tokens = lineTokens(allLines[i]);
    if (tokens[0]?.toLowerCase() === "keyword") {
      headerLineIndex = i;
      break;
    }
  }
  if (headerLineIndex === -1) return { headerDatePhrases: null, rows: [] };

  const headerLine = allLines[headerLineIndex];
  const headerTokens = lineTokens(headerLine).filter((t) => t.toLowerCase() !== "keyword");
  const headerDatePhrases = groupDatePhrases(headerTokens);
  const headerBottomY = headerLine.bbox.y1;

  // Candidate blocks below the header: the one with the most lines is
  // treated as the keyword column (one line per table row); every other
  // qualifying block to its right is pooled as "value" lines to match
  // against by y-overlap. A block is only a candidate at all if it has
  // more than one line -- single-line blocks below the header are
  // typically small stray fragments, not a real column.
  const candidateBlocks = blocks.filter((b) => b.bbox.y0 >= headerBottomY - 5 && b.lines.length > 1);
  if (candidateBlocks.length === 0) return { headerDatePhrases, rows: [] };

  const keywordBlock = candidateBlocks.reduce((best, b) => (b.lines.length > best.lines.length ? b : best));
  const valueLines = blocks
    .filter((b) => b !== keywordBlock && b.bbox.y0 >= headerBottomY - 5 && b.bbox.x0 >= keywordBlock.bbox.x1 - 20)
    .flatMap((b) => b.lines);

  const rows: OcrRow[] = [];
  for (const keywordLine of keywordBlock.lines) {
    const keyword = lineTokens(keywordLine).join(" ");
    if (!keyword) continue;

    // All value-block lines whose y-range overlaps this keyword line's,
    // pooled and sorted left-to-right -- a row's rank digits sometimes
    // land in more than one small fragment block at the same height.
    const matching = valueLines.filter((l) => yOverlaps(l.bbox, keywordLine.bbox)).sort((a, b) => yCenter(a.bbox) - yCenter(b.bbox));
    const valueTokens = matching.flatMap((l) => lineTokens(l));
    const values = extractValueTokens(valueTokens);

    rows.push({ keyword, values });
  }

  return { headerDatePhrases, rows };
}

export async function ocrExtractTablePage(imageBuffer: Buffer): Promise<OcrPageResult> {
  const worker = await createWorker("eng");
  try {
    // PSM 3 ("fully automatic page segmentation") explicitly -- NOT
    // tesseract.js's actual unset default (empirically confirmed to behave
    // like PSM 6, "single uniform block", which merged/dropped most of the
    // table's rows: 14 detected lines instead of the ~30 actually present
    // on the real sample report this was verified against). PSM 3 alone
    // correctly segmented every keyword row into its own line.
    await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
    const { data } = await worker.recognize(imageBuffer, {}, { blocks: true });
    const blocks: OcrBlock[] = (data.blocks ?? []).map((b) => ({
      bbox: b.bbox,
      lines: b.paragraphs.flatMap((p) => p.lines),
    }));
    return assembleRowsFromBlocks(blocks);
  } finally {
    await worker.terminate();
  }
}
