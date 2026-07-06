"use client"

import { useState } from "react"
import { Clock, ChevronDown } from "lucide-react"
import type { ScrapeResult } from "@/lib/mock-data"
import { HEATMAP_DAYS, HEATMAP_HOURS } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

const LEGEND = [
  { label: ">500", cls: "hatch-grape" },
  { label: ">1,000", cls: "hatch-lime" },
  { label: ">2,000", style: { backgroundColor: "color-mix(in oklab, var(--lime) 45%, var(--card))" } },
  { label: ">3,000", style: { backgroundColor: "var(--lime)" } },
]

function cellProps(level: number) {
  switch (level) {
    case 1:
      return { className: "hatch-grape" }
    case 2:
      return { className: "hatch-lime" }
    case 3:
      return { style: { backgroundColor: "color-mix(in oklab, var(--lime) 45%, var(--card))" } }
    case 4:
      return { style: { backgroundColor: "var(--lime)" } }
    default:
      return { style: { backgroundColor: "color-mix(in oklab, var(--secondary) 55%, transparent)" } }
  }
}

export function Heatmap({ data }: { data: ScrapeResult }) {
  const [dim, setDim] = useState<"Reviewers" | "Ratings">("Reviewers")

  return (
    <div className="animate-rise rounded-3xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground">
            <Clock className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Activity by time</h3>
            <p className="text-base font-semibold text-foreground">When reviews land</p>
          </div>
        </div>
        <button
          onClick={() => setDim((d) => (d === "Reviewers" ? "Ratings" : "Reviewers"))}
          className="flex items-center gap-1.5 rounded-full bg-background px-3.5 py-2 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
        >
          {dim}
          <ChevronDown className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* legend */}
      <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        {LEGEND.map((l) => (
          <span key={l.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn("h-3.5 w-3.5 rounded", l.cls)} style={l.style} />
            {l.label}
          </span>
        ))}
      </div>

      {/* grid */}
      <div className="mt-4 flex gap-2">
        {/* hour labels */}
        <div className="flex flex-col justify-between py-0.5 text-right text-[11px] text-muted-foreground">
          {HEATMAP_HOURS.map((h) => (
            <span key={h} className="leading-none">
              {h}
            </span>
          ))}
        </div>
        {/* cells */}
        <div className="flex-1">
          <div className="grid grid-cols-7 gap-1.5">
            {data.heatmap.map((row, r) =>
              row.map((level, c) => {
                const p = cellProps(level)
                return (
                  <div
                    key={`${r}-${c}`}
                    className={cn("aspect-square rounded-md transition-transform hover:scale-110", p.className)}
                    style={p.style}
                    title={`${HEATMAP_DAYS[c]} ${HEATMAP_HOURS[r]}`}
                  />
                )
              }),
            )}
          </div>
          <div className="mt-2 grid grid-cols-7 text-center text-[11px] text-muted-foreground">
            {HEATMAP_DAYS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
