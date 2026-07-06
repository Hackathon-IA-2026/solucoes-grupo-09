"use client"

import { useState } from "react"
import { UserPlus, MoreHorizontal } from "lucide-react"
import type { ScrapeResult } from "@/lib/mock-data"
import { formatNumber } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export function TimelineChart({ data }: { data: ScrapeResult }) {
  const points = data.timeline.slice(-6)
  const [range, setRange] = useState<"monthly" | "yearly">("yearly")
  const [active, setActive] = useState<number>(3)

  const max = Math.max(...points.map((p) => p.count)) * 1.15
  const W = 560
  const H = 240
  const pad = { top: 30, right: 12, bottom: 28, left: 44 }
  const chartW = W - pad.left - pad.right
  const chartH = H - pad.top - pad.bottom
  const slot = chartW / points.length
  const barW = Math.min(46, slot * 0.5)

  const axis = [1, 0.75, 0.5, 0.25, 0]

  const cur = points[active]
  const prev = points[active - 1] ?? points[active]
  const delta = prev.count ? ((cur.count - prev.count) / prev.count) * 100 : 0

  // active bar geometry (as % of viewbox for HTML overlays)
  const activeCX = pad.left + active * slot + slot / 2
  const activeTop = pad.top + chartH - (cur.count / max) * chartH

  return (
    <div className="animate-rise rounded-3xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground">
            <UserPlus className="h-[18px] w-[18px]" />
          </span>
          <div>
            <h3 className="text-sm font-medium text-muted-foreground">Review volume</h3>
            <p className="text-base font-semibold text-foreground">Last 6 months</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-full bg-secondary p-1 text-xs">
            <button
              onClick={() => setRange("monthly")}
              className={cn(
                "rounded-full px-3 py-1.5 font-medium transition-colors",
                range === "monthly" ? "bg-lime text-lime-foreground font-semibold" : "text-muted-foreground",
              )}
            >
              Monthly
            </button>
            <button
              onClick={() => setRange("yearly")}
              className={cn(
                "rounded-full px-3 py-1.5 font-medium transition-colors",
                range === "yearly" ? "bg-lime text-lime-foreground font-semibold" : "text-muted-foreground",
              )}
            >
              Yearly
            </button>
          </div>
          <button
            aria-label="More"
            className="flex h-8 w-8 items-center justify-center rounded-full bg-background text-foreground transition-colors hover:bg-secondary"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="relative mt-5">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" role="img" aria-label="Monthly review volume">
          <defs>
            <linearGradient id="tl-active" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--grape)" />
              <stop offset="100%" stopColor="var(--grape)" stopOpacity="0.55" />
            </linearGradient>
            <pattern id="tl-hatch" width="7" height="7" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
              <rect width="7" height="7" fill="var(--grape)" opacity="0.1" />
              <line x1="0" y1="0" x2="0" y2="7" stroke="var(--grape)" strokeWidth="3" opacity="0.5" />
            </pattern>
          </defs>

          {/* gridlines + y axis labels */}
          {axis.map((g) => {
            const y = pad.top + chartH * (1 - g)
            return (
              <g key={g}>
                <line
                  x1={pad.left}
                  x2={W - pad.right}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  className="text-border"
                  strokeDasharray="2 6"
                />
                <text x={pad.left - 10} y={y + 3} textAnchor="end" className="fill-muted-foreground text-[10px]">
                  {g === 0 ? "0" : formatNumber(Math.round(max * g))}
                </text>
              </g>
            )
          })}

          {points.map((p, i) => {
            const h = Math.max((p.count / max) * chartH, barW)
            const x = pad.left + i * slot + (slot - barW) / 2
            const y = pad.top + chartH - h
            const isActive = i === active
            return (
              <g key={p.month} onClick={() => setActive(i)} style={{ cursor: "pointer" }}>
                {/* invisible hit area */}
                <rect x={pad.left + i * slot} y={pad.top} width={slot} height={chartH} fill="transparent" />
                {/* capsule bar */}
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={barW / 2}
                  fill={isActive ? "url(#tl-active)" : "url(#tl-hatch)"}
                  className="transition-all duration-300"
                />
                {/* dot on top */}
                <circle cx={x + barW / 2} cy={y} r={5} fill={isActive ? "var(--grape)" : "var(--grape)"} opacity={isActive ? 0 : 1} />
                <text
                  x={x + barW / 2}
                  y={H - 6}
                  textAnchor="middle"
                  className={cn("text-[11px]", isActive ? "fill-foreground font-semibold" : "fill-muted-foreground")}
                >
                  {p.month}
                </text>
              </g>
            )
          })}

          {/* white connector dot at active bar top */}
          <circle cx={activeCX} cy={activeTop} r={6} fill="var(--foreground)" stroke="var(--grape)" strokeWidth={3} />
        </svg>

        {/* green delta bubble with downward tail */}
        <div
          className="animate-pop pointer-events-none absolute -translate-x-1/2 -translate-y-full"
          style={{ left: `${(activeCX / W) * 100}%`, top: `${((activeTop - 16) / H) * 100}%` }}
        >
          <div className="relative">
            <span className="flex items-center rounded-full bg-lime px-2.5 py-1 text-[11px] font-bold text-lime-foreground shadow-lg">
              {delta >= 0 ? "+" : ""}
              {delta.toFixed(1)}%
            </span>
            <span
              className="absolute left-1/2 top-full h-0 w-0 -translate-x-1/2 border-x-4 border-t-4 border-x-transparent"
              style={{ borderTopColor: "var(--lime)" }}
            />
          </div>
        </div>

        {/* glass tooltip — offset to the right of the bar, left-aligned */}
        <div
          className="animate-pop pointer-events-none absolute"
          style={{ left: `${(activeCX / W) * 100}%`, top: `${((activeTop + 28) / H) * 100}%` }}
        >
          <div className="ml-3 rounded-2xl border border-white/10 bg-foreground/[0.06] px-4 py-2.5 shadow-xl backdrop-blur-md">
            <div className="text-[11px] text-muted-foreground">
              {cur.month}, {new Date().getFullYear()}
            </div>
            <div className="text-xl font-semibold tabular-nums text-foreground">{cur.count.toLocaleString()}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
