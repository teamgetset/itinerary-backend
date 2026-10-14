# Production environment and database deployment audit

**Result: `BLOCKED`.** The backend cannot be deployed to Render with the current code and `.env`.

> **Update after Stage B (2026-10-12). Still `BLOCKED`, and the database user is not production-secure.**
> - The API code now runs on MongoDB/Mongoose and no longer needs `DATABASE_URL` (verified: typecheck, 64 tests on
>   MongoDB 8.0, build, a rehearsed migration, and an old-vs-new API comparison). Sections 1–4 below describe the
>   code as audited before Stage B.
> - **Stage C (2026-10-12): the data is in Atlas `getset`**, verified field by field against PostgreSQL (191
>   documents; see the migration plan, section 14). Blocker 2 is resolved.
> - **Stage D (2026-10-12): images are on Cloudinary** (`getset/staging/images`, 52 verified), served by URL; new
>   uploads go to Cloudinary. **PDFs are still on local disk** (Stage E) and **still need Chrome on the host**:
>   blockers 3 (PDF part), 4, 6 and 7 remain. Render needs `STORAGE_PROVIDER=cloudinary` and
>   `CLOUDINARY_FOLDER=getset/staging` (plus the three `CLOUDINARY_*` credentials) for this database. The website needs
>   the Cloudinary host in `next.config.ts` (Stage F) before it can render the new image URLs.
> - **Stage E (2026-10-13): PDFs are private Cloudinary files** (`getset/staging/documents`, 32 files: the 8 originals
>   plus a deliberate regeneration, 16 versions, no duplicates), streamed by the API; nothing is stored on local disk.
>   A `Dockerfile` (Node 22 + Chromium + fonts) for a Render **Docker** service was built and run locally with
>   `NODE_ENV=production` against Atlas and Cloudinary: health, PDF render, private download and public download all
>   work. Blockers 3 and 4 are resolved in code. Still `BLOCKED` by 6 and 7 (production URLs, live API for the website
>   build), the website's Cloudinary host (Stage F), and Render/Atlas set-up (section 11). Not verified: memory use on a
>   small Render instance (Chromium); measure before choosing a 512 MB plan.
> - **Stage F (2026-10-13): the website allows the Cloudinary image host** (`next.config.ts`, this account's image
>   path only), and the website and admin were verified end to end against Atlas (desktop and phone; images, prices,
>   currency switching, itineraries, PDF downloads and previews, admin content/media/package workflows). The
>   frontend change is uncommitted. Still `BLOCKED` by 6 and 7 and the Render/Atlas set-up in section 11.
> - **Stage G (2026-10-13): final verification done; the step-by-step deployment, least-privilege user, backup,
>   rollback and smoke-test procedures are in [DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md)**, which supersedes
>   sections 10–11 below. Still `BLOCKED` until the decisions and set-up listed there are done.
> - **2026-10-13: `TRUST_PROXY` now takes `cloudflare` (on Render) or `false`, and `true` is refused at start-up**
>   (fix F2 in [HOSTING_READINESS_AUDIT.md](HOSTING_READINESS_AUDIT.md)). Wherever this report says
>   `TRUST_PROXY=true`, use `TRUST_PROXY=cloudflare`.
> - **Accepted risk:** by the owner's decision, the application uses `teamgetsetmedia_db_user` (`atlasAdmin@admin`)
>   for development and production. See section 5. This configuration is **not production-secure**; this report
>   does not and will not describe it as such.

Audit date: 2026-10-12. Read-only: no `.env`, source, credentials, data, platform settings or deployments were
changed. The only new file is this report. Planned hosting: frontend and admin on Vercel, backend on Render, database
on MongoDB Atlas, media on Cloudinary. No production domains have been chosen yet, so none are assumed here.

How each finding was established:
- **verified**: checked in code, by running something locally, or by a read-only query
- **platform**: from Render, Vercel or Atlas platform behaviour; confirm on the platform when you set it up

---

## 1. Database technology actually used by the backend

**PostgreSQL through Drizzle ORM, and nothing else** (verified).

