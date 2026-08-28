import {
  BuildingIcon,
  ClockIcon,
  CoinsIcon,
  DropletIcon,
  LayersIcon,
  PercentIcon,
  radius,
  SlidersHorizontalIcon,
  Toggle,
  useContainerWidth,
  usePalette,
} from "@negotiatio/ui";
import { useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { useI18n } from "@/i18n";
import {
  activeFilterCount,
  type FacetOption,
  type Facets,
  type FilterField,
  type FilterState,
} from "@/lib/offers";
import { FilterDrawer } from "./filter-drawer";
import { FilterDropdown } from "./filter-dropdown";
import { SearchInput } from "./search-input";
import { SortMenu } from "./sort-menu";

/** Below this container width the pill row collapses into the drawer. */
const COMPACT_BREAKPOINT = 900;

/** Nice display name per category key (stable across locales). */
const CATEGORY_LABEL: Record<string, string> = {
  cdb: "CDB",
  lci: "LCI",
  lca: "LCA",
  debenture: "Debênture",
  cri: "CRI",
  cra: "CRA",
};

export interface FilterBarProps {
  filters: FilterState;
  facets: Facets;
  termOptions: FacetOption[];
  resultCount: number;
  onToggleArray: (field: FilterField, value: string) => void;
  onClearArray: (field: FilterField) => void;
  onFgc: (value: boolean) => void;
  onSearch: (value: string) => void;
  onSort: (value: FilterState["sort"]) => void;
  onReset: () => void;
}

/**
 * Responsive filter bar. Wide containers keep the full pill row (unchanged);
 * narrow ones collapse to FGC + a "Filtros" button (with an active-count
 * badge) + search, and every filter moves into the lateral FilterDrawer.
 */
export function FilterBar(props: FilterBarProps) {
  const [width, onLayout] = useContainerWidth();
  // Width is 0 on the first (and prerender) pass — assume wide so the static
  // HTML matches the desktop layout it is most often served to.
  const compact = width > 0 && width < COMPACT_BREAKPOINT;

  return (
    <View onLayout={onLayout}>
      {compact ? <CompactBar {...props} /> : <WideBar {...props} />}
    </View>
  );
}

/** The original full pill row (desktop). */
function WideBar({
  filters,
  facets,
  termOptions,
  onToggleArray,
  onClearArray,
  onFgc,
  onSearch,
  onSort,
}: FilterBarProps) {
  const colors = usePalette();
  const { t, tEnum } = useI18n();
  const iconColor = colors.inkMuted;

  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
      }}
    >
      {/* FGC guarantee toggle */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingRight: 4,
        }}
      >
        <Text style={{ fontSize: 14, fontWeight: "600", color: colors.ink }}>
          {t("filter.fgc")}
        </Text>
        <Toggle value={filters.fgcOnly} onValueChange={onFgc} label={t("filter.fgc")} />
      </View>

      <FilterDropdown
        label={t("filter.type")}
        icon={<LayersIcon size={16} color={iconColor} />}
        options={facets.type}
        selected={filters.type}
        onToggle={(v) => onToggleArray("type", v)}
        onClear={() => onClearArray("type")}
        renderLabel={(v) => CATEGORY_LABEL[v] ?? v.toUpperCase()}
        clearLabel={t("filter.clear")}
      />
      <FilterDropdown
        label={t("filter.term")}
        icon={<ClockIcon size={16} color={iconColor} />}
        options={termOptions}
        selected={filters.term}
        onToggle={(v) => onToggleArray("term", v)}
        onClear={() => onClearArray("term")}
        renderLabel={(v) => t(`term.${v}` as "term.upTo1")}
        clearLabel={t("filter.clear")}
      />
      <FilterDropdown
        label={t("filter.distributor")}
        icon={<BuildingIcon size={16} color={iconColor} />}
        options={facets.distributor}
        selected={filters.distributor}
        onToggle={(v) => onToggleArray("distributor", v)}
        onClear={() => onClearArray("distributor")}
        clearLabel={t("filter.clear")}
      />
      <FilterDropdown
        label={t("filter.liquidity")}
        icon={<DropletIcon size={16} color={iconColor} />}
        options={facets.liquidity}
        selected={filters.liquidity}
        onToggle={(v) => onToggleArray("liquidity", v)}
        onClear={() => onClearArray("liquidity")}
        renderLabel={(v) => tEnum("liquidity", v)}
        clearLabel={t("filter.clear")}
      />
      <FilterDropdown
        label={t("filter.taxation")}
        icon={<CoinsIcon size={16} color={iconColor} />}
        options={facets.taxation}
        selected={filters.taxation}
        onToggle={(v) => onToggleArray("taxation", v)}
        onClear={() => onClearArray("taxation")}
        renderLabel={(v) => tEnum("taxation", v)}
        clearLabel={t("filter.clear")}
      />
      <FilterDropdown
        label={t("filter.indexer")}
        icon={<PercentIcon size={16} color={iconColor} />}
        options={facets.indexer}
        selected={filters.indexer}
        onToggle={(v) => onToggleArray("indexer", v)}
        onClear={() => onClearArray("indexer")}
        clearLabel={t("filter.clear")}
      />

      <SortMenu value={filters.sort} onChange={onSort} />
      <SearchInput value={filters.search} onChange={onSearch} />
    </View>
  );
}

