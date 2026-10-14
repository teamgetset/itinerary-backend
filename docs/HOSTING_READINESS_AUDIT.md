# Hosting readiness audit: Vercel + Render + MongoDB Atlas + Cloudinary

Audit date: 2026-10-13. Scope: the three repositories (`getset-itinerary-backend`, `getset-itinerary-frontend`,
`getset-itinerary-admin`) for this hosting setup:

- **Vercel:** the website and the admin (two projects).
- **Render:** the API, as a Docker service.
- **MongoDB Atlas:** the database.
- **Cloudinary:** images (public) and itinerary PDFs (private).

Nothing was committed, pushed, deployed or deleted, and Atlas and Cloudinary were not modified. Production-mode tests ran
against a throwaway local copy of the database. No secret appears in this document. This audit builds on, and does not
repeat, [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md) (procedures: least-privilege user, backups, rollback, smoke
tests) and [MONGODB_CLOUDINARY_MIGRATION_PLAN.md](MONGODB_CLOUDINARY_MIGRATION_PLAN.md) (what was migrated and verified).

> **Update 2026-10-14: itinerary PDFs are uploaded, not generated.** An admin uploads one prepared PDF per package
> (PDF only, up to 4 MB, required to publish). The API stores it privately on Cloudinary under `CLOUDINARY_FOLDER`
> (`getset/production` in production) and streams it to customers. Chromium, Playwright and the `PDF_BROWSER_*` settings
> are gone: the image is 385 MB instead of 1.39 GB and peaked at 126 MB in a test with a 4 MB upload, so **Render
> Starter (512 MB, $7) is now the recommended instance**. The rows below are updated; the generated PDFs and their
> records in the staging database stay untouched until they are retired after production verification.

## Verdict: READY AFTER FIXES

The code, data, images, PDFs, Docker image and both web apps work in production mode. **Before you deploy:**

1. **Two small code fixes (Blocked, below):**
   - the admin must not fall back silently to localhost (F1);
   - the API's per-address rate limits can be bypassed behind Render (F2).

   **Update 2026-10-13:** both are fixed in code and tested, together with F3 (per-person admin sign-in limits, new
   secret `ADMIN_PROXY_SECRET`) (section 1). Their behaviour on Render itself is confirmed by two requests after
   deploying (section 7).
2. **Your manual prerequisites:** review, commit and push (M1), and three decisions (M2): the production database, the
   Cloudinary folder and the domains.

Everything else is either a dashboard action during deployment (Pending) or an improvement (Recommended).

Labels:
- **Verified**: tested or confirmed here (code, a local run, or the real Atlas/Cloudinary read-only), or read on the
  provider's official page on 2026-10-13 (URL given).
- **Pending**: needs a dashboard action or a test on the deployed service.
- **Blocked**: must be fixed before deployment.
- **Recommended**: an improvement, not an immediate blocker.

---

## 1. Blocked: must be fixed or done before deploying

