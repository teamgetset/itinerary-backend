# MongoDB Atlas + Cloudinary migration plan

**Status (2026-10-13): Stage G complete (final verification; deployment checklist in
[DEPLOYMENT_CHECKLIST.md](DEPLOYMENT_CHECKLIST.md)). Nothing is deployed or committed; deployment and the cleanup phase
wait for the owner's approval.** Plan approved with
decisions 1–7 (copy the PostgreSQL data; Cloudinary private PDFs; `getset` is a development/staging database on the
Atlas Free plan; keep PostgreSQL and local files for rollback). Stage A (connectivity) and Stage B (MongoDB
implementation), Stage C (data migration), Stage D (images), Stage E (PDFs), Stage F (website and admin) and Stage G
(final verification) results are in section 14. The API runs
on MongoDB/Mongoose, the data is in Atlas `getset`, images are served from Cloudinary (`getset/staging/images`) and
itinerary PDFs are private Cloudinary files (`getset/staging/documents`) streamed by the API.
PostgreSQL (never started), `storage/` (originals kept) and `.data/postgres` are unchanged.

> **Accepted security risk (owner's decision, 2026-10-12): not production-secure.** The application connects as
> `teamgetsetmedia_db_user`, which has `atlasAdmin@admin` (read, write and drop on every database in the project), and
> the owner intends to use the same credentials for development and production. The application needs only
> `readWrite@getset`. Risks and safeguards: section 9 and `docs/PRODUCTION_ENVIRONMENT_AUDIT.md` section 5.

**Goal:** move the GETSET API from PostgreSQL + Drizzle ORM to MongoDB Atlas + Mongoose, and move images and media
from the API server's disk to Cloudinary. The HTTP API that the website and admin use must not change.

**Summary of the recommendation**

- Keep every existing ID as a UUID **string `_id`**. URLs, admin forms, audit history, PDF paths and the
  `z.uuid()` validators then keep working, and migrated records keep their IDs.
- Collapse 27 tables into **16 collections**. A package's nine child tables (gallery, highlights, inclusions,
  exclusions, prices, hotel options, linked activities, itinerary days, timeline entries) are embedded in the package
  document. Everything reusable stays a referenced collection.
- Only the `media` collection holds Cloudinary metadata (`publicId`, `secureUrl`, ...). Every other document keeps
  referencing media by ID, exactly as today, so the admin's `<field>ImageId` contract is unchanged.
- Do the work in two separate cut-overs: first the database (with local file storage, so old and new API responses can
  be diffed byte for byte), then the media move to Cloudinary.
- The existing PostgreSQL data is development/demo data (details in section 5). Copy it with a read-only, re-runnable
  ETL script rather than re-seeding (this needs your confirmation, see section 12).

---

## 1. Current backend architecture

| Layer | Implementation (verified in source) |
| --- | --- |
| Runtime | Node 20 (`engines >=20.12`; this machine runs 20.20.0), TypeScript run with `tsx`, built with `tsc` to `dist/` |
| HTTP | Hono 4 (`src/app.ts`), with `@hono/node-server` (`src/server.ts`) |
| Validation | Zod 4 at every boundary (`readBody`, `readQuery`, `idParam` in `src/lib/http.ts`) |
| Database | PostgreSQL 15+ via `pg` Pool (`src/db/client.ts`), Drizzle ORM 0.45 (`src/db/schema.ts`, 781 lines) |
| Migrations | `drizzle-kit generate` produces `drizzle/0000_initial_schema.sql`; `src/db/migrations.ts` applies it; `src/db/verify.ts` compares the live catalog with the schema (the created / applied / verified states) |
| Local DB | `embedded-postgres` (`npm run db:dev`, port 5433, data in `.data/postgres`, 65 MB) |
| Files | `src/modules/storage.ts`: a `Storage` interface (`put`/`get`/`delete`/`publicUrl`) with one provider, `local`. Files live in `STORAGE_LOCAL_DIR` (`./storage`, 30 MB). Images are served by `GET /media/images/*`; PDFs only through API routes |
| PDFs | `playwright-core` drives system Chrome (`src/modules/pdf/render.ts`); HTML template with fonts and logo inlined from `src/assets`. Two prints per version (with and without logo), versioned by content hash |
| Auth | Opaque bearer tokens: SHA-256 stored in `admin_sessions`, scrypt password hashes, roles EDITOR < ADMIN < SUPER_ADMIN, in-memory rate limits |
| Cache refresh | `src/modules/revalidate.ts` POSTs tags (`catalog`, `testimonials`, `hero`, `content`) to the website's `/api/revalidate` |
| Tests | `npm test` (`src/scripts/test.ts`): a throwaway embedded PostgreSQL, a template DB migrated and verified once, then one DB copy per test file; 9 files, 59 tests (58 at the audit, plus the credentials test added 2026-10-12), all through the real HTTP app |

Request flow: website (Next 16, Vercel) reads `/api/public/*` server-side and from the browser. The admin (Next 16)
calls `/api/auth/*` and `/api/admin/*` from its own server, passing the session token kept in an httpOnly cookie.
All business rules (pricing, publish checklist, search, recommendations, PDF versioning) live in the API modules.

**39 source files** (excluding `*.test.ts`) import Drizzle, `pg`, the schema/client or local storage, as do 5 test
files, with about 180 query call sites. The heaviest are
`packages/service.ts` (48), `scripts/seed.ts` (24), `crud.ts` (14), `dashboard.ts` (12), `pdf/service.ts` (11) and
`enquiries.ts` (10). Changing `.env` alone would do nothing. Every query, the error mapping, the health check, the
shutdown hook, the scripts and the test runner have to change (section 4).

---

## 2. Existing database tables and relationships

27 tables plus Drizzle's bookkeeping table (`drizzle.__drizzle_migrations`, 1 migration applied). All primary keys are
`uuid DEFAULT gen_random_uuid()` except `currencies.code` (`char(3)`) and `site_content.key` (text). Timestamps are
`timestamptz`; `created_at`/`updated_at` exist on most tables (`updated_at` is maintained by Drizzle's `$onUpdate`,
not by a trigger).

**Enums:** `admin_role` (SUPER_ADMIN, ADMIN, EDITOR) · `package_status` (DRAFT, PUBLISHED, ARCHIVED) ·
`price_type` (ADULT, CHILD, INFANT) · `meal` (BREAKFAST, LUNCH, DINNER) · `itinerary_activity_type` (ARRIVAL,
TRANSFER, CHECK_IN, SIGHTSEEING, ACTIVITY, MEAL, FREE_TIME, CHECK_OUT, DEPARTURE, OTHER) · `destination_kind`
(COUNTRY, PLACE) · `enquiry_status` (NEW, CONTACTED, IN_PROGRESS, CONVERTED, CLOSED) · `media_kind` (IMAGE, DOCUMENT).

| Table | Rows* | Constraints and indexes | References (ON DELETE) |
| --- | ---: | --- | --- |
| `admin_users` | 1 | unique `lower(email)` (stored lower-cased) | none |
| `admin_sessions` | 1 | unique `token_hash`; idx `admin_user_id` | admin_users (CASCADE) |
| `audit_logs` | 43 (44 since 2026-10-12) | idx `(entity, entity_id)`, idx `created_at`; `metadata jsonb` | admin_users (SET NULL) |
| `media` | 60 | unique `storage_key`; check `size_bytes > 0`; idx `(kind, created_at)`; soft delete `deleted_at` | admin_users `uploaded_by_id` (SET NULL) |
| `currencies` | 2 | PK `code`, check `^[A-Z]{3}$` | none |
| `branches` | 2 | unique `slug`; `address_lines text[]`; shared SEO columns | media banner/thumbnail/og (SET NULL) |
| `destinations` | 10 | unique `slug`; `facts jsonb` | media hero/thumbnail/og (SET NULL) |
| `package_categories` | 9 | unique `slug` | none |
| `hotels` | 0 | unique `slug`; check star 1–5, rating 0–5 (`numeric(2,1)`) | media primary (SET NULL) |
| `activities` | 10 | unique `slug`; idx `destination_id` | media (SET NULL), destinations (SET NULL) |
| `activity_prices` | 20 | PK `(activity_id, currency_code)`; `amount numeric(12,2) >= 0` | activities (CASCADE), currencies (ON UPDATE CASCADE) |
| `packages` | 12 | unique `slug` + slug format check; days > 0, 0 ≤ nights ≤ days; idx `(branch_id,status)`, `destination_id`, `(status,display_order)`; soft delete; `search_text` (denormalised) | branches (RESTRICT), destinations (RESTRICT), categories (SET NULL), media hero/og (SET NULL), admin_users created/updated by (SET NULL) |
| `package_images` | 36 | PK `(package_id, media_id)`, `display_order` | packages (CASCADE), media (RESTRICT) |
| `package_inclusions` / `package_exclusions` | 71 / 56 | idx `package_id`, `display_order` | packages (CASCADE) |
| `package_highlights` | 63 | idx `package_id`; `icon` | packages (CASCADE) |
| `package_prices` | 72 | unique `(package_id, currency_code, price_type)`; amount ≥ 0 | packages (CASCADE), currencies |
| `package_hotels` | 0 | nights > 0; `is_default`; idx `package_id` | packages (CASCADE), hotels (RESTRICT) |
| `package_activities` | 0 | PK `(package_id, activity_id)` | packages (CASCADE), activities (RESTRICT) |
| `itinerary_days` | 65 | unique `(package_id, day_number)`, day > 0; `meals meal[]` | packages (CASCADE), hotels (SET NULL), media (SET NULL) |
| `itinerary_activities` | 14 | idx `itinerary_day_id`; `time` (time of day) | itinerary_days (CASCADE), activities (SET NULL) |
| `itinerary_pdfs` | 4 | unique `(package_id, version)`; idx `(package_id, content_hash)` | packages (CASCADE), media ×2 (RESTRICT), admin_users (SET NULL) |
| `testimonials` | 10 | check rating 1–5; idx `(is_published, display_order)`; soft delete; `reviewed_at date` | media (SET NULL), packages (SET NULL) |
| `hero_slides` | 6 | idx `(is_published, display_order)` | media (RESTRICT, required) |
| `site_content` | 10 | PK `key`; `value jsonb` (validated per key in `content.ts`) | admin_users (SET NULL) |
| `enquiries` | 0 | check: email, phone or WhatsApp present; adults ≥ 1, total travellers ≤ 60; idx `(status, created_at)`, `package_id`, `branch_id`; `travel_date date` | branches, packages (SET NULL), currencies |
| `enquiry_notes` | 0 | idx `enquiry_id` | enquiries (CASCADE), admin_users (SET NULL) |

