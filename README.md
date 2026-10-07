# GETSET API

REST API, PostgreSQL schema and itinerary PDF generation for GETSET Tours & Travels.
Node.js 20, TypeScript, Hono, Drizzle ORM, Zod, playwright-core (Chrome) for PDFs.

```bash
npm install
cp .env.example .env          # then set AUTH_SECRET and REVALIDATE_SECRET
npm run db:dev                # local PostgreSQL 18 (keep running)
npm run db:migrate && npm run db:verify
npm run db:seed               # demo content (SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD for a local admin)
npm run dev                   # http://localhost:4000
```

| Script | |
| --- | --- |
| `dev`, `build`, `start` | Run with reload; compile to `dist`; run compiled |
| `test` | All `*.test.ts` against a throwaway PostgreSQL (needs Chrome for PDF tests) |
| `typecheck` | TypeScript |
| `db:dev` | Local PostgreSQL from npm, data in `.data/postgres` |
| `db:generate`, `db:status`, `db:migrate`, `db:verify` | Create, inspect, apply and verify migrations (see docs/DATABASE.md) |
| `db:seed` | Demo catalogue into an empty database (`-- --reset`, `-- --pdfs`) |
| `admin:create` | `-- --email x --name "Y" --role SUPER_ADMIN` |

Documentation: [../docs](../docs) (architecture, database, API reference, PDFs, deployment).
