import { env, isProduction } from "../config/env.ts";

/*
 * Structured logs: one JSON object per line, ready for any log collector.
 * Fields whose names look secret are masked, so a stray token or password never reaches the logs.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;
type Fields = Record<string, unknown>;

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|hash|uri|api_?key|connection_?string/i;
/** Credentials inside connection strings, e.g. in a driver error message. */
const CREDENTIALS_IN_URL = /([a-z+]+:\/\/)[^\s/@:]+:[^\s/@]+@/gi;
const scrub = (text?: string) => text?.replace(CREDENTIALS_IN_URL, "$1[redacted]@");

/** An error's message with any connection-string credentials removed, for scripts that print errors. */
export const safeMessage = (error: unknown) => scrub(error instanceof Error ? error.message : String(error)) ?? "";

function clean(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (value instanceof Error) {
    return { name: value.name, message: scrub(value.message), ...(!isProduction && { stack: scrub(value.stack) }) };
  }
  if (typeof value === "string") return scrub(value);
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v, k)]));
  }
  return value;
}

function write(level: Level, event: string, fields: Fields = {}) {
  if (LEVELS[level] < LEVELS[env.LOG_LEVEL]) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...(clean(fields) as Fields) });
  (level === "warn" || level === "error" ? process.stderr : process.stdout).write(`${line}\n`);
}

export const log = {
  debug: (event: string, fields?: Fields) => write("debug", event, fields),
  info: (event: string, fields?: Fields) => write("info", event, fields),
  warn: (event: string, fields?: Fields) => write("warn", event, fields),
  error: (event: string, fields?: Fields) => write("error", event, fields),
};
