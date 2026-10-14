/**
 * `npm test`: runs every src/**\/*.test.ts against a real, throwaway MongoDB (no network, no Atlas, no Cloudinary).
 * Starts a temporary one-node replica set (transactions need one), applies and verifies the indexes once with the
 * same scripts used in real environments, then gives each test file its own database, so files run in parallel
 * without sharing state.
 *   npm test -- packages     only files whose path contains "packages"
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { MongoMemoryReplSet } from "mongodb-memory-server";

/**
 * The MongoDB server version for tests: the same 8.0 series as the Atlas cluster. Newer 8.0 patch builds need
 * macOS 14; 8.0.4 also runs on older Macs. Downloaded once into ~/.cache/mongodb-binaries.
 */
const MONGODB_VERSION = "8.0.4";

const root = new URL("../../", import.meta.url).pathname;
const filter = process.argv[2];
const files = (readdirSync(join(root, "src"), { recursive: true }) as string[])
  // The legacy PostgreSQL tooling has its own check (`npm run pg:verify`); its test needs PostgreSQL.
  .filter((file) => file.endsWith(".test.ts") && !file.startsWith("legacy-postgres") && (!filter || file.includes(filter)))
  .map((file) => join(root, "src", file))
  .sort();

const dir = mkdtempSync(join(tmpdir(), "getset-test-"));
const replSet = await MongoMemoryReplSet.create({ binary: { version: MONGODB_VERSION }, replSet: { count: 1, storageEngine: "wiredTiger" } });

const baseEnv = {
  ...process.env,
  NODE_ENV: "test",
  LOG_LEVEL: "error",
  MONGODB_URI: replSet.getUri(),
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
  // Apply and verify the indexes once, through the same scripts used in real environments.
  const env = { ...baseEnv, MONGODB_DB_NAME: "template", STORAGE_LOCAL_DIR: join(dir, "storage") };
  for (const script of ["db-indexes.ts", "db-verify.ts"]) {
    const result = await run("node", ["--import", "tsx", join(root, "src/scripts", script)], env);
    if (result.code !== 0) throw new Error(`${script} failed:\n${result.output}`);
  }
  console.log(`Indexes applied and verified. Running ${files.length} test file(s)...\n`);

  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      const file = files[index]!;
      const started = Date.now();
      const result = await run("node", ["--import", "tsx", "--test", "--test-reporter=spec", file], {
        ...baseEnv,
        MONGODB_DB_NAME: `t${index}`,
        STORAGE_LOCAL_DIR: join(dir, `storage-${index}`),
      });
      const name = relative(root, file);
      if (result.code !== 0) failed++;
      console.log(`${result.code === 0 ? "PASS" : "FAIL"}  ${name}  (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      if (result.code !== 0 || process.env.VERBOSE) console.log(result.output);
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, worker));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  failed++;
} finally {
  await replSet.stop().catch(() => {});
  rmSync(dir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} file(s) failed.` : `\nAll ${files.length} test files passed.`);
process.exit(failed ? 1 : 0);
