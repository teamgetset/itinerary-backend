/**
 * `npm test`: runs every src/**\/*.test.ts against a real, throwaway PostgreSQL.
 * Starts a temporary cluster, migrates a template database once, then gives each test file its own copy
 * (CREATE DATABASE ... TEMPLATE), so files run in parallel without sharing state.
 *   npm test -- packages     only files whose path contains "packages"
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

const root = new URL("../../", import.meta.url).pathname;
const filter = process.argv[2];
const files = (readdirSync(join(root, "src"), { recursive: true }) as string[])
  .filter((file) => file.endsWith(".test.ts") && (!filter || file.includes(filter)))
  .map((file) => join(root, "src", file))
  .sort();

const dir = mkdtempSync(join(tmpdir(), "getset-test-"));
const port = 20000 + Math.floor(Math.random() * 20000);
const server = new EmbeddedPostgres({
  databaseDir: join(dir, "pg"),
  user: "test",
  password: "test",
  port,
  persistent: false,
  initdbFlags: ["--encoding=UTF8", "--locale-provider=builtin", "--builtin-locale=C.UTF-8"],
  onLog: () => {},
});
const url = (database: string) => `postgres://test:test@localhost:${port}/${database}`;

const baseEnv = {
  ...process.env,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  API_URL: "http://api.test",
  FRONTEND_URL: "http://site.test",
  ADMIN_URL: "http://admin.test",
  AUTH_SECRET: "test-secret-test-secret-test-secret-test",
  REVALIDATE_SECRET: "",
  DEFAULT_CURRENCY: "INR",
  SUPPORTED_CURRENCIES: "INR,AED",
};

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn(command, args, { env, cwd: root });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

let failed = 0;
try {
  await server.initialise();
  await server.start();
  const admin = new pg.Client({ connectionString: url("postgres") });
  admin.on("error", () => {});
  await admin.connect();
  await admin.query("create database getset_template");

  // Migrate and verify the template once, through the same scripts used in real environments.
  const env = { ...baseEnv, DATABASE_URL: url("getset_template"), STORAGE_LOCAL_DIR: join(dir, "storage") };
  for (const script of ["migrate.ts", "verify-schema.ts"]) {
    const result = await run("node", ["--import", "tsx", join(root, "src/scripts", script)], env);
    if (result.code !== 0) throw new Error(`${script} failed:\n${result.output}`);
  }
  console.log(`Template database migrated and verified. Running ${files.length} test file(s)...\n`);

  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index]!;
      const database = `t${index}`;
      await admin.query(`create database ${database} template getset_template`);
      const started = Date.now();
      const result = await run("node", ["--import", "tsx", "--test", "--test-reporter=spec", file], {
        ...baseEnv,
        DATABASE_URL: url(database),
        STORAGE_LOCAL_DIR: join(dir, `storage-${index}`),
      });
      const name = relative(root, file);
      if (result.code !== 0) failed++;
      console.log(`${result.code === 0 ? "PASS" : "FAIL"}  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      if (result.code !== 0 || process.env.VERBOSE) console.log(result.output);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
  await admin.end();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failed++;
} finally {
  await server.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} file(s) failed.` : `\nAll ${files.length} test files passed.`);
process.exit(failed ? 1 : 0);
