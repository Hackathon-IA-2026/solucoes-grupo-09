import { mkdir, writeFile } from "node:fs/promises";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppleReview } from "./types.js";

const CSV_COLUMNS: (keyof AppleReview | "developerResponseBody")[] = [
  "id",
  "date",
  "rating",
  "userName",
  "title",
  "body",
  "isEdited",
  "developerResponseBody",
  "appId",
  "country",
];

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  // Quote if the cell contains a delimiter, quote, or newline.
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRow(review: AppleReview): string {
  return CSV_COLUMNS.map((col) => {
    if (col === "developerResponseBody") {
      return csvCell(review.developerResponse?.body ?? "");
    }
    return csvCell(review[col as keyof AppleReview]);
  }).join(",");
}

/** Write the full array to a pretty-printed JSON file. */
export async function writeJson(
  path: string,
  reviews: AppleReview[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(reviews, null, 2), "utf8");
}

/** Write the full array to a CSV file. */
export async function writeCsv(
  path: string,
  reviews: AppleReview[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const lines = [CSV_COLUMNS.join(","), ...reviews.map(csvRow)];
  await writeFile(path, lines.join("\n") + "\n", "utf8");
}

/**
 * Streaming CSV sink — append rows as reviews arrive instead of buffering the
 * whole dataset. Useful for very large pulls.
 */
export function createCsvSink(path: string): {
  write: (review: AppleReview) => void;
  close: () => Promise<void>;
} {
  mkdirSync(dirname(path), { recursive: true });
  const stream = createWriteStream(path, { encoding: "utf8" });
  stream.write(CSV_COLUMNS.join(",") + "\n");
  return {
    write: (review) => stream.write(csvRow(review) + "\n"),
    close: () =>
      new Promise<void>((resolve, reject) => {
        stream.end((err: unknown) => (err ? reject(err) : resolve()));
      }),
  };
}
