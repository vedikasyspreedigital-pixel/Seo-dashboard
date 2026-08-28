// Diagnostic only: compares DataForSEO's Live REGULAR endpoint against the
// Live ADVANCED result we already got for this exact keyword/target, to test
// the hypothesis that Advanced's richer SERP-feature parsing (images, etc.)
// might be misreading a page that Regular's narrower extraction handles fine.
// Does NOT touch the mapper, does NOT write to Postgres -- one real call only.

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch { /* optional */ }
}

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;
if (!login || !password) throw new Error('DATAFORSEO_LOGIN/DATAFORSEO_PASSWORD not set');

const authHeader = 'Basic ' + Buffer.from(`${login}:${password}`).toString('base64');

const requestPayload = {
  keyword: 'cash for cars perth',
  target: '*cash-for-cars-perth.*',
  location_name: 'Australia',
  se_domain: 'google.com.au',
  language_name: 'English',
  device: 'desktop',
  os: 'windows',
  depth: 100,
};

console.log('--- Request (Live REGULAR) ---');
console.log(JSON.stringify(requestPayload, null, 2));

const response = await fetch('https://api.dataforseo.com/v3/serp/google/organic/live/regular', {
  method: 'POST',
  headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
  body: JSON.stringify([requestPayload]),
});
const body = await response.json();

console.log('\n--- Response ---');
console.log(`HTTP ${response.status}`);
console.log(JSON.stringify(body, null, 2));
