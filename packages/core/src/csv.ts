import type { Review } from "./types";

/**
 * RFC 4180 field escaping: quote when the value contains a comma, quote, or
 * newline; double any embedded quotes. Values are emitted as-is otherwise —
 * conservative in what we send.
 */
function escapeField(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const COLUMNS = [
  "store",
  "appId",
  "country",
  "id",
  "userName",
  "rating",
  "title",
  "body",
  "date",
  "thumbsUp",
  "appVersion",
  "isEdited",
  "developerResponse",
  "developerResponseDate",
] as const;

/** Serialize reviews to a CSV string (header + one row per review, CRLF). */
export function reviewsToCsv(reviews: Review[]): string {
  const rows = reviews.map((review) =>
    [
      review.store,
      review.appId,
      review.country,
      review.id,
      review.userName,
      review.rating,
      review.title,
      review.body,
      review.date,
      review.thumbsUp,
      review.appVersion,
      review.isEdited,
      review.developerResponse?.body,
      review.developerResponse?.modified,
    ]
      .map(escapeField)
      .join(","),
  );
  return [COLUMNS.join(","), ...rows].join("\r\n");
}

/** Serialize reviews to pretty-printed JSON. */
export function reviewsToJson(reviews: Review[]): string {
  return JSON.stringify(reviews, null, 2);
}

/** A safe export filename like `noviq-reviews-com.spotify.music-us.csv`. */
export function exportFilename(
  appId: string,
  country: string,
  ext: "csv" | "json",
): string {
  const safe = appId.replace(/[^\w.-]/g, "_");
  return `noviq-reviews-${safe}-${country}.${ext}`;
}
