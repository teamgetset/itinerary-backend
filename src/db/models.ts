import { randomUUID } from "node:crypto";
import mongoose, { Schema, type Model } from "mongoose";

/*
 * The GETSET content model in MongoDB. It mirrors the former PostgreSQL schema (src/legacy-postgres/schema.ts):
 * same field names, so API responses do not change; ids stay UUID strings; a package's child rows (gallery, lists,
 * prices, hotel options, itinerary days and their timeline) are embedded in the package document.
 * MongoDB has no foreign keys: references are checked in the services (crud.ts refs/inUse/onDelete, package
 * service), and `npm run db:verify` scans for dangling ones. Indexes: `npm run db:indexes`. See docs/DATABASE.md.
 */

// ---------------------------------------------------------------------------------------------
// Enumerations

export const ADMIN_ROLES = ["SUPER_ADMIN", "ADMIN", "EDITOR"] as const;
export const PACKAGE_STATUSES = ["DRAFT", "PUBLISHED", "ARCHIVED"] as const;
export const PRICE_TYPES = ["ADULT", "CHILD", "INFANT"] as const;
export const MEALS = ["BREAKFAST", "LUNCH", "DINNER"] as const;
export const ITINERARY_ACTIVITY_TYPES = [
  "ARRIVAL",
  "TRANSFER",
  "CHECK_IN",
  "SIGHTSEEING",
  "ACTIVITY",
  "MEAL",
  "FREE_TIME",
  "CHECK_OUT",
  "DEPARTURE",
  "OTHER",
] as const;
export const DESTINATION_KINDS = ["COUNTRY", "PLACE"] as const;
export const ENQUIRY_STATUSES = ["NEW", "CONTACTED", "IN_PROGRESS", "CONVERTED", "CLOSED"] as const;
export const MEDIA_KINDS = ["IMAGE", "DOCUMENT"] as const;

export type AdminRole = (typeof ADMIN_ROLES)[number];
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];
export type PriceType = (typeof PRICE_TYPES)[number];
export type Meal = (typeof MEALS)[number];
export type ItineraryActivityType = (typeof ITINERARY_ACTIVITY_TYPES)[number];

// ---------------------------------------------------------------------------------------------
// Document shapes (what `.lean()` returns)

interface Seo {
  seoTitle: string | null;
  seoDescription: string | null;
  canonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageId: string | null;
  noindex: boolean;
}