| Check | Finding |
| --- | --- |
| Runtime dependencies | `drizzle-orm`, `pg`, `hono`, `@hono/node-server`, `playwright-core`, `zod`. **No `mongoose`, `mongodb` or `cloudinary`**, in `package.json` or in `node_modules` |
| Imports in `src/` (excluding tests) | `drizzle-orm` in 27 files, `pg` in 2, `embedded-postgres` in 2; `mongoose` / `mongodb` / `cloudinary` in **0** |
| Configuration read at start-up (`src/config/env.ts`) | requires `DATABASE_URL` (must match `postgres://`). It does **not** read `MONGODB_URI`, `MONGODB_DB_NAME` or any `CLOUDINARY_*` variable |
| Storage | `STORAGE_PROVIDER` accepts only `local` (`z.enum(["local"])`); files go to `./storage` on the server's disk |
| Scripts needing PostgreSQL | `db:dev`, `db:migrate`, `db:status`, `db:verify`, `db:seed`, `admin:create`, `admin:credentials`, and `npm test` (spins up an embedded PostgreSQL) |
| Running without PostgreSQL | The compiled API was started with `NODE_ENV=production` and no PostgreSQL. The process starts (the `.env` passes production validation), but `GET /health`, `/api/public/settings`, `/api/public/packages`, `/api/public/branches` and `POST /api/auth/login` all return **500** (logged cause: `Failed query`). This is exactly what Render would get |

## 2. Is the MongoDB migration complete?

**No. It has not started** (verified). Stage A (connectivity) is done; Stage B (implementation) has not begun.

- No Mongoose models, connection code or MongoDB queries exist.
- The Atlas database `getset` **does not exist yet**: 0 collections (read-only query). The cluster holds only
  `sample_mflix`, `admin` and `local`.
- **All content lives only in the local embedded PostgreSQL on this Mac** (`.data/postgres`): 12 packages, 2 branches,
  10 destinations, 10 testimonials, 6 hero slides, 10 content blocks, 1 admin account, 44 audit rows. None of it is
  in Atlas or anywhere reachable from Render.
- **No files are in Cloudinary.** The 52 images and 8 PDFs are in local `storage/`, which is git-ignored, so a Render
  build from GitHub will not contain them. Stage A's test assets were deleted.

## 3. Is the current `.env` suitable for deployment?

**No** (verified). It is a correct **local development** file, and it is safe: git-ignored, untracked, no exposed
values (section 8). But it cannot be copied to Render:

- `DATABASE_URL` points to `localhost:5433` (section 4).
- `API_URL`, `FRONTEND_URL` and `ADMIN_URL` are `http://localhost:3000/3001/4000`. CORS would reject the website's
  browser calls, and image and PDF links would point to localhost.
- `TRUST_PROXY=false` (section 7, blocker 6).
- `STORAGE_PROVIDER=local` means an ephemeral disk on Render (blocker 3).
- `PDF_BROWSER_CHANNEL=chrome`, and Render's native Node runtime has no Chrome (blocker 4).
- `MONGODB_URI` uses the broadly privileged Atlas user (section 5), and the code doesn't read it yet anyway.

### Variable-by-variable

"Render" means the target configuration for the **MongoDB/Cloudinary version** of the API, the only one planned for
deployment.

