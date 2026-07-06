"use client"

import { useState } from "react"
import { ArrowRight, Link2, Sparkles, Zap } from "lucide-react"
import { NoviqWordmark } from "./brand"
import { cn } from "@/lib/utils"

const SAMPLES = [
  { label: "App Store", url: "https://apps.apple.com/us/app/lumen/id1552321045" },
  { label: "Google Play", url: "https://play.google.com/store/apps/details?id=com.northwind.app" },
]

const STEPS = [
  "Resolving store listing…",
  "Fetching review pages…",
  "Parsing ratings & dates…",
  "Extracting developer replies…",
  "Scoring sentiment…",
  "Building your dashboard…",
]

export function ScraperHero({
  onStart,
  onComplete,
  scraping,
}: {
  onStart: () => void
  onComplete: (url: string) => void
  scraping: boolean
}) {
  const [url, setUrl] = useState("")
  const [stepIndex, setStepIndex] = useState(0)

  function handleSubmit() {
    if (!url.trim() || scraping) return
    setStepIndex(0)
    onStart()
    let i = 0
    const timer = setInterval(() => {
      i += 1
      if (i >= STEPS.length) {
        clearInterval(timer)
        onComplete(url)
      } else {
        setStepIndex(i)
      }
    }, 320)
  }

  return (
    <div className="relative flex min-h-[100dvh] flex-col items-center justify-center overflow-hidden px-4 py-10">
      {/* ambient glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 h-[420px] w-[620px] -translate-x-1/2 rounded-full opacity-30 blur-[120px]"
        style={{ background: "radial-gradient(closest-side, var(--lime), transparent)" }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 right-0 h-[360px] w-[360px] rounded-full opacity-25 blur-[120px]"
        style={{ background: "radial-gradient(closest-side, var(--grape), transparent)" }}
      />

      <header className="absolute left-0 right-0 top-0 flex items-center justify-between p-5 sm:p-8">
        <NoviqWordmark />
        <div className="hidden items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-muted-foreground backdrop-blur sm:flex">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-lime opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-lime" />
          </span>
          Scraper online
        </div>
      </header>

      <div className="relative z-10 w-full max-w-2xl text-center">
        <div className="mx-auto mb-6 flex w-fit items-center gap-2 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs font-medium text-muted-foreground backdrop-blur">
          <Sparkles className="h-3.5 w-3.5 text-lime" />
          Review intelligence, in seconds
        </div>

        <h1 className="text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
          Turn any app's reviews into
          <span className="text-lime"> clean data.</span>
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-pretty text-base leading-relaxed text-muted-foreground">
          Paste an App Store or Google Play link. Noviq scrapes every review —
          ratings, dates, developer responses — and hands you a jaw-dropping dashboard.
        </p>

        {/* input */}
        <div className="mx-auto mt-9 max-w-xl">
          <div
            className={cn(
              "group relative flex items-center gap-2 rounded-2xl border border-border bg-card/70 p-2 backdrop-blur transition-all",
              "focus-within:border-lime/60 focus-within:ring-4 focus-within:ring-lime/10",
            )}
          >
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
              <Link2 className="h-5 w-5" />
            </div>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) handleSubmit()
              }}
              placeholder="Paste an App Store or Google Play link…"
              disabled={scraping}
              className="min-w-0 flex-1 bg-transparent px-1 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
              aria-label="App Store or Google Play URL"
            />
            <button
              onClick={handleSubmit}
              disabled={scraping || !url.trim()}
              className={cn(
                "flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-lime px-4 text-sm font-semibold text-lime-foreground transition-all",
                "hover:brightness-105 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {scraping ? (
                <>
                  <Zap className="h-4 w-4 animate-pulse" />
                  Scraping
                </>
              ) : (
                <>
                  Scrape
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </div>

          {/* samples / progress */}
          <div className="mt-4 min-h-[28px]">
            {scraping ? (
              <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                <span className="relative flex h-1.5 w-24 overflow-hidden rounded-full bg-secondary">
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-lime transition-all duration-300"
                    style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
                  />
                </span>
                <span className="tabular-nums">{STEPS[stepIndex]}</span>
              </div>
            ) : (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <span className="text-xs text-muted-foreground">Try:</span>
                {SAMPLES.map((s) => (
                  <button
                    key={s.label}
                    onClick={() => setUrl(s.url)}
                    className="rounded-full border border-border bg-card/50 px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-lime/40 hover:text-foreground"
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs text-muted-foreground">
          <Feature label="Every rating & version" />
          <Feature label="Developer responses" />
          <Feature label="Sentiment scoring" />
          <Feature label="CSV / JSON export" />
        </div>
      </div>
    </div>
  )
}

function Feature({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="h-1.5 w-1.5 rounded-full bg-lime" />
      {label}
    </div>
  )
}
