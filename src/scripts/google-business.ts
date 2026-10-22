/**
 * Google Business Profile setup for the website's Google reviews. Run once, on your own computer, signed in as an
 * owner or manager of the Business Profile (README, "Google reviews"):
 *   npm run google:business -- authorize   signs in with Google; prints the refresh token for GOOGLE_OAUTH_REFRESH_TOKEN
 *   npm run google:business -- locations   lists your profiles as accounts/<id>/locations/<id> for GOOGLE_BUSINESS_LOCATIONS
 * Reads GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (a "Desktop app" OAuth client of the Google Cloud
 * project approved for the Business Profile APIs), and for "locations" the refresh token, from the environment or .env.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

if (existsSync(".env")) process.loadEnvFile(".env");
const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/business.manage";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) fail(`${new URL(url).host} answered ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

const form = (fields: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields),
});

if (!clientId || !clientSecret) fail("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET first (a Desktop app OAuth client).");
const command = process.argv[2];

if (command === "authorize") {
  // Google's loopback flow: the browser comes back to this computer with a one-time code.
  const state = randomBytes(16).toString("hex");
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") return void res.writeHead(404).end();
    const code = url.searchParams.get("code");
    if (url.searchParams.get("state") !== state || !code) {
      res.writeHead(400).end("Sign-in did not complete. Run the command again.");
      fail(`Sign-in did not complete${url.searchParams.get("error") ? `: ${url.searchParams.get("error")}` : ""}.`);
    }
    const redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`;
    const tokens = await json(TOKEN_URL, form({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }));
    res.end("Signed in. You can close this tab and go back to the terminal.");
    server.close();
    if (!tokens.refresh_token) fail("Google sent no refresh token. Remove the app's access at https://myaccount.google.com/permissions and run this again.");
    console.log(`\nSet this as GOOGLE_OAUTH_REFRESH_TOKEN in the API's environment (Render). It is a secret: keep it out of code and chats.\n\n${tokens.refresh_token}\n`);
  });
  server.listen(0, "127.0.0.1", () => {
    const consent = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    consent.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: `http://127.0.0.1:${(server.address() as AddressInfo).port}/callback`,
      response_type: "code",
      scope: SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
    }).toString();
    console.log(`Open this link and sign in with the Google account that owns or manages the Business Profile:\n\n${consent}\n`);
  });
} else if (command === "locations") {
  if (!refreshToken) fail("Set GOOGLE_OAUTH_REFRESH_TOKEN first: npm run google:business -- authorize");
  const { access_token: accessToken } = await json(TOKEN_URL, form({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }));
  const headers = { authorization: `Bearer ${accessToken}` };
  const { accounts = [] } = await json("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", { headers });
  for (const account of accounts as { name: string; accountName?: string }[]) {
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ readMask: "name,title,storefrontAddress", pageSize: "100", ...(pageToken && { pageToken }) });
      const page = await json(`https://mybusinessbusinessinformation.googleapis.com/v1/${account.name}/locations?${query}`, { headers });
      for (const location of page.locations ?? []) {
        const address = [...(location.storefrontAddress?.addressLines ?? []), location.storefrontAddress?.locality].filter(Boolean).join(", ");
        console.log(`${account.name}/${location.name}   ${location.title}${address ? `, ${address}` : ""}`);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  console.log("\nPut the profiles to show in GOOGLE_BUSINESS_LOCATIONS, comma-separated.");
} else {
  fail("Usage: npm run google:business -- authorize | locations");
}
