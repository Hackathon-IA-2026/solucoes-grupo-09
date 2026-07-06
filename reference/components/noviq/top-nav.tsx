"use client"

import { useState } from "react"
import { Bell, LayoutDashboard, Search, ChevronDown } from "lucide-react"
import { NoviqMark } from "./brand"
import { cn } from "@/lib/utils"

const TABS = [
  { label: "Overview", icon: true },
  { label: "Insights", dropdown: true },
  { label: "Analytics", badge: 7 },
  { label: "Audiences" },
  { label: "Reports" },
]

export function TopNav() {
  const [active, setActive] = useState("Overview")

  return (
    <nav className="flex items-center gap-3">
      {/* logo */}
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-grape">
        <NoviqMark className="h-6 w-6 text-grape" />
      </span>

      {/* tab pills — scroll on small screens */}
      <div className="no-scrollbar flex flex-1 items-center gap-2 overflow-x-auto">
        {TABS.map((t) => {
          const isActive = active === t.label
          return (
            <button
              key={t.label}
              onClick={() => setActive(t.label)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors",
                isActive
                  ? "bg-lime text-lime-foreground font-semibold"
                  : "bg-card text-muted-foreground hover:bg-secondary hover:text-foreground",
              )}
            >
              {t.icon && <LayoutDashboard className="h-4 w-4" />}
              {t.label}
              {t.badge && (
                <span
                  className={cn(
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-[11px] font-bold",
                    isActive ? "bg-lime-foreground/15 text-lime-foreground" : "bg-lime text-lime-foreground",
                  )}
                >
                  {t.badge}
                </span>
              )}
              {t.dropdown && <ChevronDown className="h-3.5 w-3.5 opacity-70" />}
            </button>
          )
        })}
      </div>

      {/* right cluster */}
      <div className="flex shrink-0 items-center gap-2">
        <button
          aria-label="Search"
          className="flex h-11 w-11 items-center justify-center rounded-full bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Search className="h-[18px] w-[18px]" />
        </button>
        <button
          aria-label="Notifications"
          className="relative flex h-11 w-11 items-center justify-center rounded-full bg-card text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <Bell className="h-[18px] w-[18px]" />
          <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-lime ring-2 ring-card" />
        </button>
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-grape/20 p-[3px] ring-2 ring-grape">
          <span className="flex h-full w-full items-center justify-center rounded-full bg-grape text-xs font-bold text-grape-foreground">
            DR
          </span>
        </span>
      </div>
    </nav>
  )
}
