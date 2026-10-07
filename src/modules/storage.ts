import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { env } from "../config/env.ts";
import { AppError } from "../lib/errors.ts";

/**
 * Where files live. The rest of the app only knows keys ("images/2026/10/<uuid>.jpg") and this interface,
 * so swapping local disk for S3, R2 or Cloudinary means adding one provider here.
 */
export interface Storage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  /** Browser-facing URL. Only keys under "images/" are publicly served; documents go through the API. */
  publicUrl(key: string): string;
}

const SAFE_KEY = /^[a-z0-9]+(\/[a-z0-9._-]+)+$/i;

function assertSafeKey(key: string) {
  if (!SAFE_KEY.test(key) || key.includes("..")) throw new AppError(400, "STORAGE_ERROR", "Invalid storage key");
}

/** Files on the API server's disk. Fine for one server with a persistent volume; see docs/DEPLOYMENT.md. */
function localStorage(rootDir: string): Storage {
  const root = resolve(rootDir);
  const pathFor = (key: string) => {
    assertSafeKey(key);
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new AppError(400, "STORAGE_ERROR", "Invalid storage key");
    return path;
  };
  return {
    async put(key, data) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, data);
    },
    async get(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    publicUrl: (key) => `${env.API_URL}/media/${key}`,
  };
}

export const storage: Storage = localStorage(env.STORAGE_LOCAL_DIR);

// ---------------------------------------------------------------------------------------------
// Upload checks. The type comes from the file's first bytes, never from its name or the browser's claim.

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const SIGNATURES: { mime: string; ext: string; test: (b: Buffer) => boolean }[] = [
  { mime: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: "image/png", ext: "png", test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mime: "image/webp", ext: "webp", test: (b) => b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" },
  {
    mime: "image/avif",
    ext: "avif",
    test: (b) => b.toString("ascii", 4, 8) === "ftyp" && ["avif", "avis"].includes(b.toString("ascii", 8, 12)),
  },
];

export function sniffImage(data: Buffer) {
  return SIGNATURES.find((signature) => signature.test(data)) ?? null;
}

export const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  pdf: "application/pdf",
};

/** Keeps a readable, harmless file name for display and downloads. */
export function safeFileName(name: string, fallbackExt: string) {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFKD")
    .replace(/[^\w.\- ]+/g, "")
    .replace(/\s+/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned || `file.${fallbackExt}`;
}

export function newKey(folder: "images" | "documents", ext: string) {
  const now = new Date();
  const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${folder}/${month}/${crypto.randomUUID()}.${ext}`;
}
