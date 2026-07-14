"use client"

import { useState } from "react"
import { ScraperHero } from "@/components/zalytix/scraper-hero"
import { Dashboard } from "@/components/zalytix/dashboard"
import { scrape, type ScrapeResult } from "@/lib/mock-data"

export default function Page() {
  const [scraping, setScraping] = useState(false)
  const [result, setResult] = useState<ScrapeResult | null>(null)
  const [url, setUrl] = useState("")

  function handleComplete(u: string) {
    setUrl(u)
    setResult(scrape(u))
    setScraping(false)
  }

  function handleReset() {
    setResult(null)
    setScraping(false)
    setUrl("")
  }

  if (result) {
    return (
      <main className="min-h-[100dvh]">
        <Dashboard data={result} url={url} onReset={handleReset} />
      </main>
    )
  }

  return (
    <main>
      <ScraperHero
        scraping={scraping}
        onStart={() => setScraping(true)}
        onComplete={handleComplete}
      />
    </main>
  )
}
