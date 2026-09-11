import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeKeyword, parseBaselineRank } from "../backend/baselines/normalizeKeyword.js";
import { parseDateLabel, pickNewestDateColumn } from "../backend/baselines/parseDateColumn.js";

test("normalizeKeyword: lowercases, trims, and collapses internal whitespace -- must match identically at write and read time", () => {
  assert.equal(normalizeKeyword("  Car Accessories   Abu Dhabi "), "car accessories abu dhabi");
  assert.equal(normalizeKeyword("Car Accessories Abu Dhabi"), normalizeKeyword("  car accessories  abu dhabi  "));
});

test("parseBaselineRank: numeric ranks parse to their integer value with a matching display string", () => {
  assert.deepEqual(parseBaselineRank("1"), { rankValue: 1, rankDisplay: "1" });
  assert.deepEqual(parseBaselineRank("42"), { rankValue: 42, rankDisplay: "42" });
});

test("parseBaselineRank: 'Not in 100' and 'Not in100' (both seen in the real sample report) both normalize to a null rank with the canonical display text", () => {
  assert.deepEqual(parseBaselineRank("Not in 100"), { rankValue: null, rankDisplay: "Not in 100" });
  assert.deepEqual(parseBaselineRank("Not in100"), { rankValue: null, rankDisplay: "Not in 100" });
  assert.deepEqual(parseBaselineRank("not in 100"), { rankValue: null, rankDisplay: "Not in 100" });
});

test("parseBaselineRank: blank or unparseable cells are treated as unranked (null), not thrown away as an error", () => {
  assert.deepEqual(parseBaselineRank(""), { rankValue: null, rankDisplay: null });
  assert.deepEqual(parseBaselineRank(null), { rankValue: null, rankDisplay: null });
  assert.deepEqual(parseBaselineRank("garbled#text"), { rankValue: null, rankDisplay: null });
});

test("parseDateLabel: parses the exact ordinal-date format from the real sample PDF", () => {
  const d1 = parseDateLabel("31st August 2026");
  const d2 = parseDateLabel("17th August 2026");
  assert.ok(d1 && d2);
  assert.equal(d1!.getUTCFullYear(), 2026);
  assert.equal(d1!.getUTCMonth(), 7); // August = index 7
  assert.equal(d1!.getUTCDate(), 31);
  assert.ok(d1!.getTime() > d2!.getTime());
});

test("parseDateLabel: also handles plain day-month-year, ISO, and slash formats", () => {
  assert.ok(parseDateLabel("31 August 2026"));
  assert.equal(parseDateLabel("2026-08-31")?.getUTCDate(), 31);
  assert.equal(parseDateLabel("31/08/2026")?.getUTCMonth(), 7);
});

test("parseDateLabel: returns null for text that isn't a date, rather than guessing", () => {
  assert.equal(parseDateLabel("Keyword"), null);
  assert.equal(parseDateLabel("Google.ae"), null);
  assert.equal(parseDateLabel(""), null);
});

test("parseDateLabel: rejects an out-of-range calendar date instead of silently rolling it over", () => {
  assert.equal(parseDateLabel("32 August 2026"), null);
});

test("pickNewestDateColumn: picks the maximum parsed date with no override -- exactly the sample report's two columns", () => {
  const columns = [{ label: "31st August 2026" }, { label: "17th August 2026" }];
  const result = pickNewestDateColumn(columns);
  assert.ok(result);
  assert.equal(result!.column.label, "31st August 2026");
});

test("pickNewestDateColumn: ignores non-date columns (e.g. a 'Keyword' header) when picking the newest", () => {
  const columns = [{ label: "Keyword" }, { label: "17th August 2026" }, { label: "31st August 2026" }];
  const result = pickNewestDateColumn(columns);
  assert.equal(result!.column.label, "31st August 2026");
});

test("pickNewestDateColumn: returns null when nothing parses as a date", () => {
  assert.equal(pickNewestDateColumn([{ label: "Keyword" }, { label: "Status" }]), null);
});
