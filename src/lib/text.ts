/** "Malé, Türkiye" -> "male, turkiye": lower-case without accents, for matching typed searches. */
export const normalizeText = (value: string) =>
  value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export const slugify = (value: string) =>
  normalizeText(value)
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

/** Escapes regular-expression characters in user input, so `$regex` matches it literally. */
export const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Case-insensitive "contains" filter for user-typed text (the `ILIKE '%q%'` of the PostgreSQL version). */
export const contains = (value: string) => ({ $regex: escapeRegex(value), $options: "i" });

export const slugSchemaMessage = "Use lower-case letters, numbers and single hyphens";
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
