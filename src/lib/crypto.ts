import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

/*
 * Password hashing with scrypt (Node's built-in memory-hard KDF). Stored as
 * "scrypt$N$r$p$salt$hash" so the cost can be raised later without breaking existing hashes.
 */
const COST = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEY_LENGTH, { ...COST, maxmem: 64 * 1024 * 1024 });
  return ["scrypt", COST.N, COST.r, COST.p, salt.toString("base64"), hash.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const actual = await scryptAsync(password, Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

/** A hash to compare against when the account does not exist, so both paths take the same time. */
export const DUMMY_PASSWORD_HASH = await hashPassword(randomBytes(16).toString("hex"));

export const randomToken = () => randomBytes(32).toString("base64url");

export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

/** Signed, expiring token: "<payload>.<expiry>.<signature>". */
export function signToken(payload: string, secret: string, ttlSeconds: number): string {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = createHmac("sha256", secret).update(`${payload}.${expires}`).digest("base64url");
  return `${payload}.${expires}.${signature}`;
}

/** Returns the payload when the signature is valid and the token has not expired. */
export function verifyToken(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [payload, expires, signature] = parts as [string, string, string];
  const expected = createHmac("sha256", secret).update(`${payload}.${expires}`).digest();
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (Number(expires) < Date.now() / 1000) return null;
  return payload;
}
