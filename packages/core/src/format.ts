/** Compact human numbers: 950 → "950", 1400 → "1.4K", 2_100_000 → "2.1M". */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs < 1000) {
    return String(value);
  }
  const units: [number, string][] = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1000, "K"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = value / size;
      // One decimal below 10 ("1.4K"), none above ("14K") — Tufte-tight.
      const text = Math.abs(scaled) < 10 ? scaled.toFixed(1) : String(Math.round(scaled));
      return `${text.replace(/\.0$/, "")}${suffix}`;
    }
  }
  return String(value);
}

/** ISO date → "Mar 4, 2026" (falls back to the raw string on bad input). */
export function formatDate(iso: string): string {
  // Date-only strings ("2010-10-06") parse as UTC midnight, which renders as
  // the PREVIOUS day in UTC-negative timezones — construct them as local.
  const dateOnly = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
