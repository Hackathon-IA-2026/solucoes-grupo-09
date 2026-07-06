import {
  ArrowUpRight,
  MessageSquareReply,
  Star,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";
import type { ScrapeResult } from "@/lib/mock-data";
import { formatNumber } from "@/lib/mock-data";
import { cn } from "@/lib/utils";
import { Stars } from "./brand";

export function StatCards({ data }: { data: ScrapeResult }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {/* Average rating — highlighted lime card */}
      <div
        className="animate-rise rounded-3xl bg-lime p-5 text-lime-foreground"
        style={{ animationDelay: "0ms" }}
      >
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Star className="h-4 w-4 fill-current" />
            Average rating
          </div>
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-lime-foreground/10">
            <ArrowUpRight className="h-4 w-4" />
          </span>
        </div>
        <div className="mt-6 text-5xl font-semibold tracking-tight tabular-nums">
          {data.rating.toFixed(1)}
        </div>
        <div className="mt-3 flex items-center justify-between">
          <Stars
            value={data.rating}
            size={15}
            className="[&_.text-lime]:text-lime-foreground [&_span]:text-lime-foreground/25"
          />
          <span className={cn("flex items-center gap-1 text-xs font-semibold")}>
            {data.ratingChange >= 0 ? (
              <TrendingUp className="h-3.5 w-3.5" />
            ) : (
              <TrendingDown className="h-3.5 w-3.5" />
            )}
            {data.ratingChange >= 0 ? "+" : ""}
            {data.ratingChange.toFixed(2)}
          </span>
        </div>
      </div>

      <StatCard
        delay={60}
        icon={<Users className="h-4 w-4" />}
        label="Total reviews"
        value={formatNumber(data.totalReviews)}
        sub={`${formatNumber(data.totalScraped)} scraped`}
        trend="+4.2%"
      />
      <StatCard
        delay={120}
        icon={<MessageSquareReply className="h-4 w-4" />}
        label="Response rate"
        value={`${data.responseRate}%`}
        sub="developer replies"
        trend={data.responseRate > 45 ? "Healthy" : "Low"}
        trendTone={data.responseRate > 45 ? "pos" : "neg"}
      />
      <StatCard
        delay={180}
        icon={<TrendingUp className="h-4 w-4" />}
        label="Positive sentiment"
        value={`${data.sentiment.positive}%`}
        sub={`${data.sentiment.negative}% negative`}
        accent
      />
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  sub,
  trend,
  trendTone = "pos",
  accent,
  delay = 0,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  trend?: string;
  trendTone?: "pos" | "neg";
  accent?: boolean;
  delay?: number;
}) {
  return (
    <div
      className="animate-rise rounded-3xl border border-border bg-card p-5"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <span className={cn("text-muted-foreground", accent && "text-grape")}>
            {icon}
          </span>
          {label}
        </div>
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-muted-foreground">
          <ArrowUpRight className="h-4 w-4" />
        </span>
      </div>
      <div className="mt-6 text-4xl font-semibold tracking-tight tabular-nums text-foreground">
        {value}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{sub}</span>
        {trend && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-semibold",
              trendTone === "pos"
                ? "bg-lime/15 text-lime"
                : "bg-destructive/15 text-destructive",
            )}
          >
            {trend}
          </span>
        )}
      </div>
    </div>
  );
}
