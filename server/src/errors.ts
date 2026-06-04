export type ErrorCode =
  | "VALIDATION_FAILED"
  | "NAME_TAKEN"
  | "CONFIRMATION_REQUIRED"
  | "NOT_FOUND"
  | "WRONG_DOMAIN"
  | "ALREADY_EXISTS"
  | "CANNOT_REMOVE_SELF"
  | "INTERNAL";

export class AppError extends Error {
  constructor(public code: ErrorCode, message: string, public status: number = 400) {
    super(message);
    this.name = "AppError";
  }
}
