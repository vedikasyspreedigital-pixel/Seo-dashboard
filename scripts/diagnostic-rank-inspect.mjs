// Read-only diagnostic for the ranking-accuracy investigation. Does NOT call
// DataForSEO and does NOT touch mapResponse.js/recordAttemptAndApply.js --
// it only re-reads what's already stored on each row's latest attempt
// (request_payload + raw_response are saved for every attempt, win or lose)
// and lays out every candidate item DataForSEO returned, not just the one
// items[0] the locked mapper currently selects. Nothing here mutates the DB.
//
// Usage:
//   node scripts/diagnostic-rank-inspect.mjs --run <runId>
//   node scripts/diagnostic-rank-inspect.mjs --keyword "some keyword"
//   node scripts/diagnostic-rank-inspect.mjs --row <rankingRowId>

import { prisma } from '../backend/db/client.js';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch { /* optional */ }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--run') out.runId = argv[++i];
    else if (argv[i] === '--keyword') out.keyword = argv[++i];
    else if (argv[i] === '--row') out.rowId = argv[++i];
  }
  return out;
}

function extractDomain(urlOrWildcard) {
  if (!urlOrWildcard) return null;
  // target is often a wildcard like *example.com.* or *example-page.*, not a
  // real parseable URL -- strip leading/trailing '*' and any scheme, then
  // take everything up to the first remaining '/' as the "domain-ish" part.
  const stripped = urlOrWildcard.replace(/^\*+/, '').replace(/\*+$/, '').replace(/^https?:\/\//, '');
  return stripped.split('/')[0] || null;
}

function domainFromResultUrl(url) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

async function main() {
  const { runId, keyword, rowId } = parseArgs(process.argv.slice(2));

  const where = {};
  if (runId) where.runId = runId;
  if (keyword) where.keyword = { contains: keyword, mode: 'insensitive' };
  if (rowId) where.id = rowId;

  if (!runId && !keyword && !rowId) {
    console.error('Provide --run <runId>, --keyword "<text>", or --row <rowId>');
    process.exit(1);
  }

  const rows = await prisma.rankingRow.findMany({
    where,
    orderBy: { sourceRowNumber: 'asc' },
    include: { attempts: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
  });

  if (rows.length === 0) {
    console.log('No matching rows found.');
    await prisma.$disconnect();
    return;
  }

  for (const row of rows) {
    const attempt = row.attempts[0];
    console.log('\n' + '='.repeat(100));
    console.log(`Row ${row.id}  (run ${row.runId}, source row #${row.sourceRowNumber})`);
    console.log(`Keyword:        ${row.keyword}`);
    console.log(`Target URL:     ${row.targetUrl}`);
    console.log(`Location/SE/Lang: ${row.locationName} / ${row.seDomain} / ${row.languageName}`);
    console.log(`Row status:     ${row.status}`);
    console.log(`Final Ranks:        ${row.rankDisplay}`);
    console.log(`Final Ranking URL:  ${row.rankingUrl ?? '(none)'}`);

    if (!attempt) {
      console.log('No attempts recorded for this row.');
      continue;
    }

    console.log(`\n--- Attempt #${attempt.attemptNumber} (outcome=${attempt.outcome}) ---`);
    console.log('Exact DataForSEO request payload:');
    console.log(JSON.stringify(attempt.requestPayload, null, 2));

    const body = attempt.rawResponse;
    const task = body?.tasks?.[0];
    const result = Array.isArray(task?.result) ? task.result[0] : null;
    const items = Array.isArray(result?.items) ? result.items : [];

    console.log(`\nTop-level status_code: ${body?.status_code} ${body?.status_message ?? ''}`);
    console.log(`Task status_code:      ${task?.status_code} ${task?.status_message ?? ''}`);
    console.log(`result.se_results_count: ${result?.se_results_count ?? '(n/a)'}`);
    console.log(`items returned (already target-filtered by DataForSEO server-side): ${items.length}`);

    const targetDomain = extractDomain(row.targetUrl);
    console.log(`\nDomain extracted from our targetUrl/wildcard: ${targetDomain}`);

    if (items.length === 0) {
      console.log('(no items in raw response -- this is what produced "Not in 100")');
    } else {
      console.log('\nEvery item DataForSEO returned as matching our target filter, in order:');
      console.table(
        items.map((it, idx) => ({
          idx,
          selected_by_current_logic: idx === 0 ? 'YES (items[0])' : '',
          rank_group: it.rank_group,
          rank_absolute: it.rank_absolute,
          type: it.type,
          url: it.url,
          result_domain: domainFromResultUrl(it.url),
          domain_matches_target: domainFromResultUrl(it.url) === targetDomain?.replace(/^www\./, ''),
        })),
      );
    }

    console.log(`\nMapped by current logic -> rank_group=${attempt.mappedRankValue}, url=${attempt.mappedRankingUrl}`);
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