\* Row counts from the local development database, read on 2026-10-12 inside a `BEGIN READ ONLY` transaction (the
database server was started, read and stopped again; nothing was written).

**Behaviour the database enforces today that MongoDB will not.** Each of these needs an explicit replacement:

1. **Foreign keys on insert/update.** An unknown `bannerImageId` currently fails with `400 INVALID_REFERENCE`
   (`app.ts`, PG code 23503). Packages check branch/destination/category/hero explicitly (`assertReferences`), but
   `ogImageId` and the image fields of branches, destinations, hotels, activities, testimonials and hero slides rely on
   the database.
2. **RESTRICT on delete** returns `409 IN_USE`, e.g. deleting a branch that has packages (covered by
   `catalog.test.ts`), a hotel used by a package, or an activity linked to a package.
3. **SET NULL on delete**: deleting a destination clears `activities.destination_id`; deleting a category clears
   `packages.category_id`; deleting a hotel clears `itinerary_days.hotel_id`; deleting an activity clears timeline
   links. **CASCADE**: an activity's prices go with it.
4. **Unique constraints** map to `409 CONFLICT` with a field path (`slug`, `email`, `code`), covered by tests.
5. **Check constraints** (ranges, slug format, contact present) duplicate Zod rules; the Zod rules stay.
6. **`numeric(12,2)`** rounds amounts to 2 decimals. Package prices are rounded in Zod already; activity prices and
   enquiry estimates are not.
7. **Transactions** wrap every write together with its audit row, and `assertStillPublishable` rolls back an edit
   that would leave a live package incomplete (`PUBLISHED_INCOMPLETE`, tested).

---

## 3. MongoDB collection and model proposal

### Principles

- **IDs:** `_id: String` holding a UUID (`default: () => crypto.randomUUID()`); natural keys stay natural
  (`currencies._id = "INR"`, `site_content._id = "home.hero"`). Responses expose `id`, never `_id` or `__v`.
- **Field names:** identical to today's Drizzle property names (`heroImageId`, `shortDescription`, `seoTitle`...).
  Several DTOs spread whole rows (`withImages(row)`, `activityDtos`, enquiries, the package editor, categories), so the
  JSON keys stay identical only if the field names do.
- **Nulls:** every nullable field gets `default: null` and the ETL writes explicit nulls. Otherwise JSON would *omit*
  keys that are `null` today.
- **Types:** amounts are `Number` with a 2-decimal rounding setter (not `Decimal128`, which serialises as
  `{"$numberDecimal": ...}`); `date` columns stay `"YYYY-MM-DD"` strings (no time-zone shift); timeline `time` becomes
  `"HH:MM"`; `jsonb` becomes nested subdocuments (`facts`) or `Mixed` (`audit_logs.metadata`, `site_content.value`).
- **Collection names:** set explicitly, the same snake_case as the tables, for traceability.
- **Validation:** Zod stays the first line at the API boundary. Mongoose schemas repeat the essential constraints
  (`enum`, `min`/`max`, `match`, `required`) as a second line, with `mongoose.set("runValidators", true)` and
  `strictQuery: true`.

### Collections (16)

| Collection | From | Embedded | References (UUID) | Indexes (✱ unique) |
| --- | --- | --- | --- | --- |
| `admin_users` | admin_users | none | none | ✱ `email` (`lowercase: true`) |
| `admin_sessions` | admin_sessions | none | `adminUserId` | ✱ `tokenHash`; `adminUserId` |
| `audit_logs` | audit_logs | `metadata` | `adminUserId` | `{entity, entityId}`; `{createdAt: -1}` |
| `media` | media | Cloudinary metadata (section 6) | `uploadedById` | `{kind, createdAt: -1}`; ✱ `storageKey` (partial); ✱ `cloudinary.publicId` (partial) |
| `currencies` | currencies | none | none | `_id` = code |
| `branches` | branches | `addressLines`, SEO fields | `bannerImageId`, `thumbnailImageId`, `ogImageId` | ✱ `slug`; `{displayOrder, name}` |
| `destinations` | destinations | `facts[{label, value}]` | `heroImageId`, `thumbnailImageId`, `ogImageId` | ✱ `slug` |
| `package_categories` | package_categories | none | none | ✱ `slug` |
| `hotels` | hotels | none | `primaryImageId` | ✱ `slug` |
| `activities` | activities + activity_prices | `prices[{currencyCode, amount}]` | `imageId`, `destinationId` | ✱ `slug`; `destinationId` |
| `packages` | packages + 9 child tables | see below | `branchId`, `destinationId`, `categoryId`, `heroImageId`, `ogImageId`, `createdById`, `updatedById` | ✱ `slug`; `{branchId, status}`; `destinationId`; `categoryId`; `{status, displayOrder}` |
| `itinerary_pdfs` | itinerary_pdfs | none | `packageId`, `withLogoMediaId`, `withoutLogoMediaId`, `generatedById` | ✱ `{packageId, version}`; `{packageId, contentHash}` |
| `testimonials` | testimonials | none | `imageId`, `packageId` | `{isPublished, displayOrder}`; `packageId` |
| `hero_slides` | hero_slides | none | `imageId` (required) | `{isPublished, displayOrder}` |
| `site_content` | site_content | `value` | `updatedById` | `_id` = key |
| `enquiries` | enquiries + enquiry_notes | `notes[{_id, adminUserId, body, createdAt}]` | `branchId`, `packageId`, `currencyCode` | `{status, createdAt: -1}`; `packageId`; `branchId`; `{createdAt: -1}` |

### The package document

```text
packages {
  _id, branchId, destinationId, categoryId|null, title, slug, shortDescription, description,
  durationDays, durationNights, bestTime|null, arrivalAirportCode|null, arrivalCity|null,
  heroImageId|null, keywords[], importantInfo[], status, displayOrder, isFeatured, isRecommended,
  searchText, seoTitle|null, seoDescription|null, canonicalUrl|null, ogTitle|null, ogDescription|null,
  ogImageId|null, noindex, publishedAt|null, deletedAt|null, createdById|null, updatedById|null,
  createdAt, updatedAt,

  gallery:     [mediaId, ...]                                   // was package_images, array order = display order
  highlights:  [{ title, description|null, icon|null }]
  inclusions:  [{ title, description|null }]
  exclusions:  [{ title, description|null }]
  prices:      [{ currencyCode, priceType, amount }]             // same shape priceTable() already consumes
  hotels:      [{ hotelId, nights, roomType|null, mealPlan|null, isDefault }]
  activityIds: [activityId, ...]
  itinerary:   [{ dayNumber, title, description, stay|null, hotelId|null, meals[], imageId|null,
                  activities: [{ time|null ("HH:MM"), title, description|null, location|null, type, activityId|null }] }]
}
```

**Why embed these:** the editor always loads the whole graph (`loadPackageGraph`); each section is saved by replacing
it wholesale (today: delete all rows, insert new ones); none of the child row IDs or timestamps appear in any API
response (checked against `packageDetail`, `packageEditorDto` and the PDF model); and the sizes are bounded by Zod
(≤ 90 days × ≤ 30 timeline entries, ≤ 60 prices, ≤ 30 photos), so documents stay far below 16 MB. A section save then
becomes one atomic `updateOne`, and the 9-way join becomes a single read plus a few lookups by ID (branch,
destination, category, hotels, activities, media).

**Why reference the rest:** branches, destinations, categories, hotels, activities and media are reused across
packages and edited on their own (a renamed destination must show everywhere). Media in particular is a shared library
("upload once, reuse anywhere"), and alt text, focal point and soft delete apply to every use.

`itinerary_pdfs` stays separate because versions grow without bound. Enquiry notes are embedded because they are only
read with their enquiry. Their `id` *is* returned by the API, so they keep a UUID `_id`.

### Replacing what PostgreSQL enforced

| Today (PostgreSQL) | MongoDB replacement |
| --- | --- |
| FK on insert/update → `400 INVALID_REFERENCE` | `crudRoutes` gets a `refs` map (field → model, plus `kind: "IMAGE"` for media). It checks existence before writing; packages extend `assertReferences` to `ogImageId`, gallery, hotels, activities and day images (most already exist as `assertAllExist`) |
| RESTRICT → `409 IN_USE` | per-entity `inUse(id)` checks inside the delete transaction: branch/destination → any package (including soft-deleted, as today); hotel → `packages.hotels.hotelId`; activity → `packages.activityIds`; media is only ever soft-deleted |
| SET NULL / CASCADE | explicit `updateMany` in the same transaction: destination delete → `activities.destinationId = null`; category → `packages.categoryId = null`; hotel → `itinerary.$[d].hotelId = null` with arrayFilter `d.hotelId = id`; activity → `itinerary.$[].activities.$[a].activityId = null` with arrayFilter `a.activityId = id`. Activity prices are embedded, so they cascade automatically |
| `23505` unique → `409 CONFLICT` + field | Mongo error `11000`: read `keyPattern` to derive the field (`slug`, `email`, `_id` of currencies → `code`) |
| `23514` check → `400 CONSTRAINT_VIOLATION` | Mongoose `ValidationError` → same code and shape |
| `22P02` → `400 INVALID_VALUE` | Mongoose `CastError` → same |
| Transactions | `mongoose.connection.transaction(fn)`. Atlas clusters (M0 included) are replica sets. Every query inside must pass `{ session }`; the rollback test (`PUBLISHED_INCOMPLETE`) proves it |
| `refreshSearchText` keeps `updated_at` | `updateOne(..., { timestamps: false })` |
| `ILIKE '%q%'` / `LIKE base%` | `$regex` on **escaped** input (`escapeLike` becomes `escapeRegex`), `i` flag where ILIKE was used |
| `ORDER BY adult price NULLS LAST` | aggregation: `$addFields` the adult price for the chosen currency plus a "missing" flag; sort by flag, then price |
| `count() ... GROUP BY` | `$group` aggregation (`listPublicBranches`, `listPublicDestinations`) |
| joins for list filters (branch/destination/category slug, country, active flags) | resolve the small lookup collections to ID sets first, then one `find`/`countDocuments` on packages with the same filter |

