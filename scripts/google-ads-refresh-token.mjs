// One-time sign-in for the Google Ads API (Baseline Report volumes, 2026-11-10).
//
//   node scripts/google-ads-refresh-token.mjs "C:\path\to\client_secret_....json"
//
// The JSON is the "Desktop app" OAuth client downloaded from Google Cloud (Google Auth Platform -> Clients).
// It opens Google's sign-in page; approve with the Google account that can open the Google Ads manager account
// (syspree.adwords@gmail.com). The refresh token is printed HERE, in your own terminal -- copy it into Railway as
// GOOGLE_ADS_REFRESH_TOKEN (with GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET from the same JSON).
// Nothing is saved to disk and nothing is sent anywhere except Google.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { randomBytes } from "node:crypto";

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/google-ads-refresh-token.mjs "<path to the downloaded client JSON>"');
  process.exit(1);
}
const json = JSON.parse(readFileSync(file, "utf8"));
const client = json.installed ?? json.web;
if (!client?.client_id || !client?.client_secret) {
  console.error("That JSON has no client_id/client_secret -- download the Desktop app client's JSON again.");
  process.exit(1);
}

const state = randomBytes(16).toString("hex");
const server = createServer();
server.listen(0, "127.0.0.1", () => {
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const url =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/adwords",
      access_type: "offline",
      prompt: "consent",
      state,
    });
  console.log("\nOpening Google sign-in in your browser. If it doesn't open, paste this link into the browser:\n\n" + url + "\n");
  exec(process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`);

  server.on("request", async (req, res) => {
    const params = new URL(req.url, redirectUri).searchParams;
    if (!params.has("code") && !params.has("error")) {
      res.end();
      return;
    }
    if (params.get("state") !== state || params.get("error")) {
      res.end("Sign-in was cancelled or failed. Close this tab and run the script again.");
      console.error("Sign-in failed:", params.get("error") ?? "state mismatch");
      server.close();
      return;
    }
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: params.get("code"),
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });
    const token = await tokenRes.json();
    if (!token.refresh_token) {
      res.end("Google didn't return a refresh token. Close this tab; see the terminal.");
      console.error("No refresh token in Google's answer:", token.error ?? "", token.error_description ?? "");
    } else {
      res.end("Done -- you can close this tab and go back to the terminal.");
      console.log("Put these three into Railway (serp-console-backend -> Variables):\n");
      console.log("GOOGLE_ADS_CLIENT_ID=" + client.client_id);
      console.log("GOOGLE_ADS_CLIENT_SECRET=" + client.client_secret);
      console.log("GOOGLE_ADS_REFRESH_TOKEN=" + token.refresh_token);
      console.log("\nAlso: GOOGLE_ADS_CUSTOMER_ID=4900299803 (the manager account; no dashes needed).");
      console.log("Treat these like passwords -- don't paste them into chats or files.\n");
    }
    server.close();
  });
});
