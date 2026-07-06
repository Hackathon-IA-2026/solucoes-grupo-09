"use client";

import { Apple, Download, Play, RotateCcw } from "lucide-react";
import type { ScrapeResult } from "@/lib/mock-data";
import { formatNumber } from "@/lib/mock-data";
import { NoviqWordmark, Stars } from "./brand";
import {
  KeywordPanel,
  RatingDistribution,
  SentimentRing,
  VersionPanel,
} from "./breakdown";
import { ReviewsFeed } from "./reviews-feed";
import { StatCards } from "./stat-cards";
import { TimelineChart } from "./timeline-chart";

export function Dashboard({
  data,
  url,
  onReset,
}: {
  data: ScrapeResult;
  url: string;
  onReset: () => void;
}) {
  function exportJson() {
    const blob = new Blob([JSON.stringify({ url, ...data }, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, `noviq-${data.appName.toLowerCase()}.json`);
  }

  function exportCsv() {
    const header = [
      "author",
      "rating",
      "date",
      "country",
      "version",
      "sentiment",
      "helpful",
      "title",
      "body",
      "developer_response",
    ];
    const rows = data.reviews.map((r) =>
      [
        r.author,
        r.rating,
        r.date,
        r.country,
        r.version,
        r.sentiment,
        r.helpful,
        r.title,
        r.body,
        r.developerResponse?.body ?? "",
      ]
        .map((c) => `"${String(c).replace(/"/g, '""')}"`)
        .join(","),
    );
    const blob = new Blob([[header.join(","), ...rows].join("\n")], { type: "text/csv" });
    downloadBlob(blob, `noviq-${data.appName.toLowerCase()}.csv`);
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Top bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <NoviqWordmark />
        <div className="flex items-center gap-2">
          <button
            onClick={exportCsv}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Download className="h-4 w-4" />
            CSV
          </button>
          <button
            onClick={exportJson}
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Download className="h-4 w-4" />
            JSON
          </button>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 rounded-full bg-lime px-3.5 py-2 text-sm font-semibold text-lime-foreground transition-transform hover:brightness-105 active:scale-95"
          >
            <RotateCcw className="h-4 w-4" />
            New scrape
          </button>
        </div>
      </div>

      {/* App identity */}
      <div className="animate-rise mt-6 flex flex-wrap items-center gap-4 rounded-3xl border border-border bg-card p-5">
        <div
          className="flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-2xl font-bold text-lime-foreground"
          style={{ background: `oklch(0.9 0.19 ${data.iconHue})` }}
          aria-hidden="true"
        >
          {data.icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              {data.appName}
            </h1>
            <span className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-muted-foreground">
              {data.store === "app-store" ? (
                <Apple className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3" />
              )}
              {data.store === "app-store" ? "App Store" : "Google Play"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.developer} · {data.category}
          </p>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="flex items-center gap-2">
              <span className="text-2xl font-semibold tabular-nums text-foreground">
                {data.rating.toFixed(1)}
              </span>
              <Stars value={data.rating} size={16} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {formatNumber(data.totalReviews)} ratings
            </p>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-6">
        <StatCards data={data} />
      </div>

      {/* Charts row */}
      <div className="mt-6 grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <TimelineChart data={data} />
        <SentimentRing data={data} />
      </div>

      {/* Breakdown row */}
      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <RatingDistribution data={data} />
        <VersionPanel data={data} />
        <KeywordPanel data={data} />
      </div>

      {/* Reviews */}
      <div className="mt-6">
        <ReviewsFeed data={data} />
      </div>

      <footer className="mt-10 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="h-1.5 w-1.5 rounded-full bg-lime" />
        Scraped by Noviq · {formatNumber(data.totalScraped)} reviews processed
      </footer>
    </div>
  );
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