| # | Item | Evidence | Fix |
| --- | --- | --- | --- |
| F1 (**fixed 2026-10-13**) | **The admin silently falls back to localhost.** `API_URL` defaults to `http://localhost:4000` and `SITE_URL` to `http://localhost:3000` (`src/lib/api.ts`; repeated inline in `src/app/(admin)/currencies/page.tsx`). The admin has no build check, so a Vercel deploy without these variables builds fine, then cannot sign in, and "View on site" links point to localhost. | Verified (code) | A build-time check in the admin's `next.config.ts` like the website's: on Vercel, require `API_URL` and `SITE_URL` to be `https://` origins. The currencies page should use the shared `API_URL`. About 10 lines. |
| F2 (**fixed 2026-10-13**; confirm after deploy) | **Per-address rate limits can be bypassed on Render.** With `TRUST_PROXY=true` the API uses the left-most `X-Forwarded-For` entry. Render's edge (Cloudflare) *appends* to that header, so the left-most entry is whatever the caller sent. This affects the enquiry form (5 per 10 minutes per address) and the 20-per-address sign-in limit. The 5-per-email sign-in limit is not affected. | Verified locally: the 6th attempt was blocked; changing the header got through. Verified (Render): [render.com/articles/host-pocketbase-on-render](https://render.com/articles/host-pocketbase-on-render): "Cloudflare appends to X-Forwarded-For … a caller who sends their own copy of the header controls the leftmost entry", and "CF-Connecting-IP … overwrites whatever the caller sent". | When `TRUST_PROXY` is on, read `CF-Connecting-IP` first (`src/lib/http.ts`, one line). Consequence: admin sign-ins are then counted by Vercel's address instead of the visitor's. That is acceptable: the per-email limit still protects each account. After deploying, confirm with the test in section 7. |
| F3 (**fixed 2026-10-13**; confirm after deploy) | **Admin sign-ins shared one per-address limit.** On Render every admin sign-in arrives from Vercel's address, so 20 failed attempts by anyone on the admin's sign-in page would lock out all admins for 15 minutes. | Verified locally (8 API tests, 5 admin tests) | The admin's server passes on the visitor's address (Vercel overwrites `x-real-ip`, so it cannot be forged) together with the shared secret `ADMIN_PROXY_SECRET`. The API uses that address only when the secret matches (constant-time) and the address is valid; otherwise it falls back to `CF-Connecting-IP`. The per-email limit and the enquiry limits are unchanged. |
| M1 | **Uncommitted work.** Backend: 71 entries (47 modified, 7 moved to `src/legacy-postgres/`, the rest new, including `Dockerfile`). Website: `next.config.ts`, `VERCEL_DEPLOYMENT.md`, and your own `src/app/account/page.tsx`. Render and Vercel deploy from GitHub. | Verified (git) | You review, commit and push. Leave out the stray `.DS_Store` in the backend: it is not git-ignored. No secrets are in the files to be committed (Verified: scan of the files a commit would include; `.env*`, `storage/`, `.data/` and build outputs are git-ignored). |
| M2 | **Decisions:** the production database (section 4.1), the Cloudinary production folder (4.3) and the domains. | – | Yours (section 6). |

## 2. Render (API, Docker service)