interface Timestamps {
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserDoc extends Timestamps {
  _id: string;
  name: string;
  /** Stored lower-cased. */
  email: string;
  passwordHash: string;
  role: AdminRole;
  isActive: boolean;
  lastLoginAt: Date | null;
}

export interface AdminSessionDoc {
  _id: string;
  adminUserId: string;
  /** SHA-256 of the bearer token. The token itself is never stored. */
  tokenHash: string;
  expiresAt: Date;
  lastUsedAt: Date;
  userAgent: string | null;
  createdAt: Date;
}

export interface AuditLogDoc {
  _id: string;
  adminUserId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

/** Where Cloudinary keeps a file, from its upload response. */
export interface CloudinaryAsset {
  /** e.g. "getset/staging/images/<media id>". */
  publicId: string;
  /** The https URL the API hands out for images. */
  secureUrl: string;
  version: number;
  /** "jpg"... Cloudinary gives none for raw files (PDFs). */
  format: string | null;
  resourceType: string;
  /** "upload" (public delivery) or "authenticated" (private, e.g. PDFs). */
  type: string;
  width: number | null;
  height: number | null;
  bytes: number;
}

export interface MediaDoc {
  _id: string;
  kind: (typeof MEDIA_KINDS)[number];
  /**
   * Where the original lives: a local key ("images/2026/10/<uuid>.jpg") or, for files uploaded straight to
   * Cloudinary, their public id. Files migrated to Cloudinary keep their local key, which old URLs redirect from.
   */
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  altText: string;
  /** CSS object-position for photos whose subject is off-centre, e.g. "center 25%". */
  focalPoint: string | null;
  uploadedById: string | null;
  createdAt: Date;
  /** Soft delete: hidden from the library, still resolvable where already used. */
  deletedAt: Date | null;
  /** Set once the file is on Cloudinary (verified). Null while it is only on local storage. */
  cloudinary: CloudinaryAsset | null;
}

export interface CurrencyDoc extends Timestamps {
  /** ISO 4217 code, e.g. "INR". */
  _id: string;
  symbol: string;
  name: string;
  locale: string;
  displayOrder: number;
  isActive: boolean;
}

export interface BranchDoc extends Seo, Timestamps {
  _id: string;
  slug: string;
  name: string;
  shortDescription: string;
  description: string;
  bannerImageId: string | null;
  thumbnailImageId: string | null;
  addressLines: string[];
  city: string;
  countryCode: string;
  countryName: string;
  airportCode: string | null;
  airportCity: string | null;
  phone: string;
  whatsapp: string | null;
  email: string | null;
  latitude: number | null;
  longitude: number | null;
  mapUrl: string | null;
  displayOrder: number;
  isActive: boolean;
}

export type Fact = { label: string; value: string };

export interface DestinationDoc extends Seo, Timestamps {
  _id: string;
  slug: string;
  name: string;
  kind: (typeof DESTINATION_KINDS)[number];
  countryCode: string;
  countryName: string;
  region: string | null;
  shortDescription: string;
  description: string;
  heroImageId: string | null;
  thumbnailImageId: string | null;
  facts: Fact[];
  displayOrder: number;
  isActive: boolean;
}

export interface CategoryDoc extends Timestamps {
  _id: string;
  name: string;
  slug: string;
  displayOrder: number;
}

export interface HotelDoc extends Timestamps {
  _id: string;
  name: string;
  slug: string;
  starCategory: number | null;
  rating: number | null;
  description: string;
  location: string;
  address: string | null;
  primaryImageId: string | null;
  isActive: boolean;
}

export interface ActivityDoc extends Timestamps {
  _id: string;
  name: string;
  slug: string;
  description: string;
  imageId: string | null;
  location: string | null;
  destinationId: string | null;
  /** Price per person when booked on its own, one per currency. */
  prices: { currencyCode: string; amount: number }[];
  displayOrder: number;
  isActive: boolean;
}

export interface ListItem {
  title: string;
  description: string | null;
}

export interface Highlight extends ListItem {
  icon: string | null;
}

export interface PackagePrice {
  currencyCode: string;
  priceType: PriceType;
  amount: number;
}

/** A hotel option. Every field is optional; a row without a hotel is kept for the admin but not published. */
export interface PackageHotel {
  hotelId: string | null;
  nights: number | null;
  roomType: string | null;
  mealPlan: string | null;
  /** The hotel the listed price includes. Other entries are alternatives. */
  isDefault: boolean;
}

export interface TimelineEntry {
  /** Local time at the destination, "HH:MM". */
  time: string | null;
  title: string;
  description: string | null;
  location: string | null;
  type: ItineraryActivityType;
  activityId: string | null;
}

export interface ItineraryDay {
  /** 1-based; also the display order. */
  dayNumber: number;
  title: string;
  description: string;
  stay: string | null;
  hotelId: string | null;
  meals: Meal[];
  imageId: string | null;
  activities: TimelineEntry[];
}

export interface PackageDoc extends Seo, Timestamps {
  _id: string;
  branchId: string;
  destinationId: string;
  categoryId: string | null;
  title: string;
  slug: string;
  shortDescription: string;
  description: string;
  durationDays: number;
  durationNights: number;
  bestTime: string | null;
  arrivalAirportCode: string | null;
  arrivalCity: string | null;
  heroImageId: string | null;
  /** The uploaded itinerary PDF with the GETSET logo (a DOCUMENT media record); required to publish. */
  itineraryPdfId: string | null;
  /** The same itinerary without the logo; optional. Missing on packages saved before it existed. */
  itineraryPdfWithoutLogoId?: string | null;
  keywords: string[];
  importantInfo: string[];
  status: PackageStatus;
  displayOrder: number;
  isFeatured: boolean;
  isRecommended: boolean;
  /** Lower-cased, accent-free text that search matches against. Maintained by the package service. */
  searchText: string;
  publishedAt: Date | null;
  deletedAt: Date | null;
  createdById: string | null;
  updatedById: string | null;
  /** Media ids, in display order. */
  gallery: string[];
  highlights: Highlight[];
  inclusions: ListItem[];
  exclusions: ListItem[];
  /** "Good to know" on the package page, once the package has its own lists (ownInfo). Missing on older packages. */
  goodToKnow?: ListItem[];
  /**
   * Set when the package's "Good to know" and "Important information" are saved in the admin: from then on the page shows
   * exactly its own lists. Until then it shows the shared content (destination travel facts, Global content notes).
   */
  ownInfo?: boolean;
  prices: PackagePrice[];
  hotels: PackageHotel[];
  activityIds: string[];
  itinerary: ItineraryDay[];
}

export interface ItineraryPdfDoc {
  _id: string;
  packageId: string;
  version: number;
  /** Hash of everything printed in the PDF. A different hash means the PDF is out of date. */
  contentHash: string;
  withLogoMediaId: string;
  withoutLogoMediaId: string;
  generatedById: string | null;
  generatedAt: Date;
}

export interface TestimonialDoc extends Timestamps {
  _id: string;
  customerName: string;
  profile: string;
  imageId: string | null;
  rating: number;
  review: string;
  place: string;
  sourceName: string | null;
  sourceUrl: string | null;
  /** "YYYY-MM-DD". */
  reviewedAt: string | null;
  packageId: string | null;
  displayOrder: number;
  isPublished: boolean;
  deletedAt: Date | null;
}

export interface HeroSlideDoc extends Timestamps {
  _id: string;
  title: string;
  description: string | null;
  label: string | null;
  imageId: string;
  buttonText: string | null;
  buttonLink: string | null;
  displayOrder: number;
  isPublished: boolean;
}

export interface SiteContentDoc {
  /** The content key, e.g. "home.hero". */
  _id: string;
  value: unknown;
  updatedById: string | null;
  updatedAt: Date;
}

export interface EnquiryNote {
  _id: string;
  adminUserId: string | null;
  body: string;
  createdAt: Date;
}

export interface EnquiryDoc extends Timestamps {
  _id: string;
  name: string;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  branchId: string | null;
  packageId: string | null;
  /** "YYYY-MM-DD". */
  travelDate: string | null;
  adults: number;
  children: number;
  infants: number;
  currencyCode: string | null;
  estimatedTotal: number | null;
  message: string | null;
  status: (typeof ENQUIRY_STATUSES)[number];
  notes: EnquiryNote[];
}

// ---------------------------------------------------------------------------------------------
// Schema building blocks

const uuid = { type: String, default: () => randomUUID() };
const text = (required = true) => (required ? { type: String, required: true } : { type: String, default: null });
const textDefault = (value = "") => ({ type: String, default: value });
const ref = { type: String, default: null };
const flag = (value: boolean) => ({ type: Boolean, required: true, default: value });
const displayOrder = { type: Number, required: true, default: 0 };
const round2 = (value: number) => (typeof value === "number" ? Math.round(value * 100) / 100 : value);
const money = { type: Number, required: true, min: 0, set: round2 };
const nullableDate = { type: Date, default: null };

const options = (collection: string, timestamps: boolean | { createdAt: boolean; updatedAt: boolean } = true) => ({
  collection,
  timestamps,
  versionKey: false as const,
  minimize: false,
  id: false,
});
const embedded = { _id: false, versionKey: false, minimize: false } as const;

const seo = {
  seoTitle: text(false),
  seoDescription: text(false),
  canonicalUrl: text(false),
  ogTitle: text(false),
  ogDescription: text(false),
  ogImageId: ref,
  noindex: flag(false),
};

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---------------------------------------------------------------------------------------------
// Admin users, sessions, audit

const adminUserSchema = new Schema<AdminUserDoc>(
  {
    _id: uuid,
    name: text(),
    email: { type: String, required: true, lowercase: true, trim: true, unique: true },
    passwordHash: text(),
    role: { type: String, enum: ADMIN_ROLES, required: true, default: "EDITOR" },
    isActive: flag(true),
    lastLoginAt: nullableDate,
  },
  options("admin_users"),
);

const adminSessionSchema = new Schema<AdminSessionDoc>(
  {
    _id: uuid,
    adminUserId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, required: true, default: () => new Date() },
    userAgent: text(false),
  },
  options("admin_sessions", { createdAt: true, updatedAt: false }),
);

const auditLogSchema = new Schema<AuditLogDoc>(
  {
    _id: uuid,
    adminUserId: ref,
    action: text(),
    entity: text(),
    entityId: text(false),
    metadata: { type: Schema.Types.Mixed, required: true, default: () => ({}) },
  },
  options("audit_logs", { createdAt: true, updatedAt: false }),
);
auditLogSchema.index({ entity: 1, entityId: 1 });
auditLogSchema.index({ createdAt: -1 });

// ---------------------------------------------------------------------------------------------
// Media: every image and generated document. Documents hold the storage key; URLs are built at read time.

const cloudinaryAssetSchema = new Schema<CloudinaryAsset>(
  {
    publicId: text(),
    secureUrl: { type: String, required: true, match: /^https:\/\// },
    version: { type: Number, required: true },
    format: { type: String, default: null },
    resourceType: text(),
    type: text(),
    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, required: true, min: 1 },
  },
  embedded,
);

const mediaSchema = new Schema<MediaDoc>(
  {
    _id: uuid,
    kind: { type: String, enum: MEDIA_KINDS, required: true },
    storageKey: { type: String, required: true, unique: true },
    fileName: text(),
    mimeType: text(),
    sizeBytes: { type: Number, required: true, min: 1 },
    altText: textDefault(),
    focalPoint: text(false),
    uploadedById: ref,
    deletedAt: nullableDate,
    cloudinary: { type: cloudinaryAssetSchema, default: null },
  },
  options("media", { createdAt: true, updatedAt: false }),
);
mediaSchema.index({ kind: 1, createdAt: -1 });
mediaSchema.index({ "cloudinary.publicId": 1 }, { unique: true, partialFilterExpression: { "cloudinary.publicId": { $type: "string" } } });

// ---------------------------------------------------------------------------------------------
// Currencies, branches, destinations

const currencySchema = new Schema<CurrencyDoc>(
  {
    _id: { type: String, required: true, match: /^[A-Z]{3}$/ },
    symbol: text(),
    name: text(),
    locale: textDefault("en-US"),
    displayOrder,
    isActive: flag(true),
  },
  options("currencies"),
);

const branchSchema = new Schema<BranchDoc>(
  {
    _id: uuid,
    slug: { type: String, required: true, unique: true, match: SLUG },
    name: text(),
    shortDescription: textDefault(),
    description: textDefault(),
    bannerImageId: ref,
    thumbnailImageId: ref,
    addressLines: { type: [String], default: [] },
    city: text(),
    countryCode: { type: String, required: true, match: /^[A-Z]{2}$/ },
    countryName: text(),
    airportCode: { type: String, default: null, match: /^[A-Z]{3}$/ },
    airportCity: text(false),
    phone: text(),
    whatsapp: text(false),
    email: text(false),
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    mapUrl: text(false),
    displayOrder,
    isActive: flag(true),
    ...seo,
  },
  options("branches"),
);

const factSchema = new Schema<Fact>({ label: text(), value: text() }, embedded);

const destinationSchema = new Schema<DestinationDoc>(
  {
    _id: uuid,
    slug: { type: String, required: true, unique: true, match: SLUG },
    name: text(),
    kind: { type: String, enum: DESTINATION_KINDS, required: true, default: "PLACE" },
    countryCode: { type: String, required: true, match: /^[A-Z]{2}$/ },
    countryName: text(),
    region: text(false),
    shortDescription: textDefault(),
    description: textDefault(),
    heroImageId: ref,
    thumbnailImageId: ref,
    facts: { type: [factSchema], default: [] },
    displayOrder,
    isActive: flag(true),
    ...seo,
  },
  options("destinations"),
);

// ---------------------------------------------------------------------------------------------
// Reusable catalogue items

const categorySchema = new Schema<CategoryDoc>(
  {
    _id: uuid,
    name: text(),
    slug: { type: String, required: true, unique: true, match: SLUG },
    displayOrder,
  },
  options("package_categories"),
);

const hotelSchema = new Schema<HotelDoc>(
  {
    _id: uuid,
    name: text(),
    slug: { type: String, required: true, unique: true, match: SLUG },
    starCategory: { type: Number, default: null, min: 1, max: 5 },
    rating: { type: Number, default: null, min: 0, max: 5 },
    description: textDefault(),
    location: text(),
    address: text(false),
    primaryImageId: ref,
    isActive: flag(true),
  },
  options("hotels"),
);

const activityPriceSchema = new Schema({ currencyCode: { type: String, required: true, match: /^[A-Z]{3}$/ }, amount: money }, embedded);

const activitySchema = new Schema<ActivityDoc>(
  {
    _id: uuid,
    name: text(),
    slug: { type: String, required: true, unique: true, match: SLUG },
    description: textDefault(),
    imageId: ref,
    location: text(false),
    destinationId: { type: String, default: null, index: true },
    prices: { type: [activityPriceSchema], default: [] },
    displayOrder,
    isActive: flag(true),
  },
  options("activities"),
);

// ---------------------------------------------------------------------------------------------
// Packages, with their embedded sections

const listItemSchema = new Schema<ListItem>({ title: text(), description: text(false) }, embedded);
const highlightSchema = new Schema<Highlight>({ title: text(), description: text(false), icon: text(false) }, embedded);
const packagePriceSchema = new Schema<PackagePrice>(
  {
    currencyCode: { type: String, required: true, match: /^[A-Z]{3}$/ },
    priceType: { type: String, enum: PRICE_TYPES, required: true },
    amount: money,
  },
  embedded,
);
const packageHotelSchema = new Schema<PackageHotel>(
  {
    hotelId: ref,
    nights: { type: Number, default: null, min: 1 },
    roomType: text(false),
    mealPlan: text(false),
    isDefault: flag(true),
  },
  embedded,
);
const timelineEntrySchema = new Schema<TimelineEntry>(
  {
    time: { type: String, default: null, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    title: text(),
    description: text(false),
    location: text(false),
    type: { type: String, enum: ITINERARY_ACTIVITY_TYPES, required: true, default: "OTHER" },
    activityId: ref,
  },
  embedded,
);
const itineraryDaySchema = new Schema<ItineraryDay>(
  {
    dayNumber: { type: Number, required: true, min: 1 },
    title: text(),
    description: textDefault(),
    stay: text(false),
    hotelId: ref,
    meals: { type: [{ type: String, enum: MEALS }], default: [] },
    imageId: ref,
    activities: { type: [timelineEntrySchema], default: [] },
  },
  embedded,
);

const packageSchema = new Schema<PackageDoc>(
  {
    _id: uuid,
    branchId: { type: String, required: true },
    destinationId: { type: String, required: true },
    categoryId: ref,
    title: text(),
    slug: { type: String, required: true, unique: true, match: SLUG },
    shortDescription: textDefault(),
    description: textDefault(),
    durationDays: { type: Number, required: true, min: 1 },
    durationNights: { type: Number, required: true, min: 0 },
    bestTime: text(false),
    arrivalAirportCode: { type: String, default: null, match: /^[A-Z]{3}$/ },
    arrivalCity: text(false),
    heroImageId: ref,
    itineraryPdfId: ref,
    itineraryPdfWithoutLogoId: ref,
    keywords: { type: [String], default: [] },
    importantInfo: { type: [String], default: [] },
    status: { type: String, enum: PACKAGE_STATUSES, required: true, default: "DRAFT" },
    displayOrder,
    isFeatured: flag(false),
    isRecommended: flag(false),
    searchText: textDefault(),
    ...seo,
    publishedAt: nullableDate,
    deletedAt: nullableDate,
    createdById: ref,
    updatedById: ref,
    gallery: { type: [String], default: [] },
    highlights: { type: [highlightSchema], default: [] },
    inclusions: { type: [listItemSchema], default: [] },
    exclusions: { type: [listItemSchema], default: [] },
    goodToKnow: { type: [listItemSchema], default: [] },
    ownInfo: flag(false),
    prices: { type: [packagePriceSchema], default: [] },
    hotels: { type: [packageHotelSchema], default: [] },
    activityIds: { type: [String], default: [] },
    itinerary: { type: [itineraryDaySchema], default: [] },
  },
  options("packages"),
);
packageSchema.index({ branchId: 1, status: 1 });
packageSchema.index({ destinationId: 1 });
packageSchema.index({ status: 1, displayOrder: 1 });

// ---------------------------------------------------------------------------------------------
// LEGACY: itinerary PDFs the API used to generate (one document per version, pointing at both prints). Nothing writes
// here any more; the collection and its files are kept until they are retired after production verification.
// Itinerary PDFs are now uploaded by the admin: Package.itineraryPdfId.

const itineraryPdfSchema = new Schema<ItineraryPdfDoc>(
  {
    _id: uuid,
    packageId: { type: String, required: true },
    version: { type: Number, required: true, min: 1 },
    contentHash: text(),
    withLogoMediaId: { type: String, required: true },
    withoutLogoMediaId: { type: String, required: true },
    generatedById: ref,
    generatedAt: { type: Date, required: true, default: () => new Date() },
  },
  options("itinerary_pdfs", false),
);
itineraryPdfSchema.index({ packageId: 1, version: 1 }, { unique: true });
itineraryPdfSchema.index({ packageId: 1, contentHash: 1 });

// ---------------------------------------------------------------------------------------------
// Website content

const testimonialSchema = new Schema<TestimonialDoc>(
  {
    _id: uuid,
    customerName: text(),
    profile: textDefault(),
    imageId: ref,
    rating: { type: Number, required: true, min: 1, max: 5 },
    review: text(),
    place: textDefault(),
    sourceName: text(false),
    sourceUrl: text(false),
    reviewedAt: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    packageId: ref,
    displayOrder,
    isPublished: flag(false),
    deletedAt: nullableDate,
  },
  options("testimonials"),
);
testimonialSchema.index({ isPublished: 1, displayOrder: 1 });

const heroSlideSchema = new Schema<HeroSlideDoc>(
  {
    _id: uuid,
    title: text(),
    description: text(false),
    label: text(false),
    imageId: { type: String, required: true },
    buttonText: text(false),
    buttonLink: text(false),
    displayOrder,
    isPublished: flag(false),
  },
  options("hero_slides"),
);
heroSlideSchema.index({ isPublished: 1, displayOrder: 1 });

const siteContentSchema = new Schema<SiteContentDoc>(
  {
    _id: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    updatedById: ref,
  },
  options("site_content", { createdAt: false, updatedAt: true }),
);

// ---------------------------------------------------------------------------------------------
// Enquiries

const enquiryNoteSchema = new Schema<EnquiryNote>(
  { _id: uuid, adminUserId: ref, body: text(), createdAt: { type: Date, required: true, default: () => new Date() } },
  { versionKey: false },
);

const enquirySchema = new Schema<EnquiryDoc>(
  {
    _id: uuid,
    name: text(),
    email: text(false),
    phone: text(false),
    whatsapp: text(false),
    branchId: { type: String, default: null, index: true },
    packageId: { type: String, default: null, index: true },
    travelDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    adults: { type: Number, required: true, default: 1, min: 1 },
    children: { type: Number, required: true, default: 0, min: 0 },
    infants: { type: Number, required: true, default: 0, min: 0 },
    currencyCode: { type: String, default: null },
    estimatedTotal: { type: Number, default: null, set: round2 },
    message: text(false),
    status: { type: String, enum: ENQUIRY_STATUSES, required: true, default: "NEW" },
    notes: { type: [enquiryNoteSchema], default: [] },
  },
  options("enquiries"),
);
enquirySchema.index({ status: 1, createdAt: -1 });
enquirySchema.index({ createdAt: -1 });
enquirySchema.pre("validate", function () {
  if (!this.email && !this.phone && !this.whatsapp) this.invalidate("phone", "An email, phone or WhatsApp number is required");
  if (this.adults + this.children + this.infants > 60) this.invalidate("adults", "At most 60 travellers");
});

// ---------------------------------------------------------------------------------------------
// Models

export const AdminUser = mongoose.model<AdminUserDoc>("AdminUser", adminUserSchema);
export const AdminSession = mongoose.model<AdminSessionDoc>("AdminSession", adminSessionSchema);
export const AuditLog = mongoose.model<AuditLogDoc>("AuditLog", auditLogSchema);
export const Media = mongoose.model<MediaDoc>("Media", mediaSchema);
export const Currency = mongoose.model<CurrencyDoc>("Currency", currencySchema);
export const Branch = mongoose.model<BranchDoc>("Branch", branchSchema);
export const Destination = mongoose.model<DestinationDoc>("Destination", destinationSchema);
export const Category = mongoose.model<CategoryDoc>("Category", categorySchema);
export const Hotel = mongoose.model<HotelDoc>("Hotel", hotelSchema);
export const Activity = mongoose.model<ActivityDoc>("Activity", activitySchema);
export const Package = mongoose.model<PackageDoc>("Package", packageSchema);
export const ItineraryPdf = mongoose.model<ItineraryPdfDoc>("ItineraryPdf", itineraryPdfSchema);
export const Testimonial = mongoose.model<TestimonialDoc>("Testimonial", testimonialSchema);
export const HeroSlide = mongoose.model<HeroSlideDoc>("HeroSlide", heroSlideSchema);
export const SiteContent = mongoose.model<SiteContentDoc>("SiteContent", siteContentSchema);
export const Enquiry = mongoose.model<EnquiryDoc>("Enquiry", enquirySchema);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_MODELS: Model<any>[] = [
  AdminUser,
  AdminSession,
  AuditLog,
  Media,
  Currency,
  Branch,
  Destination,
  Category,
  Hotel,
  Activity,
  Package,
  ItineraryPdf,
  Testimonial,
  HeroSlide,
  SiteContent,
  Enquiry,
];

/**
 * Every reference between documents (what foreign keys used to guarantee). `npm run db:verify` and the PostgreSQL
 * migration check that each value points at an existing document.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const REFERENCES: { from: Model<any>; path: string; to: Model<any> }[] = [
  { from: AdminSession, path: "adminUserId", to: AdminUser },
  { from: AuditLog, path: "adminUserId", to: AdminUser },
  { from: Media, path: "uploadedById", to: AdminUser },
  { from: Branch, path: "bannerImageId", to: Media },
  { from: Branch, path: "thumbnailImageId", to: Media },
  { from: Branch, path: "ogImageId", to: Media },
  { from: Destination, path: "heroImageId", to: Media },
  { from: Destination, path: "thumbnailImageId", to: Media },
  { from: Destination, path: "ogImageId", to: Media },
  { from: Hotel, path: "primaryImageId", to: Media },
  { from: Activity, path: "imageId", to: Media },
  { from: Activity, path: "destinationId", to: Destination },
  { from: Activity, path: "prices.currencyCode", to: Currency },
  { from: Package, path: "branchId", to: Branch },
  { from: Package, path: "destinationId", to: Destination },
  { from: Package, path: "categoryId", to: Category },
  { from: Package, path: "heroImageId", to: Media },
  { from: Package, path: "itineraryPdfId", to: Media },
  { from: Package, path: "itineraryPdfWithoutLogoId", to: Media },
  { from: Package, path: "ogImageId", to: Media },
  { from: Package, path: "createdById", to: AdminUser },
  { from: Package, path: "updatedById", to: AdminUser },
  { from: Package, path: "gallery", to: Media },
  { from: Package, path: "prices.currencyCode", to: Currency },
  { from: Package, path: "hotels.hotelId", to: Hotel },
  { from: Package, path: "activityIds", to: Activity },
  { from: Package, path: "itinerary.hotelId", to: Hotel },
  { from: Package, path: "itinerary.imageId", to: Media },
  { from: Package, path: "itinerary.activities.activityId", to: Activity },
  { from: ItineraryPdf, path: "packageId", to: Package },
  { from: ItineraryPdf, path: "withLogoMediaId", to: Media },
  { from: ItineraryPdf, path: "withoutLogoMediaId", to: Media },
  { from: ItineraryPdf, path: "generatedById", to: AdminUser },
  { from: Testimonial, path: "imageId", to: Media },
  { from: Testimonial, path: "packageId", to: Package },
  { from: HeroSlide, path: "imageId", to: Media },
  { from: SiteContent, path: "updatedById", to: AdminUser },
  { from: Enquiry, path: "branchId", to: Branch },
  { from: Enquiry, path: "packageId", to: Package },
  { from: Enquiry, path: "currencyCode", to: Currency },
  { from: Enquiry, path: "notes.adminUserId", to: AdminUser },
];

/** The fields of a partial update that were actually sent (an undefined field means "leave unchanged"). */
export const defined = <T extends Record<string, unknown>>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) as Partial<T>;

/** `{ _id, ...rest }` from the database becomes `{ id, ...rest }` for the API, as the PostgreSQL rows were. */
export const withId = <T extends { _id: string }>({ _id, ...rest }: T): Omit<T, "_id"> & { id: string } => ({ id: _id, ...rest });
