import { test } from "node:test";
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { prisma } from "../backend/db/client.js";
import { createApp } from "../backend/api/app.js";
import { createAuthenticatedSession } from "./helpers/auth.js";
import { authedRequest } from "./helpers/authedRequest.js";
import { KeywordExportError, readKeywordExport } from "../backend/domainIntel/readKeywordExport.js";
import { brandTerms, classifyByPattern, classifyIntents } from "../backend/domainIntel/classifyIntent.js";
import { buildDomainReportExcel } from "../backend/domainIntel/buildDomainReportExcel.js";
import type { PostCommentParams } from "../backend/domainIntel/clickupCommentPoster.js";
import type { CallDataForSeoFn } from "../backend/worker/processRun.js";

// Domain Intelligence: tool exports in -> intent-labelled side-by-side Excel
// out -> posted as a ClickUp comment (mocked here).

const neverCalled: CallDataForSeoFn = async () => {
  throw new Error("Domain Intelligence must never call DataForSEO");
};

const SEMRUSH_CSV = [
  '"Keyword","Position","Previous position","Search Volume","Keyword Difficulty","CPC","URL"',
  '"meraki photography","1","2","480","30","1.2","https://merakiphotography.com.au/"',
  '"wedding photography melbourne","59","61","1,900","55","3.1","https://merakiphotography.com.au/weddings"',
  '"how to choose a wedding photographer","","","210","20","0.5",""',
  '"Meraki  Photography","4","2","480","30","1.2","https://merakiphotography.com.au/"',
].join("\n");