| Variable | Present | Code uses it | Local dev | Render | Status and action |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | yes (`development`) | yes | yes | **yes: `production`** | correct locally. On Render set `production` as a runtime variable (see the build note in section 7) |
| `PORT` | yes (`4000`) | yes | optional | **don't set** | Render injects `PORT`; the app already reads it |
| `LOG_LEVEL` | yes (`info`) | yes | optional | optional (`info`) | keep |
| `DATABASE_URL` | yes (local PostgreSQL) | **yes, required at start-up** | yes, until the migration is signed off | **no** (after migration) | keep locally for now; see section 4 |
| `API_URL` | yes (`http://localhost:4000`) | yes (builds the image and PDF URLs it returns) | yes | **yes: the Render HTTPS URL** | set on Render only; don't edit `.env` |
| `FRONTEND_URL` | yes (localhost:3000) | yes (CORS origin, preview links, revalidation target) | yes | **yes: the Vercel website URL** | set on Render only |
| `ADMIN_URL` | yes (localhost:3001) | yes (CORS origin) | yes | **yes: the Vercel admin URL** | set on Render only |
| `AUTH_SECRET` | yes, ≥ 32 characters, not the example | yes (signs preview links; production refuses the example value) | yes | **yes: a new random value** | generate a separate production value (`openssl rand -base64 48`); don't reuse the local one |
| `SESSION_TTL_HOURS` | yes (`12`) | yes | optional | optional | keep |
| `REVALIDATE_SECRET` | yes, ≥ 24 characters, not the example; equals the frontend's `.env.local` | yes | yes | **yes: a new value, identical in Render and the Vercel frontend** | generate a production value; set it in both places |
| `TRUST_PROXY` | yes (`false`) | yes (client IP for rate limits) | `false` | **yes: `true`** | Render only; see blocker 6 |
| `STORAGE_PROVIDER` | yes (`local`) | yes (only `local` exists today) | `local` | **`cloudinary`** (after Stage D) | Render only, once the provider is implemented |
| `STORAGE_LOCAL_DIR` | yes (`./storage`) | yes | yes | no | not needed on Render with Cloudinary |
| `PDF_BROWSER_CHANNEL` | yes (`chrome`) | yes | yes (Chrome is installed here) | **replace with `PDF_BROWSER_PATH`** | see blocker 4 |
| `PDF_BROWSER_PATH` | no | yes (wins over the channel) | no | **yes: the Chromium path in the Render image** | add on Render |
| `DEFAULT_CURRENCY` / `SUPPORTED_CURRENCIES` | yes (`INR` / `INR,AED`) | yes | optional | optional (same values) | keep |
| `WHATSAPP_NUMBER` | yes | yes | optional | optional | keep |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | yes | only by `npm run db:seed` (development; ignored when `NODE_ENV=production`) | optional | **never set** | keep locally only |
| `MONGODB_URI` | yes (Atlas, `mongodb+srv`) | **no, not read by the code yet** | yes (from Stage B) | **yes: the `getset_app` user** | change to `getset_app` (section 5); safe to do now |
| `MONGODB_DB_NAME` | yes (`getset`) | **no, not read yet** | yes (from Stage B) | yes | keep. `getset` is your dev/staging database; decide a production name before real production |
| `CLOUDINARY_CLOUD_NAME` / `_API_KEY` / `_API_SECRET` | yes, all non-empty | **no, not read yet** | yes (from Stage D) | yes | keep; set on Render as secret variables |
| `CLOUDINARY_FOLDER` | no | not yet (planned) | optional | yes (e.g. a staging folder name you choose) | add with Stage D |

Missing from `.env` but read by the code: only `PDF_BROWSER_PATH` (optional locally). `.env.example` is missing the
`MONGODB_*` and `CLOUDINARY_*` names (section 7).

## 4. `DATABASE_URL`: retain, change or remove?

| Question | Answer |
| --- | --- |
| Can Render reach `localhost:5433`? | **No.** On Render, `localhost` is the Render container itself, where no PostgreSQL runs. Every query fails (reproduced locally: all data routes return 500, and the health check fails, so a Render health check on `/health` would mark the deploy failed) |
| Does the app still depend on it? | **Yes.** `env.ts` requires it (start-up fails if it's missing or isn't a `postgres://` URL), `db/client.ts` builds the pool from it, and every module queries through it |
| Can it be removed now? | **No.** Removing it makes the API refuse to start, locally and on Render. It is also the source for the read-only data migration (Stage C) |
| Must it remain until the migration is complete? | **Yes, locally.** Keep it in your local `.env` until Stages B–G are done and you approve the cleanup (decision 7 keeps PostgreSQL for rollback) |
| Replace it with the MongoDB URI? | **No.** Different protocol, driver and code; `env.ts` rejects a non-`postgres://` value |
| Correct production configuration after a verified migration | Render has **no `DATABASE_URL` at all**. It has `MONGODB_URI` (the `getset_app` user) plus `MONGODB_DB_NAME`. In the cleanup phase, after your sign-off, `DATABASE_URL` comes out of `env.ts`, `.env` and `.env.example`, together with Drizzle, `pg` and `embedded-postgres`. Before recommending removal I will re-check that no route, script, test or build step reads it (the same grep and run as in this audit) |
| Deploy *before* the migration instead? | Only by deliberately provisioning a hosted PostgreSQL (e.g. Render PostgreSQL), copying the local data into it, and later migrating again to MongoDB. That doubles the work and contradicts the approved plan, so it is not recommended |

## 5. Is the current `MONGODB_URI` appropriate for production?

