import type { ScrapeResult } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

export function RatingDistribution({ data }: { data: ScrapeResult }) {
  const rows = [5, 4, 3, 2, 1];
  const max = Math.max(...data.distribution);
  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <h3 className="text-sm font-medium text-muted-foreground">Rating breakdown</h3>
      <p className="mt-1 text-lg font-semibold text-foreground">
        {data.distribution[4].toFixed(0)}% love it
      </p>
      <div className="mt-5 space-y-3">
        {rows.map((star) => {
          const pct = data.distribution[star - 1];
          const isTop = star >= 4;
          return (
            <div key={star} className="flex items-center gap-3">
              <span className="w-4 text-right text-xs font-medium tabular-nums text-muted-foreground">
                {star}
              </span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    isTop ? "bg-lime" : star === 3 ? "bg-grape" : "bg-destructive",
                  )}
                  style={{ width: `${(pct / max) * 100}%` }}
                />
              </div>
              <span className="w-10 text-right text-xs font-semibold tabular-nums text-foreground">
                {pct.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SentimentRing({ data }: { data: ScrapeResult }) {
  const { positive, neutral, negative } = data.sentiment;
  const r = 54;
  const c = 2 * Math.PI * r;
  const segs = [
    { value: positive, color: "var(--lime)", label: "Positive" },
    { value: neutral, color: "var(--grape)", label: "Neutral" },
    { value: negative, color: "var(--destructive)", label: "Negative" },
  ];
  let offset = 0;
  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <h3 className="text-sm font-medium text-muted-foreground">Sentiment mix</h3>
      <div className="mt-3 flex items-center gap-5">
        <div className="relative h-[132px] w-[132px] shrink-0">
          <svg viewBox="0 0 132 132" className="h-full w-full -rotate-90">
            <circle
              cx="66"
              cy="66"
              r={r}
              fill="none"
              stroke="var(--secondary)"
              strokeWidth="14"
            />
            {segs.map((s) => {
              const len = (s.value / 100) * c;
              const el = (
                <circle
                  key={s.label}
                  cx="66"
                  cy="66"
                  r={r}
                  fill="none"
                  stroke={s.color}
                  strokeWidth="14"
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(len - 4, 0)} ${c}`}
                  strokeDashoffset={-offset}
                />
              );
              offset += len;
              return el;
            })}
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-semibold tabular-nums text-foreground">
              {positive}%
            </span>
            <span className="text-[10px] text-muted-foreground">positive</span>
          </div>
        </div>
        <div className="flex-1 space-y-2.5">
          {segs.map((s) => (
            <div key={s.label} className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2 text-muted-foreground">
                <span
                  className="h-2.5 w-2.5 rounded-full"
                  style={{ background: s.color }}
                />
                {s.label}
              </span>
              <span className="font-semibold tabular-nums text-foreground">
                {s.value}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function KeywordPanel({ data }: { data: ScrapeResult }) {
  const max = Math.max(...data.keywords.map((k) => k.count));
  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <h3 className="text-sm font-medium text-muted-foreground">What people mention</h3>
      <div className="mt-4 flex flex-wrap gap-2">
        {data.keywords.map((k) => {
          const scale = 0.8 + (k.count / max) * 0.7;
          return (
            <span
              key={k.word}
              className={cn(
                "rounded-full border px-3 py-1 font-medium leading-none",
                k.tone === "positive" && "border-lime/30 bg-lime/10 text-lime",
                k.tone === "negative" &&
                  "border-destructive/30 bg-destructive/10 text-destructive",
                k.tone === "neutral" && "border-grape/30 bg-grape/10 text-grape",
              )}
              style={{
                fontSize: `${scale * 0.85}rem`,
                paddingTop: `${scale * 0.35}rem`,
                paddingBottom: `${scale * 0.35}rem`,
              }}
            >
              {k.word}
              <span className="ml-1.5 opacity-60 tabular-nums">{k.count}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function VersionPanel({ data }: { data: ScrapeResult }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <h3 className="text-sm font-medium text-muted-foreground">Ratings by version</h3>
      <div className="mt-4 space-y-1">
        {data.versions.map((v) => (
          <div
            key={v.version}
            className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-secondary/60"
          >
            <span className="w-14 font-mono text-xs text-muted-foreground">
              {v.version}
            </span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-lime"
                style={{ width: `${(v.rating / 5) * 100}%` }}
              />
            </div>
            <span className="w-8 text-right text-sm font-semibold tabular-nums text-foreground">
              {v.rating.toFixed(1)}
            </span>
            <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
              {v.reviews.toLocaleString()}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
