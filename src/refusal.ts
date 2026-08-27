/**
 * Raised when a Claude call comes back with `stop_reason: "refusal"`.
 *
 * Safety classifiers return HTTP 200 with an empty or partial body, so without
 * an explicit check the caller gets a confusing null dereference instead of a
 * message it can show the user. Every Claude call in this codebase checks for
 * it and throws this.
 */
export class RefusalError extends Error {
  readonly category: string | null | undefined;

  constructor(message: string, category?: string | null) {
    super(message);
    this.name = 'RefusalError';
    this.category = category;
  }
}

/** Formats `(category)` into a message only when the API supplied one. */
export function withCategory(text: string, category: string | null | undefined): string {
  return category ? `${text} (${category})` : text;
}