**No. The owner has accepted the risk and will use it anyway (decision of 2026-10-12). It is not production-secure.**
(Verified read-only on 2026-10-12; nothing written; no credential printed.)

| Check | Finding |
| --- | --- |
| Target | the Atlas cluster of the new GETSET Itinerary project (3-member replica set, MongoDB 8.0.34, transactions available); database `getset` matches `MONGODB_DB_NAME` |
| Connecting user | **`teamgetsetmedia_db_user`** (not `getset_app`), role **`atlasAdmin@admin`** |
| Its effective privileges | find, insert, update, remove, createIndex, dropCollection and **dropDatabase on every database** (including `config`); listDatabases on the cluster. Not granted: createUser, dropUser, grantRole, killop, shutdown (Atlas manages users) |
| `getsetAppReadWrite` custom role | **exists**; it grants `readWrite@getset` only. That covers everything the app and the migration need in `getset`: find, insert, update, remove, create collections, create and drop indexes. Not used, by the owner's decision |
| Created on first write? | **Yes.** MongoDB creates the `getset` database and each collection on the first insert or index creation |
| Data migrated? | **No.** `getset` is still empty (Stage C not started) |

**Production risks of this decision** (beyond the generic "too many privileges"):
1. **Blast radius.** A leak of the API's environment (a Render variable, a laptop `.env`, a misconfigured log
   collector) gives full read, write and drop access to **every** database in the project, not just `getset`.
2. **Development and production share one credential.** A development mistake (a script run against the wrong
   database name, a test pointed at the real cluster) can change or destroy production data. One environment's
   access cannot be revoked or rotated without breaking the other, and the credential sits on more machines.
3. **Silent mistakes.** A typo in `MONGODB_DB_NAME` creates a new, empty database instead of failing. A
   `readWrite@getset` user would get an authorisation error.
4. **No recovery net.** The Atlas Free tier has no automated backups, so an accidental drop or bulk overwrite is
   permanent unless you take your own `mongodump` exports.
5. **No accountability.** Atlas logs show the same user for developers and the application.

**Safeguards in the code** (they reduce, not remove, these risks): no code path drops a database or collection;
`db:indexes` never drops indexes; `migrate:pg-to-mongo` only inserts and never overwrites; `db:seed --reset` is refused
in production and requires repeating the database name; the API touches only `MONGODB_DB_NAME`; connection strings are
redacted from logs and script output.

**If you change your mind** (recommended before real production): put the `getset_app` (`getsetAppReadWrite`)
connection string in `MONGODB_URI` (locally and on Render), and use a separate database name, or better a separate
project, for production. No code change is needed. At minimum, schedule `mongodump` backups and restrict Atlas Network
Access to Render's outbound IPs.

Also needed for Render (platform): Atlas → Network Access must allow the Render service's outbound IPs. Render
publishes them per region; `0.0.0.0/0` works but relies entirely on the password. The Free (M0) tier has no automated
backups: fine for the development/staging use you decided on, not for production.

## 6. Cloudinary configuration

| Check | Finding |
| --- | --- |
| Implemented in code? | **No** (verified). Only configured in `.env`; no source file reads `CLOUDINARY_*`; the SDK is not installed |
| Images today | uploaded by `POST /api/admin/media` to local disk; served by `GET /media/images/*` from the API |
| API secret server-side only | yes: it is in the backend `.env` only. Neither the frontend nor the admin references any `CLOUDINARY_*` variable, and nothing is `NEXT_PUBLIC_` |
| Uploads require authorization | yes (verified in code): `/api/admin/*` requires a valid session (`requireAdmin`); upload requires the EDITOR role or higher; the real file type is checked from its bytes; maximum 10 MB |
| Images deliverable after deployment? | **Not with the current code.** Local storage on Render is ephemeral, and the existing 52 images are not in the repository (blocker 3) |
| PDF workflow | the secure backend-mediated download (`private_download_url`, private `authenticated` assets) was **verified in the Stage A spike only**; it is **not implemented**. Today's PDFs live on local disk |
| Account settings | no changes made. Strict Transformations is still off (optional manual step; Stage A confirmed it is safe to enable) |

## 7. Local vs production configuration

**Hardcoded `localhost` (all fallbacks used only when a variable is missing):**

