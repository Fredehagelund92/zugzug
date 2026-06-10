export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NAME_TAKEN"
  | "CONFIRMATION_REQUIRED"
  | "NOT_FOUND"
  | "WRONG_DOMAIN"
  | "ALREADY_EXISTS"
  | "CANNOT_REMOVE_SELF"
  | "CONFLICT"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public status: number = 400,
    /** Structured payload included verbatim in the JSON response body under "details".
     *  Used by CONFLICT to carry { current, conflictedKeys? } for optimistic concurrency. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}
