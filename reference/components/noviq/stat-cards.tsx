import { ArrowUpRight, MessageSquareReply, Star, Smile, Users } from "lucide-react"
import type { ScrapeResult } from "@/lib/mock-data"
import { formatNumber } from "@/lib/mock-data"
import { cn } from "@/lib/utils"

export function StatCards({ data }: { data: ScrapeResult }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        highlight
        delay={0}
        icon={<Star className="h-[18px] w-[18px]" />}
        label="Average rating"
        value={data.rating.toFixed(1)}
        deltaValue={`${data.ratingChange >= 0 ? "+" : ""}${data.ratingChange.toFixed(2)}`}
        deltaPositive={data.ratingChange >= 0}
        deltaLabel="from last month"
      />
      <StatCard
        delay={70}
        icon={<Users className="h-[18px] w-[18px]" />}
        label="Total reviews"
        value={formatNumber(data.totalReviews)}
        deltaValue="+4.2%"
        deltaPositive
        deltaLabel="from previous week"
      />
      <StatCard
        delay={140}
        icon={<MessageSquareReply className="h-[18px] w-[18px]" />}
        label="Response rate"
        value={`${data.responseRate}%`}
        deltaValue={data.responseRate > 45 ? "Healthy" : "Low"}
        deltaPositive={data.responseRate > 45}
        deltaLabel="developer replies"
      />
      <StatCard
        delay={210}
        icon={<Smile className="h-[18px] w-[18px]" />}
        label="Positive sentiment"
        value={`${data.sentiment.positive}%`}
        deltaValue={`${data.sentiment.negative}%`}
        deltaPositive={false}
        deltaLabel="negative"
      />
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  deltaValue,
  deltaPositive,
  deltaLabel,
  highlight,
  delay = 0,
}: {
  icon: React.ReactNode
  label: string
  value: string
  deltaValue: string
  deltaPositive: boolean
  deltaLabel: string
  highlight?: boolean
  delay?: number
}) {
  return (
    <div
      className={cn(
        "animate-rise flex flex-col rounded-3xl p-5",
        highlight ? "bg-lime text-lime-foreground" : "border border-border bg-card",
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between">
        <span
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full",
            highlight ? "bg-lime-foreground/10 text-lime-foreground" : "border border-border text-muted-foreground",
          )}
        >
          {icon}
        </span>
        <button
          aria-label={`Open ${label}`}
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full transition-transform hover:scale-105 active:scale-95",
            highlight ? "bg-lime-foreground text-lime" : "bg-foreground text-background",
          )}
        >
          <ArrowUpRight className="h-4 w-4" />
        </button>
      </div>

      <div
        className={cn(
          "mt-5 text-sm font-medium",
          highlight ? "text-lime-foreground/70" : "text-muted-foreground",
        )}
      >
        {label}
      </div>
      <div className="mt-1 text-4xl font-semibold tracking-tight tabular-nums">{value}</div>

      <div className={cn("mt-3 text-xs", highlight ? "text-lime-foreground/70" : "text-muted-foreground")}>
        <span
          className={cn(
            "font-bold",
            highlight ? "text-lime-foreground" : deltaPositive ? "text-lime" : "text-destructive",
          )}
        >
          {deltaValue}
        </span>{" "}
        {deltaLabel}
      </div>
    </div>
  )
}
