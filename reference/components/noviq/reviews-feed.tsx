"use client"

import { useMemo, useState } from "react"
import { CornerDownRight, Search, ThumbsUp } from "lucide-react"
import type { Review, ScrapeResult } from "@/lib/mock-data"
import { Stars } from "./brand"
import { cn } from "@/lib/utils"

type Filter = "all" | "5" | "4" | "3" | "2" | "1" | "responded"
type Sort = "recent" | "helpful" | "critical"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "5", label: "5★" },
  { id: "4", label: "4★" },
  { id: "3", label: "3★" },
  { id: "2", label: "2★" },
  { id: "1", label: "1★" },
  { id: "responded", label: "Replied" },
]

export function ReviewsFeed({ data }: { data: ScrapeResult }) {
  const [filter, setFilter] = useState<Filter>("all")
  const [sort, setSort] = useState<Sort>("recent")
  const [query, setQuery] = useState("")

  const filtered = useMemo(() => {
    let list = [...data.reviews]
    if (filter === "responded") list = list.filter((r) => r.developerResponse)
    else if (filter !== "all") list = list.filter((r) => r.rating === Number(filter))
    if (query.trim()) {
      const q = query.toLowerCase()
      list = list.filter(
        (r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q) || r.author.toLowerCase().includes(q),
      )
    }
    if (sort === "recent") list.sort((a, b) => a.daysAgo - b.daysAgo)
    else if (sort === "helpful") list.sort((a, b) => b.helpful - a.helpful)
    else list.sort((a, b) => a.rating - b.rating)
    return list
  }, [data.reviews, filter, sort, query])

  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-foreground">Scraped reviews</h3>
          <p className="text-sm text-muted-foreground">
            {filtered.length} of {data.reviews.length} shown
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search reviews…"
              className="w-32 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground sm:w-44"
              aria-label="Search reviews"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            className="rounded-full border border-border bg-secondary/60 px-3 py-1.5 text-sm text-foreground outline-none"
            aria-label="Sort reviews"
          >
            <option value="recent">Most recent</option>
            <option value="helpful">Most helpful</option>
            <option value="critical">Most critical</option>
          </select>
        </div>
      </div>

      <div className="no-scrollbar mt-4 flex gap-2 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-medium transition-colors",
              filter === f.id
                ? "border-lime bg-lime text-lime-foreground"
                : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4 space-y-3">
        {filtered.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border py-12 text-center text-sm text-muted-foreground">
            No reviews match your filters.
          </div>
        )}
        {filtered.map((r, i) => (
          <ReviewCard key={r.id} review={r} developer={data.developer} index={i} />
        ))}
      </div>
    </div>
  )
}

function ReviewCard({ review, developer, index }: { review: Review; developer: string; index: number }) {
  const toneRing =
    review.sentiment === "positive"
      ? "bg-lime/15 text-lime"
      : review.sentiment === "negative"
        ? "bg-destructive/15 text-destructive"
        : "bg-grape/15 text-grape"

  return (
    <div
      className="animate-rise rounded-2xl border border-border bg-background/40 p-4"
      style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className={cn("flex h-9 w-9 items-center justify-center rounded-full text-xs font-semibold", toneRing)}>
            {review.avatar}
          </span>
          <div>
            <p className="text-sm font-semibold text-foreground">{review.author}</p>
            <div className="mt-0.5 flex items-center gap-2">
              <Stars value={review.rating} size={12} />
              <span className="text-xs text-muted-foreground">· {review.country}</span>
            </div>
          </div>
        </div>
        <div className="text-right">
          <p className="text-xs text-muted-foreground">{review.date}</p>
          <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">v{review.version}</p>
        </div>
      </div>

      <h4 className="mt-3 text-sm font-semibold text-foreground">{review.title}</h4>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{review.body}</p>

      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <ThumbsUp className="h-3.5 w-3.5" />
        {review.helpful} found helpful
      </div>

      {review.developerResponse && (
        <div className="mt-3 rounded-xl border border-lime/20 bg-lime/5 p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-lime">
            <CornerDownRight className="h-3.5 w-3.5" />
            {developer}
            <span className="font-normal text-muted-foreground">· {review.developerResponse.date}</span>
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{review.developerResponse.body}</p>
        </div>
      )}
    </div>
  )
}