/** Ahrefs exports UTF-16LE with a BOM, tab-separated. */
function ahrefsCsv(): Buffer {
  const text = ["Keyword\tVolume\tKD\tCurrent position\tCurrent URL", "book photographer melbourne\t320\t12\t8\thttps://x", "photo studio\t90\t5\t\thttps://x"].join("\r\n");
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

async function ubersuggestXlsx(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Keywords");
  sheet.addRow(["Organic keywords for merakiphotography.com.au"]);
  sheet.addRow(["No", "Keywords", "Volume", "Position"]);
  sheet.addRow([1, "marici experience centre", 260, 66]);
  sheet.addRow([2, "best photographers near me", 1000, 17]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("readKeywordExport: Semrush CSV -- picks current Position (not Previous), parses 1,900, merges duplicates keeping the best", async () => {
  const e = await readKeywordExport("semrush", Buffer.from(SEMRUSH_CSV), "semrush.csv");
  assert.deepEqual(
    e.rows.map((r) => [r.keyword, r.position, r.volume]),
    [
      ["meraki photography", 1, 480],
      ["wedding photography melbourne", 59, 1900],
      ["how to choose a wedding photographer", null, 210],
    ],
  );
  assert.equal(e.duplicatesRemoved, 1);
});

test("readKeywordExport: Ahrefs UTF-16 tab file and Ubersuggest Excel with a title row above the headers", async () => {
  const a = await readKeywordExport("ahrefs", ahrefsCsv(), "ahrefs.csv");
  assert.deepEqual(a.rows.map((r) => [r.keyword, r.position, r.volume]), [["book photographer melbourne", 8, 320], ["photo studio", null, 90]]);
  const u = await readKeywordExport("ubersuggest", await ubersuggestXlsx(), "uber.xlsx");
  assert.deepEqual(u.rows.map((r) => [r.keyword, r.position]), [["best photographers near me", 17], ["marici experience centre", 66]]);
});

test("readKeywordExport: Semrush 'Keyword Intents' is kept (capitalised, mixed intents joined); blank stays null", async () => {
  const csv = [
    "Keyword,Position,Previous position,Search Volume,URL,Keyword Intents,Position Type",
    "melbourne chauffeur online,9,9,70,https://x/,informational,Organic",
    "chauffeur service melbourne,31,31,1600,https://x/,commercial,Organic",
    "book chauffeur,40,40,90,https://x/,\"informational, transactional\",Organic",
    "chuefer,44,44,50,https://x/,,Organic",
  ].join("\n");
  const e = await readKeywordExport("semrush", Buffer.from(csv), "semrush.csv");
  assert.deepEqual(
    e.rows.map((r) => [r.keyword, r.sourceIntent]),
    [
      ["melbourne chauffeur online", "Informational"],
      ["chauffeur service melbourne", "Commercial"],
      ["book chauffeur", "Informational, Transactional"],
      ["chuefer", null],
    ],
  );
});

test("readKeywordExport: clear errors for a file without Keyword/Position columns and for old .xls", async () => {
  await assert.rejects(readKeywordExport("semrush", Buffer.from("a,b\n1,2"), "x.csv"), KeywordExportError);
  await assert.rejects(readKeywordExport("semrush", Buffer.from("Keyword,Volume\nfoo,10"), "x.csv"), /No "Position" column/);
  await assert.rejects(readKeywordExport("ahrefs", Buffer.from("x"), "old.xls"), /old \.xls/);
});

test("classifyByPattern: the spec's examples, brand first, questions before service words, else undecided", () => {
  const brands = brandTerms("Meraki Photography", "https://www.merakiphotography.com.au/");
  assert.deepEqual(brands, ["meraki photography", "merakiphotography"]);
  assert.equal(classifyByPattern("meraki photography reviews", brands), "Navigational");
  assert.equal(classifyByPattern("book airport chauffeur melbourne", brands), "Transactional");
  assert.equal(classifyByPattern("best chauffeur service melbourne", brands), "Commercial");
  assert.equal(classifyByPattern("how to choose a chauffeur service", brands), "Informational");
  assert.equal(classifyByPattern("Melbourne Chauffeur official website", brandTerms("Melbourne Chauffeur", "melbournechauffeur.com.au")), "Navigational");
  assert.equal(classifyByPattern("best photographers near me", brands), "Transactional");
  assert.equal(classifyByPattern("wedding photography ideas", brands), "Informational");
  assert.equal(classifyByPattern("photo studio", brands), null);
});

// Audit 2026-10-27: the brand used to match ANY part of the text, so ordinary searches became "brand searches"
// (skipped by the AI, left out of the Gap report). Now whole words must spell the brand.
test("classifyByPattern: a brand counts only as whole words, never inside another word", () => {
  const eagle = brandTerms("Eagle Law and Integrity", "https://eaglelaw.com.au");
  assert.equal(classifyByPattern("eagle law firm", eagle), "Navigational");
  assert.equal(classifyByPattern("eaglelaw reviews", eagle), "Navigational");
  assert.notEqual(classifyByPattern("eagle lawyer sydney", eagle), "Navigational");
  const trueit = brandTerms("TrueIT", "https://trueit.com.au");
  assert.equal(classifyByPattern("trueit support", trueit), "Navigational");
  assert.equal(classifyByPattern("true it support", trueit), "Navigational");
  assert.notEqual(classifyByPattern("true italian pizza", trueit), "Navigational");
  const yoga = brandTerms("Yoga Peace", "https://www.yogapeaceaustralia.com");
  assert.equal(classifyByPattern("yogapeaceaustralia com", yoga), "Navigational");
  assert.equal(classifyByPattern("yoga peace parramatta", yoga), "Navigational");
  assert.notEqual(classifyByPattern("peaceful yoga music", yoga), "Navigational");
});

test("classifyIntents: only undecided keywords go to the AI step, once each; without AI they fall back to Informational", async () => {
  const seen: string[][] = [];
  const ai = async (keywords: string[]) => {
    seen.push(keywords);
    return new Map(keywords.map((k) => [k.toLowerCase(), "Commercial" as const]));
  };
  const ctx = { clientName: "Meraki Photography", websiteUrl: "merakiphotography.com.au" };
  const r = await classifyIntents(["photo studio", "Photo Studio", "book a shoot", "marici experience centre"], ctx, ai);
  assert.deepEqual(seen, [["photo studio", "marici experience centre"]]);
  assert.equal(r.intents.get("photo studio"), "Commercial");
  assert.equal(r.intents.get("book a shoot"), "Transactional");
  assert.deepEqual([r.byPattern, r.byAi, r.unresolved], [1, 2, 0]);

  const noAi = await classifyIntents(["photo studio"], ctx, null);
  assert.equal(noAi.intents.get("photo studio"), "Informational");
  assert.equal(noAi.unresolved, 1);
});

test("buildDomainReportExcel: side-by-side yellow/blue blocks in Semrush, Ubersuggest, Ahrefs order with a spacer column", async () => {
  const buffer = await buildDomainReportExcel([
    { source: "ahrefs", rows: [{ keyword: "c", volume: 5, position: 3, intent: "Commercial" }] },
    { source: "semrush", rows: [{ keyword: "a", volume: 480, position: 1, intent: "Navigational" }] },
    { source: "ubersuggest", rows: [{ keyword: "b", volume: 260, position: 66, intent: "Informational" }] },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  const row = (n: number) => Array.from((sheet.getRow(n).values as unknown[]).slice(1)); // holes -> undefined
  assert.equal(sheet.getCell("E1").value, null, "spacer column between blocks");
  assert.equal(sheet.getCell("A1").value, "SEMrush");
  assert.equal(sheet.getCell("F1").value, "Ubersuggest");
  assert.equal(sheet.getCell("K1").value, "Ahrefs");
  assert.deepEqual(
    row(2),
    ["Keyword", "Position", "Search Volume", "Intent", undefined, "Keyword", "Volume", "Current position", "Intent", undefined, "Keywords", "Volume", "Current position", "Intent"],
  );
  assert.deepEqual(row(3), ["a", 1, 480, "Navigational", undefined, "b", 260, 66, "Informational", undefined, "c", 5, 3, "Commercial"]);
  assert.equal((sheet.getCell("A1").fill as ExcelJS.FillPattern).fgColor?.argb, "FFFFFF00");
  assert.equal((sheet.getCell("A2").fill as ExcelJS.FillPattern).fgColor?.argb, "FF4472C4");
});

test("POST /api/domain-intel/reports: builds combined + individual files, posts them to the client's domain task, keeps history", async () => {
  const auth = await createAuthenticatedSession();
  const posted: PostCommentParams[] = [];
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async (p) => {
      posted.push(p);
    },
    classifyWithAi: null,
  });
  const client = await prisma.client.create({
    data: { name: "Meraki Photography", domain: "merakiphotography.com.au", workspaceId: auth.workspace.id, domainReportTaskId: "86dtest123" },
  });
  const api = authedRequest(app, auth.cookieHeader);
  try {
    const res = await api
      .post("/api/domain-intel/reports")
      .field("clientId", client.id)
      .field("reportMode", "both")
      .attach("semrush", Buffer.from(SEMRUSH_CSV), "semrush.csv")
      .attach("ahrefs", ahrefsCsv(), "ahrefs.csv");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.websiteUrl, "merakiphotography.com.au");
    assert.deepEqual(
      res.body.files.map((f: { name: string }) => f.name.replace(/ - \d.*$/, "")),
      ["Meraki Photography - Domain Keyword Report", "Meraki Photography - SEMrush Keywords", "Meraki Photography - Ahrefs Keywords"],
    );
    assert.equal(res.body.files[0].path, undefined, "server paths never reach the browser");
    assert.deepEqual(res.body.summary.sources, { semrush: { keywords: 3, duplicatesRemoved: 1 }, ahrefs: { keywords: 2, duplicatesRemoved: 0 } });

    // Posting happens in the background.
    let report = await prisma.domainReport.findUniqueOrThrow({ where: { id: res.body.id } });
    for (let i = 0; i < 50 && report.status !== "POSTED"; i++) {
      await new Promise((r) => setTimeout(r, 20));
      report = await prisma.domainReport.findUniqueOrThrow({ where: { id: res.body.id } });
    }
    assert.equal(report.status, "POSTED");
    assert.equal(posted.length, 1);
    assert.equal(posted[0].taskId, "86dtest123");
    assert.equal(posted[0].files.length, 3);
    assert.ok(posted[0].lines.join("\n").includes(posted[0].marker));

    const file = await api.get(`/api/domain-intel/reports/${res.body.id}/files/0`).buffer(true);
    assert.equal(file.status, 200);
    const history = await api.get(`/api/domain-intel/reports?clientId=${client.id}`);
    assert.equal(history.body.length, 1);

    const again = await api.post(`/api/domain-intel/reports/${res.body.id}/post`);
    assert.equal(again.status, 409, "an already-posted report is not posted twice");
  } finally {
    const reports = await prisma.domainReport.findMany({ where: { clientId: client.id } });
    for (const r of reports) {
      const files = r.files as { path: string }[];
      if (files[0]) await rm(path.dirname(files[0].path), { recursive: true, force: true });
    }
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test("POST /api/domain-intel/reports: ONE intent per keyword, the same in every block; tool labels are only hints for the AI", async () => {
  const auth = await createAuthenticatedSession();
  const classified: string[][] = [];
  const hintsSeen: [string, string[]][][] = [];
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async () => {},
    classifyWithAi: async (keywords, _context, toolLabels) => {
      classified.push(keywords);
      hintsSeen.push([...(toolLabels ?? new Map())]);
      return new Map(keywords.map((k) => [k.toLowerCase(), "Commercial" as const]));
    },
  });
  const client = await prisma.client.create({ data: { name: "Chauffeur Melbourne", domain: "chauffeurmelbourne.com.au", workspaceId: auth.workspace.id } });
  const semrush = "Keyword,Position,Search Volume,Keyword Intents\nphoto studio,5,90,navigational\nconference chauffeur,42,70,informational";
  try {
    const res = await authedRequest(app, auth.cookieHeader)
      .post("/api/domain-intel/reports")
      .field("clientId", client.id)
      .attach("semrush", Buffer.from(semrush), "semrush.csv")
      .attach("ahrefs", ahrefsCsv(), "ahrefs.csv");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    // Every unique keyword is classified once ("photo studio" is in both files); patterns decide "book ...".
    assert.deepEqual(classified, [["photo studio", "conference chauffeur"]]);
    assert.deepEqual(hintsSeen[0], [["photo studio", ["Navigational"]], ["conference chauffeur", ["Informational"]]], "Semrush's labels go to the AI as hints");
    assert.equal(res.body.summary.intentByAi, 2);
    assert.equal(res.body.summary.intentByPattern, 1);

    const report = await prisma.domainReport.findUniqueOrThrow({ where: { id: res.body.id } });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile((report.files as { path: string }[])[0].path);
    const sheet = workbook.worksheets[0];
    assert.equal(sheet.getCell("A3").value, "photo studio");
    assert.equal(sheet.getCell("D3").value, "Commercial", "one intent, not Semrush's label as-is");
    assert.equal(sheet.getCell("D4").value, "Commercial");
    assert.equal(sheet.getCell("F3").value, "book photographer melbourne");
    assert.equal(sheet.getCell("I3").value, "Transactional", "pattern");
    assert.equal(sheet.getCell("F4").value, "photo studio");
    assert.equal(sheet.getCell("I4").value, "Commercial", "same keyword, same intent in every block");
    for (const cell of ["D3", "D4", "I3", "I4"]) assert.ok(!String(sheet.getCell(cell).value).includes(","), "never several intents in one cell");
  } finally {
    const reports = await prisma.domainReport.findMany({ where: { clientId: client.id } });
    for (const r of reports) {
      const files = r.files as { path: string }[];
      if (files[0]) await rm(path.dirname(files[0].path), { recursive: true, force: true });
    }
    await prisma.domainReport.deleteMany({ where: { clientId: client.id } });
    await prisma.client.delete({ where: { id: client.id } });
    await auth.cleanup();
  }
});

test("POST /api/domain-intel/reports: no domain task id -> generated but NOT_POSTED; bad file -> 422; other workspace -> 404", async () => {
  const auth = await createAuthenticatedSession();
  const other = await createAuthenticatedSession();
  const app = createApp(neverCalled, "mock", undefined, undefined, {
    postComment: async () => {
      throw new Error("must not post");
    },
    classifyWithAi: null,
  });
  const client = await prisma.client.create({ data: { name: "No Task Co", workspaceId: auth.workspace.id } });
  const foreign = await prisma.client.create({ data: { name: "Foreign", workspaceId: other.workspace.id } });
  const api = authedRequest(app, auth.cookieHeader);
  try {
    const ok = await api
      .post("/api/domain-intel/reports")
      .field("clientId", client.id)
      .field("websiteUrl", "https://notask.example")
      .attach("semrush", Buffer.from(SEMRUSH_CSV), "semrush.csv");
    assert.equal(ok.status, 201);
    assert.equal(ok.body.status, "NOT_POSTED");
    assert.match(ok.body.error, /domain-report ClickUp task/);

    const bad = await api.post("/api/domain-intel/reports").field("clientId", client.id).field("websiteUrl", "x.com").attach("semrush", Buffer.from("a,b\n1,2"), "s.csv");
    assert.equal(bad.status, 422);
    const none = await api.post("/api/domain-intel/reports").field("clientId", client.id).field("websiteUrl", "x.com");
    assert.equal(none.status, 422);

    const cross = await api.post("/api/domain-intel/reports").field("clientId", foreign.id).field("websiteUrl", "x.com").attach("semrush", Buffer.from(SEMRUSH_CSV), "s.csv");
    assert.equal(cross.status, 404);
  } finally {
    const reports = await prisma.domainReport.findMany({ where: { clientId: { in: [client.id, foreign.id] } } });
    for (const r of reports) {
      const files = r.files as { path: string }[];
      if (files[0]) await rm(path.dirname(files[0].path), { recursive: true, force: true });
    }
    await prisma.domainReport.deleteMany({ where: { clientId: { in: [client.id, foreign.id] } } });
    await prisma.client.deleteMany({ where: { id: { in: [client.id, foreign.id] } } });
    await auth.cleanup();
    await other.cleanup();
  }
});

// Audit 2026-10-27 (the user's choice): a file in another tool's slot is refused -- only when it clearly IS
// that other tool's export. Header rows copied from real exports (27-28 Oct), no client data.
test("readKeywordExport: a file in the wrong tool's slot is refused; an unknown layout still goes through", async () => {
  const csv = (header: string, row: string) => Buffer.from(`${header}\n${row}`);
  const files = {
    semrush: csv("Keyword,Position,Previous position,Search Volume,Keyword Difficulty,CPC,URL,Traffic,Keyword Intents", "yoga,3,4,500,30,1.2,https://a/,40,commercial"),
    ubersuggest: csv("No,Keywords,Volume,Position,Est. Visits,Seo Difficulty,CPC,Ranking Url", "1,yoga,500,3,40,30,1.2,https://a/"),
    ahrefs: csv('"Keyword","Country","Volume","KD","Organic traffic","Current position","Current URL"', '"yoga","AU","500","30","40","3","https://a/"'),
  };
  for (const [tool, buf] of Object.entries(files)) {
    for (const slot of ["semrush", "ubersuggest", "ahrefs"] as const) {
      if (slot === tool) assert.equal((await readKeywordExport(slot, buf, `${tool}.csv`)).rows.length, 1, `${tool} in its own slot`);
      else await assert.rejects(readKeywordExport(slot, buf, `${tool}.csv`), /looks like a .* export, not/, `${tool} in the ${slot} slot`);
    }
  }
  // A layout no tool is known for (e.g. a tool changed its export) is not refused.
  assert.equal((await readKeywordExport("ahrefs", csv("Keyword,Position,Volume", "yoga,3,500"), "plain.csv")).rows.length, 1);
});
