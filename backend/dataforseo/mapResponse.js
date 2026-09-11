import { NOT_IN_100 } from '../excel/mapping.js';

// DataForSEO status codes (docs.dataforseo.com/v3/appendix/errors, and
// confirmed per-code against dataforseo.com/help-center/what-does-the-*
// -error-mean for the ones that actually showed up in production data --
// see the investigation that added 40101/40103/40106 below). The
// 40000-49999 range is NOT uniformly "permanent, do not retry" -- that was
// the bug: several codes in that range are DataForSEO's own documented
// transient/retryable outcomes despite the 4xxxx numbering. Each retryable
// code here is deliberately enumerated, not inferred from its numeric
// range, since the range alone doesn't reliably indicate permanence.
// 20000  success
// 40101  "Internal SE Server Error" -- the search engine itself errored
//        processing the request. DataForSEO's own docs: "Transient server
//        error... Retry: Yes, safe to retry." Confirmed in production: 2
//        rows that failed with this code both succeeded on a later retry
//        with the identical request.
// 40102  "No Search Results" -- handled separately below (notFoundSuccess),
//        not via this retryable-code set. Confirmed valid as "not found"
//        ONLY when the crawl reached the requested depth first -- see
//        hasSufficientDepthCoverage below for the real-data investigation
//        that found this code coming back on crawls that stopped after as
//        little as 1 of the expected ~10 pages.
// 40103  "Task Execution Failed" -- DataForSEO's docs: "try posting
//        another task with similar parameters... Retry: Yes, recommended
//        to resubmit." Not yet seen in production data, but documented
//        the same way as 40101/40106 -- included for the same reason.
// 40106  "Task Completed with Partial Results" -- DataForSEO's docs:
//        "Transient/degraded success... Retry: Yes, safe to retry for
//        missing pages." Confirmed in production: 7 of the 9 rows in the
//        run that prompted this investigation failed with this exact
//        code, then succeeded on a later retry with the identical
//        request -- direct evidence this is transient, not permanent.
//        Separately confirmed a partial crawl can still carry a confident
//        match in `items` (a real row had rank_group=1 discarded twice
//        under this code before failing outright) -- handled below by
//        inspecting items before treating this code as an error.
// 40202  rate limit -- transient, safe to retry
// 50000-59999  server-side errors -- transient, safe to retry
const NO_SEARCH_RESULTS_STATUS_CODE = 40102;
const PARTIAL_RESULTS_STATUS_CODE = 40106;
const RETRYABLE_STATUS_CODES = new Set([40101, 40103, 40106, 40202]);

export function isRetryableDataForSeoStatusCode(code) {
  if (RETRYABLE_STATUS_CODES.has(code)) return true;
  return code >= 50000 && code < 60000;
}

// DataForSEO's Live Regular SERP is paginated 10 results/page (confirmed
// against every real response recorded so far: pages_count tops out at
// depth/10). A 40102 "No Search Results" is only trustworthy as a genuine
// "not ranked in top N" if the crawl actually reached that depth -- found
// via real production data where the SAME keyword/target, run a day apart,
// got 40102 with result.pages_count=1 (target.rankValue lost -> "Not in
// 100") and then a full pages_count=9 crawl on retry that found rank 12.
// Same pattern confirmed on a second keyword/domain pair (pages_count=2 ->
// "Not in 100", pages_count=10 retry -> rank 2). Allowing a 1-page
// shortfall (rather than requiring an exact match) avoids flip-flopping
// crawls that legitimately run just short of the full page count.
const RESULTS_PER_PAGE = 10;
const MAX_PAGE_SHORTFALL = 1;

function hasSufficientDepthCoverage(requestPayload, result) {
  const depth = Number(requestPayload?.depth) || 100;
  const expectedPages = Math.ceil(depth / RESULTS_PER_PAGE);
  const pagesCount = result?.pages_count;
  if (typeof pagesCount !== 'number') return false; // no completeness evidence at all
  return pagesCount >= expectedPages - MAX_PAGE_SHORTFALL;
}

function notFoundSuccess(task) {
  return {
    outcome: 'SUCCESS',
    retryable: false,
    taskStatusCode: task.status_code,
    taskStatusMessage: task.status_message,
    rankValue: null,
    rankDisplay: NOT_IN_100,
    rankingUrl: null,
    matchedItemCount: 0,
    errorMessage: null,
  };
}

function incompleteDepthCoverage(task, result, requestPayload) {
  const depth = Number(requestPayload?.depth) || 100;
  const expectedPages = Math.ceil(depth / RESULTS_PER_PAGE);
  return {
    outcome: 'API_ERROR',
    retryable: true, // crawl didn't reach the requested depth -- not enough evidence to trust "not found" yet
    taskStatusCode: task.status_code,
    taskStatusMessage: task.status_message,
    rankValue: null,
    rankDisplay: null,
    rankingUrl: null,
    matchedItemCount: 0,
    errorMessage: `Task reported ${task.status_code} (${task.status_message ?? 'no message'}) but only crawled ${result?.pages_count ?? 'an unknown number of'} of the expected ~${expectedPages} page(s) for depth=${depth} -- retrying instead of confirming "${NOT_IN_100}"`,
  };
}

function matchFromItems(task, items) {
  const best = items[0];
  if (typeof best.rank_group !== 'number') return null;
  return {
    outcome: 'SUCCESS',
    retryable: false,
    taskStatusCode: task.status_code,
    taskStatusMessage: task.status_message,
    rankValue: best.rank_group,
    rankDisplay: String(best.rank_group),
    rankingUrl: best.url ?? null,
    matchedItemCount: items.length,
    errorMessage: null,
  };
}

