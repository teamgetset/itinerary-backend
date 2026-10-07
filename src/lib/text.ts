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

/** Escapes LIKE wildcards in user input. */
export const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

export const slugSchemaMessage = "Use lower-case letters, numbers and single hyphens";
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