---

## 4. Affected source files and dependencies

### Source files

| Change | Files |
| --- | --- |
| **Replace** | `src/db/client.ts` (mongoose connection), `src/db/schema.ts` (Mongoose models; enum value lists move to a constants module because `packages/input.ts` imports them), `src/db/migrations.ts` + `src/db/verify.ts` (index sync + index/validator verification), `src/db/schema.test.ts`, `src/scripts/migrate.ts`, `src/scripts/verify-schema.ts`, `src/scripts/test.ts` (in-memory replica set), `src/scripts/dev-db.ts` (removed in cleanup) |
| **Heavy port** | `packages/service.ts`, `packages/read.ts`, `packages/search-text.ts`, `crud.ts` (generic over models; refs/inUse/set-null rules), `pdf/service.ts`, `enquiries.ts`, `dashboard.ts`, `auth/service.ts`, `media/routes.ts`, `storage.ts` (Cloudinary provider), `scripts/seed.ts` |
| **Light port** | `admin-users.ts`, `audit.ts` (session param), `auth/routes.ts`, `branches.ts`, `destinations.ts`, `catalog.ts`, `currencies.ts`, `content.ts` (upsert), `hero-slides.ts`, `testimonials.ts`, `search.ts`, `shared.ts` (`uniqueSlug`, types), `media/dto.ts` (`loadImages`, URL from metadata), `media/files.ts` (redirect for migrated files), `public-routes.ts` (categories, preview), `packages/input.ts`, `packages/routes.ts`, `scripts/create-admin.ts`, `scripts/set-admin-credentials.ts` (added 2026-10-12) |
| **App wiring** | `app.ts` (error mapping, `/health` ping), `server.ts` (`mongoose.disconnect()` on shutdown), `config/env.ts` (new variables), `lib/text.ts` (`escapeRegex`), `lib/logger.ts` (also redact `uri`, `apiKey`/`api_key`, `connectionString`) |
| **Tests** | `test/helpers.ts` (`signIn` and `catalogue` insert directly), `auth/auth.test.ts` (7 direct DB calls), `packages/packages.test.ts` (1), `testimonials.test.ts` (1), `pdf/pdf.test.ts` (imports the schema for `loadPackageGraph`). Every HTTP-level assertion stays as it is |
| **Unchanged** | `lib/crypto.ts`, `lib/errors.ts`, `lib/http.ts` (`idParam` keeps validating UUIDs), `lib/money.ts`, `lib/rate-limit.ts`, `pricing.ts`, `revalidate.ts`, `pdf/render.ts`, `pdf/template.ts`, `auth/middleware.ts`, `admin-routes.ts`, `src/assets/*` |
| **Delete in cleanup** (after sign-off) | `drizzle.config.ts`, `drizzle/` (migration SQL + snapshot), `src/scripts/dev-db.ts` |
| **Config** | `package.json` (deps, scripts, `engines` → `>=20.19`), `package-lock.json`, `.env.example`, `README.md`. `.gitignore` already ignores `.env`, `.data`, `storage` |
| **Docs** (repo root `/docs`, not under git) | `ARCHITECTURE.md`, `DATABASE.md` (rewrite), `DEPLOYMENT.md`, `API.md` (image URL host), `PDF.md`, root `README.md` |
| **Other repos** (separate approval) | `getset-itinerary-frontend/next.config.ts` (`images.remotePatterns` must allow Cloudinary, see section 8); frontend `VERCEL_DEPLOYMENT.md` and `.env.example` comment. The admin needs no change: it renders images with plain `<img>` and streams PDFs through the API |

### Dependencies

| Action | Package | Latest checked 2026-10-12 | Note |
| --- | --- | --- | --- |
| add | `mongoose` | 9.11.1 | requires **Node ≥ 20.19**, so `engines` must rise from `>=20.12` (local Node is 20.20.0; the API host must match) |
| add | `cloudinary` | 2.11.0 | official SDK (signed upload, `upload_stream`, signed/authenticated URLs, destroy). The alternative is about 40 lines of signed `fetch` calls; the SDK is the boring choice for signature correctness |
| add (dev) | `mongodb-memory-server` | 11.3.0 | Node ≥ 20.19; downloads a `mongod` binary on first run (cached) |
| remove (cleanup) | `drizzle-orm`, `pg`, `@types/pg`, `drizzle-kit`, `embedded-postgres` | none | Keep them until the data migration is signed off: the ETL reads PostgreSQL with `pg`, and `npm run db:dev` starts the source database |
| keep | `hono`, `@hono/node-server`, `zod`, `playwright-core`, `tsx`, `typescript` | none | none |

Exact versions are pinned at install time (Phase 2), not before.

### Scripts (`package.json`)

| Today | After |
| --- | --- |
| `db:dev` | removed after cleanup (development uses an Atlas dev database; `npm test` uses the in-memory server) |
| `db:generate`, `db:status`, `db:migrate`, `db:verify` | `db:indexes` (`syncIndexes` per model = *applied*) and `db:verify` (live indexes and validators match the models = *verified*). Index definitions in code = *created*. The three states are still reported separately per environment, as the original brief requires |
| `db:seed` | ported (uploads seed images through the configured storage provider; `--reset` stays development-only and only touches MongoDB) |
| none | `migrate:pg-to-mongo` (dry-run by default, `--apply`, `--verify`), `media:to-cloudinary` (dry-run by default, `--apply`, `--verify`). Both are temporary and removed in cleanup |

---

## 5. PostgreSQL to MongoDB migration strategy

### What the existing data is

Checked read-only on 2026-10-12 against the only PostgreSQL in use (`DATABASE_URL` points to the local embedded
server; no staging or production database exists):

- **Demo seed (2026-10-06 08:54 UTC):** all branches, destinations, categories, activities and prices, all 12
  packages (PUBLISHED, none edited since), 10 testimonials, 6 hero slides, 52 images. None of these rows was modified
  after seeding (`updated_at` = `created_at`). The seed's own note says the prices and itineraries are illustrative
  (only the Malaysia and Singapore AED adult prices are real). The branch contacts and Google reviews are real.
- **Created by hand (small, but not in the seed):**
  - `site_content["home.hero"]` was edited by the admin on 2026-10-07 14:18 UTC (the only edited content block).
  - One SUPER_ADMIN account with its scrypt password hash. Its email and password were changed in place on 2026-10-12
    (`npm run admin:credentials`; same id, role and history); `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` in `.env` match.
  - 4 generated PDF versions (8 files, 6.5 MB): derived data that can be regenerated, but old versions are history.
  - 43 audit log rows (44 after the 2026-10-12 credentials change) (logins, PDF builds, content edits). Some point at rows removed by an earlier `db:seed --reset`
    (it truncates content tables, not audit logs), so dangling `entityId`s are expected.
- **None:** enquiries (0), enquiry notes (0), hotels (0), package hotels (0), package-linked activities (0).

So nothing looks business-critical, but the hero edit, the admin account and the history would be lost by a plain
re-seed. **Decision needed (section 12, Q1):** copy the data (recommended), or start fresh from the seed.

### Recommended: a read-only, re-runnable ETL

`npm run migrate:pg-to-mongo` (temporary script):

1. **Source:** PostgreSQL via `DATABASE_URL`, inside `BEGIN READ ONLY`. It never writes to PostgreSQL. Raw SQL with
   `pg`, so the script does not depend on the Drizzle schema that is being removed.
2. **Target:** `MONGODB_URI` + `MONGODB_DB_NAME`. Writes are `replaceOne({_id}, doc, {upsert: true})`, so re-runs
   are safe and need no drop step. Without `--apply` it only reports what it would write.
3. **Transforms:**
   - UUIDs are kept as `_id`; `currencies.code` and `site_content.key` become `_id`.
   - The 9 package child tables are embedded, ordered by `display_order` (or `day_number`); timeline entries go
     inside their day. Child row IDs and child timestamps are dropped (never exposed).
   - `activity_prices` → `activities.prices`; `enquiry_notes` → `enquiries.notes` (keeping note IDs).
   - `time` `"10:30:00"` → `"10:30"`; `date` stays `"YYYY-MM-DD"`; numerics → numbers; `jsonb` → objects;
     `text[]`/`meal[]` → arrays; every nullable column written as an explicit `null`.
   - Password hashes, session token hashes, `search_text`, `published_at`, `created_at`/`updated_at` are copied
     verbatim. Existing passwords keep working.
   - `media.storage_key` is kept (still served by the `local` provider until the Cloudinary step).
4. **Ordering:** referenced collections first (media, users, currencies, branches, destinations, categories, hotels,
   activities), then packages, PDFs, testimonials, hero slides, content, enquiries, sessions, audit logs. Indexes are
   synced before loading, so a duplicate surfaces as an error instead of being silently accepted.
5. **Verification (`--verify`, exits non-zero on any difference):**
   - Counts per collection **and** per embedded array, against the source (expected today: packages 12, gallery 36,
     highlights 63, inclusions 71, exclusions 56, prices 72, itinerary days 65, timeline entries 14, activities 10,
     activity prices 20, media 60, testimonials 10, hero slides 6, content blocks 10, PDF versions 4, audit logs 44,
     admin users 1).
   - For each record: a SHA-256 of the canonical, API-visible fields computed from both sides must match.
   - Referential scan: every `*Id` field in MongoDB resolves (0 dangling references, except audit `entityId`, which is
     free text by design).
   - All unique indexes are present.