| Where | Fallback | Risk on Vercel or Render |
| --- | --- | --- |
| frontend `src/lib/api.ts:7`, `next.config.ts:4` | `NEXT_PUBLIC_API_URL ?? "http://localhost:4000"` | guarded: `next.config.ts` **fails the Vercel build** unless `NEXT_PUBLIC_API_URL` is `https://` |
| frontend `src/config/site.ts:7` | `NEXT_PUBLIC_SITE_URL ?? "https://teamgetset.com"` | silently uses that domain for canonical URLs, sitemap and structured data if unset. Set it explicitly |
| admin `src/lib/api.ts:10-11`, `currencies/page.tsx:21` | `API_URL ?? "http://localhost:4000"`, `SITE_URL ?? "http://localhost:3000"` | **unguarded**: if `API_URL` is missing on Vercel, the admin builds fine and then every page fails ("API not reachable"). Set both variables |
| backend `scripts/dev-db.ts`, `scripts/test.ts` | local PostgreSQL URLs | development and test only, not used by the server |

**CORS, cookies and sessions** (verified in code):
- The API allows exactly `FRONTEND_URL` and `ADMIN_URL`. Vercel preview URLs are not allowed: preview sites render,
  but browser-side calls (paging, search, enquiries) fail. Expected.
- The admin session cookie is `httpOnly`, `sameSite=lax`, and `secure` when `NODE_ENV=production`. The token is a
  bearer token that the admin's server sends to the API; browsers never call the API with it. This works across
  separate Vercel and Render domains; no cookie needs to be shared with the API.
- Sessions are opaque database tokens (SHA-256 at rest), so they move to MongoDB with the migration; there is no JWT
  secret.

**Build-time requirements:**
- **Frontend:** the API must be **live on public HTTPS during the Vercel build**, because pages are pre-rendered from
  it. A sleeping Render free instance (it spins down after inactivity) can make builds slow or fail. Use a paid
  instance or wake the API before building (platform).
- **Admin:** builds without the API (all pages are dynamic).
- **Backend on Render:** `typescript` is a devDependency. If `NODE_ENV=production` is present during the build,
  `npm ci` skips devDependencies and `tsc` is missing. Use the build command
  `npm ci --include=dev && npm run build` and the start command `npm start`, with health check path `/health`
  (platform).
- **Node version:** the backend declares `>=20.12`; Mongoose 9 (Stage B) needs `>=20.19`. Pin Node 20.19+ or 22 on
  Render (e.g. `NODE_VERSION`) (platform).

**Variables to set on each platform** (none of your local `.env` files reach Vercel or Render automatically):

| Platform | Variables |
| --- | --- |
| **Render (backend)** | `NODE_ENV=production`, `API_URL`, `FRONTEND_URL`, `ADMIN_URL`, `AUTH_SECRET` (new), `REVALIDATE_SECRET` (new, shared with the frontend), `TRUST_PROXY=true`, `MONGODB_URI` (`getset_app`), `MONGODB_DB_NAME`, `STORAGE_PROVIDER=cloudinary`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `CLOUDINARY_FOLDER` (`PDF_BROWSER_PATH` is set by the Docker image). Optional: `LOG_LEVEL`, `SESSION_TTL_HOURS`, `DEFAULT_CURRENCY`, `SUPPORTED_CURRENCIES`, `WHATSAPP_NUMBER`. **Do not set:** `PORT`, `DATABASE_URL`, `SEED_ADMIN_*`, `STORAGE_LOCAL_DIR` |
| **Vercel (website)** | `NEXT_PUBLIC_API_URL` (Render origin, `https://`, no path; build time), `NEXT_PUBLIC_SITE_URL`, `REVALIDATE_SECRET` (production environment; the build fails without it). Leave `GETSET_API_URL` unset (no private network between Vercel and Render) |
| **Vercel (admin)** | `API_URL` (Render origin, `https://`), `SITE_URL` (website URL) |

**Required `.env.example` changes** (backend; make them in Stage B, when the code starts reading the variables, so
the example never documents variables the code ignores):
- Add `MONGODB_URI=` and `MONGODB_DB_NAME=`, with a note to use the least-privilege app user.
- Add `CLOUDINARY_CLOUD_NAME=`, `CLOUDINARY_API_KEY=`, `CLOUDINARY_API_SECRET=`, `CLOUDINARY_FOLDER=`.
- Document `STORAGE_PROVIDER=local|cloudinary`, `TRUST_PROXY=true` behind Render, and `PDF_BROWSER_PATH` for Linux
  hosts.
