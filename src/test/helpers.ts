import { readFileSync } from "node:fs";
import { after } from "node:test";
import { createApp } from "../app.ts";
import { connectDb, disconnectDb } from "../db/client.ts";
import { ensureIndexes } from "../db/indexes.ts";
import { AdminUser, Currency, withId, type AdminUserDoc } from "../db/models.ts";
import { hashPassword } from "../lib/crypto.ts";

/* Shared test setup: the real app, called in-process, against this file's own database (see scripts/test.ts). */

await connectDb();
await ensureIndexes();
// An open connection would keep the test process running after the last test.
after(() => disconnectDb());

export const app = createApp();

export interface ApiResult<T = any> {
  status: number;
  /** Loosely typed on purpose: tests assert on whatever shape the endpoint returns. */
  body: { success: boolean; data: T; meta?: any; error?: any } & Record<string, any>;
  headers: Headers;
}

export async function api<T = any>(
  method: string,
  path: string,
  options: { body?: unknown; token?: string; form?: FormData; headers?: Record<string, string> } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  let body: RequestInit["body"];
  if (options.form) body = options.form;
  else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await app.request(path, { method, headers, body });
  const text = await response.text();
  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

let counter = 0;

/** Creates an admin and signs them in. */
export async function signIn(role: "SUPER_ADMIN" | "ADMIN" | "EDITOR" = "SUPER_ADMIN") {
  const email = `${role.toLowerCase()}-${++counter}-${Date.now()}@test.local`;
  const password = "correct-horse-42-battery";
  const user = withId((await AdminUser.create({ name: `Test ${role}`, email, role, passwordHash: await hashPassword(password) })).toObject() as AdminUserDoc);
  const result = await api("POST", "/api/auth/login", { body: { email, password } });
  if (result.status !== 200) throw new Error(`login failed: ${JSON.stringify(result.body)}`);
  return { token: result.body.data.token as string, user, email, password };
}

export const PHOTO = readFileSync(new URL("../../seed/images/branches/dubai.jpg", import.meta.url));

export async function uploadPhoto(token: string, name = "photo.jpg", bytes: Uint8Array = PHOTO) {
  const form = new FormData();
  form.append("file", new File([bytes], name, { type: "image/jpeg" }));
  form.append("alt", "A test photo");
  const result = await api("POST", "/api/admin/media", { token, form });
  if (result.status !== 201) throw new Error(`upload failed: ${JSON.stringify(result.body)}`);
  return result.body.data.id as string;
}

/** Currencies, a branch, a destination, a category and a photo: enough to build packages on. */
export async function catalogue(token: string) {
  await Currency.bulkWrite(
    [
      { _id: "INR", symbol: "₹", name: "Indian rupee", locale: "en-IN", displayOrder: 0 },
      { _id: "AED", symbol: "د.إ", name: "UAE dirham", locale: "en-AE", displayOrder: 1 },
    ].map((currency) => ({ updateOne: { filter: { _id: currency._id }, update: { $setOnInsert: currency }, upsert: true } })),
  );
  const photoId = await uploadPhoto(token);
  const branch = await api("POST", "/api/admin/branches", {
    token,
    body: { name: "Dubai", city: "Dubai", countryCode: "AE", countryName: "United Arab Emirates", phone: "+971 58 568 9114", airportCode: "DXB", bannerImageId: photoId },
  });
  const otherBranch = await api("POST", "/api/admin/branches", {
    token,
    body: { name: "Calicut", city: "Kozhikode", countryCode: "IN", countryName: "India", phone: "+91 6282 860 728", airportCode: "CCJ" },
  });
  const destination = await api("POST", "/api/admin/destinations", {
    token,
    body: { name: "Georgia", kind: "COUNTRY", countryCode: "GE", countryName: "Georgia" },
  });
  const otherDestination = await api("POST", "/api/admin/destinations", {
    token,
    body: { name: "Malé", kind: "PLACE", countryCode: "MV", countryName: "Maldives" },
  });
  const category = await api("POST", "/api/admin/categories", { token, body: { name: "Mountains" } });
  for (const result of [branch, otherBranch, destination, otherDestination, category]) {
    if (result.status !== 201) throw new Error(`catalogue setup failed: ${JSON.stringify(result.body)}`);
  }
  return {
    photoId,
    branchId: branch.body.data.id as string,
    otherBranchId: otherBranch.body.data.id as string,
    destinationId: destination.body.data.id as string,
    otherDestinationId: otherDestination.body.data.id as string,
    categoryId: category.body.data.id as string,
  };
}

export const FULL_PRICES = [
  { currencyCode: "INR", priceType: "ADULT", amount: 54999 },
  { currencyCode: "INR", priceType: "CHILD", amount: 39999 },
  { currencyCode: "INR", priceType: "INFANT", amount: 8999 },
  { currencyCode: "AED", priceType: "ADULT", amount: 2450 },
  { currencyCode: "AED", priceType: "CHILD", amount: 1800 },
  { currencyCode: "AED", priceType: "INFANT", amount: 400 },
];

/** A draft package with everything publishing needs. */
export async function readyPackage(
  token: string,
  ids: Awaited<ReturnType<typeof catalogue>>,
  overrides: Record<string, unknown> = {},
) {
  const created = await api("POST", "/api/admin/packages", {
    token,
    body: {
      branchId: ids.branchId,
      destinationId: ids.destinationId,
      categoryId: ids.categoryId,
      title: "Georgia Mountains",
      shortDescription: "Tbilisi and the Caucasus.",
      description: "First paragraph.\n\nSecond paragraph.",
      durationDays: 3,
      durationNights: 2,
      heroImageId: ids.photoId,
      arrivalAirportCode: "TBS",
      arrivalCity: "Tbilisi",
      keywords: ["snow"],
      ...overrides,
    },
  });
  if (created.status !== 201) throw new Error(`create failed: ${JSON.stringify(created.body)}`);
  const id = created.body.data.id as string;
  await api("PUT", `/api/admin/packages/${id}/prices`, { token, body: { prices: FULL_PRICES } });
  await api("PUT", `/api/admin/packages/${id}/itinerary`, {
    token,
    body: {
      days: [
        { title: "Arrive in Tbilisi", description: "Transfer to the hotel.", stay: "Tbilisi", activities: [{ time: "10:30", title: "Airport arrival", type: "ARRIVAL" }] },
        { title: "Kazbegi", stay: "Kazbegi", meals: ["BREAKFAST", "DINNER"] },
        { title: "Departure", meals: ["BREAKFAST"] },
      ],
    },
  });
  return { id, slug: created.body.data.slug as string };
}
