"use client";

import { useState } from "react";
import type { ScrapeResult } from "@/lib/mock-data";
import { formatNumber } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

export function TimelineChart({ data }: { data: ScrapeResult }) {
  const [active, setActive] = useState<number | null>(null);
  const points = data.timeline;
  const max = Math.max(...points.map((p) => p.count)) * 1.1;
  const W = 520;
  const H = 200;
  const pad = { top: 16, right: 8, bottom: 24, left: 8 };
  const chartW = W - pad.left - pad.right;
  const chartH = H - pad.top - pad.bottom;
  const barGap = 10;
  const barW = chartW / points.length - barGap;

  const activeIdx = active ?? points.length - 3;

  return (
    <div className="rounded-3xl border border-border bg-card p-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-muted-foreground">Review volume</h3>
          <p className="mt-1 text-lg font-semibold text-foreground">Last 12 months</p>
        </div>
        <div className="flex items-center gap-1 rounded-full bg-secondary p-1 text-xs">
          <span className="rounded-full px-3 py-1 text-muted-foreground">Monthly</span>
          <span className="rounded-full bg-lime px-3 py-1 font-semibold text-lime-foreground">
            Yearly
          </span>
        </div>
      </div>

      <div className="mt-4">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label="Monthly review volume chart"
        >
          <defs>
            <linearGradient id="barActive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--grape)" />
              <stop offset="100%" stopColor="var(--grape)" stopOpacity="0.35" />
            </linearGradient>
            <pattern
              id="hatch"
              width="6"
              height="6"
              patternTransform="rotate(45)"
              patternUnits="userSpaceOnUse"
            >
              <rect width="6" height="6" fill="var(--grape)" opacity="0.12" />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="var(--grape)"
                strokeWidth="2.4"
                opacity="0.5"
              />
            </pattern>
          </defs>

          {/* gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map((g) => (
            <line
              key={g}
              x1={pad.left}
              x2={W - pad.right}
              y1={pad.top + chartH * g}
              y2={pad.top + chartH * g}
              stroke="currentColor"
              className="text-border"
              strokeDasharray="3 5"
            />
          ))}

          {points.map((p, i) => {
            const h = (p.count / max) * chartH;
            const x = pad.left + i * (barW + barGap);
            const y = pad.top + chartH - h;
            const isActive = i === activeIdx;
            return (
              <g key={p.month}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={6}
                  fill={isActive ? "url(#barActive)" : "url(#hatch)"}
                  className="transition-all"
                  onMouseEnter={() => setActive(i)}
                  onMouseLeave={() => setActive(null)}
                  style={{ cursor: "pointer" }}
                />
                <text
                  x={x + barW / 2}
                  y={H - 6}
                  textAnchor="middle"
                  className={cn(
                    "text-[10px]",
                    isActive ? "fill-foreground" : "fill-muted-foreground",
                  )}
                >
                  {p.month}
                </text>
              </g>
            );
          })}

          {/* tooltip */}
          {(() => {
            const p = points[activeIdx];
            const h = (p.count / max) * chartH;
            const x = pad.left + activeIdx * (barW + barGap) + barW / 2;
            const y = pad.top + chartH - h;
            const tipW = 78;
            const tipX = Math.min(Math.max(x - tipW / 2, pad.left), W - pad.right - tipW);
            const tipY = Math.max(y - 44, 0);
            return (
              <g className="pointer-events-none">
                <rect
                  x={tipX}
                  y={tipY}
                  width={tipW}
                  height={36}
                  rx={9}
                  fill="var(--foreground)"
                />
                <text
                  x={tipX + tipW / 2}
                  y={tipY + 15}
                  textAnchor="middle"
                  className="fill-background text-[10px]"
                >
                  {p.month} · {p.avg.toFixed(1)}★
                </text>
                <text
                  x={tipX + tipW / 2}
                  y={tipY + 28}
                  textAnchor="middle"
                  className="fill-background text-[11px] font-semibold"
                >
                  {formatNumber(p.count)}
                </text>
                <circle
                  cx={x}
                  cy={y}
                  r={4}
                  fill="var(--grape)"
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              </g>
            );
          })()}
        </svg>
      </div>
    </div>
  );
}
