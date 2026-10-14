# GETSET deployment checklist (Render + MongoDB Atlas + Vercel)

Prepared 2026-10-13 at the end of the MongoDB/Cloudinary migration (Stage G). Nothing below has been deployed, no
production resource exists yet, and nothing has been committed. Companion documents:
[MONGODB_CLOUDINARY_MIGRATION_PLAN.md](MONGODB_CLOUDINARY_MIGRATION_PLAN.md) (what was migrated and how it was
verified) and [PRODUCTION_ENVIRONMENT_AUDIT.md](PRODUCTION_ENVIRONMENT_AUDIT.md) (the original audit).

> **Update 2026-10-14:** itinerary PDFs are now uploaded in the admin (PDF only, up to 4 MB, one per package, required
> to publish) instead of generated; Chromium is gone from the image. Sections 2 (B8, W1, W3), 4.2, 7 and 9 below are
> updated for this; see [HOSTING_READINESS_AUDIT.md](HOSTING_READINESS_AUDIT.md) for the current figures.
>
> **Update 2026-10-13:** [HOSTING_READINESS_AUDIT.md](HOSTING_READINESS_AUDIT.md) checks this checklist against the
> chosen hosting: Vercel, and Render as a Docker service. It adds platform facts read on the providers' official pages,
> two required fixes (F1, F2), costs and the final deployment order. Where the two documents differ, the audit wins.

Every statement is tagged:

- **[Verified]**: checked on this machine against the real Atlas database and Cloudinary account, or in the code, with
  the date and how.
- **[Assumed]**: platform behaviour (Render, Vercel, Atlas, Cloudinary) taken from their documentation or common
  practice, not checked here. Confirm it in the platform's dashboard when you get there.
- **[Pending]**: must be done or checked during or after deployment; cannot be verified before.

Placeholders: `<api>` = the API's public origin (for example `https://api.example.com`), `<site>` = the website's
origin, `<admin>` = the admin's origin, `<cloud>` = the Cloudinary cloud name. No domain has been chosen yet.

---

## 1. Status summary

| Area | State | Tag |
| --- | --- | --- |
| Backend code | Runs on MongoDB/Mongoose with Cloudinary storage. 11 test files, typecheck and production build pass (2026-10-13). | [Verified] |
| Data | In Atlas `getset` (16 collections). `db:verify`: all 26 index definitions applied, every reference resolves (2026-10-13). | [Verified] |
| Images | 53 of 53 on Cloudinary (`getset/staging/images`), delivered byte-identical to their originals, no strays (2026-10-13). | [Verified] |
| PDFs | 34 of 34 private (`raw/authenticated`) on Cloudinary, delivered byte-identical, unsigned access refused (2026-10-13). | [Verified] |
| Cloudinary vs database | 87 assets under `getset/staging`, 87 records pointing at them: no asset without a record, no record without its asset. | [Verified] |
| Render image | `Dockerfile` (Node 22; Chromium removed 2026-10-14, 385 MB) built and run as production against a throwaway MongoDB: health, 4 MB PDF upload, preview, removal; 126 MB peak (section 9). | [Verified] |
| Website | Production build against Atlas; desktop and phone; images, prices, currency switch, itinerary, PDFs (Stage F). | [Verified] |
| Admin | Production build against Atlas; sign-in, every page, PDF previews, content, media and package workflows (Stage F). | [Verified] |
| Backups | Every backup's checksums verified; both MongoDB backup formats restore exactly (section 8). | [Verified] |
| Code rollback | The pre-migration backend (commit `8165a2c` + saved patch + untracked files) rebuilds cleanly from the backup. Not started. | [Verified] (source) / [Pending] (run) |
| Commits | Backend: 71 uncommitted entries on `main` (47 modified, 7 moved to `src/legacy-postgres/`, the rest new). Website: 3 (`next.config.ts`, `VERCEL_DEPLOYMENT.md`, and your own `src/app/account/page.tsx`). Admin: clean. | [Verified] |
| Deployment | Nothing deployed; no Render or Vercel project, production domain or production database exists. | [Verified] |

## 2. Remaining blockers

### Decisions only you can make