| Item | Status | Evidence / note |
| --- | --- | --- |
| `Dockerfile` builds: Node 22, runs as `node`, no `.env`/data/sources in the image; no Chromium since 2026-10-14 (385 MB) | Verified | Built and run on 2026-10-14 against a throwaway MongoDB replica set |
| Itinerary PDF upload and download in the image | Verified | 2026-10-14: a 4 MB upload, a byte-identical admin preview, and a removal that deleted the file (local storage in the container) |
| Start command | Verified | The image's `CMD ["node","dist/server.js"]`; Render needs no start command for Docker services |
| Port | Verified | The API listens on `PORT`, on all interfaces (reached through Docker port mapping). Render sets `PORT=10000` and deploys fail if no bound port is found ([docs/web-services](https://render.com/docs/web-services)). Do not set `PORT` yourself. |
| Health check `/health` | Verified | 200 in production mode; it pings the database. Render needs a 2xx within 5 s and cancels a deploy whose instance is not healthy within 15 minutes ([docs/health-checks](https://render.com/docs/health-checks)) |
| Shutdown on deploy | Verified | On `SIGTERM` the API closes the server and the database connection and exits (logged `server.stopping` in production mode). Render sends `SIGTERM` 60 s after the new instance is live, then `SIGKILL` after 30 s ([docs/deploys](https://render.com/docs/deploys)). |
| API routes | Verified | Public routes answer; admin routes return 401 without a valid session (also with a fake token); unknown paths return a JSON 404 (production mode, 2026-10-13) |
| CORS | Verified | Only the exact `FRONTEND_URL` and `ADMIN_URL` origins are echoed. Refused: apex vs `www`, a trailing slash, `http://`, Vercel preview addresses and foreign origins (production mode, 2026-10-13). Set the origins exactly, with no trailing slash. |
| HTTPS | Verified | Render terminates TLS and redirects HTTP to HTTPS; certificates are automatic for custom domains ([docs/web-services](https://render.com/docs/web-services), [docs/custom-domains](https://render.com/docs/custom-domains)). The API sends HSTS, `nosniff`, `X-Frame-Options`, `Referrer-Policy` and CORP headers; PDF links use the `https://` `API_URL`, and no `http://` address appears in responses. |
| `TRUST_PROXY=cloudflare` | Pending | **Required on Render.** Without it, every visitor appears as Render's proxy, and the whole site shares one budget: 5 enquiries per 10 minutes and 20 sign-in attempts per 15 minutes (Verified in code). Since the F2 fix, `cloudflare` reads only `CF-Connecting-IP`; the old value `true` stops the API at start-up. |
| Rate limits | Verified (locally) / Blocked (F2 on Render) | Sign-in: 5 per email and 20 per address per 15 min, then 429. Enquiries: 5 per address per 10 min, plus a hidden bot trap. Counters live in the process: **run one instance**. |
| Atlas from Render | Pending | Verified from the same image on this Mac against Atlas. On Render it needs Atlas Network Access (section 4.2). |
| Cloudinary from Render | Pending | Verified from the same image on this Mac. Outbound HTTPS only, no allow-list needed. |
| Memory and instance type | Verified (measured) | Without Chromium: about 46 MB idle and a 126 MB peak during a 4 MB PDF upload (2026-10-14; it was 477 MB while printing PDFs). Render plans ([docs/compute-plans](https://render.com/docs/compute-plans), [pricing](https://render.com/pricing)): Free 0.1 CPU / 512 MB (sleeps after 15 min idle, about 1 min to wake); **Starter 0.5 CPU / 512 MB $7 (recommended)**; Standard 1 CPU / 2 GB $25. Free is unsuitable: it sleeps, which breaks website builds and revalidation. |
| Region | Verified / Recommended | The Atlas cluster is AWS `ap-south-1` (Mumbai) (read from the cluster's tags, 2026-10-13). Render has no India region; the closest is **Singapore** (regions: Oregon, Ohio, Virginia, Frankfurt, Singapore; the region cannot be changed later; [docs/regions](https://render.com/docs/regions)). |
| Storage provider | Verified / Recommended | Must be `STORAGE_PROVIDER=cloudinary`. The default is `local`, which on Render would write new uploads and PDFs to a disk that disappears on every deploy. Existing records still read from Cloudinary either way. Recommended: make the API refuse `local` in production (a 3-line check). |
| Zombie processes | No longer applies | Chromium was the only source of helper processes; the image no longer starts it. |
| Dependency vulnerabilities | Verified | `npm audit` (production dependencies): 0 in all three repositories (2026-10-13) |

## 3. Vercel (website and admin)

Both are standalone Next.js 16.3.8 repositories with the app at the repository root and `package-lock.json`. They can be
deployed independently: two projects, root directory `.`, framework Next.js, default build (`next build`) and output.
No `vercel.json` is needed. Both production builds pass (Verified, Stage F).

| Item | Status | Evidence / note |
| --- | --- | --- |
| Website: no silent localhost fallback | Verified | The code falls back to `http://localhost:4000`, but `next.config.ts` stops any Vercel build whose `NEXT_PUBLIC_API_URL` is not an `https://` origin. A production build without `REVALIDATE_SECRET` also fails. |
| Website: site address fallback | Recommended | `NEXT_PUBLIC_SITE_URL` silently falls back to `https://teamgetset.com` (canonical URLs, sitemap). Set it explicitly; optionally add it to the build check. |
| Admin: no silent localhost fallback | Verified (fixed, F1) | Production builds and `next start` stop with a clear error when `API_URL` or `SITE_URL` is missing or malformed, and on Vercel unless both are public `https://` (tested with real builds); `next dev` alone keeps the localhost defaults |
| Browser calls to the API (website paging, search, wishlist, enquiries) | Verified (local) / Pending | They need CORS: `FRONTEND_URL` must equal the site's address exactly. Vercel preview deployments are refused by design (server-rendered pages still work). |
| Admin calls to the API | Verified | Server to server only: no `NEXT_PUBLIC_*` variable, no browser calls, so CORS does not matter for the admin |
| Admin sign-in and sessions | Verified | Session token in an `httpOnly`, `SameSite=Lax` cookie, `Secure` in production; a redirect to sign-in when it is missing; the API checks every call. Sign-in, sign-out and expiry were tested in Stage F. The admin is `noindex`. |
| Images (`next.config.ts`) | Verified | Allows only `https://res.cloudinary.com/<cloud>/image/upload/**` without query strings (plus the API's `/media/**`). Stage F: 551 images loaded, none broken; other accounts, PDFs and query strings refused. |
| Website build needs the API | Verified / Pending | The build renders every page from the API (Stage F build), so the API must be up. Another reason not to use Render's sleeping Free plan. |
| Revalidation (API → website) | Verified (code, local) / Pending | The website endpoint compares the secret in constant time and accepts only known tags; tested end to end locally in Stage F |
| Node.js version | Recommended | Neither app pins one. Vercel uses its default LTS (24.x) unless set ([docs](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions)). Local builds used Node 20; the API image uses 22. Set **22.x** in both projects (Project Settings → Build) or add `"engines": {"node": "22.x"}`. |
| Function region | Recommended | Vercel defaults to Washington D.C. (`iad1`) ([docs](https://vercel.com/docs/functions/configuring-functions/region)). Set **`sin1` (Singapore)** next to the Render API (Mumbai `bom1` also exists) in both projects. |
| Admin uploads over 4.5 MB | Recommended | Vercel limits function request bodies, including Server Actions, to 4.5 MB ([docs/functions/limitations](https://vercel.com/docs/functions/limitations)). The admin allows 12 MB and the API 10 MB, so larger photos fail with 413 on Vercel. Resize before uploading, or lower the admin limit so the message is clear. |
| Plan | Verified | Hobby is "restricted to non-commercial personal use only" ([fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)): a business site needs **Pro**. |
| Preview deployments | Verified (docs) | Protected by default (Standard Protection) and served with `noindex` ([docs](https://vercel.com/docs/deployment-protection)) |
| Customer sign-in on the website | Recommended | `/account` is a placeholder that always answers "unavailable" (by design). Decide whether to show it at launch. |
| Website `.env.example` | Recommended | Still says photos load from the API; a one-line documentation fix |

## 4. Database and storage

### 4.1 Should `getset` be production?

**Recommendation: keep `getset` as staging; create a production database on Atlas Flex.**

`getset` works (Verified: indexes, references, all images and PDFs). It is still a poor production home:

- It was agreed as staging (decision 5).
- It is on **M0 Free**, where "You can't enable backups" (also: 0.5 GB storage, 100 operations/second, 500 connections;
  [M0 limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/)).
- It holds test leftovers.
- Your local `.env` holds a project-wide administrator credential for it.

**Flex** costs $8–30 a month and takes daily snapshots, keeping the last 8
([pricing](https://www.mongodb.com/pricing), [Flex backups](https://www.mongodb.com/docs/atlas/backup/cloud-backup/flex-cluster-backup/)).
Whether those snapshots cost extra is not stated. Choose AWS **Singapore** for it, next to Render. Fill it with a copy of
`getset`: `mongodump`/`mongorestore` are verified (checklist section 8), cleaning the copy's test leftovers first
(checklist section 11).

### 4.2 Atlas access

| Item | Status | Note |
| --- | --- | --- |
| Application user | Verified / Recommended | Today the app connects as `atlasAdmin`, which reads, writes and drops every database in the project (your accepted risk; not production-secure). The least-privilege role `getsetAppReadWrite` (readWrite on `getset` only) exists. For production, create a user with readWrite on the production database only, restricted to that cluster: Atlas supports "Restrict Access to Specific Clusters" and per-database privileges ([docs](https://www.mongodb.com/docs/atlas/security-add-mongodb-users/)). Steps: checklist section 5. |
| Does the `getset_app` user exist? | Pending | Atlas refuses to list users from code; check Database Access |
| Network access | Pending / Recommended | Allow Render's outbound ranges for Singapore (service page → Connect → Outbound). They are shared per region and have been rotated once (Oct–Dec 2025; [changelog](https://render.com/changelog/upcoming-changes-to-outbound-ip-addresses)): follow Render's changelog. Dedicated IPs need a Pro workspace plus $100/month ([docs](https://render.com/docs/dedicated-ips)), which is not worth it here. Avoid `0.0.0.0/0`. |

### 4.3 Cloudinary

| Item | Status | Note |
| --- | --- | --- |
| Folder separation | Verified / Pending | The folder comes only from `CLOUDINARY_FOLDER`; nothing is hard-coded (Verified, grep). Set `getset/production` for production uploads. Records copied from `getset` keep their `getset/staging/...` addresses, so **never empty `getset/staging`** while production uses them. |
| One account for staging and production | Verified (docs) / Recommended | The Free plan supports only one product environment ([docs](https://cloudinary.com/documentation/solution_overview)), so separation is by folder. Create a separate **API key** for production (Settings → API Keys), so each can be rotated on its own. |
| PDFs private | Verified (code, tests) / Pending (live) | Uploaded PDFs are stored `raw/authenticated` with the storage code verified against real Cloudinary in Stage E (unsigned URLs refused); the API alone fetches them with a short-lived signed link and streams them; no Cloudinary URL appears in API responses (tests). Deleting a replaced or removed file (`raw`/`authenticated` destroy) is new and was only tested against a fake: confirm it once after deploying (section 7). Keep "Allow delivery of PDF and ZIP files" **off**: it is off by default on Free accounts ([docs](https://cloudinary.com/documentation/ts_how_to_upload_manage_and_deliver_pdf_files)), and the API's private download does not need it. |
| Backups | Recommended | "Backup is available on all plans", "Automatic backup is off by default", and without it deleted assets cannot be recovered ([docs](https://cloudinary.com/documentation/backups_and_version_management)). Turn it on: it counts toward storage, which is tiny here. |

### 4.4 Will anything be lost during deployment?

**No (Verified).**

- Deploying reads the database and Cloudinary; it never rewrites them.
- The API uses no Render disk (with `STORAGE_PROVIDER=cloudinary`).
- Every backup verifies, and both database restore methods work (checklist section 8).
- The local originals (`storage/`, `.data/postgres`) are intact.

The only expected writes:

- None for PDFs: they are no longer generated. Existing packages start without an uploaded PDF and show "not available
  yet" until one is uploaded.
- Normal admin activity.

## 5. Environment variables by application

Shapes of the local values were checked without printing them; production values do not exist yet.

### 5.1 API (Render)

| Variable | Secret? | Value / where to get it |
| --- | --- | --- |
| `MONGODB_URI` | **Secret** | Atlas → your production cluster → Connect → Drivers. Use the least-privilege user; its password is set when you create it (Database Access). URL-encode special characters. |
| `MONGODB_DB_NAME` | No | The production database name you choose (4.1) |
| `API_URL` | No | `https://` + the Render service address (on the service page, `https://<name>.onrender.com`) or your API domain |
| `FRONTEND_URL` | No | The website's production address in Vercel (Project → Domains), exact origin, no trailing slash |
| `ADMIN_URL` | No | The admin's production address in Vercel, exact origin, no trailing slash |
| `AUTH_SECRET` | **Secret** | Generate: `openssl rand -base64 48` (at least 32 characters). New for production. |
| `REVALIDATE_SECRET` | **Secret** | Generate: `openssl rand -base64 36` (at least 24). The same value goes into the website project. |
| `ADMIN_PROXY_SECRET` | **Secret** | Generate: `openssl rand -base64 48` (at least 32). The same value goes into the **admin** project. Without it the API still runs, warns at start-up, and admin sign-ins share one limit (F3). |
| `TRUST_PROXY` | No | `cloudflare` (only on Render; `true` is refused) |
| `STORAGE_PROVIDER` | No | `cloudinary` |
| `CLOUDINARY_CLOUD_NAME` | No (public) | Cloudinary console → Settings → API Keys (also in every image URL) |
| `CLOUDINARY_API_KEY` | **Secret** (treat as) | Cloudinary console → Settings → API Keys: a new key for production |
| `CLOUDINARY_API_SECRET` | **Secret** | Same page; reveal the production key's secret |
| `CLOUDINARY_FOLDER` | No | Your choice, for example `getset/production` |
| `SESSION_TTL_HOURS`, `DEFAULT_CURRENCY`, `SUPPORTED_CURRENCIES`, `LOG_LEVEL` | No | Optional: defaults are 12, `INR`, `INR,AED` and `info` |
| `WHATSAPP_NUMBER` | No (public) | Optional: the business number (international format, digits only) |
| Set for you | – | `PORT` (Render) and `NODE_ENV=production` (the image) |
| Do not set | – | `DATABASE_URL`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `STORAGE_LOCAL_DIR`; `PDF_BROWSER_*` no longer exist (ignored if present) |

### 5.2 Website (Vercel)

| Variable | Secret? | Environments | Value / where to get it |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | No: it is built into the browser code | Production and Preview (preview builds fail without it) | The API's `https://` origin |
| `NEXT_PUBLIC_SITE_URL` | No | Production (Preview optional) | The website's production address |
| `REVALIDATE_SECRET` | **Secret** | Production | The same value as the API's |
| `GETSET_API_URL` | No | Optional | A private address for server-side reads; defaults to `NEXT_PUBLIC_API_URL` |

### 5.3 Admin (Vercel)

| Variable | Secret? | Value / where to get it |
| --- | --- | --- |
| `API_URL` | No (server-only) | The API's public `https://` origin, no path. **Required on Vercel for Production and Preview**: the build stops if it is missing, not `https://`, or a local address. |
| `SITE_URL` | No | The website's public `https://` origin ("View on site" links). **Required on Vercel for Production and Preview**, with the same checks as `API_URL`. |
| `ADMIN_PROXY_SECRET` | **Secret** (server-only, never `NEXT_PUBLIC_`) | Must match the `ADMIN_PROXY_SECRET` on the Render service. **Required on Vercel for Production and Preview**: the build stops if it is missing or under 32 characters. |

`NEXT_PUBLIC_*` values are baked in at build time: after changing one, redeploy the website.

## 6. Deployment order

1. **Fixes and code.** Approve F1 and F2 (and any Recommended items you want). After they are applied and tested,
   review, commit and push both repositories (M1).
2. **Decide the names.**
   - The Render service name gives `https://<name>.onrender.com`.
   - The two Vercel project names give `https://<project>.vercel.app`.
   - Your custom domains, if any.

   Write down the expected URLs; they are needed before the services exist.
3. **Generate the production secrets** (`AUTH_SECRET`, `REVALIDATE_SECRET`, `ADMIN_PROXY_SECRET`) and store them in
   your password manager.
4. **Atlas.**
   - Create the Flex cluster (AWS Singapore).
   - Copy `getset` into it with dump and restore under the production name, removing the test leftovers in the copy.
   - Run `db:indexes`, then `db:verify`.
   - Create the least-privilege user.
   - Network access comes in step 6.
5. **Cloudinary.**
   - Create a production API key.
   - Turn on automatic backup.
   - Leave PDF delivery off.

   The `getset/production` folder is created by the first upload.
6. **Render.**
   1. Create a Hobby workspace, then New → Web Service from `itinerary-backend` → Docker.
   2. Region **Singapore**, instance **Starter**, health check path `/health`, one instance.
   3. Add the variables in 5.1. Use the URLs from step 2 for `API_URL`, `FRONTEND_URL` and `ADMIN_URL`.
   4. Copy the service's outbound ranges into Atlas Network Access.
   5. Deploy, or redeploy if the first attempt could not reach Atlas, until `/health` answers 200.
7. **Vercel admin.**
   1. Pro team → new project from `itinerary-admin`.
   2. Node 22.x, function region `sin1`.
   3. Add the variables in 5.3 for **Production and Preview**, then deploy.
   4. Sign in.
8. **Vercel website.**
   1. New project from `itinerary-frontend`.
   2. Node 22.x, function region `sin1`.
   3. Add the variables in 5.2.
   4. With the API awake, deploy.
9. **Correct the addresses.** If the real Vercel addresses differ from step 2, update `FRONTEND_URL` and `ADMIN_URL` on
   Render and redeploy the API.
10. **Custom domains (before announcing the site).**
    1. Add the domains in Vercel and Render, create the DNS records, and wait for the certificates (automatic).
    2. Update all address variables:
       - Render: `API_URL`, `FRONTEND_URL`, `ADMIN_URL`;
       - website: `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_SITE_URL`;
       - admin: `API_URL`, `SITE_URL`.
    3. Redeploy all three; the website must rebuild.

    Settle the final domain early: it appears in links, the sitemap and canonical URLs.
11. **Smoke and security tests** (checklist section 7, plus section 7 below).
12. **Backups.** Take a `mongodump` of production, confirm Flex's daily snapshots and Cloudinary's backup. Then retire the
    `atlasAdmin` credential from application use and change its password (checklist section 5).

## 7. Tests on the deployed services (Pending)

- Everything in checklist section 7: health, packages, Cloudinary photo URLs, itinerary PDF upload and download, 401 without a session,
  CORS for the website's origin, website pages and currency switch, admin sign-in and sign-out, revalidation.
- **Client address (F2).** The API now counts `CF-Connecting-IP` (set by Render's Cloudflare edge) when
  `TRUST_PROXY=cloudflare`, and never `X-Forwarded-For`. Locally the tests prove the header logic; only the deployed
  service can prove that Render's edge overwrites a forged header. Check once after deploying:
  1. Find your own public address: `curl -s https://api.ipify.org`.
  2. Send one failed sign-in with forged headers and a made-up email:
     ```sh
     curl -s -X POST https://<api>/api/auth/login -H 'content-type: application/json' \
       -H 'CF-Connecting-IP: 203.0.113.7' -H 'X-Forwarded-For: 203.0.113.8' \
       -d '{"email":"nobody@example.invalid","password":"x"}'
     ```
  3. In Render → Logs, the `auth.login_failed` line must show **your address from step 1**:
     - `203.0.113.7` would mean the edge passed the forged header through: set `TRUST_PROXY=false` at once and report it;
     - `203.0.113.8` is impossible with this code;
     - an address of Render's own (the same one for every visitor) means `TRUST_PROXY` is not `cloudflare`.
- **Admin sign-in address (F3).** Sign in to the deployed admin once with a wrong password (your own email is fine:
  one attempt does not lock it). In Render → Logs, that `auth.login_failed` line must show **your own address**
  (`curl -s https://api.ipify.org`), not a Vercel address.
  - A Vercel address, or an `http.forwarded_ip_rejected` line with `wrong_secret` or `secret_not_configured`, means
    `ADMIN_PROXY_SECRET` differs between, or is missing in, the admin project and the Render service.
  - A forged request straight to the API (`-H 'x-getset-client-ip: 203.0.113.9' -H 'x-getset-proxy-secret: wrong'`)
    must log `http.forwarded_ip_rejected` and count your own address.
- **Itinerary PDFs (live Cloudinary):** upload a PDF to one package, replace it, then (on a draft) remove it. In the
  Cloudinary console under `getset/production/documents/itineraries/`, only the current file remains, and the API logs
  show no `pdf.file_delete_failed`. The website's download button downloads `getset-<slug>-itinerary.pdf`.
- **Memory:** watch the instance's memory graph during the first PDF upload; the expected peak is about 130 MB.

## 8. Hosting costs

**Verified prices** (official pricing pages read 2026-10-13; USD per month, before tax):

| Service | Plan | Price | Source |
| --- | --- | --- | --- |
| Render | Hobby workspace | $0 + compute; 5 GB bandwidth, then $0.15/GB; 500 build minutes; 2 custom domains | [render.com/pricing](https://render.com/pricing) |
| Render | Starter instance (0.5 CPU, 512 MB) | $7 | same |
| Render | **Standard instance (1 CPU, 2 GB)** | **$25** | same |
| Vercel | **Pro** (required for business use) | **$20** per team: 1 deploying seat, $20 usage credit, 1 TB transfer, 1M CDN requests; extra seats $20 each | [vercel.com/docs/plans/pro-plan](https://vercel.com/docs/plans/pro-plan) |
| Vercel | Image optimization (Pro, from the usage credit) | $0.05–0.0812 per 1,000 transformations; cache reads $0.40–0.64 per million; cache writes $4.00–6.40 per million | [image-optimization pricing](https://vercel.com/docs/image-optimization/limits-and-pricing) |
| Atlas | M0 Free | $0, no backups | [pricing](https://www.mongodb.com/pricing) |
| Atlas | **Flex** | **$8–30** (5 GB, daily snapshots) | same |
| Atlas | M10 dedicated | from about $57 (us-east-1; Mumbai/Singapore prices only in the calculator) | same |
| Cloudinary | Free | $0; 25 credits (1 credit = 1 GB storage, 1 GB bandwidth or 1,000 transformations) | [cloudinary.com/pricing](https://cloudinary.com/pricing) |
| Cloudinary | Plus (multiple environments) | $99, or $89 billed yearly | same |

**Estimated monthly total** (my estimate from the prices above; usage is assumed low: a small catalogue, about 48 MB of
media today: 53 images, 24 MB, and 34 PDFs, 25 MB; Verified):

| Setup | Render | Vercel | Atlas | Cloudinary | Total |
| --- | --- | --- | --- | --- | --- |
| **Recommended** | Starter $7 | Pro $20 | Flex $8–30 | Free $0 | **about $35–57** |
| Lowest workable (accepting no database backups) | Starter $7 | Pro $20 | M0 $0 | Free $0 | about $27 |
| Higher assurance | Standard $25 (more CPU) | Pro $20 | M10 about $57+ | Free $0 | about $102+ |

**Estimates and assumptions:**

- Both Vercel projects fit in one Pro team, with one seat.
- Image optimization stays within the $20 credit: about 53 photos × a few sizes × 2 formats is roughly a thousand
  transformations to start.
- API bandwidth stays under 5 GB: an itinerary PDF is at most 4 MB.
- Cloudinary stays within 25 credits.
- Domain registration is not included.

Watch the dashboards in the first month to confirm.

## 9. Recommended (not blocking)

1. Make the API refuse `STORAGE_PROVIDER=local` in production (2).
2. Add `tini` as the image's init process (2).
3. Pin Node 22.x and set the function region to `sin1` in both Vercel projects (3).
4. Require `NEXT_PUBLIC_SITE_URL` in Vercel production builds (3).
5. Make the 4.5 MB upload limit clear in the admin (3).
6. Least-privilege database user and a Flex production database (4).
7. A Cloudinary production API key and automatic backup (4.3).
8. Allow-list Render's ranges in Atlas, not `0.0.0.0/0`, and follow Render's changelog (4.2).
9. Let the API finish in-flight requests on shutdown (minor; Render waits 60 s before `SIGTERM` anyway).
10. Fix the website `.env.example` wording; decide on `/account`.
11. After sign-off, the cleanup phase: legacy PostgreSQL code and the Stage F test leftovers (checklist section 11).

## 10. Next steps for you

1. Reply with approval for fixes **F1** and **F2**, plus any Recommended items, for me to make and test (no commit).
2. Decide: the production database (Flex in Singapore recommended), the Cloudinary production folder, the domains, and
   the Render instance (Starter recommended).
3. Review and commit/push the backend and website changes yourself (M1).
4. Follow section 6 step by step, with checklist sections 5, 7 and 8 for the detailed procedures.
