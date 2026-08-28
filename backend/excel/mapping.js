// Locked Excel <-> internal field mapping (see architecture discussion).
// Column lookup is by header text, not fixed letter position, so client
// files can add/reorder trailing columns without breaking the parser.

export const COLUMN_HEADERS = {
  keyword: 'Keywords',
  fullUrl: 'Full URL',
  targetUrl: 'URL',
  concatenate: 'Concatenate',
  locationName: 'Location',
  seDomain: 'Domain',
  languageName: 'Language',
  status: 'Status',
  rank: 'Ranks',
  rankingUrl: 'Ranking URL',
};

// Fields that must be present and non-empty on every data row.
export const REQUIRED_ROW_FIELDS = [
  'keyword',
  'targetUrl',
  'locationName',
  'seDomain',
  'languageName',
];

export const STATUS_TEXT = {
  PENDING: 'Pending',
  ERROR_RETRY: 'Error - Retry',
  COMPLETED: 'Completed',
};

// FAILED is a DB-only terminal state (no equivalent in the original Make
// sheet). We render it back to Excel as "Error - Retry" so client-facing
// files never show a status string the existing process doesn't recognize
// -- confirm with the user if a distinct visible label is wanted instead.
export const ROW_STATUS_TO_EXCEL_TEXT = {
  PENDING: STATUS_TEXT.PENDING,
  PROCESSING: STATUS_TEXT.PENDING,
  ERROR_RETRY: STATUS_TEXT.ERROR_RETRY,
  FAILED: STATUS_TEXT.ERROR_RETRY,
  COMPLETED: STATUS_TEXT.COMPLETED,
};

export const NOT_IN_100 = 'Not in 100';

function normalizeHeader(value) {
  return (value ?? '').toString().trim().toLowerCase();
}

/**
 * Reads an ExcelJS header row and returns { fieldKey: columnNumber }.
 * Throws if any required column header is missing.
 */
export function locateColumns(headerRow) {
  const found = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const text = normalizeHeader(cell.value);
    for (const [fieldKey, headerText] of Object.entries(COLUMN_HEADERS)) {
      if (normalizeHeader(headerText) === text && found[fieldKey] === undefined) {
        found[fieldKey] = colNumber;
      }
    }
  });

  const missing = Object.keys(COLUMN_HEADERS).filter((key) => found[key] === undefined);
  if (missing.length > 0) {
    const missingHeaders = missing.map((key) => COLUMN_HEADERS[key]);
    throw new Error(`Missing required Excel column(s): ${missingHeaders.join(', ')}`);
  }

  return found;
}
