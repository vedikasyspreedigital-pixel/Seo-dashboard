import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleRowsFromBlocks, extractValueTokens, groupDatePhrases, type OcrBlock } from "../backend/baselines/ocrExtractTable.js";

// Synthetic fixtures modeling exactly what tesseract.js's PSM-3 output
// looked like for the real sample PDF this feature was built against:
// content splits into a keyword-column block and a separate values block
// (rather than one line per table row), matched here by y-overlap.

function word(text: string, x0: number, x1: number, y0: number, y1: number) {
  return { text, bbox: { x0, x1, y0, y1 } };
}

function line(words: ReturnType<typeof word>[]) {
  const y0 = Math.min(...words.map((w) => w.bbox.y0));
  const y1 = Math.max(...words.map((w) => w.bbox.y1));
  const x0 = Math.min(...words.map((w) => w.bbox.x0));
  const x1 = Math.max(...words.map((w) => w.bbox.x1));
  return { words, bbox: { x0, x1, y0, y1 } };
}

test("extractValueTokens: numeric tokens each become their own value", () => {
  assert.deepEqual(extractValueTokens(["2", "9"]), ["2", "9"]);
});

test("extractValueTokens: a 'Not in 100' phrase split across multiple OCR tokens collapses into one value", () => {
  assert.deepEqual(extractValueTokens(["Not", "in", "100"]), ["Not in 100"]);
  assert.deepEqual(extractValueTokens(["Notin100"]), ["Notin100"]);
});

test("extractValueTokens: mixes a numeric value and a 'Not in 100' value in order", () => {
  assert.deepEqual(extractValueTokens(["32", "Not", "in100"]), ["32", "Not in100"]);
});

test("extractValueTokens: skips unrecognized stray fragments instead of poisoning a value", () => {
  assert.deepEqual(extractValueTokens(["~~", "4", "garbled"]), ["4"]);
});

test("groupDatePhrases: splits a flat token run into whole date phrases after each 4-digit year", () => {
  assert.deepEqual(
    groupDatePhrases(["31st", "August", "2026", "17th", "August", "2026"]),
    ["31st August 2026", "17th August 2026"],
  );
});

test("assembleRowsFromBlocks: matches keyword-block lines to value-block lines by y-overlap, not by shared line/x-position", () => {
  const headerBlock: OcrBlock = {
    bbox: { x0: 400, x1: 2130, y0: 200, y1: 260 },
    lines: [line([word("Keyword", 400, 600, 200, 260), word("31st", 1300, 1400, 200, 260), word("August", 1410, 1550, 200, 260), word("2026", 1560, 1650, 200, 260), word("17th", 1700, 1800, 200, 260), word("August", 1810, 1950, 200, 260), word("2026", 1960, 2050, 200, 260)])],
  };
  // Keyword column: one line per row, spanning the whole table height --
  // this is the block with the most lines, exactly like the real sample.
  const keywordBlock: OcrBlock = {
    bbox: { x0: 400, x1: 1200, y0: 300, y1: 700 },
    lines: [
      line([word("car", 400, 440, 300, 340), word("seat", 450, 500, 300, 340), word("covers", 510, 580, 300, 340), word("mussafah", 590, 700, 300, 340)]),
      line([word("car", 400, 440, 500, 540), word("sound", 450, 520, 500, 540), word("system", 530, 600, 500, 540)]),
    ],
  };
  // Values block: fewer/separate lines, at the same y-heights as their
  // matching keyword row, but NOT the same "line" object.
  const valuesBlock: OcrBlock = {
    bbox: { x0: 1300, x1: 2130, y0: 300, y1: 700 },
    lines: [
      line([word("2", 1430, 1460, 305, 335), word("|", 1550, 1560, 305, 335), word("9", 1650, 1680, 305, 335)]),
      line([word("4", 1430, 1460, 505, 535), word("|", 1550, 1560, 505, 535), word("2", 1650, 1680, 505, 535)]),
    ],
  };
  // A small stray fragment block above the header -- must never be
  // mistaken for the keyword or values column.
  const titleBlock: OcrBlock = {
    bbox: { x0: 700, x1: 1000, y0: 50, y1: 100 },
    lines: [line([word("Client", 700, 780, 50, 100), word("Keyword", 790, 880, 50, 100), word("Ranking", 890, 970, 50, 100)])],
  };

  const result = assembleRowsFromBlocks([titleBlock, headerBlock, keywordBlock, valuesBlock]);

  assert.deepEqual(result.headerDatePhrases, ["31st August 2026", "17th August 2026"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].keyword, "car seat covers mussafah");
  assert.deepEqual(result.rows[0].values, ["2", "9"]);
  assert.equal(result.rows[1].keyword, "car sound system");
  assert.deepEqual(result.rows[1].values, ["4", "2"]);
});

test("assembleRowsFromBlocks: the page title containing the word 'Keyword' is not mistaken for the table header", () => {
  const titleBlock: OcrBlock = {
    bbox: { x0: 700, x1: 1000, y0: 50, y1: 100 },
    lines: [line([word("Client", 700, 780, 50, 100), word("Keyword", 790, 880, 50, 100), word("Ranking", 890, 970, 50, 100), word("Report", 980, 1060, 50, 100)])],
  };
  const result = assembleRowsFromBlocks([titleBlock]);
  assert.equal(result.headerDatePhrases, null);
  assert.equal(result.rows.length, 0);
});

test("assembleRowsFromBlocks: returns no rows (not a crash) when no Keyword header is found at all", () => {
  const result = assembleRowsFromBlocks([]);
  assert.equal(result.headerDatePhrases, null);
  assert.deepEqual(result.rows, []);
});
