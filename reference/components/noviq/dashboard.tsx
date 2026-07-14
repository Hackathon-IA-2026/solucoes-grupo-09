"use client"

import { useState } from "react"
import { Apple, CalendarDays, Download, Play, RotateCcw, SlidersHorizontal } from "lucide-react"
import type { ScrapeResult } from "@/lib/mock-data"
import { formatNumber } from "@/lib/mock-data"
import { Stars } from "./brand"
import { TopNav } from "./top-nav"
import { StatCards } from "./stat-cards"
import { TimelineChart } from "./timeline-chart"
import { Heatmap } from "./heatmap"
import { RatingDistribution, SentimentRing, KeywordPanel, VersionPanel } from "./breakdown"
import { ReviewsFeed } from "./reviews-feed"
import { cn } from "@/lib/utils"

const VIEWS = ["All", "Trends", "Sentiment", "Reviews"] as const

export function Dashboard({ data, url, onReset }: { data: ScrapeResult; url: string; onReset: () => void }) {
  const [view, setView] = useState<(typeof VIEWS)[number]>("All")

  function exportJson() {
    const blob = new Blob([JSON.stringify({ url, ...data }, null, 2)], { type: "application/json" })
    downloadBlob(blob, `zalytix-${data.appName.toLowerCase()}.json`)
  }

  function exportCsv() {
    const header = ["author", "rating", "date", "country", "version", "sentiment", "helpful", "title", "body", "developer_response"]
    const rows = data.reviews.map((r) =>
      [r.author, r.rating, r.date, r.country, r.version, r.sentiment, r.helpful, r.title, r.body, r.developerResponse?.body ?? ""]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(","),
    )
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv" })
    downloadBlob(blob, `zalytix-${data.appName.toLowerCase()}.csv`)
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-5 sm:px-6 sm:py-7">
      <TopNav />

      {/* Hero */}
      <header className="mt-8 flex flex-wrap items-end justify-between gap-6">
        <div className="flex items-center gap-4">
          <div
            className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold text-lime-foreground"
            style={{ background: `oklch(0.9 0.19 ${data.iconHue})` }}
            aria-hidden="true"
          >
            {data.icon}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Scraped results for</p>
            <div className="flex flex-wrap items-center gap-3">
              <h1 className="text-4xl font-semibold tracking-tight text-foreground text-balance sm:text-5xl">
                {data.appName}
              </h1>
              <span className="flex items-center gap-1.5 rounded-full bg-grape px-3 py-1 text-xs font-semibold text-grape-foreground">
                {data.store === "app-store" ? <Apple className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {data.store === "app-store" ? "App Store" : "Google Play"}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <Stars value={data.rating} size={15} />
              <span className="text-sm text-muted-foreground">
                {data.rating.toFixed(1)} · {formatNumber(data.totalReviews)} ratings · {data.developer}
              </span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={exportJson}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Download className="h-4 w-4" />
            JSON
          </button>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 rounded-full bg-lime px-4 py-2.5 text-sm font-semibold text-lime-foreground transition-transform hover:brightness-105 active:scale-95"
          >
            <RotateCcw className="h-4 w-4" />
            New scrape
          </button>
        </div>
      </header>

      {/* Stats */}
      <div className="mt-7">
        <StatCards data={data} />
      </div>

      {/* Filter row */}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
        <div className="no-scrollbar flex items-center gap-2 overflow-x-auto">
          {VIEWS.map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={cn(
                "shrink-0 rounded-full px-4 py-2 text-sm font-medium transition-colors",
                view === v ? "bg-lime text-lime-foreground font-semibold" : "bg-card text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            aria-label="Filter"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
          <button
            aria-label="Date range"
            className="flex h-10 w-10 items-center justify-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <CalendarDays className="h-4 w-4" />
          </button>
          <button
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Download className="h-4 w-4" />
            Download reports
          </button>
        </div>
      </div>

      {/* Charts */}
      <div className="mt-5 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <TimelineChart data={data} />
        <Heatmap data={data} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <SentimentRing data={data} />
        <RatingDistribution data={data} />
        <VersionPanel data={data} />
      </div>

      <div className="mt-4">
        <KeywordPanel data={data} />
      </div>

      {/* Reviews */}
      <div className="mt-6">
        <ReviewsFeed data={data} />
      </div>

      <footer className="mt-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-lime" />
        Scraped by Zalytix · {formatNumber(data.totalScraped)} reviews processed
      </footer>
    </div>
  )
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