- Mark `DATABASE_URL` as "migration source only; removed after sign-off", then delete it in the cleanup phase.
- Placeholders only, never real values. (`SEED_ADMIN_*` placeholders were already added on 2026-10-12.)

The frontend and admin `.env.example` files already list every variable their code reads.

## 8. Git and secret exposure

Verified, with no values printed:
- `.env` (backend) and `.env.local` (frontend, admin) are **git-ignored and not tracked** in their repositories.
- **No current secret value** appears in any tracked file or anywhere in the git history (all commits, full diffs) of
  the backend, admin or frontend repositories. That covers the MongoDB URI, its password and cluster host, the
  Cloudinary key and secret, `AUTH_SECRET`, `REVALIDATE_SECRET` and the admin password. No MongoDB or Cloudinary
  credential URL and no private-key block appears either.
- The new, not-yet-committed backend files (`docs/*.md`, `src/scripts/set-admin-credentials.ts`) contain no secrets.
- The only credential in tracked files is the **local development PostgreSQL default** `getset:getset@localhost`
  (`.env.example`, `scripts/dev-db.ts`). It is a throwaway login for the embedded database on this Mac, not
  exposed infrastructure.
- **Hygiene:** `backend/.DS_Store` is untracked but not ignored; add `.DS_Store` to `.gitignore` before any
  `git add .`.
- **Note:** Render deploys from GitHub. `origin/main` has only the initial commit; this session's local changes (the
  `admin:credentials` script, the plan and audit docs) are uncommitted, as you requested.

No exposed credential was found, so no rotation is required by this audit. (The old Atlas project's credentials were
already retired by deleting that project; the old admin password is retired.)

## 9. Security risks and missing production settings

| # | Risk | Severity | Fix |
| --- | --- | --- | --- |
| 1 | `MONGODB_URI` uses an `atlasAdmin` user, shared by development and production | high, **accepted by the owner (2026-10-12)** | not production-secure; see section 5 for the risks and the switch to `getset_app` |
| 2 | Rate limits behind Render's proxy: with `TRUST_PROXY=false`, **every visitor shares one IP**. The site would allow only 5 enquiries per 10 minutes and 20 sign-in attempts per 15 minutes **in total** | high (blocks real users) | `TRUST_PROXY=true` on Render. Also: the API takes the **first** `X-Forwarded-For` entry; if Render appends to a client-sent header, a client could spoof it to dodge rate limits. Confirm Render's behaviour; if it appends, use the last entry (small code change, later) |
| 3 | Reusing local `AUTH_SECRET` / `REVALIDATE_SECRET` in production | medium | generate new production values |
| 4 | Admin image uploads go through Next server actions. Vercel limits a function's request body to about **4.5 MB**, while the API accepts 10 MB | medium (large photos fail on the hosted admin) | keep uploads under ~4 MB for now; later send uploads from the browser to the API directly or with signed uploads |
| 5 | Unguarded admin `API_URL` fallback to localhost | low | set it on Vercel; optionally add a build guard like the frontend's |
| 6 | Atlas M0: no backups, shared resources | accepted for dev/staging (decision 5) | paid tier or scheduled `mongodump` before real production |
| 7 | Atlas network access open to `0.0.0.0/0`, if you choose that | medium | restrict to Render's published outbound IPs where possible |
| 8 | Rate limits and the PDF lock are per process | low | run a single API instance (Render default) |
| 9 | Cloudinary Strict Transformations off | low | enable manually when ready (verified safe for the app) |

## 10. Deployment blockers, by priority

1. **Backend data layer is PostgreSQL-only** and `DATABASE_URL` is `localhost`, so all data routes and `/health`
   fail on Render (reproduced). *Fix:* Stage B (MongoDB implementation).
2. **No data in Atlas.** All content exists only in this Mac's local PostgreSQL. *Fix:* Stage C (verified, read-only
   ETL to `getset`).
3. **Media on local disk.** Render's filesystem is ephemeral (persistent disks need a paid plan and pin you to one
   instance); the 52 images and 8 PDFs are not in git; Cloudinary is not implemented. *Fix:* Stages D and E.
   **Resolved (2026-10-13):** images (Stage D) and PDFs (Stage E) are on Cloudinary; nothing is read from local disk.