- **D1. Which database is production.** `getset` was agreed as a **development/staging** database on the Atlas
  **Free** plan (decision 5). The Free plan has no automatic backups and shared resources [Assumed]. Options:
  1. *Recommended:* a production database on a paid Atlas tier with backups, filled with a copy of `getset`
     (`mongodump`/`mongorestore`, both verified in section 8), with the Stage F test leftovers removed first (section 11).
  2. A second database (for example `getset_production`) on the current Free cluster: separates the data, but still
     no automatic backups; schedule `mongodump` (section 8).
  3. Use `getset` itself as production: the fastest, but it then holds test leftovers and staging history, and it is
     no longer a safe place to test.
- **D2. Cloudinary folder for production uploads.** Records copied from `getset` keep their current asset addresses
  under `getset/staging/...`, which keep working. Set `CLOUDINARY_FOLDER=getset/production` (for example) so new
  uploads are separated. **Consequence:** the `getset/staging` folder is then shared with production and must never
  be emptied while production refers to it.
- **D3. Domains** for the API, the website and the admin (and `www` or not). They are needed for `API_URL`,
  `FRONTEND_URL`, `ADMIN_URL`, `NEXT_PUBLIC_*` and CORS.
- **D4. Render instance size:** see B8 (recommended: above 512 MB).
- **D5. Database user:** keep the accepted `atlasAdmin` risk or switch to the least-privilege user (section 5). It is
  not blocking by your decision of 2026-10-12, but it is **not production-secure**.

### Must be done before the first production deploy

- **B1. Review, commit and push** the backend (71 entries) and website (2 of the 3 entries are migration work) to
  their GitHub repositories; Render and Vercel deploy from git. Exclude the stray `.DS_Store` in the backend (it is
  not git-ignored). Secrets are safe: `.env`, `.env.local`, `storage/`, `.data/` and build outputs are git-ignored,
  and a scan of the files a commit would include found no connection strings or API secrets [Verified 2026-10-13].
- **B2. Production database** per D1, with indexes applied (`db:indexes`), verified (`db:verify`), and an admin
  account (section 4.1).
- **B3. Atlas network access** must allow Render's outbound addresses (section 4.1). The current access list cannot be
  read through the driver [Pending: check in Atlas → Network Access].
- **B4. New production secrets:** `AUTH_SECRET` and `REVALIDATE_SECRET` must be newly generated, not the local ones.
- **B5. Render service** created as a Docker service with the variables in section 6.
- **B6. Vercel projects** for the website and the admin with the variables in section 6. The website build needs the
  live API on HTTPS (it renders pages from the API at build time) [Verified in code; Stage F build].
- **B7. Final URLs wired back** into the API (`FRONTEND_URL`, `ADMIN_URL`) and `TRUST_PROXY=cloudflare`, then redeploy.
- **B8. Memory:** resolved by removing PDF generation (2026-10-14): the API peaked at 126 MB during a 4 MB PDF upload,
  so Render **Starter** (512 MB) is enough (section 9).

### Warnings (not blocking)

- **W1. Itinerary PDFs must be uploaded.** PDFs are no longer generated, so every package starts without one: publishing
  needs one, and live packages without one show "not available yet" on the website until a PDF is uploaded.
- **W2. Admin uploads over about 4.5 MB** may fail on Vercel even though the admin allows 12 MB and the API 10 MB:
  Vercel functions limit request bodies [Assumed]. Resize large photos before uploading, or upload them while
  running the admin locally.
- **W3. One API instance.** Rate limits live in the process; run a single Render instance [Verified in code].
- **W4. Free Render instances sleep** when idle and take time to wake [Assumed]; a sleeping API makes the first visit
  slow and can fail a website build. A paid instance avoids this.
- **W5. Vercel preview deployments** have their own addresses; browser calls from them (paging, search, enquiries)
  are refused by the API's CORS unless their origin is `FRONTEND_URL` [Verified in code: CORS allows exactly
  `FRONTEND_URL` and `ADMIN_URL`]. Server-rendered pages still work.
- **W6. Expired admin sessions are not deleted automatically** (no TTL index); each admin's expired sessions are
  removed at their next sign-in [Verified in code: `auth/service.ts`]. Harmless.
- **W7. The website's `.env.example`** still says photos load from the API; photos now come from Cloudinary. A one-line
  fix (not made: changes need your approval).