6. **API parity check (the strongest test of the whole port):** run the PostgreSQL build (git tag, see Phase 1) and
   the MongoDB build side by side, both with `STORAGE_PROVIDER=local` and the same `API_URL`, and diff the JSON of
   every public endpoint (settings, branches, destinations, categories, every package detail, listings with each sort
   and currency, search, testimonials, hero slides, quotes) and the admin read endpoints. Expected diff: none.

**Freeze rule:** if real content gets entered in the PostgreSQL admin before cut-over, the final ETL run happens
after admin edits stop. Re-running is safe, so a rehearsal run followed by a final run costs nothing.

**Rollback:** PostgreSQL and `storage/` are never modified. Until cut-over, rollback = run the tagged PostgreSQL
build. After cut-over, content created in MongoDB would not flow back (no reverse ETL is planned).

### Alternative: fresh seed

Port `seed.ts` to MongoDB (needed anyway for new environments), seed, recreate the admin with `SEED_ADMIN_*`, and
retype the `home.hero` text. This is less code, but new UUIDs, no audit or PDF history, and no parity diff (IDs and
timestamps differ).

---

## 6. Cloudinary integration strategy

### Today

- **One upload endpoint:** `POST /api/admin/media` (multipart `file`, optional `alt`, `focalPoint`; EDITOR+). It
  checks size ≤ 10 MB and sniffs the real type from the first bytes (JPEG, PNG, WebP, AVIF only; SVG and renamed
  files refused). It writes `images/YYYY/MM/<uuid>.<ext>` to disk and inserts a `media` row.
- **Generated files:** `pdf/service.ts` writes `documents/itineraries/<packageId>/v<n>-<branding>.pdf` and two
  `media` rows (`kind: DOCUMENT`) per version.
- **Delivery:** `GET /media/images/*` streams from disk with `Cache-Control: immutable` (one year). The API builds
  image URLs at read time as `${API_URL}/media/<key>`, so rows store keys, not URLs. PDFs are streamed by
  `/api/public/packages/:slug/pdf` and the admin PDF routes, never from `/media`.
- **Local filesystem dependencies:** `storage.ts` (fs `put`/`get`/`rm`), `media/files.ts`, `pdf/service.ts`
  (`storage.get` to embed photos into the PDF HTML and to stream PDFs), `scripts/seed.ts` (reads `seed/images`,
  `--reset` deletes `storage/images` and `storage/documents`), `scripts/test.ts` (temp storage dirs),
  `test/helpers.ts` (`PHOTO` from `seed/images`). The logo and fonts (`src/assets`) are bundled build assets read
  with `readFileSync`, not user media; they stay local.

### Design

1. **Keep the `Storage` interface and add a `cloudinary` provider.** `STORAGE_PROVIDER=local|cloudinary`. `local`
   stays for tests and offline development, so `npm test` never touches the network or the real Cloudinary account.
   The interface changes slightly: `put` returns the stored file's metadata (Cloudinary decides `version`,
   `format`, dimensions), and `get`/`url` take the media document instead of a bare key.
2. **Uploads stay server-side and signed.** The admin's browser never talks to Cloudinary. The admin server sends the
   file to the API (as today), the API validates (size, byte sniffing, alt, focal point; all unchanged), then calls
   `upload_stream` with:
   - `public_id: "<CLOUDINARY_FOLDER>/images/<mediaId>"`, which is deterministic and lets the migration be idempotent
   - `asset_folder: "<CLOUDINARY_FOLDER>/images"`: the account uses **dynamic folders** (verified in Stage A), where
     the `public_id` path alone does not place the asset in a Media Library folder
   - `resource_type: "image"`, `type: "upload"`, `overwrite: false`
   - Stage A verified that the delivered original is byte-identical to the uploaded file, and that `secure_url` is
     `https://res.cloudinary.com/<cloud>/image/upload/v<version>/<public_id>.<format>`
   No unsigned upload presets. If the database insert fails after a successful upload, the asset is destroyed
   (compensation), so no orphans are left.
3. **Delivery:** `ImageDto.url` = the stored `secure_url`
   (`https://res.cloudinary.com/<cloud>/image/upload/v<version>/<public_id>.<format>`). Versioned URLs are immutable,
   like today's. The original is delivered (no transformation credits); the website's Next image optimiser still
   produces AVIF/WebP. Later option: a Cloudinary loader with `f_auto,q_auto,w_*` to offload resizing from Vercel.
4. **Archive (soft delete) keeps the asset**, as today ("still resolvable where already used"). Cleaning up truly
   unused assets is a separate, later job.
5. **PDF photos:** `embedImage` fetches the image bytes from `secure_url` (timeout; a failure becomes `null`, as a
   missing file does today). The renderer already downscales to print size.
6. **PDF files (decision 2, approved: Cloudinary private storage).** Cloudinary `resource_type: "raw"`,
   `type: "authenticated"`, `public_id: "<CLOUDINARY_FOLDER>/documents/itineraries/<packageId>/v<n>-<branding>.pdf"`.
   The API fetches the bytes server-side through `cloudinary.utils.private_download_url(...)` (an `api.cloudinary.com`
   download URL signed with the API secret, expiring after a few minutes) and streams them with the same headers as
   today (`Content-Disposition` file name, `X-Pdf-Version`, cache headers). Public PDF URLs do not change, and no
   Cloudinary URL ever reaches the browser.
   **Verified in the Stage A spike (2026-10-12, Free plan):**
   - unsigned `raw/authenticated` → 401; `raw/upload` → 404; the upload response's `secure_url` → 401
     ("deny or ACL failure"). The PDF is not public.
   - signed CDN URL (`sign_url`) → 401 "deny or ACL failure". This is the Free plan's PDF/ZIP delivery block, so CDN
     delivery is **not** used.
   - `private_download_url` → 200, `application/pdf`, bytes identical to the source. An expired link → 401
     ("Stale request"); a tampered signature → 401.
   - Therefore **no account setting change is needed** ("Allow delivery of PDF and ZIP files" stays off).
   - Checked in Stage E: private download responses carry no `x-featureratelimit-*` headers, so they do not appear to
     count against the Admin API hourly limit. No PDF cache was added; add one per version (versions are immutable) if
     Cloudinary ever starts limiting downloads.
   GridFS is not used. Per decision 2 it is not a silent fallback.
7. **Configuration:** `cloudinary.config({ cloud_name, api_key, api_secret, secure: true })` from `CLOUDINARY_*`,
   once at start-up, only when the provider is `cloudinary`.

### Database fields that store Cloudinary metadata

Only the `media` collection. Every entity keeps pointing at media by ID (`bannerImageId`, `heroImageId`, `gallery[]`,
`imageId`, `primaryImageId`, `withLogoMediaId`...), so a re-upload or provider change never touches packages or
branches.

```text
media {
  _id, kind ("IMAGE" | "DOCUMENT"), fileName, mimeType, sizeBytes, altText, focalPoint|null,
  uploadedById|null, createdAt, deletedAt|null,
  storageKey|null,          // local disk key ("images/2026/10/<uuid>.jpg"); kept on migrated files as the legacy key
  cloudinary: null | {
    publicId,               // "getset/production/images/<mediaId>" (unique)
    secureUrl,              // what ImageDto.url returns
    version, format,        // from the upload response
    resourceType,           // "image" | "raw"
    type,                   // "upload" (public) | "authenticated" (PDFs)
    width, height, bytes    // from the upload response; width/height stored but not exposed yet
  }
}
```

Read rule: `cloudinary ? cloudinary.secureUrl : ${API_URL}/media/${storageKey}`.

### Where each image feature lives

| Feature | Field(s) | Today (dev data) |
| --- | --- | ---: |
| Homepage hero images | `hero_slides.imageId` | 6 |
| Branch banners / office photos | `branches.bannerImageId`, `branches.thumbnailImageId` | 2 / 2 |
| Destination images | `destinations.heroImageId`, `thumbnailImageId` | 10 / 0 |
| Package hero images | `packages.heroImageId` | 12 |
| Package galleries | `packages.gallery[]` | 36 |
| Itinerary day images | `packages.itinerary[].imageId` | 0 |
| Hotel images | `hotels.primaryImageId` | 0 |
| Activity images | `activities.imageId` | 0 |
| Testimonial profile photos (with consent only) | `testimonials.imageId` | 0 |
| Share images (Open Graph) | `branches/destinations/packages.ogImageId` | 0 |
| Itinerary PDFs | `itinerary_pdfs.withLogoMediaId`, `withoutLogoMediaId` → `media` (DOCUMENT) | 8 files |

68 image references point to 52 unique files: the seed reuses some photos across packages, destinations and hero
slides, which the shared media library supports by design.

---

## 7. Media migration requirements

**Inventory (verified):** `storage/images` holds 52 JPEGs (24.8 MB; the largest is 0.93 MB), every one referenced and
none archived. `storage/documents` holds 8 PDFs (6.5 MB). All 60 `media` rows have their file on disk (0 missing). The 52
images are the uploaded copies of the 52 files in `seed/images` (tracked in git). `src/assets` (logo, two fonts) is
bundled with the build and is **not** migrated.

`npm run media:to-cloudinary` (temporary script, run after the data is in MongoDB):

1. Dry run by default: lists what it would upload and the total size.
2. `--apply`: for each `media` document with `cloudinary: null`, upload the local file with the deterministic
   `public_id` (`overwrite: false`), then set `cloudinary` on the document. `storageKey` and the local file are kept.
   It is re-runnable: already-migrated documents are skipped, and an existing `public_id` is adopted, not duplicated.
3. PDFs: per decision Q2 (Cloudinary raw/authenticated, or GridFS).
4. `--verify`: every document has metadata; Cloudinary `bytes` equals `sizeBytes`; every `secure_url` answers
   `200` with an `image/*` type; images: 52 of 52.
