# GETSET API

REST API and MongoDB data model for GETSET Tours & Travels.
Node.js 20.19+, TypeScript, Hono, Mongoose (MongoDB Atlas), Cloudinary (images and private itinerary PDFs), Zod.

```bash
npm install
cp .env.example .env          # then set MONGODB_URI, AUTH_SECRET and REVALIDATE_SECRET
npm run db:indexes && npm run db:verify
npm run db:seed               # demo content into an EMPTY database (SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD for a local admin)
npm run dev                   # http://localhost:4000
```

| Script | |
| --- | --- |
| `dev`, `build`, `start` | Run with reload; compile to `dist`; run compiled |
| `test` | All `*.test.ts` against a throwaway in-memory MongoDB 8.0 (no network; Cloudinary is faked) |
| `typecheck` | TypeScript |
| `db:indexes`, `db:verify` | Create missing collections and indexes (never drops anything); check indexes and references (read-only) |
| `db:seed` | Demo catalogue into an empty database (`-- --reset --confirm-database <name>`); demo packages have no itinerary PDF |
| `admin:create` | `-- --email x --name "Y" --role SUPER_ADMIN` |
| `admin:credentials` | Change an existing admin's email and password: `ADMIN_PASSWORD=... npm run admin:credentials -- --current-email old@x --email new@x` |
| `media:to-cloudinary` | One-off move of the local images (or, with `-- --documents`, the PDFs, as private files) to Cloudinary (dry run; `-- --apply`, `-- --verify`). Local files are only read |
| `migrate:pg-to-mongo` | One-off copy of the former PostgreSQL data (dry run; `-- --apply`, `-- --verify`, `-- --export <dir>`). Read-only on PostgreSQL |
| `pg:dev`, `pg:status`, `pg:migrate`, `pg:verify`, `pg:generate` | LEGACY PostgreSQL tooling (`src/legacy-postgres/`), kept for the migration and rollback until sign-off |
| `google:business` | Google reviews setup, run by the profile owner on their own computer: `-- authorize` (sign in, prints the refresh token), `-- locations` (lists profile ids) |

Itinerary PDFs are prepared outside GETSET and uploaded in the admin (PDF only, up to 4 MB), in two versions per
package: with the GETSET logo and, optionally, without it. Publishing never waits for them: the publish checklist only
flags what is missing. The API stores them privately
(Cloudinary `raw/authenticated` under `CLOUDINARY_FOLDER`) and streams them at `GET /api/public/packages/<slug>/pdf`
(`?branding=without-logo` for the other version); admin routes: `PUT`/`DELETE`/`GET
/api/admin/packages/<id>/itinerary-pdf` (with logo) and `.../itinerary-pdf/without-logo`.
Replacing or removing one deletes the old file; a file that cannot be deleted is logged (`pdf.file_delete_failed`) and its
media record kept, archived, for clean-up. The API no longer generates PDFs (no Chromium).

## Google reviews

The website's reviews band shows the reviews of GETSET's own Google Business Profiles next to the ones entered in the
admin, read with the official Business Profile API: every review, 50 per page, with each profile's average rating and
total. Each review is stored once (`google_reviews`, keyed by Google's review id) so that in the admin's *Google
reviews* list it can be linked to the package it is about; a package page shows only its linked reviews, and an
unlinked review stays general (reviews band only). Google's policy allows keeping that content for up to 30 days,
unchanged: every sync (every 6 hours) rewrites it as Google gives it and deletes reviews Google no longer has, and a
review not read again within 30 days (Google out of reach) is deleted, with its package link.
`GET /api/public/google-reviews`; the admin dashboard shows the status. Without the settings below it is switched off.

Setup, done once by an owner or manager of the Business Profile:

1. Create a Google Cloud project, and request access: the Business Profile API contact form, "Application for Basic API
   Access", with the project number, sent from the profile owner's or manager's email. Google requires a profile
   verified and active for 60+ days and a website for the business. Until approved, the quota is 0.
2. Once approved, enable the *Google My Business API*, *My Business Account Management API* and *My Business Business
   Information API* in the project, and create an OAuth client of type **Desktop app** (OAuth consent screen with the
   `https://www.googleapis.com/auth/business.manage` scope).
3. On your computer, with `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` in `.env`:
   `npm run google:business -- authorize` (sign in as the owner; it prints the refresh token), then, with
   `GOOGLE_OAUTH_REFRESH_TOKEN` set too, `npm run google:business -- locations` (prints `accounts/<id>/locations/<id>`
   for each profile).
4. On Render, set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN` (secrets) and
   `GOOGLE_BUSINESS_LOCATIONS` (the profiles to show, comma-separated), then redeploy.

Deploy: the `Dockerfile` (Node 22) runs as a Render Docker service; configuration comes from the host's environment
variables, never from a file in the image.

Migration status and plan: [docs/MONGODB_CLOUDINARY_MIGRATION_PLAN.md](docs/MONGODB_CLOUDINARY_MIGRATION_PLAN.md).
Documentation: [../docs](../docs) (architecture, database, API reference, PDFs, deployment; to be updated for MongoDB).
