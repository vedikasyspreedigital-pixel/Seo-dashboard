import { NOT_IN_100 } from '../excel/mapping.js';

// DataForSEO status code ranges (docs.dataforseo.com/v3/appendix/errors):
// 20000        success
// 40102        "no results matching the details of your request have been
//              found" -- a valid empty-result outcome, not a failure
// 40202        rate limit -- transient, safe to retry
// 40000-49999  other client/request errors -- permanent, do not retry
// 50000-59999  server-side errors -- transient, safe to retry
const NO_SEARCH_RESULTS_STATUS_CODE = 40102;

export function isRetryableDataForSeoStatusCode(code) {
  if (code === 40202) return true;
  return code >= 50000 && code < 60000;
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
 * @param {{ transportError?: Error, httpStatus?: number, body?: any }} input
 */
export function mapDataForSeoResponse({ transportError, httpStatus, body } = {}) {
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
    return notFoundSuccess(task);
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
