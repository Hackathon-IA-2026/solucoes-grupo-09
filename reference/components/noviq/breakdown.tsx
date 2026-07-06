"use client"

import { Hash, PieChart, Layers, MoreHorizontal } from "lucide-react"
import type { ScrapeResult } from "@/lib/mock-data"
import { formatNumber } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export function RatingDistribution({ data }: { data: ScrapeResult }) {
  const rows = [5, 4, 3, 2, 1]
  const max = Math.max(...data.distribution)
  return (
    <div className="animate-rise rounded-3xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground">
          <Layers className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">Rating breakdown</h3>
          <p className="text-base font-semibold text-foreground">{data.distribution[4].toFixed(0)}% love it</p>
        </div>
      </div>
      <div className="mt-5 space-y-3.5">
        {rows.map((star) => {
          const pct = data.distribution[star - 1]
          const isTop = star >= 4
          return (
            <div key={star} className="flex items-center gap-3">
              <span className="w-4 text-right text-xs font-medium tabular-nums text-muted-foreground">{star}</span>
              <div className="h-3 flex-1 overflow-hidden rounded-full bg-secondary">
                <div
                  className={cn(
                    "h-full rounded-full transition-all duration-500",
                    isTop ? "bg-lime" : star === 3 ? "bg-grape" : "bg-destructive",
                  )}
                  style={{ width: `${(pct / max) * 100}%` }}
                />
              </div>
              <span className="w-10 text-right text-xs font-semibold tabular-nums text-foreground">{pct.toFixed(1)}%</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Arc gauge — sentiment distribution
export function SentimentRing({ data }: { data: ScrapeResult }) {
  const { positive, neutral, negative } = data.sentiment
  const segs = [
    { key: "positive", value: positive, color: "var(--lime)", label: "Positive", count: Math.round((positive / 100) * data.totalScraped) },
    { key: "neutral", value: neutral, color: "var(--grape)", label: "Neutral", count: Math.round((neutral / 100) * data.totalScraped) },
    { key: "negative", value: negative, hatch: true, label: "Negative", count: Math.round((negative / 100) * data.totalScraped) },
  ]

  const size = 200
  const cx = size / 2
  const cy = size / 2
  const r = 74
  const stroke = 22
  const c = 2 * Math.PI * r
  const sweep = 0.72 // 259° arc, gap at bottom
  const gap = 1 - sweep
  // rotate so the gap is centered at the bottom
  const rotation = 90 + (gap * 360) / 2

  let acc = 0
  return (
    <div className="animate-rise rounded-3xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground">
            <PieChart className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Sentiment split</h3>
            <p className="text-base font-semibold text-foreground">Across all reviews</p>
          </div>
        </div>
        <button
          aria-label="More"
          className="flex h-8 w-8 items-center justify-center rounded-full bg-background text-foreground transition-colors hover:bg-secondary"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </div>

      <div className="relative mx-auto mt-3 w-[200px]">
        <svg viewBox={`0 0 ${size} ${size}`} className="w-full">
          <defs>
            <pattern id="gauge-hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="7" height="7" fill="var(--grape)" opacity="0.18" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--grape)" strokeWidth="3.5" opacity="0.7" />
            </pattern>
          </defs>
          <g transform={`rotate(${rotation} ${cx} ${cy})`}>
            {/* track */}
            <circle
              cx={cx}
              cy={cy}
              r={r}
              fill="none"
              stroke="var(--secondary)"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${sweep * c} ${c}`}
            />
            {segs.map((s) => {
              const len = (s.value / 100) * sweep * c
              const el = (
                <circle
                  key={s.key}
                  cx={cx}
                  cy={cy}
                  r={r}
                  fill="none"
                  stroke={s.hatch ? "url(#gauge-hatch)" : s.color}
                  strokeWidth={stroke}
                  strokeLinecap="round"
                  strokeDasharray={`${Math.max(len - 6, 0)} ${c}`}
                  strokeDashoffset={-acc}
                />
              )
              acc += len
              return el
            })}
          </g>
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold tabular-nums text-foreground">{formatNumber(data.totalScraped)}</span>
          <span className="text-xs text-muted-foreground">reviews analyzed</span>
        </div>
      </div>

      {/* legend stats */}
      <div className="mt-2 grid grid-cols-3 gap-2 border-t border-border pt-4">
        {segs.map((s) => (
          <div key={s.key} className="text-center">
            <div className="text-lg font-semibold tabular-nums text-foreground">{formatNumber(s.count)}</div>
            <div className="mt-1 flex items-center justify-center gap-1.5 text-[11px] text-muted-foreground">
              <span
                className={cn("h-2.5 w-2.5 rounded-full", s.hatch && "hatch-grape")}
                style={s.hatch ? undefined : { background: s.color }}
              />
              {s.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export function KeywordPanel({ data }: { data: ScrapeResult }) {
  const max = Math.max(...data.keywords.map((k) => k.count))
  return (
    <div className="animate-rise rounded-3xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground">
          <Hash className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">What people mention</h3>
          <p className="text-base font-semibold text-foreground">Top keywords</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        {data.keywords.map((k) => {
          const scale = 0.85 + (k.count / max) * 0.55
          return (
            <span
              key={k.word}
              className={cn(
                "rounded-full border px-3 py-1.5 font-medium leading-none",
                k.tone === "positive" && "border-lime/30 bg-lime/10 text-lime",
                k.tone === "negative" && "border-destructive/30 bg-destructive/10 text-destructive",
                k.tone === "neutral" && "border-grape/30 bg-grape/10 text-grape",
              )}
              style={{ fontSize: `${scale * 0.85}rem` }}
            >
              {k.word}
              <span className="ml-1.5 opacity-60 tabular-nums">{k.count}</span>
            </span>
          )
        })}
      </div>
    </div>
  )
}

export function VersionPanel({ data }: { data: ScrapeResult }) {
  return (
    <div className="animate-rise rounded-3xl border border-border bg-card p-5">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground">
          <Layers className="h-[18px] w-[18px]" />
        </span>
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">Ratings by version</h3>
          <p className="text-base font-semibold text-foreground">Recent releases</p>
        </div>
      </div>
      <div className="mt-4 space-y-1">
        {data.versions.map((v) => (
          <div key={v.version} className="flex items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-secondary/60">
            <span className="w-14 font-mono text-xs text-muted-foreground">{v.version}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-lime transition-all duration-500" style={{ width: `${(v.rating / 5) * 100}%` }} />
            </div>
            <span className="w-8 text-right text-sm font-semibold tabular-nums text-foreground">{v.rating.toFixed(1)}</span>
            <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{v.reviews.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