5. **Old URLs keep working:** with the `cloudinary` provider, `GET /media/images/<key>` looks up the document by
   `storageKey` and answers `301` to its `secure_url`, or serves the local file if it is not migrated. Pages cached by
   the website (ISR), shared links and search engines may still hold old URLs.
6. **After cut-over:** trigger every revalidation tag once (`catalog`, `hero`, `testimonials`, `content`) so the
   website re-renders with Cloudinary URLs.
7. **Expected side effect:** the PDF content hash includes image URLs, so each package's PDF regenerates once on its
   next request (its version goes up by one). This is correct behaviour, not a bug.

**Nothing is deleted.** `storage/`, `seed/images` and `.data/postgres` stay until you explicitly approve removing them
after sign-off. `seed/images` stays in git for seeding and tests regardless.

---

## 8. API compatibility requirements

The contract in `docs/API.md` is unchanged: same paths, methods, status codes, error codes and response shapes. The
59 existing HTTP-level tests encode most of it and stay unmodified apart from their direct database lines.

| Area | Must stay exactly as today |
| --- | --- |
| Envelope | `{ success: true, data, meta? }` / `{ success: false, error: { code, message, details? } }`; `meta` = `{ page, pageSize, total, totalPages }` |
| IDs and fields | UUID strings under `id`; no `_id`/`__v`; identical camelCase keys; nullable fields present as `null`; ISO timestamps; `YYYY-MM-DD` dates; `HH:MM` times; numeric amounts |
| Errors | `VALIDATION_ERROR` (with `path`s), `CONFLICT` + `[{path:"slug"}]`/`email`/`code`, `IN_USE`, `INVALID_REFERENCE`, `CONSTRAINT_VIOLATION`, `INVALID_VALUE`, `*_NOT_FOUND`, `PUBLISH_BLOCKED`, `PUBLISHED_INCOMPLETE`, `LAST_SUPER_ADMIN`, `TOO_MANY_REQUESTS`, `PAYLOAD_TOO_LARGE`, `FILE_TOO_LARGE`, `UNSUPPORTED_FILE`, `STORAGE_ERROR`, `PDF_ERROR` |
| Authentication | `POST /api/auth/login` → `{ token, expiresAt, user }`; `Authorization: Bearer`; token stored only as SHA-256; scrypt hashes carried over so passwords keep working; same 401 for wrong password or unknown email; 403 `ACCOUNT_DISABLED`; inactive or expired → 401; rate limits; `POST /logout`, `GET /me`; preview tokens signed with `AUTH_SECRET` (`package:<uuid>`), unchanged |
| Branch and package management | every `/api/admin/*` route and role (EDITOR < ADMIN < SUPER_ADMIN); `PUT /:id/<section>` returns the full editor DTO; publish checklist; publish builds the PDF first; unpublish/archive; soft delete renames the slug `-deleted-<base36>`; duplicate; `PUT /order` reorders; editing a live package into an incomplete state is rolled back |
| Itinerary | `dayNumber` 1..n in order; timeline entries in order with `time`, `type`; `meals`; day hotel summary; day image |
| INR/AED | `/api/public/settings` → `{ defaultCurrency, currencies, content }`; price table `{ ADULT: { INR, AED }, CHILD: ..., INFANT: ... }`; `startingPrice`; `?currency=` with `minPrice`/`maxPrice` on the adult price; `price-asc`/`price-desc` with missing prices last; no conversion anywhere; the default currency cannot be switched off |
| Adult/child/infant | `POST /api/public/pricing/quote` (`calculateTotal`, unchanged); enquiry `estimatedTotal`; publish requires all three types in every active currency |
| Images | `ImageDto { id, url, alt, focalPoint }`; `url` absolute. **Compatibility gap:** the website's `next.config.ts` allows `next/image` sources only from `<API host>/media/**`, so Cloudinary URLs need one extra `remotePatterns` entry (`https://res.cloudinary.com/<cloud>/image/upload/**`) in the frontend repo (decision Q4). The admin uses plain `<img>`: no change. Old `/media/images/*` URLs redirect (section 7) |
| Enquiries | `POST /api/public/enquiries` → 201 `{ received: true, id }`; honeypot returns success and stores nothing; per-IP rate limit; past travel dates refused; admin search on name/email/phone/WhatsApp/package title; status and branch/package filters; notes with author name |
| Testimonials | public paging; published + not deleted only; per-package reviews on package pages; soft delete; audit `TESTIMONIAL_PUBLISHED`/`UNPUBLISHED` |
| PDFs | `GET /api/public/packages/:slug/pdf?branding=with-logo\|without-logo` → attachment named `getset-<slug>-itinerary(-no-logo).pdf`, `X-Pdf-Version`, `Cache-Control: public, max-age=300`; admin `GET`/`POST /:id/pdf` and `GET /:id/pdf/:version/:branding` (inline, private); the two prints differ only in the logo; versioning by content hash; concurrent requests share one build, and the unique `{packageId, version}` index stops duplicates across instances |
| Cache revalidation | same tags, same batching, same `x-revalidate-secret` header; send every tag once at cut-over |
| CORS and headers | origins `FRONTEND_URL` and `ADMIN_URL`; secure headers with `Cross-Origin-Resource-Policy: cross-origin`; public `GET` cache headers; 1 MB JSON limit, 10 MB upload limit |
| Health | `GET /health` → 200 `{ success: true, data: { status: "ok" } }` after a MongoDB `ping`; 500 JSON when the database is down, as now |

---

## 9. Authentication and security considerations

**Verified during this audit (values never printed):**
- `.env` is ignored by git (`.gitignore` line 3) and has never been committed. Only `.env.example` is tracked, with
  placeholder values.
- None of the secret values in `.env` (MongoDB URI and its password, Cloudinary key and secret, `AUTH_SECRET`,
  `REVALIDATE_SECRET`, the seed admin password) appear in any tracked file or anywhere in the git history of the
  backend, admin or frontend repositories.

**Plan:**
- **Secrets stay server-only:** in `.env` locally and real environment variables in production. `.env.example` gets
  the new names with placeholders only. `CLOUDINARY_API_SECRET` never reaches the admin or the browser (uploads are
  signed by the API).
- **Logging:** the logger already masks keys matching `pass|token|secret|authorization|cookie|hash`. Add `uri`,
  `apiKey`/`api_key` and `connectionString`, never log the env object or a connection string, and keep env
  validation errors to variable names only (as today).
- **Atlas:** a database user with `readWrite` on the application database only (not `atlasAdmin`); separate
  databases and users per environment; the network access list limited to the API host's egress IPs (if
  `0.0.0.0/0` is unavoidable on a PaaS, use a long random password and rotate it); TLS is on by default with
  `mongodb+srv`.
  - *Verified 2026-10-12:* the configured user `teamgetsetmedia_db_user` has `atlasAdmin@admin`: find, insert,
    update, remove, createIndex, dropCollection and **dropDatabase on every database** (including `config`), plus
    listDatabases. It cannot create or drop users (Atlas manages users). A least-privilege role exists in the project
    (`getsetAppReadWrite` = `readWrite@getset` only) but is not used.
  - **Owner's decision (2026-10-12): use `teamgetsetmedia_db_user` for development and production, accepting the
    risk. This configuration is not production-secure.** Risks: any leak of the API's environment (Render variables,
    a laptop `.env`, a log) exposes and endangers every database in the project; with one credential for development
    and production, a development mistake can damage production data and one environment cannot be revoked without
    the other; a typo in `MONGODB_DB_NAME` silently creates a new database instead of failing; Atlas logs cannot tell
    developer activity from the application's; and the Free tier has no backups to recover from any of this.
  - *Safeguards in the code (they reduce, not remove, the risk):* nothing in the application or scripts drops a
    database or collection; `db:indexes` never drops indexes; `migrate:pg-to-mongo` only inserts and never overwrites;
    `db:seed --reset` is refused in production and requires repeating the database name; the API reads and writes only
    the database named in `MONGODB_DB_NAME`; credentials never appear in logs (redacted). **M0 (free) has no automated backups.** Production needs a paid tier or a scheduled `mongodump`.
- **Cloudinary:** signed server-side uploads only, no unsigned presets; byte sniffing and the 10 MB limit stay
  *before* upload; enable **Strict Transformations** so outsiders cannot run paid transformations on public assets;
  PDFs as `authenticated`.
  - *Stage A inspection:* Strict Transformations is currently **off** (an unsigned `w_200` URL was generated). The
    account has 2 transformations, both Cloudinary's Media Library thumbnail (`t_media_lib_thumb`), both already
    `allowed_for_strict`. The application delivers originals only (no transformation in any URL), so turning Strict
    Transformations on would not break any application image or the Media Library. It is a console-only setting
    (Settings → Security), so it is a manual action for the account owner, verified afterwards.
- **NoSQL injection:** every input already passes Zod (strings, numbers and enums only; unknown keys stripped). Never
  pass request objects into filters; `strictQuery: true`; escape all user text used in `$regex` (inputs are already
  capped at 100 characters).
- **Auth data:** scrypt hashes and SHA-256 token hashes are copied verbatim; unique `tokenHash`; session expiry and
  inactive-account checks unchanged; existing sessions can be copied or dropped (dropping just means signing in again).
- **Audit integrity:** audit rows are written in the same transaction as the change, as today.

---

## 10. Environment variable requirements

Checked by name and shape only:

