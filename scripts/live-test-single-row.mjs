import { buildDataForSeoRequest } from "../backend/dataforseo/buildRequest.js";

// One controlled real DataForSEO call, nothing else. No Postgres writes,
// no Excel I/O. Credentials are read from process.env only -- never
// printed, logged, or hardcoded here.

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile();
  } catch {
    // .env optional if the vars are already set in the environment
  }
}

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;

if (!login || !password) {
  throw new Error(
    "DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD must be set (see serp-interpreter/.env)",
  );
}

const row = {
  keyword: "cash for cars perth",
  targetUrl: "*cash-for-cars-perth.*",
  locationName: "Australia",
  seDomain: "google.com.au",
  languageName: "English",
};

const requestPayload = buildDataForSeoRequest(row);
const requestBody = [requestPayload]; // DataForSEO Live: array of tasks, one task per call

console.log("--- Request ---");
console.log(
  "POST https://api.dataforseo.com/v3/serp/google/organic/live/regular",
);
console.log(JSON.stringify(requestBody, null, 2));

const authHeader =
  "Basic " + Buffer.from(`${login}:${password}`).toString("base64");

const response = await fetch(
  "https://api.dataforseo.com/v3/serp/google/organic/live/regular",
  {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  },
);

const responseBody = await response.json();

console.log("\n--- Response ---");
console.log(`HTTP ${response.status}`);
console.log(JSON.stringify(responseBody, null, 2));
