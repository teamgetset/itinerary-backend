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

Itinerary PDFs are prepared outside GETSET and uploaded in the admin (PDF only, up to 4 MB; one per package, required to
publish). The API stores them privately (Cloudinary `raw/authenticated` under `CLOUDINARY_FOLDER`) and streams them at
`GET /api/public/packages/<slug>/pdf`; admin routes: `PUT`/`DELETE`/`GET /api/admin/packages/<id>/itinerary-pdf`.
Replacing or removing one deletes the old file; a file that cannot be deleted is logged (`pdf.file_delete_failed`) and its
media record kept, archived, for clean-up. The API no longer generates PDFs (no Chromium).

Deploy: the `Dockerfile` (Node 22) runs as a Render Docker service; configuration comes from the host's environment
variables, never from a file in the image.

Migration status and plan: [docs/MONGODB_CLOUDINARY_MIGRATION_PLAN.md](docs/MONGODB_CLOUDINARY_MIGRATION_PLAN.md).
Documentation: [../docs](../docs) (architecture, database, API reference, PDFs, deployment; to be updated for MongoDB).
