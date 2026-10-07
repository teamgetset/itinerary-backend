import { defineConfig } from "drizzle-kit";

// Only `generate` is used: it diffs src/db/schema.ts against the last migration snapshot, offline.
// Migrations are applied by `npm run db:migrate`, which records each one in the database.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  strict: true,
});