| Variable | In `.env` | Plan |
| --- | --- | --- |
| `MONGODB_URI` | present, non-empty | **required.** Shape is fine: `mongodb+srv://`, an Atlas `*.mongodb.net` host, credentials present and correctly encoded, no `<password>` placeholder. It has no database name in the path and no query options, which is fine: the name comes from `MONGODB_DB_NAME` (`dbName` option), and Atlas SRV records supply the replica set and auth source. Validate with `^mongodb(\+srv)?://` |
| `MONGODB_DB_NAME` | present, non-empty, valid characters | **required.** Use a different name per environment (e.g. `getset_dev`, `getset_staging`, `getset`); see Q5 |
| `CLOUDINARY_CLOUD_NAME` | present, non-empty | required when `STORAGE_PROVIDER=cloudinary` |
| `CLOUDINARY_API_KEY` | present, numeric (as expected) | required when `STORAGE_PROVIDER=cloudinary` |
| `CLOUDINARY_API_SECRET` | present, non-empty | required when `STORAGE_PROVIDER=cloudinary` |
| `CLOUDINARY_FOLDER` | not set (new) | optional, default `getset/${NODE_ENV}`; keeps dev, test and production assets apart in one cloud |
| `CLOUDINARY_URL` | not set | not needed (the three separate variables are used) |
| `STORAGE_PROVIDER` | `local` | becomes `local \| cloudinary` (`cloudinary` in staging and production) |
| `STORAGE_LOCAL_DIR` | present | kept for `local` (tests, offline dev, the not-yet-migrated fallback) |
| `DATABASE_URL` | present (local embedded PostgreSQL) | becomes optional, read only by `migrate:pg-to-mongo`; removed in cleanup |
| everything else | present | unchanged (`API_URL` still builds PDF links and local media URLs) |

None of the required names are missing or misspelled. No name in `.env` is unknown to the plan.

---

## 11. Testing and verification plan

1. **Existing suite as the contract.** All 59 tests keep their HTTP assertions. Only direct database access is ported:
   `test/helpers.ts` (2), `auth.test.ts` (7), `packages.test.ts` (1), `testimonials.test.ts` (1), `pdf.test.ts`
   (graph loader), and `schema.test.ts` becomes "every model's indexes exist and match".