/**
 * Narrow layout: just search + a "Filtros" button (the drawer holds every
 * filter — FGC included — so nothing is duplicated on the surface).
 */
function CompactBar(props: FilterBarProps) {
  const { filters, onSearch } = props;
  const colors = usePalette();
  const { t } = useI18n();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Everything except the search (visible here) counts toward the badge.
  const active = activeFilterCount({ ...filters, search: "" });

  return (
    <View>
      {/* One row: search (fills the width) · Filtros. flexWrap is a safety net
          for very narrow phones. */}
      <View
        style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 10 }}
      >
        <SearchInput
          value={filters.search}
          onChange={onSearch}
          minWidth={140}
          maxWidth={9999}
        />

        <Pressable
          onPress={() => setDrawerOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={t("filter.title")}
          style={(state) => {
            const { hovered = false, pressed = false } = state as {
              hovered?: boolean;
              pressed?: boolean;
            };
            return {
              flexDirection: "row",
              alignItems: "center",
              gap: 8,
              borderRadius: radius.pill,
              borderWidth: 1,
              borderColor: active > 0 ? colors.accent : colors.borderStrong,
              backgroundColor:
                active > 0
                  ? colors.accentSoft
                  : hovered
                    ? colors.surfaceSunken
                    : colors.surface,
              paddingHorizontal: 14,
              paddingVertical: 10,
              transform: [{ scale: pressed ? 0.96 : 1 }],
              ...(Platform.OS === "web"
                ? ({
                    cursor: "pointer",
                    transitionProperty: "background-color, border-color, transform",
                    transitionDuration: "150ms",
                  } as object)
                : null),
            };
          }}
        >
          <SlidersHorizontalIcon
            size={16}
            color={active > 0 ? colors.onAccentSoft : colors.inkMuted}
          />
          <Text
            style={{
              fontSize: 14,
              fontWeight: "600",
              color: active > 0 ? colors.onAccentSoft : colors.ink,
            }}
          >
            {t("filter.title")}
          </Text>
          {active > 0 ? (
            <View
              style={{
                minWidth: 18,
                height: 18,
                paddingHorizontal: 5,
                borderRadius: 999,
                backgroundColor: colors.accent,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <Text style={{ fontSize: 12, fontWeight: "700", color: colors.onAccent }}>
                {active}
              </Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      <FilterDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        filters={props.filters}
        facets={props.facets}
        termOptions={props.termOptions}
        resultCount={props.resultCount}
        onToggleArray={props.onToggleArray}
        onFgc={props.onFgc}
        onSort={props.onSort}
        onReset={props.onReset}
      />
    </View>
  );
}