4. **PDF generation needs Chrome**, which Render's native Node runtime does not have (platform). Without it, PDF
   downloads fail **and publishing a package fails** (publish builds the PDF first). *Fix:* run the API as a Render
   **Docker** service with Chromium installed and `PDF_BROWSER_PATH` set (recommended), or install Chromium during the
   build into the project directory. Needs a small Dockerfile; your decision.
   **Resolved in code (2026-10-13):** `Dockerfile` added (Debian `chromium`, `PDF_BROWSER_PATH=/usr/bin/chromium` set
   in the image) and verified locally. Remaining: create the Render service as a Docker service.
5. **`MONGODB_URI` is the `atlasAdmin` user.** The owner accepted this risk on 2026-10-12, so it no longer blocks
   deployment, but the configuration is **not production-secure** (section 5). *Recommended:* switch to `getset_app`.
6. **Production URLs and proxy settings**: `API_URL`, `FRONTEND_URL`, `ADMIN_URL` and `TRUST_PROXY=true` must be set
   on Render, and the matching Vercel variables. *Fix:* when the Render and Vercel URLs exist.
7. **Website build needs the live API** on HTTPS (and a production `REVALIDATE_SECRET`). *Fix:* deploy the API first;
   avoid a sleeping instance during builds.

The frontend and admin themselves are build-ready (admin lint, typecheck and production build passed on 2026-10-12;
the frontend was audited for Vercel on 2026-10-07). They depend entirely on blockers 1–7.

## 11. Exact next actions, in order

1. **Don't deploy the backend yet.** The website build would also fail without a live API.
2. **You, in Atlas:** confirm the `getset_app` user with only `getsetAppReadWrite`; put its connection string in
   `MONGODB_URI` in backend `.env`. Tell me, and I'll verify read-only. *(Safe now.)*
3. ~~**You, decide:** the Render setup for PDFs.~~ Done in Stage E: a Docker service (`Dockerfile`, verified
   locally).
4. **Approve Stage B.** I implement MongoDB/Mongoose (and update `.env.example`). `DATABASE_URL` stays locally.
5. **Stages C–E:** copy and verify the data; move images and PDFs to Cloudinary (per the approved plan, with your
   approval at each stage).
6. **Stages F–G:** full local verification against Atlas and Cloudinary.
7. **Create the Render service** as a **Docker** service from the backend's `Dockerfile` (it builds and starts the
   API itself, with Node 22 and Chromium; no build or start command), health check `/health`, one instance, at least
   1 GB of memory unless 512 MB is measured to be enough for PDF printing. Set the variables from section 7 (new production secrets). Allow Render's
   outbound IPs in Atlas Network Access.
8. **Deploy the API; check** `/health`, public routes, admin sign-in, an image URL and a PDF download.
9. **Vercel:** set the admin and website variables, deploy the admin, then the website (API awake). Put the final
   Vercel URLs into `FRONTEND_URL`/`ADMIN_URL` on Render and redeploy.
10. **Afterwards:** optionally enable Cloudinary Strict Transformations; then, with your sign-off, run the cleanup
    phase: remove `DATABASE_URL`, Drizzle and PostgreSQL from the code, and, only on your explicit approval, the local
    PostgreSQL data and `storage/`.

### Environment-variable changes: when each is safe

| Change | Why | Safe before the migration? |
| --- | --- | --- |
| `MONGODB_URI` → `getset_app` (local `.env`) | least privilege | **yes**: the code doesn't read it yet |
| `.env.example`: add `MONGODB_*` / `CLOUDINARY_*` | document real inputs | at Stage B, when the code reads them |
| Remove `DATABASE_URL` (local) | PostgreSQL retired | **no**: only after Stages B–G and your sign-off |
| Never set `DATABASE_URL` on Render | the deployed version is MongoDB-only | n/a (Render is set up after the migration) |
| `STORAGE_PROVIDER=cloudinary` (Render) | ephemeral disk | only after Stage D implements it |
| `TRUST_PROXY=true`, production URLs, new secrets, `PDF_BROWSER_PATH` (Render) | correct behaviour behind Render | set when creating the Render service |
