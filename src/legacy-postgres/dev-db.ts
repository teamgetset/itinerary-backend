/**
 * Local PostgreSQL for development, from npm (no Docker or Homebrew needed).
 * Runs the server in the foreground on the port and database named in DATABASE_URL; Ctrl+C stops it.
 * Data lives in .data/postgres and survives restarts. Production uses any PostgreSQL via DATABASE_URL.
 */
import { existsSync, mkdirSync } from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

if (existsSync(".env")) process.loadEnvFile(".env");
const url = new URL(process.env.DATABASE_URL ?? "postgres://getset:getset@localhost:5433/getset");
const database = url.pathname.slice(1);
const dataDir = ".data/postgres";

const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  port: Number(url.port || 5432),
  persistent: true,
  // UTF-8 with the built-in collation: the same everywhere, no OS locales needed.
  initdbFlags: ["--encoding=UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"],
  onLog: () => {},
});

if (!existsSync(`${dataDir}/PG_VERSION`)) {
  mkdirSync(dataDir, { recursive: true });
  console.log("Creating a new local database cluster in .data/postgres ...");
  await server.initialise();
}
await server.start();
try {
  await server.createDatabase(database);
  console.log(`Created database "${database}".`);
} catch {
  // Already exists.
}
console.log(`PostgreSQL is running on port ${url.port}, database "${database}". Press Ctrl+C to stop.`);

const stop = async () => {
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