- **W8. Legacy PostgreSQL code** (`src/legacy-postgres/`, `drizzle/`, the `pg` dependency, `DATABASE_URL`) is still in
  the backend for rollback until the cleanup phase you approve.

## 3. Before you start (local)

1. Decide D1–D5.
2. Review the uncommitted work, then commit and push (B1). I have not committed anything.
3. Take a fresh backup of `getset` (section 8.1) and keep it with the others in `backups/`.
4. Generate the production secrets on your own machine and keep them in your password manager:
   ```sh
   openssl rand -base64 48   # AUTH_SECRET (at least 32 characters)
   openssl rand -base64 36   # REVALIDATE_SECRET (at least 24 characters; the same value goes to the API and the website)
   openssl rand -base64 48   # ADMIN_PROXY_SECRET (at least 32 characters; the same value goes to the API and the admin)
   ```
5. If D1 is a new database: create it (section 4.1) before Render, so the API has data on its first start.

## 4. Step-by-step deployment

### 4.1 MongoDB Atlas

1. **Production database (D1).** For a copy of `getset` into a new database name on a cluster you control:
   - take a dump (section 8.1), remove the test leftovers from the copy if you approved that (section 11), and
     restore it under the new name with `mongorestore --nsFrom 'getset.*' --nsTo '<prod-db>.*'` (section 8.2);
   - renaming on restore was verified on a small test database; the full restore was verified into a test server
     with the original name [Verified 2026-10-13].
2. **Application user:** create the least-privilege user for the production database (section 5) and keep the
   connection string for Render.
3. **Network access:** in Atlas → Network Access, add Render's outbound IP ranges for your Render region (shown in
   the Render service's *Connect → Outbound* panel [Assumed]). Avoid `0.0.0.0/0`; if you must use it briefly, remove
   it afterwards. [Pending]
4. **Indexes and checks**, from your machine, with the production values typed into the shell (they take precedence
   over the local `.env` [Verified 2026-10-13]; any variable you do not set still comes from the local `.env`):
   ```sh
   cd getset-itinerary-backend
   read -rs MONGODB_URI; export MONGODB_URI        # paste the production connection string, press Enter (not shown)
   export MONGODB_DB_NAME=<prod-db>
   npm run db:indexes                               # creates missing collections/indexes; never drops anything
   npm run db:verify                                # read-only: indexes and every reference
   ```
5. **Admin account** in the production database (skip if it was copied with the data and you keep that account):
   ```sh
   ADMIN_PASSWORD='…' npm run admin:create -- --email you@example.com --name "Your Name" --role SUPER_ADMIN
   ```
   Type the password in the shell, never in a file that is committed. To change an existing admin's credentials use
   `npm run admin:credentials` as before.
6. **Backups:** on a paid tier, enable and test Atlas backups [Assumed: availability depends on the tier]. On the Free
   tier, schedule the `mongodump` in section 8.1 (at least before every release).

### 4.2 Render (API)

1. New → **Web Service** → connect `teamgetset/itinerary-backend`, branch `main`, **Language/Runtime: Docker**,
   Dockerfile path `./Dockerfile`, build context `.` [Assumed: Render field names].
2. Region: the one closest to the Atlas cluster's region (Atlas → cluster overview) [Assumed].
3. Instance: see B8 / section 9. **One instance** (W3).
4. Health check path: `/health` (it pings the database) [Verified in code].
5. Environment variables: section 6.1. Do **not** set `PORT` (Render provides it and the API reads it [Assumed:
   Render sets `PORT`; Verified: the API listens on `PORT`]), `DATABASE_URL`, `SEED_ADMIN_*` or `STORAGE_LOCAL_DIR`
   (the image sets `NODE_ENV=production` [Verified]). The former `PDF_BROWSER_*` settings no longer exist.
6. Deploy. In the logs, expect `server.started` with `"env":"production"`. Then `curl -s <api>/health` returns
   `{"success":true,"data":{"status":"ok"}}`. [Pending]
7. Add Render's outbound IPs to Atlas (4.1 step 3) if the health check fails with a database timeout.

### 4.3 Vercel: admin

1. New project from `teamgetset/itinerary-admin`, framework Next.js (detected) [Assumed].
2. Variables, for **Production and Preview** (a build stops without them):
   - `API_URL=<api>` and `SITE_URL=<site>`: public `https://` origins, no path;
   - `ADMIN_PROXY_SECRET`: the same value as on the Render service.

   All three are server-only; never `NEXT_PUBLIC_`.
