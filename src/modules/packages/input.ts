import { z } from "zod";
import { ITINERARY_ACTIVITY_TYPES } from "../../db/models.ts";
import { nullableText, optionalId } from "../crud.ts";
import { seoInput, slugInput } from "../shared.ts";
import { PRICE_TYPES } from "./read.ts";

/* Admin input for packages. Each section of the package editor saves through its own schema. */

const unique = <T>(list: T[], key: (item: T) => string = String) => new Set(list.map(key)).size === list.length;

export const packageInput = z
  .object({
    branchId: z.uuid("Choose a branch."),
    destinationId: z.uuid("Choose a destination."),
    categoryId: optionalId,
    title: z.string().trim().min(1, "Package title is required.").max(160),
    slug: slugInput.optional(),
    shortDescription: z.string().trim().max(300).optional(),
    description: z.string().trim().max(10_000).optional(),
    durationDays: z.number().int().min(1, "Duration must be greater than 0.").max(90),
    durationNights: z.number().int().min(0, "Nights cannot be negative.").max(90),
    bestTime: nullableText(120),
    arrivalAirportCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Three-letter airport code, e.g. KUL").nullish(),
    arrivalCity: nullableText(80),
    heroImageId: optionalId,
    keywords: z.array(z.string().trim().toLowerCase().min(1).max(40)).max(30).optional(),
    importantInfo: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    displayOrder: z.number().int().min(0).optional(),
    isFeatured: z.boolean().optional(),
    isRecommended: z.boolean().optional(),
  })
  .extend(seoInput.shape);

export const createPackageInput = packageInput.refine((data) => data.durationNights <= data.durationDays, {
  path: ["durationNights"],
  message: "Nights cannot be more than days.",
});

/** PATCH: any subset. Nights vs days is checked against the stored values in the service. */
export const updatePackageInput = packageInput.partial();

const listItem = z.object({ title: z.string().trim().min(1, "Text is required.").max(300), description: nullableText(1000) });

export const highlightsInput = z.object({ items: z.array(listItem.extend({ icon: nullableText(40) })).max(30) });
/** Inclusions, exclusions and "Good to know": short texts with optional detail. */
export const inclusionsInput = z.object({ items: z.array(listItem).max(60) });
/** "Important information": one line each. Up to 40: a package's own copy starts with the shared notes (up to 20) and its own. */
export const importantInfoInput = z.object({ items: z.array(z.string().trim().min(1, "Text is required.").max(300)).max(40) });

export const itineraryInput = z.object({
  days: z
    .array(
      z.object({
        title: z.string().trim().min(1, "Day title is required.").max(160),
        description: z.string().trim().max(5000).optional(),
        stay: nullableText(120),
        hotelId: optionalId,
        meals: z
          .array(z.enum(["BREAKFAST", "LUNCH", "DINNER"]))
          .max(3)
          .refine((meals) => unique(meals), "Each meal once")
          .optional(),
        imageId: optionalId,
        activities: z
          .array(
            z.object({
              time: z
                .string()
                .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour time, e.g. 09:30")
                .nullish(),
              title: z.string().trim().min(1, "Activity title is required.").max(160),
              description: nullableText(1000),
              location: nullableText(160),
              type: z.enum(ITINERARY_ACTIVITY_TYPES).optional(),
              activityId: optionalId,
            }),
          )
          .max(30)
          .optional(),
      }),
    )
    .max(90),
});

const PRICE_LABEL = { ADULT: "Adult", CHILD: "Child", INFANT: "Infant" } as const;

export const pricesInput = z.object({
  prices: z
    .array(
      z
        .object({
          currencyCode: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/, "Unknown currency"),
          priceType: z.enum(PRICE_TYPES),
          amount: z.number("Enter a number."),
        })
        .superRefine((price, ctx) => {
          if (price.amount < 0) {
            ctx.addIssue({
              code: "custom",
              path: ["amount"],
              message: `${PRICE_LABEL[price.priceType]} ${price.currencyCode} price cannot be negative.`,
            });
          }
          if (price.amount > 100_000_000) ctx.addIssue({ code: "custom", path: ["amount"], message: "That price is too large." });
        })
        .transform((price) => ({ ...price, amount: Math.round(price.amount * 100) / 100 })),
    )
    .max(60)
    .refine((prices) => unique(prices, (p) => `${p.currencyCode}:${p.priceType}`), "Each traveller type once per currency"),
});

export const hotelsInput = z.object({
  hotels: z
    .array(
      z.object({
        // All optional: a row may be saved before its hotel or nights are known.
        hotelId: optionalId,
        nights: z.number().int().min(1, "At least one night.").max(60).nullish(),
        roomType: nullableText(80),
        mealPlan: nullableText(80),
        isDefault: z.boolean().optional(),
      }),
    )
    .max(30),
});

export const activitiesInput = z.object({
  activityIds: z.array(z.uuid()).max(60).refine((ids) => unique(ids), "Each activity once"),
});

export const galleryInput = z.object({
  mediaIds: z.array(z.uuid()).max(30).refine((ids) => unique(ids), "Each photo once"),
});

export const adminPackageQuery = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
  branchId: z.uuid().optional(),
  destinationId: z.uuid().optional(),
  categoryId: z.uuid().optional(),
  featured: z.enum(["true", "false"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
