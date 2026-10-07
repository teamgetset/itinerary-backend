import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { z } from "zod";

/** An error that is safe to show to the API client: a status, a stable code and a plain message. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (thing: string) =>
  new AppError(404, `${thing.toUpperCase().replace(/\W+/g, "_")}_NOT_FOUND`, `${thing} not found`);

export const badRequest = (code: string, message: string, details?: unknown) => new AppError(400, code, message, details);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

export const unauthorized = (message = "Sign in to continue") => new AppError(401, "UNAUTHORIZED", message);

export const forbidden = (message = "You do not have permission to do this") => new AppError(403, "FORBIDDEN", message);

/** Field-level problems, keyed by dotted path ("days.0.title"), so forms can show them next to the right input. */
export function validationError(error: z.ZodError) {
  return new AppError(
    400,
    "VALIDATION_ERROR",
    "Some fields need attention",
    error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}