function mappingError(message, extra = {}) {
  return {
    outcome: 'MAPPING_ERROR',
    retryable: true, // unexpected shape, not a reported permanent failure -- worth one more try
    taskStatusCode: null,
    taskStatusMessage: null,
    rankValue: null,
    rankDisplay: null,
    rankingUrl: null,
    matchedItemCount: 0,
    errorMessage: message,
    ...extra,
  };
}

function apiError({ statusCode, statusMessage }) {
  return {
    outcome: 'API_ERROR',
    retryable: isRetryableDataForSeoStatusCode(statusCode),
    taskStatusCode: statusCode,
    taskStatusMessage: statusMessage,
    rankValue: null,
    rankDisplay: null,
    rankingUrl: null,
    matchedItemCount: 0,
    errorMessage: statusMessage,
  };
}

/**
 * Pure mapper: DataForSEO response (or a transport failure) -> our internal
 * result shape. No DB access, no side effects -- safe to unit test with
 * hand-built fixtures.
 *
 * @param {{ transportError?: Error, httpStatus?: number, body?: any, requestPayload?: { depth?: number } }} input
 */
export function mapDataForSeoResponse({ transportError, httpStatus, body, requestPayload } = {}) {
  if (transportError) {
    return {
      outcome: 'API_ERROR',
      retryable: true, // network/timeout failures are transient by nature
      taskStatusCode: null,
      taskStatusMessage: null,
      rankValue: null,
      rankDisplay: null,
      rankingUrl: null,
      matchedItemCount: 0,
      errorMessage: transportError.message,
    };
  }

  if (!body || typeof body !== 'object') {
    return mappingError(`Response body missing or not an object (httpStatus=${httpStatus ?? 'unknown'})`);
  }

  if (typeof body.status_code !== 'number') {
    return mappingError('Response missing top-level status_code');
  }

  if (body.status_code !== 20000) {
    return apiError({ statusCode: body.status_code, statusMessage: body.status_message ?? 'Unknown top-level error' });
  }

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return mappingError('Response missing tasks[]');
  }

  const task = body.tasks[0];
  if (typeof task.status_code !== 'number') {
    return mappingError('Task missing status_code');
  }

  if (task.status_code === NO_SEARCH_RESULTS_STATUS_CODE) {
    // DataForSEO's other "not found" signal (result[0].items is typically
    // null here, not []) -- same business outcome as an empty items array,
    // not a permanent request failure. Confirmed against a real response.
    // BUT only trustworthy if the crawl actually reached the requested
    // depth first -- see hasSufficientDepthCoverage's comment for the two
    // confirmed real cases where a shallow crawl produced a false "Not in
    // 100" that a full-depth retry corrected.
    const noResultsResult = Array.isArray(task.result) ? task.result[0] : null;
    if (!hasSufficientDepthCoverage(requestPayload, noResultsResult)) {
      return incompleteDepthCoverage(task, noResultsResult, requestPayload);
    }
    return notFoundSuccess(task);
  }

  if (task.status_code === PARTIAL_RESULTS_STATUS_CODE) {
    // "Task Completed with Partial Results" means the crawl didn't finish,
    // but a partial crawl can still contain a confident match (confirmed on
    // a real row: rank_group=1 came back twice under this exact code and
    // was discarded both times, permanently failing the row after retries
    // ran out). Accept a match if the existing matcher finds one; only
    // fall through to the normal retryable-error handling when it doesn't.
    const partialResult = Array.isArray(task.result) ? task.result[0] : null;
    const partialItems = Array.isArray(partialResult?.items) ? partialResult.items : [];
    if (partialItems.length > 0) {
      const matched = matchFromItems(task, partialItems);
      if (matched) return matched;
    }
    return apiError({ statusCode: task.status_code, statusMessage: task.status_message ?? 'Unknown task error' });
  }

  if (task.status_code !== 20000) {
    return apiError({ statusCode: task.status_code, statusMessage: task.status_message ?? 'Unknown task error' });
  }

  const result = Array.isArray(task.result) ? task.result[0] : null;
  if (!result || !Array.isArray(result.items)) {
    // Task reported success but has no usable items array -- since target
    // is a wildcard filter, an empty/absent items array on a *successful*
    // task normally just means "not found in depth 100", but a genuinely
    // missing `items` key (as opposed to `items: []`) is a shape we don't
    // recognize and shouldn't silently treat as "Not in 100".
    if (result && result.items === undefined) {
      return mappingError('Task succeeded but result.items is missing');
    }
  }

  const items = result?.items ?? [];
  if (items.length === 0) {
    return notFoundSuccess(task);
  }

  // `target` is a wildcard filter, so DataForSEO may return more than one
  // matching page on the same domain. Items are already rank-ordered; the
  // locked mapping uses the first (best-ranked) match.
  const best = items[0];
  if (typeof best.rank_group !== 'number') {
    return mappingError('Matched item missing rank_group', { matchedItemCount: items.length });
  }

  return {
    outcome: 'SUCCESS',
    retryable: false,
    taskStatusCode: task.status_code,
    taskStatusMessage: task.status_message,
    rankValue: best.rank_group,
    rankDisplay: String(best.rank_group),
    rankingUrl: best.url ?? null,
    matchedItemCount: items.length,
    errorMessage: null,
  };
}