2. **Test runner:** `MongoMemoryReplSet` (single node, so transactions work) instead of embedded PostgreSQL. One
   database per test file (like today's template copies), with indexes synced first, files still run 4 in parallel,
   and `STORAGE_PROVIDER=local` in temp directories. No Atlas, no Cloudinary, no network in `npm test`.
3. **New tests**, for behaviour PostgreSQL used to provide:
   - `INVALID_REFERENCE` for an unknown image/branch ID on every entity with references
   - `IN_USE` for a hotel/activity/destination still used
   - set-null on destination/category/hotel/activity delete
   - `11000` → `CONFLICT` with the field path
   - responses never contain `_id`/`__v`, and nullable fields are `null`, not missing
   - search with regex metacharacters (`a+b`, `(`, `.*`) neither errors nor over-matches
   - price sort with a missing price in one currency puts it last
   - an edit that fails after its write rolls back the write and its audit row
4. **Cloudinary provider:** unit tests with an injected fake uploader (public ID, metadata mapping, compensating
   destroy, redirect route). A live smoke script (`npm run cloudinary:smoke`: upload one image and one PDF to
   `<folder>/smoke`, fetch both, destroy both) runs only with your approval.
5. **Data migration:** `migrate:pg-to-mongo --verify` (counts, embedded counts, per-record hashes, zero dangling
   references, indexes), then the **old-vs-new API parity diff** (section 5).
6. **Media migration:** `media:to-cloudinary --verify` (52/52 images, bytes match, every URL 200 with an image type),
   and old `/media/images/*` URLs answer 301.
7. **End to end in a real browser** (Playwright with system Chrome, as used before on this project): homepage hero
   carousel, branch and destination pages, package page with hero and gallery, INR/AED toggle, the adult/child/infant
   selector total, both PDF downloads open, an enquiry submitted on the site appears in the admin. In the admin:
   sign-in, media upload (lands in Cloudinary), package edit and publish (the site refreshes), testimonial publish.
8. **Gates per phase:** `npm run typecheck`, `npm test`, `npm run build`, then `db:indexes` + `db:verify` reported
   as created / applied / verified for each environment separately.

---

## 12. Risks, assumptions and unresolved questions

### Risks

| Risk | Mitigation |
| --- | --- |
| Lost referential integrity (no foreign keys) | explicit `refs`/`inUse`/set-null rules (section 3), new tests, a dangling-reference scan in `db:verify` |
| Response drift (missing `null`s, `_id` leaks, number or date formats) | `default: null`, one `toApi` mapper on every read, exact parity diff before cut-over |
| A query inside a transaction that forgets `{ session }` | transaction helper passes the session; the rollback test catches misses |
| Old image URLs in cached pages, shared links, search engines | `/media/images/*` redirects; revalidate all tags at cut-over |
| Website images break if the frontend config is not updated | the `remotePatterns` change ships before or with the media cut-over (Q4) |
| Cloudinary blocks PDF delivery (free plan) | spike first; fallback B (GridFS) |
| Atlas M0 limits (512 MB, shared throughput, no backups) | fine for development; production tier or `mongodump` schedule (Q5) |
| Cloudinary free-plan credits | 25 MB of originals is trivial; bandwidth is limited because Next caches optimised images; Strict Transformations on |
| Node version on the future API host | Mongoose 9 needs Node ≥ 20.19; `engines` updated; check before deploy |
| Regex search scale | fine for dozens to hundreds of packages; add a text index only if search slows |
| One-time PDF version bump after the URL change | expected; noted in the release steps |

### Assumptions (my defaults unless you say otherwise)

- UUID string `_id`s (not ObjectIds), so no API or admin change is needed.
- The API stays one process on one host; the in-memory rate limits and PDF lock keep their existing `ponytail:`
  limits.
- Local development uses an Atlas development database; tests use the in-memory server.
- The API's public origin (`API_URL`) does not change at cut-over, so old media URLs can redirect.
- The plan document lives in the backend repository (`getset-itinerary-backend/docs/`), as requested. The older
  documentation lives in the repository root `/docs`.

### Questions that need your answer before implementation

1. **Existing data:** copy the local PostgreSQL data with the ETL (keeps IDs, the admin account and password, the
   edited homepage hero text, PDF and audit history; enables the exact parity check), **or** start fresh from the demo
   seed? Recommendation: ETL. Also: is there any PostgreSQL database other than the local one (the audit found none)?
2. **PDF storage:** Cloudinary raw/authenticated (A, recommended if the spike passes) or MongoDB GridFS (B)?
3. **Approval for two live checks in Phase 1:** (a) an Atlas connection `ping` (read-only); (b) a Cloudinary spike
   that uploads one test image and one test PDF to a `getset/spike` folder, fetches them, then deletes them.
4. **Frontend change:** may I later add the Cloudinary `remotePatterns` entry to
   `getset-itinerary-frontend/next.config.ts` (one config entry, no UI change)? Without it, website images break once
   media moves. The only alternative is proxying every image through the API, which defeats the CDN.
5. **Environments:** which environment is the current `MONGODB_DB_NAME` for (dev or production)? Which Atlas tier is
   the cluster (backups)? Where will the API be hosted? (This was still undecided on 2026-10-07; with Atlas and
   Cloudinary it no longer needs a persistent disk, but it still needs Chrome for PDFs.)
6. **Cloudinary settings you control:** OK to enable Strict Transformations and (for option A) PDF delivery? Folder
   naming `getset/<environment>`?
7. **Retention:** confirm that `storage/`, `.data/postgres` and the PostgreSQL code stay untouched until you approve
   removing them after sign-off.

---

## 13. Ordered implementation phases

Every phase ends with its gate. Nothing destructive happens in any phase without your explicit approval.

| # | Phase | Work | Gate |
| --- | --- | --- | --- |
| 0 | **Audit and plan** (this document) | none beyond this document | your approval |
| 1 | **Decisions and safety net** | answers to Q1–Q7; git tag `pre-mongodb` on the current backend commit (the rollback build and the parity reference); Atlas `ping`; Cloudinary spike (if approved) | tag exists; ping OK; spike result recorded |
| 2 | **Foundations** | install `mongoose`, `cloudinary`, `mongodb-memory-server` (pinned); `engines >=20.19`; env schema; connection + shutdown; models + indexes; `toApi` mapper; error mapping; `/health`; `db:indexes`/`db:verify`; test runner on an in-memory replica set; `.env.example` | typecheck; `db:indexes` + `db:verify` green on an empty dev DB |
| 3 | **Port modules** (storage stays `local`) | auth, admin users, audit → media → currencies, content → `crudRoutes` + reference rules (branches, destinations, categories, hotels, activities, testimonials, hero slides) → packages (read, service, search text) → pricing, search, recommendations → enquiries → dashboard → PDF service → seed + create-admin; port the 5 test files; add the new tests | full `npm test` green; `npm run build` |
| 4 | **Data migration** | `migrate:pg-to-mongo` dry run → `--apply` into the dev DB → `--verify` → old-vs-new parity diff | zero verification differences; zero parity diffs; your sign-off |
| 5 | **Cloudinary** | cloudinary provider; upload route on Cloudinary; PDF storage per Q2; `/media/images/*` redirect; `media:to-cloudinary` dry run → `--apply` → `--verify`; regenerate PDFs | 52/52 images verified; PDFs download (with and without logo); provider tests green |
| 6 | **Frontend/admin compatibility** | frontend `remotePatterns` (if Q4 approved, its own small commit in that repo); browser end-to-end checks (section 11.7); revalidate all tags | every page renders images; currency, traveller and PDF flows pass; admin flows pass |
| 7 | **Docs and cleanup** | update root `/docs` (ARCHITECTURE, DATABASE, DEPLOYMENT, API, PDF), backend README and frontend deployment notes; then, **only after your sign-off**, remove Drizzle, `pg`, `embedded-postgres`, `drizzle/`, `dev-db.ts`, the temporary migration scripts, and (separately approved) local `storage/` and `.data/postgres` | docs reviewed; final `typecheck` + `test` + `build` green |

Rough size: the backend has about 6,000 non-test source lines and 900 test lines. Phase 3 touches roughly half of the
source (mostly `db/*`, `packages/*`, `crud.ts`, the PDF service, enquiries, the dashboard and the seed); the other
phases are small.

---

## 14. Progress log

### Stage A: connectivity (2026-10-12), complete

- **Cloudinary:** credentials valid (Free plan, 0 of 25 credits used); account uses dynamic folders; only the 64
  starter samples exist. One test image and one private test PDF were uploaded to `getset/spike`, tested and deleted.
  Images: public delivery, bytes identical. PDFs (`raw`, `authenticated`): not public (401/404 unsigned); signed CDN
  delivery blocked by the Free plan; `private_download_url` works (200, identical bytes; expired or tampered links
  refused). No account setting was changed. Strict Transformations is off and safe to enable (manual).
- **Atlas** (new GETSET Itinerary project; the old exposed project was deleted by the owner): connected read-only; 3-member
  replica set, MongoDB 8.0.34, transactions working, database `getset` empty, `sample_mflix` present and untouched.

### Stage B: MongoDB implementation (2026-10-12), complete

- **Rollback point:** the last PostgreSQL version is commit `8165a2c` (on `origin/main`) plus this session's uncommitted
  work, saved as a verified patch in `../backups/backend-pre-mongodb-2026-10-12/` (no secrets; restore steps in its
  `RESTORE.md`). PostgreSQL tooling moved, unchanged in behaviour, to `src/legacy-postgres/` (`pg:*` scripts).
- **Code:** `mongoose` 9.11.1 (exact), `mongodb-memory-server` 11.3.0 (dev); `engines` `>=20.19`. New: `src/db/models.ts`
  (16 models, 25 index definitions, reference map), `src/db/client.ts` (connection; transactions with async local
  storage), `src/db/indexes.ts`, scripts `db:indexes`, `db:verify`, `migrate:pg-to-mongo`. Every module ported
  (auth, admin users, audit, media, currencies, content, CRUD entities with `refs`/`inUse`/`onDelete`, packages, PDFs,
  enquiries, dashboard, search, seed, admin scripts). Configuration: the API requires `MONGODB_URI` and
  `MONGODB_DB_NAME` and no longer reads `DATABASE_URL` (only `migrate:pg-to-mongo` and `pg:*` do).
- **Tests:** in-memory MongoDB **8.0.4** (newer 8.0 builds need macOS 14; this Mac runs 13.7). All 58 original tests
  pass unchanged apart from their direct database lines, plus 6 new integrity tests (invalid references, IN_USE,
  links cleared on delete, duplicate-field errors, no `_id`/`__v` and nulls kept in responses, regex characters in
  search, price sort with missing prices, transaction rollback, no dangling references). `npm run typecheck`: 0 errors.
  `npm run build`: passes.
- **Rehearsal (nothing touched PostgreSQL or Atlas):** a cold, byte-identical copy of `.data/postgres` ran on another
  port; `migrate:pg-to-mongo` copied it into a throwaway MongoDB: 191 documents inserted, no conflicts; `--verify`:
  every document identical field by field with the same ids, every embedded list complete (36 gallery photos, 63
  highlights, 71 inclusions, 56 exclusions, 72 prices, 65 itinerary days, 14 timeline entries, 20 activity prices),
  every reference resolves; a second `--apply` inserted 0 (idempotent); `db:verify` passed.
- **API parity:** the pre-migration PostgreSQL build (commit + patch) and the new MongoDB build answered the same 250
  requests (public pages, every package, sorts and filters in INR and AED, quotes, search, admin editor, PDF status of
  all 12 packages, PDF downloads): **246 identical, 4 identical apart from the order of items with equal "last
  updated" times (all 12 seeded packages share one timestamp), 0 different.** PDF content hashes match, so migrated
  PDFs are not rebuilt.
- **Atlas, read-only:** the new API connects and `/health` answers 200; `db:verify` reports 0 of 16 collections applied
  (expected before Stage C). Nothing was written to Atlas.

### Stage C: data migration to Atlas (2026-10-12), complete

- **Backups, verified before the first write:** in `../backups/postgres-2026-10-12/` (outside every repository; owner
  only; contains the admin password hash and audit history, so treat it as sensitive):
  - `pgdata/`: cold, byte-for-byte copy of `.data/postgres`, taken with PostgreSQL stopped cleanly. 1,419 files,
    each matching its SHA-256 in `pgdata.sha256`. Restored to a temporary copy, it started and answered queries.
  - `export/`: every table as JSON (27 tables, 588 rows) plus `manifest.json`. Each file re-read and re-hashed equals
    the manifest; each table's row count equals the restored database's.
  - `storage-before-stage-c.sha256`: checksums of the 60 files in `storage/`.
- **Source:** the temporary restored copy (identical to the backup). The original `.data/postgres` was never started.
- **Dry run against Atlas `getset`:** 191 documents to insert, 0 conflicts, 0 already present; counts equal the export.
- **Apply:** collections and indexes created in `getset` only; 191 documents inserted; 0 conflicts.
- **Verify:** every document identical field by field with the same ids; per-collection SHA-256 checksums of the
  canonical documents equal for all 16 collections; embedded lists complete (36 gallery, 63 highlights, 71 inclusions,
  56 exclusions, 72 prices, 65 itinerary days, 14 timeline entries, 20 activity prices); every reference resolves;
  `db:verify`: 16 of 16 collections with all 25 indexes.
- **Critical fields (15 spot checks, all pass):** admin account id, email, role, status, password hash and timestamps;
  the `home.hero` text edited on 7 October with its editor and time; all 72 prices and their totals per type and
  currency; all 4 PDF versions (package, version, content hash, files); all 60 media records and their files on disk;
  package slugs, statuses and publish times.
- **Second run:** `--apply` inserted 0 and reported 0 conflicts; the dry run then showed 0 to insert; verify passed.
- **API on Atlas vs the PostgreSQL build:** 137 public requests, 137 identical (read-only: no sign-in, no PDF
  downloads, so nothing was written). Verification re-run afterwards: still identical. The Atlas API logged 0 errors.
- **Untouched (verified):** the original `.data/postgres` matches its pre-migration checksums file for file; the backup
  is intact; `storage/` unchanged; on Atlas, `sample_mflix` has the same collections and document counts as before,
  and no database other than `getset` was created or changed.
- **Security:** the migration ran as `teamgetsetmedia_db_user` (`atlasAdmin@admin`), as agreed. This remains an accepted
  risk and **not a production-secure configuration** (section 9).

### Stage D: images to Cloudinary (2026-10-12), complete

- **Folder:** `getset/staging` (owner's choice for this dev/staging database); images at
  `getset/staging/images/<media id>`. Backend `.env` now has `STORAGE_PROVIDER=cloudinary` and
  `CLOUDINARY_FOLDER=getset/staging` (the only two keys changed).
- **Code:** `cloudinary` 2.11.0 (exact). `media.cloudinary` holds the verified asset (public id, secure URL, version,
  format, type, size, dimensions), with a unique index on the public id (26 indexes, applied and verified on Atlas).
  Image URLs come from it; new uploads go to Cloudinary when `STORAGE_PROVIDER=cloudinary` (removed again if the record
  cannot be saved); old `/media/images/<key>` addresses answer 301 to the Cloudinary URL; PDF photos are read from
  Cloudinary. `CLOUDINARY_*` are required at start-up when the provider is `cloudinary`. Tests: 66 in 10 files, all
  pass; Cloudinary is faked in tests. Typecheck and build pass.
- **Inventory (dry run):** 52 image records, each matched to an intact local file (present, same size, real JPEG); no
  unreferenced files, no missing originals; 8 PDF records left for Stage E.
- **Migration:** 52 uploaded; each verified before its record was updated (public id, image/upload, byte size,
  Cloudinary MD5 = local MD5, downloaded bytes = local original). 0 failures.
- **Verification:** `media:to-cloudinary --verify`: 52 of 52 delivered byte-identical; exactly 52 assets under the
  folder, no duplicates or strays. Re-running `--apply` uploaded nothing. A simulated crash between upload and record
  (52 records without metadata, in a throwaway database) adopted the existing assets: 0 uploads, still 52 assets.
- **Serving (API on Atlas, public endpoints, nothing written):** all 52 images the API references are Cloudinary URLs
  equal to their records, each downloads byte-identical to its original; all 52 old `/media/images/...` URLs redirect
  (301) to the right image; unknown addresses still 404; PDFs are not served from `/media` (unchanged). 0 errors logged.
- **No corruption:** a fresh restore of the PostgreSQL backup re-verified every Atlas document field by field (apart
  from the new `media.cloudinary`, excluded by design): all identical, media checksum unchanged since Stage C.
- **Untouched (verified):** local `storage/` (all 60 files, checksums unchanged), original `.data/postgres`, the
  backup, the 8 PDF records (no Cloudinary metadata), Atlas `sample_mflix` and every other database; on Cloudinary only
  `getset/staging/images` was added (112 images = 60 starter samples + 52; no raw/PDF files).
- **Known effects for later stages:** (1) the PDF content hash includes image URLs, so each package's next PDF request
  builds a new version (Stage E should regenerate deliberately); (2) the website's `next/image` does not yet allow the
  Cloudinary host (Stage F, authorised by decision 4), so a locally run website shows broken images until then; the
  admin uses plain `<img>` and is unaffected.

### Stage E: PDFs to Cloudinary (2026-10-13), complete

- **Backup first:** `backups/pdfs-2026-10-13/` (outside the repo): the 8 PDF files with a SHA-256 manifest, and
  `metadata.json` (4 `itinerary_pdfs`, their 8 document `media` records, the 3 packages) with its checksum. Both
  re-verified at the end of the stage: all OK.
- **Code:** prints are stored through `storeDocument` (media/store.ts): with `STORAGE_PROVIDER=cloudinary` as private
  `raw`/`authenticated` files at `<CLOUDINARY_FOLDER>/<key>`, read back by the API with a short-lived
  `private_download_url` (never logged, never sent to a browser) and streamed with the same headers and file names as
  before. New prints are named `documents/itineraries/<package>/v<n>-<print>-<hash12>.pdf`, so a file left by an
  interrupted run is only reused for identical content. The PDF content hash no longer includes image URLs (photos are
  embedded from their bytes and identified by media id), so moving images never creates a new version. The admin API
  keeps its former response shape (`versionDto` hides the storage metadata). `media:to-cloudinary --documents`
  migrates existing prints (same verify-then-record steps as images, plus a check that an unsigned URL is refused).
  New test `pdf/pdf-storage.test.ts` (private storage, inline and attachment downloads, publish reuses the print, a
  photo moving host makes no new version).
- **Existing PDFs:** the 8 files (4 versions of Malaysia, Bali and Georgia) uploaded at their original paths
  (`getset/staging/documents/itineraries/<package>/v<n>-with[out]-logo.pdf`), each verified (public id,
  raw/authenticated, size, MD5, downloaded bytes = backup) before its record was updated; unsigned access refused for
  all 8; re-running uploaded nothing. Records, version numbers, content hashes and package links unchanged.
- **Deliberate regeneration (admin API, 16 of 16 checks passed):** one new version per package (12): Malaysia v2,
  Bali v3, Georgia v2, the other 9 packages v1. Three simultaneous requests per package returned the same version (no
  duplicates); every old version is still listed unchanged and downloads byte-identical to the backup (8 of 8); both
  prints of every new version download in the admin (inline) and publicly (attachment, file names unchanged, identical
  bytes) (24 of 24); every new print is private (unsigned URL refused) and named with its content hash. Rendered photos,
  logo, ₹ and the dirham sign checked visually.
- **Render (Docker):** `Dockerfile` + `.dockerignore` (Node 22, Debian `chromium`, `fonts-dejavu-core`, runs as `node`;
  no `.env`, `storage/`, sources or docs in the image). Built and run locally (Colima) with the real configuration and
  `NODE_ENV=production`: `/health` 200 against Atlas; all 12 packages report their newest PDF as current (the content
  hash is the same on Linux as on macOS, so a deploy does not rebuild PDFs); the stored print downloads privately from
  Cloudinary; a fresh render (not stored) took 2.1 s with photos from Cloudinary, logo, ₹ and dirham sign correct;
  the public PDF download equals the stored file; old image URLs redirect (301). Nothing was written (Atlas counts
  unchanged). Image, base image and build cache removed afterwards; Colima stopped.
- **Atlas after the stage:** `itinerary_pdfs` 4 → 16, `media` 60 → 84, `audit_logs` 55 → 69 (12 `PDF_GENERATED`,
  1 sign-in, 1 sign-out). `sample_mflix` and every other database unchanged.
- **Cloudinary after the stage:** 112 images (unchanged) and 32 private raw files under `getset/staging/documents`
  (8 migrated + 24 new, 24.5 MB); no public raw files. Nothing outside `getset/staging/documents` was touched.
- **Untouched (verified):** `storage/` (60 files, checksums equal to the pre-Stage C manifest, the 8 local PDFs
  included), `.data/postgres`, all backups.
- **Checks:** 11 test files pass; typecheck and production build pass.

### Stage F: website and admin against Atlas (2026-10-13), complete

- **Change (website repo, uncommitted):** `next.config.ts` allows one more image source:
  `https://res.cloudinary.com/<cloud>/image/upload/**` for this account only, with no query strings (decision 4). The
  API's `/media/**` pattern stays for local storage. `VERCEL_DEPLOYMENT.md` updated to match. No UI or design change;
  the admin needed no change (it shows images with plain `<img>`).
- **Backup first:** `backups/atlas-getset-2026-10-13-pre-stage-f/` (every collection as EJSON + SHA-256 manifest),
  used afterwards to list every database change.
- **Image optimiser:** this account's photo → 200 (AVIF); another Cloudinary account, this account's raw (PDF) path,
  or an added query string → 400.
- **Website (production build + `next start`, API on Atlas; desktop 1440 px and phone 390 px):** all 28 sitemap pages
  plus `/wishlist` and `/account` on both (56 page loads): 551 images loaded (383 from Cloudinary, the rest the
  site's own files), none broken, none from the old `/media` path; 0 console errors, 0 failed requests, 0 API errors.
  On all 12 package pages, both sizes: title and every itinerary day shown; switching INR/AED changes every visible
  price to the right symbol and the API's amounts; every PDF link downloads the current version as an attachment
  named `getset-<slug>-itinerary(-no-logo).pdf`; a real click download works on desktop and phone. First requests
  for a new image size take about 0.9 s while Next.js encodes it, then come from its cache.
- **Admin (production build):** sign-in through the form; 31 pages (every section and all 12 package editors) with
  0 console errors, 0 failed requests, 66 images from Cloudinary, none broken; 32 of 32 PDF previews (current and older
  versions) stream inline. Write paths, each undone in the admin: content edit shown on the website after
  revalidation, then restored (value identical); image upload stored on Cloudinary byte-identical, thumbnail, alt
  text, archived; package duplicated into a draft, title, hero image (media picker), prices saved, itinerary shown,
  published (PDF built, private), visible on the website with a working PDF and admin preview, unpublished (gone from
  the website), deleted; sign-out ends the session. 30 of 30 checks passed (the package part was rerun after a fix to the test script's
  field selector; the first attempt's draft was deleted by the script's clean-up). The admin server logged "The destination
  stream closed early" when the test closed tabs while Next.js was still prefetching links (reproduced: 4 per cut-off,
  0 when prefetches finish); not an application fault.
- **Database changes (exactly, from the backup diff):** live packages, prices, PDFs, media and content unchanged in
  value. Added: 24 audit entries, 2 soft-deleted test packages (`dubai-city-highlights-copy-deleted-…`), 1 PDF version
  (the test package's) with its 2 PDF records, 1 archived test image record; `home.branches` and the admin user have
  new `updatedAt`/`lastLoginAt` only; 1 test sign-in session (left by an interrupted test run) expires on
  2026-10-13 21:31 UTC. Other databases unchanged.
- **Cloudinary changes:** 3 added (the archived test image under `getset/staging/images`, the test package's 2 private
  PDFs); nothing changed or removed. These test leftovers can be removed later on request.
- **Checks:** website lint, typecheck and production build pass; admin production build passes.

### Stage G: final verification and deployment checklist (2026-10-13), complete

Read-only apart from the new checklist document; nothing deployed, committed or deleted.

- **Code:** 11 test files, typecheck and production build pass.
- **Atlas:** `db:verify`: 16 collections, all 26 index definitions applied, every reference resolves. The app connects
  as `atlasAdmin@admin` (accepted risk); the role `getsetAppReadWrite` exists and inherits only `readWrite@getset`;
  the `getset_app` user cannot be listed through the driver (check in the console).
- **Cloudinary:** `media:to-cloudinary -- --verify`: 53 of 53 images and (`--documents`) 34 of 34 private PDFs delivered
  byte-identical; 87 assets under `getset/staging`, each with exactly one record.
- **Backups:** every manifest re-verified (PostgreSQL data copy 1,419 files and the untouched original, 27-table JSON
  export, 8 PDFs and metadata, the Stage F Atlas export, the 60 `storage/` files). Restores proven into a throwaway
  local MongoDB: a fresh `mongodump` of Atlas restored identical (documents and indexes, 16 of 16); the Stage F EJSON
  export loaded identical, and the app's `db:indexes` and `db:verify` pass on it; `--nsFrom/--nsTo` renaming works.
  The pre-migration backend rebuilds cleanly from commit `8165a2c` plus the saved patch.
- **Configuration:** local values checked by shape only; production values and domains do not exist yet. Secrets and
  local data are git-ignored, and the files a commit would include contain no credentials.
- **Test leftovers:** reviewed with their references; recommendations in the checklist, section 11. Nothing deleted.
- **Memory:** in the Render image under a hard 512 MB limit, one Node process + Chromium printed all 24 PDFs with a
  477 MB peak (460 MB under 1 GB); with an extra process in the container Chromium was killed for lack of memory.
  Recommendation: an instance above 512 MB (checklist, section 9). Docker images removed and Colima stopped afterwards.

### Itinerary PDFs: uploaded instead of generated (2026-10-14, code only; not committed or deployed)

The owner decided that GETSET does not need server-side PDF generation: an admin uploads a prepared PDF.

- **Workflow:** one PDF per package (`Package.itineraryPdfId` points at a `DOCUMENT` media record), uploaded, replaced,
  previewed and removed in the admin's PDF & publish tab. Checked on upload: not empty, up to 4 MB, declared
  `application/pdf`, and starting with `%PDF-`. Required to publish (enforced by the API). A live package's PDF can
  be replaced but not removed. Uploads go through the admin's server (Vercel limit 4.5 MB; a 4 MB upload measured
  4,194,645 bytes).
- **Storage:** the Stage E private storage (`raw/authenticated` under `CLOUDINARY_FOLDER`, read back with a signed link and
  streamed by the API). Replacing stores the new file first, switches the package in a transaction, then deletes the
  old file and its record; a failed deletion is logged (`pdf.file_delete_failed`) and the archived record kept.
- **Website:** one "Download itinerary (PDF)" button, or "not available yet" for packages without one.
- **Removed:** the Chromium renderer, template, version fingerprints, automatic rebuilds, the generate/status/version
  routes, `seed --pdfs`, `playwright-core`, the PDF fonts and logo, `PDF_BROWSER_*`, and Chromium in the `Dockerfile`
  (image 1.39 GB -> 385 MB; peak memory 477 MB -> 126 MB; Render Starter is enough).
- **Kept, untouched:** the legacy `itinerary_pdfs` collection and its 34 private files in `getset/staging/documents`,
  their media records, all backups. To be retired after production verification, with approval.
- **Verified:** backend 12 test files (13 new PDF tests); admin 16 unit tests, lint, typecheck, build; website lint,
  typecheck, build; an end-to-end browser run of all three apps on a throwaway local stack (21 of 21 checks); the
  Docker image against a throwaway MongoDB (4 MB upload, preview, removal). Nothing touched Atlas or Cloudinary.