3. Deploy, then sign in (section 7).

### 4.4 Vercel: website

1. Make sure the API is awake (`curl <api>/health`), because the build renders every page from it.
2. New project from `teamgetset/itinerary-frontend`. Variables (Production): `NEXT_PUBLIC_API_URL=<api>` (origin only,
   `https://`), `NEXT_PUBLIC_SITE_URL=<site>`, `REVALIDATE_SECRET=<same value as the API>`. Optional:
   `GETSET_API_URL` (a private address for server-side reads; defaults to `NEXT_PUBLIC_API_URL`).
   The build stops with a clear message if `NEXT_PUBLIC_API_URL` has a path, is not `https://` on Vercel, or if
   `REVALIDATE_SECRET` is missing in production [Verified in code: `next.config.ts`].
3. `NEXT_PUBLIC_*` values are baked in at build time: after changing one, redeploy [Assumed: standard Next.js].
4. Images: `next.config.ts` allows only `https://res.cloudinary.com/<cloud>/image/upload/**` without query strings,
   plus the API's `/media/**` [Verified Stage F: this account's image → 200; other account, PDF path, query string → 400].

### 4.5 Wire the final addresses back into the API

1. On Render set `FRONTEND_URL=<site>`, `ADMIN_URL=<admin>` (exact origins: scheme + host, **no trailing slash**: the
   API's CORS compares them character for character [Verified in code: `app.ts`]), `API_URL=<api>`,
   `TRUST_PROXY=cloudflare` (the client address then comes only from `CF-Connecting-IP`; `true` is refused).
2. Redeploy the API, then run the smoke tests (section 7).

## 5. Replacing the `atlasAdmin` user with a least-privilege application user

**Today [Verified 2026-10-13]:** the API connects as `teamgetsetmedia_db_user` with `atlasAdmin@admin`, which can read,
write and drop every database in the project (it inherits `readWriteAnyDatabase`, `dbAdminAnyDatabase`, `backup`,
`clusterMonitor` and more). A leak of this connection string (it is in your local `.env`) exposes everything.

**Already prepared [Verified 2026-10-13]:** a custom role `getsetAppReadWrite@admin` exists and inherits only
`readWrite@getset`. Whether the `getset_app` user you created on 2026-10-12 still exists cannot be read through the
driver (Atlas refuses `usersInfo`) [Pending: check in Atlas → Database Access].

**What the application needs:** read and write on its own database only. `readWrite` on that database also covers
creating collections and indexes (`db:indexes`) and transactions [Verified: the app uses only these operations; built-in
role contents per MongoDB documentation, Assumed]. It never needs other databases, user management or cluster rights.

Steps (Atlas console):

1. **Role.** For `getset`, use the existing `getsetAppReadWrite`. For a production database with another name, create a
   custom role with `readWrite` on that database only (Database Access → Custom Roles → Add → *readWrite* @
   `<prod-db>`), or pick the built-in *readWrite* with that database as a specific privilege when creating the user.
2. **User.** Database Access → Add New Database User → Password; username such as `getset_app_prod`; *Autogenerate
   Secure Password*; privileges: the role from step 1 only; *Restrict access to specific clusters*: the GETSET
   cluster. Use **separate users for development and production**, so a laptop `.env` never holds the production
   password.
3. **Connection string.** Connect → Drivers → copy the `mongodb+srv://` string and put the password in; URL-encode
   special characters in the password. Keep it in your password manager.
4. **Verify before switching (read-only), from your machine:**
   ```sh
   cd getset-itinerary-backend
   read -rs MONGODB_URI; export MONGODB_URI   # the new user's string
   export MONGODB_DB_NAME=<db>
   npm run db:verify                           # must pass: it can read everything it needs
   ```
   Optionally, with `mongosh`, `db.runCommand({connectionStatus: 1})` must show only the new role, and reading another
   database (for example `sample_mflix`) must fail with *Unauthorized*.
5. **Switch.** Set the new string as `MONGODB_URI` on Render, redeploy, run the smoke tests including one admin save
   (section 7). Keep the old string for a quick switch back until this passes.
6. **Retire the broad credential.** In Atlas → Database Access, change the password of `teamgetsetmedia_db_user`, keep
   it only for administration (restores, migrations), and update your local `.env` yourself. Or delete it once
   another administrator account exists.
7. Record the change in `PRODUCTION_ENVIRONMENT_AUDIT.md` section 5 (the accepted-risk note can then be closed).

## 6. Environment variables

Local shapes below were checked without printing values [Verified 2026-10-13]. Production values do not exist yet
[Pending].

### 6.1 API (Render)

| Variable | Production value | Local today | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | `production` (set by the image) | `development` | production refuses an example `AUTH_SECRET` |
| `MONGODB_URI` | least-privilege user's string (section 5) | `mongodb+srv`, atlasAdmin user | secret |
| `MONGODB_DB_NAME` | production database (D1) | `getset` | |
| `API_URL` | `<api>` | `http://localhost:4000` | PDF links in API responses are built from it |
| `FRONTEND_URL` | `<site>`, no trailing slash | `http://localhost:3000` | CORS, revalidation, printed on PDFs (W1) |
| `ADMIN_URL` | `<admin>`, no trailing slash | `http://localhost:3001` | CORS |
| `AUTH_SECRET` | new, at least 32 characters | set, 64 characters | secret; signs draft preview links |
| `REVALIDATE_SECRET` | new, at least 24 characters, same as the website's | set, 48 characters, equals the website's | secret |
| `ADMIN_PROXY_SECRET` | new, at least 32 characters, same as the admin's | unset (not needed locally) | secret; per-person admin sign-in limits (F3 in the audit) |
| `TRUST_PROXY` | `cloudflare` | `false` | otherwise all visitors share one rate-limit bucket; `X-Forwarded-For` is never trusted |
| `SESSION_TTL_HOURS` | optional (default 12) | 12 | |
| `STORAGE_PROVIDER` | `cloudinary` | `cloudinary` | |
| `CLOUDINARY_CLOUD_NAME` | `<cloud>` | set | public (in every image URL) |
| `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET` | same account | set | secrets |
| `CLOUDINARY_FOLDER` | D2, for example `getset/production` | `getset/staging` | where new uploads go |
| `DEFAULT_CURRENCY`, `SUPPORTED_CURRENCIES` | optional (`INR`, `INR,AED`) | same | |
| `WHATSAPP_NUMBER` | optional | set | public business number |
| `LOG_LEVEL` | optional (`info`) | `info` | |
| not on Render | `PORT`, `DATABASE_URL`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `STORAGE_LOCAL_DIR` (`PDF_BROWSER_*` no longer exist) | | |

### 6.2 Website (Vercel)

| Variable | Production value | Local today | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_API_URL` | `<api>` (origin, `https://`) | `http://localhost:4000` | build fails otherwise on Vercel |
| `NEXT_PUBLIC_SITE_URL` | `<site>` | `http://localhost:3000` | canonical URLs, sitemap |
| `REVALIDATE_SECRET` | same as the API's | set, equals the API's | build fails without it in production |
| `GETSET_API_URL` | optional | unset | private address for server reads |

### 6.3 Admin (Vercel)

| Variable | Production value | Local today | Notes |
| --- | --- | --- | --- |
| `API_URL` | `<api>` | `http://localhost:4000` | server-only; the browser never calls the API from the admin. Required on Vercel for Production and Preview: a public `https://` origin |
| `SITE_URL` | `<site>` | `http://localhost:3000` | "View on site" links. Required on Vercel for Production and Preview: a public `https://` origin |
| `ADMIN_PROXY_SECRET` | the API's value | unset | secret, server-only; must match the Render service's value; required on Vercel for Production and Preview |

The admin's session cookie is `httpOnly`, `SameSite=Lax`, and `Secure` when `NODE_ENV=production` (Vercel builds set
it) [Verified in code: `src/app/login/actions.ts`; Assumed: Vercel's `NODE_ENV`].

## 7. Smoke tests and authentication checks (after each deploy) [Pending]

All of these passed locally against Atlas in Stage F; run them against the deployed addresses.

### API

```sh
API=https://<api>
curl -s $API/health                                                    # {"success":true,"data":{"status":"ok"}}
curl -s "$API/api/public/packages?pageSize=48" | jq .meta.total         # number of published packages (12 today)
curl -s $API/api/public/packages/dubai-city-highlights | jq -r .data.heroImage.url
                                                                       # https://res.cloudinary.com/<cloud>/image/upload/...
curl -s $API/api/public/packages/<slug-with-a-pdf> | jq -r .data.pdf.url
                                                                       # must start with $API (API_URL is right); null = no PDF yet
curl -s -D - -o /tmp/p.pdf "$API/api/public/packages/<slug-with-a-pdf>/pdf" | grep -i 'content-type\|content-disposition'
head -c 5 /tmp/p.pdf                                                   # %PDF-   (attachment; filename="getset-<slug>-itinerary.pdf")
curl -s "$API/api/public/packages/<slug-without-a-pdf>/pdf"            # 404 {"code":"PDF_NOT_AVAILABLE",...}
curl -s -o /dev/null -w '%{http_code}\n' $API/api/admin/packages       # 401 without a session
curl -s -D - -o /dev/null -X OPTIONS $API/api/public/packages -H "Origin: https://<site>" -H 'Access-Control-Request-Method: GET' | grep -i access-control-allow-origin
                                                                       # https://<site>; a different Origin gets no such header
```

Upload the first itinerary PDF in the admin before these PDF checks (W1).

### Website

- Home, `/packages`, a destination and three package pages load with every photo, on a phone and a computer.
- The INR/AED switch changes every price; "Download itinerary (PDF)" downloads `getset-<slug>-itinerary.pdf`; a package
  without a PDF shows "Itinerary PDF not available yet" (and "PDF not available" in the phone's bottom bar).
- The image optimiser refuses other hosts:
  `curl -s -o /dev/null -w '%{http_code}\n' "https://<site>/_next/image?url=https%3A%2F%2Fres.cloudinary.com%2Fdemo%2Fimage%2Fupload%2Fsample.jpg&w=640&q=75"` → `400`.
- `https://<site>/sitemap.xml` lists `https://<site>/...` addresses (not localhost).

### Admin and authentication

- Sign in with the production admin; a wrong password is refused.
- Rate limit: 6 failed sign-ins **for a made-up email address** within 15 minutes → the 6th is refused (limit: 5 per
  email, 20 per address, per 15 minutes) [Verified in code]. Do not test with the real admin's email (it locks that
  account for 15 minutes).
- In the browser's developer tools, the session cookie is `Secure`, `HttpOnly`, `SameSite=Lax`.
- Packages, media (thumbnails from Cloudinary) and PDF previews open. In a package's PDF & publish tab, upload a PDF
  (shown with name, size and date), preview it, replace it; on a draft, remove it (asks for confirmation).
- Revalidation: change a content block (Content → Branch section heading), save, and the website shows it within a
  minute; change it back.
- Sign out; opening an admin page then asks you to sign in again.
- If you switched database users: one save in the admin succeeds (proves write access).

### Watch the API logs for

`pdf.file_delete_failed` (a replaced or removed PDF could not be deleted from Cloudinary; its record is kept, archived,
for clean-up), `pdf.read_failed` / `pdf.file_missing`, `revalidate.rejected` / `revalidate.unreachable` (secret or
`FRONTEND_URL` wrong), `http.unhandled_error`, and database timeouts (Atlas network access).

## 8. Backups and restoring

### 8.1 Taking a backup of the database (read-only on Atlas)

The connection string goes in a private file, not on the command line (it would be visible in the process list):

```sh
umask 077
read -rs URI; printf 'uri: "%s"\n' "$URI" > ~/getset-dump.yaml; unset URI
mongodump --config ~/getset-dump.yaml --db <db> --out backups/atlas-<db>-$(date +%F)
rm ~/getset-dump.yaml
```

[Verified 2026-10-13 with `mongodump` 100.16.1: 16 collections dumped from Atlas `getset`.] The dump contains the admin
password hash and session token hashes: store it like a secret (encrypted disk or vault).

### 8.2 Restoring, without overwriting anything

Restore into a **new database name**, check it, then point the API at it. Never restore over the live database.

```sh
mongorestore --config ~/getset-restore.yaml --dir backups/atlas-<db>-<date> \
  --nsInclude '<db>.*' --nsFrom '<db>.*' --nsTo '<db>_restore.*'
MONGODB_URI=… MONGODB_DB_NAME=<db>_restore npm run db:verify     # indexes and every reference
```

Then set `MONGODB_DB_NAME=<db>_restore` on Render and redeploy. Writing to a new database needs a user with
`readWrite` on it (the administrator user, or extend the role).

**Verified 2026-10-13** (into a throwaway local MongoDB 8.0; Atlas was only read):

- a `mongodump` of Atlas `getset` restored with `mongorestore`: all 16 collections identical to Atlas, document by
  document, and all indexes identical;
- the Stage F JSON export (`backups/atlas-getset-2026-10-13-pre-stage-f`) loaded into an empty database: all 16
  collections identical to the export; the app's own `db:indexes` then `db:verify` pass on that copy;
- `--nsFrom/--nsTo` renaming, on a small test database.

### 8.3 Existing backups (all kept; checksums verified 2026-10-13)

| Backup | Contents | Check |
| --- | --- | --- |
| `backups/postgres-2026-10-12/pgdata` | cold copy of the PostgreSQL data folder | 1,419 of 1,419 files match; the original `.data/postgres` also matches (never started since) |
| `backups/postgres-2026-10-12/export` | the 27 PostgreSQL tables as JSON (588 rows) | 27 of 27 match hash and row count |
| `backups/postgres-2026-10-12/storage-before-stage-c.sha256` | checksums of local `storage/` | all 60 files in `storage/` still match |
| `backups/pdfs-2026-10-13` | the 8 original PDFs and their records | 8 of 8 + metadata match |
| `backups/atlas-getset-2026-10-13-pre-stage-f` | Atlas `getset` before Stage F (EJSON) | 16 of 16 match; restore verified |
| `backups/backend-pre-mongodb-2026-10-12` | the pre-migration code's uncommitted work + `RESTORE.md` | rebuilds cleanly on top of commit `8165a2c` |

**Media.** Images and PDFs live on Cloudinary. The 52 migrated images and the 8 original PDFs also exist locally
(`storage/`, verified). Anything uploaded after Stage D exists only on Cloudinary (today: 1 test image), including
every itinerary PDF uploaded from now on (they are no longer generated, so they cannot be rebuilt from the data). Before relying on production uploads, decide on a Cloudinary backup (Cloudinary
offers backups on paid plans [Assumed]) or a periodic download.

## 9. Render instance memory (B8)

**Since 2026-10-14 (PDF generation removed) [Verified]:** the Render image (Node 22, no Chromium, 385 MB) ran as
production against a throwaway MongoDB replica set: about 46 MB idle, and a **126 MB peak** while uploading,
previewing and removing a 4 MB itinerary PDF. **Recommendation: Render Starter (0.5 CPU, 512 MB, $7/month).** Free is
still unsuitable: it sleeps after 15 minutes idle, which breaks website builds and revalidation.

*Before (2026-10-13, historical):* with Chromium printing both versions of all 12 packages, the peak was 477 MB under a
512 MB limit, and a second process in the container ran out of memory. That is why Standard (2 GB) was recommended then.

## 10. Rollback

| Situation | What to do | Tag |
| --- | --- | --- |
| A new API deploy misbehaves | Render → the service → Events/Deploys → roll back to the previous deploy | [Assumed] |
| A new website or admin deploy misbehaves | Vercel → Deployments → promote the previous deployment (Instant Rollback) | [Assumed] |
| A wrong environment variable | Change it back and redeploy (Vercel: `NEXT_PUBLIC_*` needs a rebuild) | [Assumed] |
| The least-privilege user fails | Put the previous `MONGODB_URI` back on Render, redeploy | [Pending] |
| Data damaged | Restore the last dump into a new database name and point `MONGODB_DB_NAME` at it (8.2). Changes made after that dump are lost unless re-entered. | [Verified] (method) |
| Images broken on the website | Keep `next.config.ts`'s Cloudinary pattern: the API returns Cloudinary URLs, so reverting only the website breaks photos | [Verified] |
| Back to PostgreSQL entirely | Only locally: rebuild commit `8165a2c` + the saved patch (`backups/backend-pre-mongodb-2026-10-12/RESTORE.md`) and use `.data/postgres` (data as of 2026-10-12, before Stage C) with `storage/`. Everything entered in Atlas since then would have to be re-entered. No hosted PostgreSQL exists, so this is not a production rollback path. | [Verified] (source and data intact) / [Pending] (not run) |

Keep `storage/`, `.data/postgres`, the PostgreSQL code and all backups until you sign off the cleanup phase
(decision 7).

## 11. Test leftovers (review only; nothing deleted)

Everything below is in the staging database `getset` or `getset/staging` on Cloudinary. References were checked across
every collection; no live content points at any of it [Verified 2026-10-13].

| Item | Where | Referred to by | Safe to remove? | Recommendation |
| --- | --- | --- | --- | --- |
| Test package `3f936590…` (`dubai-city-highlights-copy-deleted-mv6ha8au`, deleted; first Stage F attempt) | `packages` | 2 audit entries only | Yes | Remove the package document; keep the audit entries |
| Test package `45d4ad5a…` (`…-copy-deleted-mv6hccbl`, deleted; published once during the test) | `packages` | its PDF version, 2 PDF records, 8 audit entries | Yes, together with its PDF version and files | Remove the package, its PDF version `1ebda94a…` and PDF records `032d99a0…`, `10945b82…`, and the 2 private files under `getset/staging/documents/itineraries/45d4ad5a…/`; keep the audit entries |
| Test image `63aef12c…` (`stage-f-test.jpg`, archived) | `media` + `getset/staging/images/63aef12c…` | 3 audit entries only (no package, slide or page uses it) | Yes | Remove the record and the Cloudinary image |
| Test sign-in session (from an interrupted test run) | `admin_sessions` | – | Not needed | Stops working 2026-10-13 21:31 UTC; removed automatically at the admin's next sign-in after that |
| Audit entries from the tests (24 in Stage F) | `audit_logs` | – | Possible, but not advised | Keep: an audit trail should stay append-only. A new production database (D1) can start without them |
| `home.branches` content, admin `lastLoginAt` | `site_content`, `admin_users` | – | – | Not leftovers: only timestamps changed; the content is identical |
| Stage E PDFs (16 versions, 34 files) | `itinerary_pdfs`, `media`, Cloudinary | packages | No | Real data: keep |
| Cloudinary sample assets (60 images, 4 videos from account creation, outside `getset/`) | Cloudinary | – | Yes, unrelated to the app | Optional, in the Cloudinary console; never touched by this work |
| Local: build outputs (`.next`), Colima/Docker (stopped), scratch files | this Mac | – | Yes | Optional; regenerable |
| Backups, `storage/`, `.data/postgres` | this Mac | – | **No** | Keep until the cleanup phase is signed off (decision 7) |

If you approve the cleanup: remove exactly the IDs above in one step (dry run first, then apply), re-run `db:verify` and
`media:to-cloudinary [--documents] -- --verify`, and record it in the migration plan. If D1 creates a new production
database from a copy, cleaning the copy is enough and `getset` can stay as it is.

## 12. Verified, assumed, pending: summary

**Verified (2026-10-13 unless noted):** tests/typecheck/build; Atlas indexes and references; every image and PDF on
Cloudinary byte-identical, PDFs private; no Cloudinary strays; the Docker image runs as production (Stage E); website and
admin end to end (Stage F); the image allow-list is narrow (Stage F); every backup's checksums; both restore methods;
the pre-migration code rebuilds; local configuration shapes; secrets are git-ignored and absent from the files to be
committed; the app's current database role; the least-privilege role's definition; references to every test leftover;
memory under 512 MB (section 9).

**Assumed (platform behaviour, confirm in the dashboards):** Render's Docker settings, `PORT`, outbound IP panel,
rollback and idle sleep; Vercel's body-size limit, `NODE_ENV`, build-time `NEXT_PUBLIC_*` and Instant Rollback; Atlas
Free plan without backups, built-in role contents, tier-dependent backups; Cloudinary paid-plan backups.

**Pending:** decisions D1–D5; commits; production database, user, network access and admin account; Render and Vercel
projects and variables; DNS and HTTPS; smoke tests and authentication checks against the deployed addresses; the
existence of the `getset_app` user; Atlas network access list; the one-time PDF rebuild after go-live; cleanup of test
leftovers (only with your approval).
