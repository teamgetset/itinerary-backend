import { relations, sql } from "drizzle-orm";
import {
  boolean,
  char,
  check,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/*
 * The GETSET content model. Changes here go through `npm run db:generate` (creates a SQL migration),
 * `npm run db:migrate` (applies it) and `npm run db:verify` (checks the live database matches this file).
 * See docs/DATABASE.md.
 */

// ---------------------------------------------------------------------------------------------
// Shared column sets. Functions, so every table gets its own column instances.

const id = () => uuid("id").primaryKey().defaultRandom();

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

const timestamps = () => ({
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

const displayOrder = () => integer("display_order").notNull().default(0);

/** Search engine fields shared by branches, destinations and packages. */
const seo = () => ({
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  canonicalUrl: text("canonical_url"),
  ogTitle: text("og_title"),
  ogDescription: text("og_description"),
  ogImageId: uuid("og_image_id").references(() => media.id, { onDelete: "set null" }),
  noindex: boolean("noindex").notNull().default(false),
});

const emptyTextArray = sql`'{}'::text[]`;

// ---------------------------------------------------------------------------------------------
// Enums

export const adminRole = pgEnum("admin_role", ["SUPER_ADMIN", "ADMIN", "EDITOR"]);
export const packageStatus = pgEnum("package_status", ["DRAFT", "PUBLISHED", "ARCHIVED"]);
export const priceType = pgEnum("price_type", ["ADULT", "CHILD", "INFANT"]);
export const meal = pgEnum("meal", ["BREAKFAST", "LUNCH", "DINNER"]);
export const itineraryActivityType = pgEnum("itinerary_activity_type", [
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
]);
export const destinationKind = pgEnum("destination_kind", ["COUNTRY", "PLACE"]);
export const enquiryStatus = pgEnum("enquiry_status", ["NEW", "CONTACTED", "IN_PROGRESS", "CONVERTED", "CLOSED"]);
export const mediaKind = pgEnum("media_kind", ["IMAGE", "DOCUMENT"]);

// ---------------------------------------------------------------------------------------------
// Admin users, sessions, audit

export const adminUsers = pgTable(
  "admin_users",
  {
    id: id(),
    name: text("name").notNull(),
    /** Stored lower-cased. */
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: adminRole("role").notNull().default("EDITOR"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [uniqueIndex("admin_users_email_lower_key").on(sql`lower(${t.email})`)],
);

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: id(),
    adminUserId: uuid("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    /** SHA-256 of the bearer token. The token itself is never stored. */
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("admin_sessions_admin_user_id_idx").on(t.adminUserId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    adminUserId: uuid("admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    /** e.g. PACKAGE_PUBLISHED. */
    action: text("action").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_logs_entity_idx").on(t.entity, t.entityId),
    index("audit_logs_created_at_idx").on(t.createdAt),
  ],
);

// ---------------------------------------------------------------------------------------------
// Media: every image and generated document. Rows hold the storage key; URLs are built at read time,
// so moving to another storage provider does not touch the data.

export const media = pgTable(
  "media",
  {
    id: id(),
    kind: mediaKind("kind").notNull(),
    storageKey: text("storage_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    altText: text("alt_text").notNull().default(""),
    /** CSS object-position for photos whose subject is off-centre, e.g. "center 25%". */
    focalPoint: text("focal_point"),
    uploadedById: uuid("uploaded_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    /** Soft delete: hidden from the library, still resolvable where already used. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("media_kind_created_at_idx").on(t.kind, t.createdAt),
    check("media_size_bytes_positive", sql`${t.sizeBytes} > 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Currencies

export const currencies = pgTable(
  "currencies",
  {
    /** ISO 4217, e.g. "INR". */
    code: char("code", { length: 3 }).primaryKey(),
    symbol: text("symbol").notNull(),
    name: text("name").notNull(),
    /** BCP 47 locale for digit grouping, e.g. "en-IN" gives 1,01,500. */
    locale: text("locale").notNull().default("en-US"),
    displayOrder: displayOrder(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [check("currencies_code_format", sql`${t.code} ~ '^[A-Z]{3}$'`)],
);

// ---------------------------------------------------------------------------------------------
// Branches and destinations

export const branches = pgTable("branches", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** What this branch's catalogue offers. Shown on the branch card and banner. */
  shortDescription: text("short_description").notNull().default(""),
  /** About the office itself. Shown with the contact details. */
  description: text("description").notNull().default(""),
  bannerImageId: uuid("banner_image_id").references(() => media.id, { onDelete: "set null" }),
  thumbnailImageId: uuid("thumbnail_image_id").references(() => media.id, { onDelete: "set null" }),
  addressLines: text("address_lines").array().notNull().default(emptyTextArray),
  city: text("city").notNull(),
  countryCode: char("country_code", { length: 2 }).notNull(),
  countryName: text("country_name").notNull(),
  /** Departure airport for this branch's trips. */
  airportCode: char("airport_code", { length: 3 }),
  airportCity: text("airport_city"),
  phone: text("phone").notNull(),
  /** International format, digits only, for wa.me links. */
  whatsapp: text("whatsapp"),
  email: text("email"),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  mapUrl: text("map_url"),
  displayOrder: displayOrder(),
  isActive: boolean("is_active").notNull().default(true),
  ...seo(),
  ...timestamps(),
});

export type Fact = { label: string; value: string };

export const destinations = pgTable("destinations", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** A whole country (Georgia) or a place within one (Dubai, Bali). */
  kind: destinationKind("kind").notNull().default("PLACE"),
  countryCode: char("country_code", { length: 2 }).notNull(),
  countryName: text("country_name").notNull(),
  region: text("region"),
  shortDescription: text("short_description").notNull().default(""),
  description: text("description").notNull().default(""),
  heroImageId: uuid("hero_image_id").references(() => media.id, { onDelete: "set null" }),
  thumbnailImageId: uuid("thumbnail_image_id").references(() => media.id, { onDelete: "set null" }),
  /** Short travel facts (flight time, currency, visa), in display order. */
  facts: jsonb("facts").$type<Fact[]>().notNull().default([]),
  displayOrder: displayOrder(),
  isActive: boolean("is_active").notNull().default(true),
  ...seo(),
  ...timestamps(),
});

// ---------------------------------------------------------------------------------------------
// Reusable catalogue items

export const packageCategories = pgTable("package_categories", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  displayOrder: displayOrder(),
  ...timestamps(),
});

export const hotels = pgTable(
  "hotels",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    starCategory: smallint("star_category"),
    rating: numeric("rating", { precision: 2, scale: 1, mode: "number" }),
    description: text("description").notNull().default(""),
    /** City or area, e.g. "Bukit Bintang, Kuala Lumpur". */
    location: text("location").notNull(),
    address: text("address"),
    primaryImageId: uuid("primary_image_id").references(() => media.id, { onDelete: "set null" }),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    check("hotels_star_category_range", sql`${t.starCategory} between 1 and 5`),
    check("hotels_rating_range", sql`${t.rating} between 0 and 5`),
  ],
);

export const activities = pgTable(
  "activities",
  {
    id: id(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    description: text("description").notNull().default(""),
    imageId: uuid("image_id").references(() => media.id, { onDelete: "set null" }),
    location: text("location"),
    /** Bookable add-ons are listed on their destination's page. */
    destinationId: uuid("destination_id").references(() => destinations.id, { onDelete: "set null" }),
    displayOrder: displayOrder(),
    isActive: boolean("is_active").notNull().default(true),
    ...timestamps(),
  },
  (t) => [index("activities_destination_id_idx").on(t.destinationId)],
);

/** Price per person for booking an activity on its own, one row per currency. */
export const activityPrices = pgTable(
  "activity_prices",
  {
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    currencyCode: char("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onUpdate: "cascade" }),
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.activityId, t.currencyCode] }),
    check("activity_prices_amount_non_negative", sql`${t.amount} >= 0`),
  ],
);

// ---------------------------------------------------------------------------------------------
// Packages

export const packages = pgTable(
  "packages",
  {
    id: id(),
    branchId: uuid("branch_id")
      .notNull()
      .references(() => branches.id, { onDelete: "restrict" }),
    destinationId: uuid("destination_id")
      .notNull()
      .references(() => destinations.id, { onDelete: "restrict" }),
    categoryId: uuid("category_id").references(() => packageCategories.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    slug: text("slug").notNull().unique(),
    /** One-line pitch shown on cards. */
    shortDescription: text("short_description").notNull().default(""),
    /** Overview. Paragraphs separated by a blank line. */
    description: text("description").notNull().default(""),
    durationDays: integer("duration_days").notNull(),
    durationNights: integer("duration_nights").notNull(),
    bestTime: text("best_time"),
    arrivalAirportCode: char("arrival_airport_code", { length: 3 }),
    arrivalCity: text("arrival_city"),
    heroImageId: uuid("hero_image_id").references(() => media.id, { onDelete: "set null" }),
    /** Extra words people may search for, e.g. "honeymoon". */
    keywords: text("keywords").array().notNull().default(emptyTextArray),
    /** Trip-specific notes, shown after the site-wide important information. */
    importantInfo: text("important_info").array().notNull().default(emptyTextArray),
    status: packageStatus("status").notNull().default("DRAFT"),
    displayOrder: displayOrder(),
    isFeatured: boolean("is_featured").notNull().default(false),
    isRecommended: boolean("is_recommended").notNull().default(false),
    /** Lower-cased, accent-free text that search matches against. Maintained by the package service. */
    searchText: text("search_text").notNull().default(""),
    ...seo(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    updatedById: uuid("updated_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    index("packages_branch_status_idx").on(t.branchId, t.status),
    index("packages_destination_id_idx").on(t.destinationId),
    index("packages_status_display_order_idx").on(t.status, t.displayOrder),
    check("packages_duration_days_positive", sql`${t.durationDays} > 0`),
    check("packages_duration_nights_range", sql`${t.durationNights} >= 0 and ${t.durationNights} <= ${t.durationDays}`),
    check("packages_slug_format", sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

export const packageImages = pgTable(
  "package_images",
  {
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    mediaId: uuid("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    displayOrder: displayOrder(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.mediaId] })],
);

const packageListItem = <Name extends string>(name: Name) =>
  pgTable(
    name,
    {
      id: id(),
      packageId: uuid("package_id")
        .notNull()
        .references(() => packages.id, { onDelete: "cascade" }),
      title: text("title").notNull(),
      description: text("description"),
      displayOrder: displayOrder(),
    },
    (t) => [index(`${name}_package_id_idx`).on(t.packageId)],
  );

export const packageInclusions = packageListItem("package_inclusions");
export const packageExclusions = packageListItem("package_exclusions");

export const packageHighlights = pgTable(
  "package_highlights",
  {
    id: id(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description"),
    /** Optional icon name for the admin's future use. */
    icon: text("icon"),
    displayOrder: displayOrder(),
  },
  (t) => [index("package_highlights_package_id_idx").on(t.packageId)],
);

/** Official prices per traveller type and currency. GETSET sets each currency deliberately; nothing is converted. */
export const packagePrices = pgTable(
  "package_prices",
  {
    id: id(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    currencyCode: char("currency_code", { length: 3 })
      .notNull()
      .references(() => currencies.code, { onUpdate: "cascade" }),
    priceType: priceType("price_type").notNull(),
    amount: numeric("amount", { precision: 12, scale: 2, mode: "number" }).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("package_prices_package_currency_type_key").on(t.packageId, t.currencyCode, t.priceType),
    check("package_prices_amount_non_negative", sql`${t.amount} >= 0`),
  ],
);

export const packageHotels = pgTable(
  "package_hotels",
  {
    id: id(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    hotelId: uuid("hotel_id")
      .notNull()
      .references(() => hotels.id, { onDelete: "restrict" }),
    nights: integer("nights").notNull(),
    roomType: text("room_type"),
    /** e.g. "Breakfast", "Half board". */
    mealPlan: text("meal_plan"),
    /** The hotel the listed price includes. Other rows are alternatives. */
    isDefault: boolean("is_default").notNull().default(true),
    displayOrder: displayOrder(),
  },
  (t) => [
    index("package_hotels_package_id_idx").on(t.packageId),
    check("package_hotels_nights_positive", sql`${t.nights} > 0`),
  ],
);

export const packageActivities = pgTable(
  "package_activities",
  {
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    activityId: uuid("activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "restrict" }),
    displayOrder: displayOrder(),
  },
  (t) => [primaryKey({ columns: [t.packageId, t.activityId] })],
);

// ---------------------------------------------------------------------------------------------
// Itinerary

export const itineraryDays = pgTable(
  "itinerary_days",
  {
    id: id(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    /** 1-based. Also the display order. */
    dayNumber: integer("day_number").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** Where the night is spent. Empty on the departure day. */
    stay: text("stay"),
    hotelId: uuid("hotel_id").references(() => hotels.id, { onDelete: "set null" }),
    meals: meal("meals").array().notNull().default(sql`'{}'::meal[]`),
    imageId: uuid("image_id").references(() => media.id, { onDelete: "set null" }),
    ...timestamps(),
  },
  (t) => [
    unique("itinerary_days_package_day_key").on(t.packageId, t.dayNumber),
    check("itinerary_days_day_number_positive", sql`${t.dayNumber} > 0`),
  ],
);

export const itineraryActivities = pgTable(
  "itinerary_activities",
  {
    id: id(),
    itineraryDayId: uuid("itinerary_day_id")
      .notNull()
      .references(() => itineraryDays.id, { onDelete: "cascade" }),
    /** Local time at the destination. */
    time: time("time"),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    activityType: itineraryActivityType("activity_type").notNull().default("OTHER"),
    /** Links the timeline entry to a reusable activity, when there is one. */
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    displayOrder: displayOrder(),
  },
  (t) => [index("itinerary_activities_day_id_idx").on(t.itineraryDayId)],
);

// ---------------------------------------------------------------------------------------------
// Itinerary PDFs: one row per generated version, holding both prints.

export const itineraryPdfs = pgTable(
  "itinerary_pdfs",
  {
    id: id(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => packages.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Hash of everything printed in the PDF. A different hash means the PDF is out of date. */
    contentHash: text("content_hash").notNull(),
    withLogoMediaId: uuid("with_logo_media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    withoutLogoMediaId: uuid("without_logo_media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    generatedById: uuid("generated_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("itinerary_pdfs_package_version_key").on(t.packageId, t.version),
    index("itinerary_pdfs_package_hash_idx").on(t.packageId, t.contentHash),
  ],
);

// ---------------------------------------------------------------------------------------------
// Website content

export const testimonials = pgTable(
  "testimonials",
  {
    id: id(),
    customerName: text("customer_name").notNull(),
    /** Short descriptor, e.g. "Malaysia holiday". */
    profile: text("profile").notNull().default(""),
    /** Only with the customer's permission. */
    imageId: uuid("image_id").references(() => media.id, { onDelete: "set null" }),
    rating: smallint("rating").notNull(),
    review: text("review").notNull(),
    place: text("place").notNull().default(""),
    /** Where the review was published, e.g. Google, so it can be verified. */
    sourceName: text("source_name"),
    sourceUrl: text("source_url"),
    reviewedAt: date("reviewed_at"),
    /** Also shown on this package's page when set. */
    packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
    displayOrder: displayOrder(),
    isPublished: boolean("is_published").notNull().default(false),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    ...timestamps(),
  },
  (t) => [
    index("testimonials_published_order_idx").on(t.isPublished, t.displayOrder),
    check("testimonials_rating_range", sql`${t.rating} between 1 and 5`),
  ],
);

export const heroSlides = pgTable(
  "hero_slides",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    /** Short tag in the slide caption, e.g. an airport code. */
    label: text("label"),
    imageId: uuid("image_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    buttonText: text("button_text"),
    buttonLink: text("button_link"),
    displayOrder: displayOrder(),
    isPublished: boolean("is_published").notNull().default(false),
    ...timestamps(),
  },
  (t) => [index("hero_slides_published_order_idx").on(t.isPublished, t.displayOrder)],
);

/** Site-wide content blocks (hero copy, navigation, contact, defaults), validated per key in the content module. */
export const siteContent = pgTable("site_content", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedById: uuid("updated_by_id").references(() => adminUsers.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

// ---------------------------------------------------------------------------------------------
// Enquiries

export const enquiries = pgTable(
  "enquiries",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email"),
    phone: text("phone"),
    whatsapp: text("whatsapp"),
    branchId: uuid("branch_id").references(() => branches.id, { onDelete: "set null" }),
    packageId: uuid("package_id").references(() => packages.id, { onDelete: "set null" }),
    travelDate: date("travel_date"),
    adults: integer("adults").notNull().default(1),
    children: integer("children").notNull().default(0),
    infants: integer("infants").notNull().default(0),
    /** Estimate shown to the customer when they enquired, for reference. */
    currencyCode: char("currency_code", { length: 3 }).references(() => currencies.code, { onUpdate: "cascade" }),
    estimatedTotal: numeric("estimated_total", { precision: 12, scale: 2, mode: "number" }),
    message: text("message"),
    status: enquiryStatus("status").notNull().default("NEW"),
    ...timestamps(),
  },
  (t) => [
    index("enquiries_status_created_at_idx").on(t.status, t.createdAt),
    index("enquiries_package_id_idx").on(t.packageId),
    index("enquiries_branch_id_idx").on(t.branchId),
    check("enquiries_contact_present", sql`coalesce(${t.email}, ${t.phone}, ${t.whatsapp}) is not null`),
    check(
      "enquiries_travellers_range",
      sql`${t.adults} >= 1 and ${t.children} >= 0 and ${t.infants} >= 0 and ${t.adults} + ${t.children} + ${t.infants} <= 60`,
    ),
  ],
);

export const enquiryNotes = pgTable(
  "enquiry_notes",
  {
    id: id(),
    enquiryId: uuid("enquiry_id")
      .notNull()
      .references(() => enquiries.id, { onDelete: "cascade" }),
    adminUserId: uuid("admin_user_id").references(() => adminUsers.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("enquiry_notes_enquiry_id_idx").on(t.enquiryId)],
);

// ---------------------------------------------------------------------------------------------
// Relations, for nested reads with db.query.*

export const adminSessionsRelations = relations(adminSessions, ({ one }) => ({
  adminUser: one(adminUsers, { fields: [adminSessions.adminUserId], references: [adminUsers.id] }),
}));

export const auditLogsRelations = relations(auditLogs, ({ one }) => ({
  adminUser: one(adminUsers, { fields: [auditLogs.adminUserId], references: [adminUsers.id] }),
}));

export const branchesRelations = relations(branches, ({ one, many }) => ({
  bannerImage: one(media, { fields: [branches.bannerImageId], references: [media.id] }),
  thumbnailImage: one(media, { fields: [branches.thumbnailImageId], references: [media.id] }),
  ogImage: one(media, { fields: [branches.ogImageId], references: [media.id] }),
  packages: many(packages),
}));

export const destinationsRelations = relations(destinations, ({ one, many }) => ({
  heroImage: one(media, { fields: [destinations.heroImageId], references: [media.id] }),
  thumbnailImage: one(media, { fields: [destinations.thumbnailImageId], references: [media.id] }),
  ogImage: one(media, { fields: [destinations.ogImageId], references: [media.id] }),
  packages: many(packages),
  activities: many(activities),
}));

export const hotelsRelations = relations(hotels, ({ one }) => ({
  primaryImage: one(media, { fields: [hotels.primaryImageId], references: [media.id] }),
}));

export const activitiesRelations = relations(activities, ({ one, many }) => ({
  image: one(media, { fields: [activities.imageId], references: [media.id] }),
  destination: one(destinations, { fields: [activities.destinationId], references: [destinations.id] }),
  prices: many(activityPrices),
}));

export const activityPricesRelations = relations(activityPrices, ({ one }) => ({
  activity: one(activities, { fields: [activityPrices.activityId], references: [activities.id] }),
}));

export const packagesRelations = relations(packages, ({ one, many }) => ({
  branch: one(branches, { fields: [packages.branchId], references: [branches.id] }),
  destination: one(destinations, { fields: [packages.destinationId], references: [destinations.id] }),
  category: one(packageCategories, { fields: [packages.categoryId], references: [packageCategories.id] }),
  heroImage: one(media, { fields: [packages.heroImageId], references: [media.id] }),
  ogImage: one(media, { fields: [packages.ogImageId], references: [media.id] }),
  images: many(packageImages),
  highlights: many(packageHighlights),
  inclusions: many(packageInclusions),
  exclusions: many(packageExclusions),
  prices: many(packagePrices),
  hotels: many(packageHotels),
  activities: many(packageActivities),
  itineraryDays: many(itineraryDays),
  pdfs: many(itineraryPdfs),
  testimonials: many(testimonials),
}));

export const packageImagesRelations = relations(packageImages, ({ one }) => ({
  package: one(packages, { fields: [packageImages.packageId], references: [packages.id] }),
  media: one(media, { fields: [packageImages.mediaId], references: [media.id] }),
}));

export const packageHighlightsRelations = relations(packageHighlights, ({ one }) => ({
  package: one(packages, { fields: [packageHighlights.packageId], references: [packages.id] }),
}));

export const packageInclusionsRelations = relations(packageInclusions, ({ one }) => ({
  package: one(packages, { fields: [packageInclusions.packageId], references: [packages.id] }),
}));

export const packageExclusionsRelations = relations(packageExclusions, ({ one }) => ({
  package: one(packages, { fields: [packageExclusions.packageId], references: [packages.id] }),
}));

export const packagePricesRelations = relations(packagePrices, ({ one }) => ({
  package: one(packages, { fields: [packagePrices.packageId], references: [packages.id] }),
}));

export const packageHotelsRelations = relations(packageHotels, ({ one }) => ({
  package: one(packages, { fields: [packageHotels.packageId], references: [packages.id] }),
  hotel: one(hotels, { fields: [packageHotels.hotelId], references: [hotels.id] }),
}));

export const packageActivitiesRelations = relations(packageActivities, ({ one }) => ({
  package: one(packages, { fields: [packageActivities.packageId], references: [packages.id] }),
  activity: one(activities, { fields: [packageActivities.activityId], references: [activities.id] }),
}));

export const itineraryDaysRelations = relations(itineraryDays, ({ one, many }) => ({
  package: one(packages, { fields: [itineraryDays.packageId], references: [packages.id] }),
  hotel: one(hotels, { fields: [itineraryDays.hotelId], references: [hotels.id] }),
  image: one(media, { fields: [itineraryDays.imageId], references: [media.id] }),
  activities: many(itineraryActivities),
}));

export const itineraryActivitiesRelations = relations(itineraryActivities, ({ one }) => ({
  day: one(itineraryDays, { fields: [itineraryActivities.itineraryDayId], references: [itineraryDays.id] }),
  activity: one(activities, { fields: [itineraryActivities.activityId], references: [activities.id] }),
}));

export const itineraryPdfsRelations = relations(itineraryPdfs, ({ one }) => ({
  package: one(packages, { fields: [itineraryPdfs.packageId], references: [packages.id] }),
  withLogo: one(media, { fields: [itineraryPdfs.withLogoMediaId], references: [media.id] }),
  withoutLogo: one(media, { fields: [itineraryPdfs.withoutLogoMediaId], references: [media.id] }),
}));

export const testimonialsRelations = relations(testimonials, ({ one }) => ({
  image: one(media, { fields: [testimonials.imageId], references: [media.id] }),
  package: one(packages, { fields: [testimonials.packageId], references: [packages.id] }),
}));

export const heroSlidesRelations = relations(heroSlides, ({ one }) => ({
  image: one(media, { fields: [heroSlides.imageId], references: [media.id] }),
}));

export const enquiriesRelations = relations(enquiries, ({ one, many }) => ({
  branch: one(branches, { fields: [enquiries.branchId], references: [branches.id] }),
  package: one(packages, { fields: [enquiries.packageId], references: [packages.id] }),
  notes: many(enquiryNotes),
}));

export const enquiryNotesRelations = relations(enquiryNotes, ({ one }) => ({
  enquiry: one(enquiries, { fields: [enquiryNotes.enquiryId], references: [enquiries.id] }),
  adminUser: one(adminUsers, { fields: [enquiryNotes.adminUserId], references: [adminUsers.id] }),
}));
