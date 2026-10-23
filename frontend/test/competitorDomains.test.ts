import { test } from "node:test";
import assert from "node:assert/strict";
import { competitorProblems, fillFromPaste, splitPasted, toDomain } from "../src/utils/competitorDomains.js";

// Competitors typed or pasted by the team for the Keyword Analysis (2026-10-23).

test("toDomain: full URLs, www, case, paths, ports and trailing dots -> the bare domain", () => {
  assert.equal(toDomain("  https://www.UnpluggedYoga.com.au/classes?x=1 "), "unpluggedyoga.com.au");
  assert.equal(toDomain("http://meltonyoga.com.au:8080/"), "meltonyoga.com.au");
  assert.equal(toDomain("yogabayside.com.au."), "yogabayside.com.au");
  assert.equal(toDomain(""), "");
});

test("splitPasted: lines, commas, semicolons, tabs and spaces", () => {
  assert.deepEqual(splitPasted("https://a.com.au/x\nb.com, c.com;d.com\te.com f.com"), ["a.com.au", "b.com", "c.com", "d.com", "e.com", "f.com"]);
});

test("fillFromPaste: a list fills the boxes from where it was pasted; a single entry is left to the box", () => {
  assert.deepEqual(fillFromPaste(["keep.com", "", ""], 1, "https://www.b.com\nc.com\nd.com"), ["keep.com", "b.com", "c.com"]);
  assert.deepEqual(fillFromPaste(["", "", ""], 0, "a.com, b.com"), ["a.com", "b.com", ""]);
  assert.equal(fillFromPaste(["", "", ""], 0, "https://a.com/page"), null);
});

test("competitorProblems: not a domain, the client itself, duplicates; empty boxes are fine", () => {
  assert.deepEqual(competitorProblems(["yoga studio sydney", "https://www.yogapeaceaustralia.com/", "a.com", "A.com", ""], "https://www.yogapeaceaustralia.com"), [
    "Not a website address",
    "That’s the client’s own website",
    null,
    "Already listed",
    null,
  ]);
});
