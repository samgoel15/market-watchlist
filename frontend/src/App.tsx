import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import Landing from "./Landing.tsx";
import MarketBriefModal, { buildMarketBrief } from "./components/MarketBriefModal";
import MarketAlerts from "./components/MarketAlerts";
import MarketReplayPanel, { type MarketReplayData } from "./components/MarketReplayPanel";
import {
  Activity,
  ArrowDownRight,
  ArrowLeft,
  ArrowUpRight,
  CircleHelp,
  MessageCircle,
  Plus,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";

type Change = {
  ticker: string;
  name?: string;
  sector?: string;
  isNewSinceLastVisit?: boolean;
  rawMove?: number | null;
  benchmarkMove?: number | null;
  relativeMove?: number | null;
  zScore?: number | null;
  tier?: "significant" | "notable" | "insufficient-history" | "none";
  isStale?: boolean;
  attentionScore?: number;
  attentionLevel?: "high" | "medium" | "low";
  analysisStatus?: string;
  marketStatus?: "OPEN" | "CLOSED" | "DELAYED" | "UNKNOWN";
  dataStatus?: "LIVE" | "DELAYED" | "END_OF_DAY" | "HISTORICAL";
  dataSource?: string;
  latestDataTimestamp?: string | null;
  volumeRatio?: number | null;
  explanation?: string;
  error?: string;
};

type Pattern = {
  type: string;
  sector?: string;
  message: string;
  tickers?: string[];
};

type WatchlistItem = {
  tickerId: number;
  symbol: string;
  name: string;
  addedAt: string;
};

type ChangesResponse = {
  lastSeenAt: string | null;
  patterns: Pattern[];
  changes: Change[];
};

type OhlcCandle = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number | null;
};

type OhlcResponse = {
  ticker: { symbol: string; name: string };
  interval: string;
  candles: OhlcCandle[];
  lastUpdated?: string | null;
  fetchedAt?: string | null;
  marketStatus?: "OPEN" | "CLOSED" | "DELAYED" | "UNKNOWN";
  dataStatus?: "LIVE" | "DELAYED" | "END_OF_DAY" | "HISTORICAL";
  source?: string;
  cacheStatus?: string;
};

type Page = "dashboard" | "terminal" | "chat";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  dataTimestamp?: string | null;
  sources?: string[];
};

type AskAiContext = {
  question: string;
  contextType: "selected_text" | "candle";
  selectedText?: string;
  candleData?: {
    ticker: string;
    open: number;
    high: number;
    low: number;
    close: number;
    timestamp: string;
  };
  x: number;
  y: number;
};

const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:3000";
const WATCHLIST_ID = 1;

function formatPercent(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "--";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function formatRelative(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return "No comparable history";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}% vs benchmark`;
}

function formatAnalysisStatus(status?: string) {
  if (!status) return "--";
  const labels: Record<string, string> = {
    OK: "OK",
    INSUFFICIENT_HISTORY: "Insufficient History",
    NO_COMPARISON_BENCHMARK: "No Comparison Benchmark",
    NO_DATA: "No Data",
    PROVIDER_ERROR: "Provider Error",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function formatMarketStatus(status?: Change["marketStatus"]) {
  if (status === "OPEN") return "Market Open";
  if (status === "CLOSED") return "Market Closed";
  if (status === "DELAYED") return "Delayed";
  return "Market status unknown";
}

function formatDataStatus(status?: Change["dataStatus"]) {
  if (status === "LIVE") return "Live";
  if (status === "END_OF_DAY") return "End of Day";
  if (status === "DELAYED") return "Delayed";
  if (status === "HISTORICAL") return "Historical";
  return "--";
}

function formatDataSource(source?: string) {
  const labels: Record<string, string> = {
    YAHOO_FINANCE: "Yahoo Finance",
    DATABASE_SNAPSHOTS: "Database Snapshots",
  };
  return labels[source ?? ""] ?? source ?? "--";
}

function formatMovementTier(tier?: Change["tier"]) {
  if (tier === "significant") return "Significant move";
  if (tier === "notable") return "Notable move";
  if (tier === "insufficient-history") return "Building history";
  if (tier === "none") return "No unusual movement";
  return "--";
}

function formatAttentionLevel(level?: Change["attentionLevel"]) {
  if (level === "high") return "High attention";
  if (level === "medium") return "Medium attention";
  if (level === "low") return "Low attention";
  return "--";
}

function getAttentionTone(score?: number | null, level?: Change["attentionLevel"]) {
  if (score !== null && score !== undefined && score >= 60) return "high";
  if (score !== null && score !== undefined && score >= 30) return "medium";
  return level ?? "low";
}

function formatFreshness(change?: Change) {
  if (change?.isStale) return "Stale data";
  if (change?.dataStatus === "END_OF_DAY") return "Current";
  if (change?.dataStatus) return formatDataStatus(change.dataStatus);
  return "--";
}

function formatCardDataStatus(change: Change) {
  if (change.isStale) return "Stale data";
  if (change.marketStatus === "OPEN") return "Market Open";
  if (change.marketStatus === "CLOSED") return "Market Closed";
  if (change.marketStatus === "DELAYED") return "Delayed";
  return "Current data";
}

function hasRelativeMove(value?: number | null): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function tierClass(change: Change) {
  if (change.tier === "significant")
    return "change-card change-card--significant";
  if (change.tier === "notable") return "change-card change-card--notable";
  if (change.tier === "insufficient-history")
    return "change-card change-card--insufficient";
  if (change.tier === "none") return "change-card change-card--none";
  return "change-card";
}

function moveClass(change: Pick<Change, "tier" | "relativeMove">) {
  if (!hasRelativeMove(change.relativeMove)) return "move-neutral";
  return change.relativeMove > 0 ? "move-positive" : "move-negative";
}

function formatChartDate(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-IN", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function formatDateTime(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function formatAxisDate(value: string | number | Date) {
  return new Intl.DateTimeFormat("en-IN", {
    month: "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getDailyChange(candle: OhlcCandle, previous?: OhlcCandle) {
  if (!previous) return { change: null, changePercent: null };
  const change = candle.close - previous.close;
  const changePercent = previous.close !== 0 ? change / previous.close : null;
  return { change, changePercent };
}

function CandlestickChart({
  candles,
  onLongPress,
}: {
  candles: OhlcCandle[];
  onLongPress: (candle: OhlcCandle, index: number, x: number, y: number) => void;
}) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ x: number; y: number; index: number } | null>(null);
  const [size, setSize] = useState({ width: 640, height: 260 });
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [tooltip, setTooltip] = useState<{
    x: number;
    y: number;
    candle: OhlcCandle;
    index: number;
  } | null>(null);

  useEffect(() => {
    const node = chartRef.current;
    if (!node) return undefined;

    const updateSize = () => {
      setSize({
        width: node.clientWidth || 640,
        height: node.clientHeight || 260,
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (candles.length === 0) return null;

  const { width, height } = size;
  const padding = { top: 16, right: 56, bottom: 30, left: 8 };
  const minLow = Math.min(...candles.map((candle) => candle.low));
  const maxHigh = Math.max(...candles.map((candle) => candle.high));
  const priceRange = Math.max(maxHigh - minLow, 1);
  const domainPadding = priceRange * 0.12;
  const domainMin = minLow - domainPadding;
  const domainMax = maxHigh + domainPadding;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const xStep = chartWidth / Math.max(candles.length, 1);
  const candleWidth = Math.min(Math.max(6, xStep * 0.7), 14);
  const getY = (value: number) =>
    padding.top + ((domainMax - value) / (domainMax - domainMin || 1)) * chartHeight;
  const getX = (index: number) => padding.left + index * xStep + xStep / 2;
  const latest = candles[candles.length - 1];
  const hoveredCandle = hoveredIndex === null ? latest : candles[hoveredIndex];
  const xAxisIndexes = Array.from(
    new Set(
      Array.from({ length: 5 }, (_, index) =>
        Math.round((candles.length - 1) * (index / 4)),
      ),
    ),
  );
  const gridValues = Array.from({ length: 5 }, (_, index) => {
    const ratio = index / 4;
    return domainMax - (domainMax - domainMin) * ratio;
  });

  function clearLongPress() {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    longPressStart.current = null;
  }

  function getCandleAtPoint(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const index = clamp(
      Math.round((x - padding.left) / xStep),
      0,
      candles.length - 1,
    );
    return { index, x: event.clientX, y: event.clientY };
  }

  return (
    <div className="ohlc-chart-shell" ref={chartRef}>
      <svg
        className="ohlc-chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label="Candlestick chart for selected ticker"
        onPointerDown={(event) => {
          if (event.pointerType === "mouse" && event.button !== 0) return;
          const point = getCandleAtPoint(event);
          longPressStart.current = point;
          longPressTimer.current = window.setTimeout(() => {
            const start = longPressStart.current;
            if (!start) return;
            onLongPress(candles[start.index], start.index, start.x, start.y);
            longPressTimer.current = null;
          }, 2000);
        }}
        onPointerMove={(event) => {
          const start = longPressStart.current;
          if (!start) return;
          if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) {
            clearLongPress();
          }
        }}
        onPointerUp={clearLongPress}
        onPointerCancel={clearLongPress}
        onContextMenu={(event) => event.preventDefault()}
        onMouseLeave={() => {
          clearLongPress();
          setHoveredIndex(null);
          setTooltip(null);
        }}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const index = clamp(
            Math.round((x - padding.left) / xStep),
            0,
            candles.length - 1,
          );
          const nextCandle = candles[index];
          setHoveredIndex(index);
          setTooltip({
            x,
            y: event.clientY - rect.top,
            candle: nextCandle,
            index,
          });
        }}
      >
        {gridValues.map((value, index) => {
          const y = getY(value);
          return (
            <g key={`grid-${index}`}>
              <line
                x1={padding.left}
                x2={width - padding.right}
                y1={y}
                y2={y}
                stroke="rgba(255,255,255,0.08)"
                strokeDasharray="3 5"
              />
              <text
                x={width - 8}
                y={y + 4}
                fill="#929292"
                fontSize="11"
                textAnchor="end"
              >
                {formatPrice(value)}
              </text>
            </g>
          );
        })}

        {xAxisIndexes.map((index) => {
          const candle = candles[index];
          if (!candle) return null;
          return (
            <text
              key={`label-${index}`}
              x={getX(index)}
              y={height - 8}
              fill="#7f7f7f"
              fontSize="10"
              textAnchor="middle"
            >
              {formatAxisDate(candle.timestamp)}
            </text>
          );
        })}

        {candles.map((candle, index) => {
          const x = getX(index);
          const openY = getY(candle.open);
          const closeY = getY(candle.close);
          const highY = getY(candle.high);
          const lowY = getY(candle.low);
          const bodyTop = Math.min(openY, closeY);
          const bodyHeight = Math.max(3, Math.abs(closeY - openY));
          const isBullish = candle.close >= candle.open;
          const color = isBullish ? "#62c990" : "#ed7777";
          const isSelected = hoveredIndex === index;

          return (
            <g key={`${candle.timestamp}-${index}`} opacity={isSelected ? 1 : 0.9}>
              <line
                x1={x}
                x2={x}
                y1={highY}
                y2={lowY}
                stroke={color}
                strokeWidth={1.1}
              />
              <rect
                x={x - candleWidth / 2}
                y={bodyTop}
                width={candleWidth}
                height={bodyHeight}
                rx={2}
                fill={color}
                stroke={color}
              />
            </g>
          );
        })}

        {hoveredIndex !== null && hoveredCandle && (
          <g>
            <line
              x1={getX(hoveredIndex)}
              x2={getX(hoveredIndex)}
              y1={padding.top}
              y2={height - padding.bottom}
              stroke="rgba(255,255,255,0.25)"
              strokeDasharray="4 4"
            />
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={getY(hoveredCandle.close)}
              y2={getY(hoveredCandle.close)}
              stroke="rgba(255,255,255,0.18)"
              strokeDasharray="4 4"
            />
          </g>
        )}

        {latest && (
          <g>
            <line
              x1={padding.left}
              x2={width - padding.right}
              y1={getY(latest.close)}
              y2={getY(latest.close)}
              stroke="#f3f4f6"
              strokeDasharray="4 4"
              strokeOpacity={0.7}
            />
            <text
              x={width - 8}
              y={getY(latest.close) - 8}
              fill="#f3f4f6"
              fontSize="10"
              textAnchor="end"
            >
              {formatPrice(latest.close)}
            </text>
          </g>
        )}
      </svg>

      {tooltip && (
        <div
          className="ohlc-chart-tooltip"
          style={{
            left: `${clamp(tooltip.x + 16, 12, width - 200)}px`,
            top: `${clamp(tooltip.y + 18, 10, height - 160)}px`,
          }}
        >
          <p>OHLC</p>
          <strong>{formatChartDate(tooltip.candle.timestamp)}</strong>
          <span>O {formatPrice(tooltip.candle.open)}</span>
          <span>H {formatPrice(tooltip.candle.high)}</span>
          <span>L {formatPrice(tooltip.candle.low)}</span>
          <span>C {formatPrice(tooltip.candle.close)}</span>
          <small>
            {(() => {
              const previous = candles[Math.max(tooltip.index - 1, 0)];
              const { change, changePercent } = getDailyChange(
                tooltip.candle,
                previous,
              );
              const sign = (change ?? 0) >= 0 ? "+" : "-";
              const directionClass = (change ?? 0) >= 0 ? "move-positive" : "move-negative";
              return (
                <span className={directionClass}>
                  {sign}
                  {formatPrice(Math.abs(change ?? 0))} ({sign}
                  {((changePercent ?? 0) * 100).toFixed(2)}%)
                </span>
              );
            })()}
          </small>
        </div>
      )}
    </div>
  );
}

function Dashboard({
  changes,
  items,
  symbol,
  selectedTicker,
  loading,
  syncing,
  error,
  activeCount,
  sortedChanges = [],
  onRefresh,
  onAdd,
  onSymbolChange,
  onRemove,
  onSelect,
}: {
  changes: ChangesResponse;
  items: WatchlistItem[];
  symbol: string;
  selectedTicker: string | null;
  loading: boolean;
  syncing: boolean;
  error: string;
  activeCount: number;
  sortedChanges: Change[];
  onRefresh: () => void;
  onAdd: (event: FormEvent) => void;
  onSymbolChange: (value: string) => void;
  onRemove: (item: WatchlistItem) => void;
  onSelect: (ticker: string) => void;
}) {
  const visibleChanges = sortedChanges.length > 0 ? sortedChanges : changes.changes;

  return (
    <main className="dashboard">
      <section className="feed-column">
        <div className="page-heading">
          <div>
            <p className="eyebrow">Today</p>
            <h1>What changed</h1>
            <p className="heading-copy">
              The moves worth understanding in your watchlist.
            </p>
          </div>
          <button
            className="icon-button"
            onClick={onRefresh}
            disabled={syncing}
            aria-label="Refresh watchlist"
            title="Refresh watchlist"
          >
            <RefreshCw size={17} className={syncing ? "spin" : ""} />
          </button>
        </div>
        <MarketAlerts
          changes={changes.changes}
          loading={loading}
          onSelect={onSelect}
        />
        {error && (
          <div className="alert">
            <CircleHelp size={16} />
            {error}
          </div>
        )}
        {changes.patterns.length > 0 && (
          <section className="market-patterns" aria-label="Market Patterns">
            <div className="market-patterns__heading">
              <span className="pattern-label">Market Patterns</span>
              <span>{changes.patterns.length}</span>
            </div>
            <div className="market-patterns__list">
              {changes.patterns.map((pattern, index) => (
                <article className="pattern-card" key={`${pattern.type}-${index}`}>
                  <p>{pattern.message}</p>
                  {pattern.tickers && pattern.tickers.length > 0 && (
                    <span>
                      {Array.from(new Set(pattern.tickers)).join(" · ")}
                    </span>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}
        <div className="feed-meta">
          <span>
            {loading
              ? "Checking your watchlist"
              : `${changes.changes.length} stocks tracked`}
          </span>
          {activeCount > 0 && <span>{activeCount} need a closer look</span>}
        </div>
        <div className="change-feed">
          {loading && (
            <div className="empty-state">Loading your watchlist...</div>
          )}
          {!loading && changes.changes.length === 0 && (
            <div className="empty-state">
              Your watchlist is empty. Add a ticker to start seeing meaningful
              changes.
            </div>
          )}
          {!loading &&
            visibleChanges.map((change) => (
              <article
                className={`${tierClass(change)} change-card--clickable ${change.ticker === selectedTicker ? "change-card--selected" : ""}`}
                key={change.ticker}
                onClick={() => onSelect(change.ticker)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ")
                    onSelect(change.ticker);
                }}
                role="button"
                tabIndex={0}
              >
                <div className="change-card__topline">
                  <div>
                    <div className="ticker-line">
                      <h2>{change.ticker}</h2>
                      {change.isNewSinceLastVisit && (
                        <span className="new-badge">New</span>
                      )}
                      {change.isStale && (
                        <span className="stale-badge">Stale</span>
                      )}
                    </div>
                    <p className="company-name">{change.name ?? "Ticker"}</p>
                  </div>
                  <div className={`move-display ${moveClass({ ...change, relativeMove: change.relativeMove ?? change.rawMove })}`}>
                    {hasRelativeMove(change.relativeMove ?? change.rawMove) && (change.relativeMove ?? change.rawMove)! > 0 && (
                      <ArrowUpRight size={18} />
                    )}
                    {hasRelativeMove(change.relativeMove ?? change.rawMove) && (change.relativeMove ?? change.rawMove)! < 0 && (
                      <ArrowDownRight size={18} />
                    )}
                    <span>{formatPercent(change.relativeMove ?? change.rawMove)}</span>
                  </div>
                </div>
                <p className="explanation">
                  {change.explanation ?? "No unusual market signal was detected."}
                </p>
                <div className="change-card__insights">
                  <div className={`attention-score ${change.attentionScore !== null && change.attentionScore !== undefined && change.attentionScore >= 40 ? "attention-score--prominent" : ""}`}>
                    <span>Attention Score</span>
                    <strong>{change.attentionScore ?? "--"} / 100</strong>
                    {change.attentionScore !== null && change.attentionScore !== undefined && (
                      <span className={`attention-score__bar attention-score--${getAttentionTone(change.attentionScore, change.attentionLevel)}`}>
                        <span
                          className="attention-score__fill"
                          style={{ width: `${Math.min(Math.max(change.attentionScore, 0), 100)}%` }}
                        />
                      </span>
                    )}
                  </div>
                  <div className="change-card__insight">
                    <span>Attention Level</span>
                    <strong>{formatAttentionLevel(change.attentionLevel)}</strong>
                  </div>
                  <div className="change-card__insight">
                    <span>Meaningful Movement</span>
                    <strong>{formatMovementTier(change.tier)}</strong>
                  </div>
                  <div className="change-card__insight">
                    <span>Market Status</span>
                    <strong className={change.isStale ? "text-amber" : ""}>
                      {formatCardDataStatus(change)}
                    </strong>
                  </div>
                </div>
                <div className="change-card__footer">
                  <span>{formatRelative(change.relativeMove)}</span>
                  <span>{formatDataStatus(change.dataStatus)}</span>
                </div>
              </article>
            ))}
        </div>
      </section>
      <WatchlistPanel
        items={items}
        symbol={symbol}
        syncing={syncing}
        onAdd={onAdd}
        onSymbolChange={onSymbolChange}
        onRemove={onRemove}
        onSelect={onSelect}
      />
    </main>
  );
}

function WatchlistPanel({
  items,
  symbol,
  syncing,
  onAdd,
  onSymbolChange,
  onRemove,
  onSelect,
}: {
  items: WatchlistItem[];
  symbol: string;
  syncing: boolean;
  onAdd: (event: FormEvent) => void;
  onSymbolChange: (value: string) => void;
  onRemove: (item: WatchlistItem) => void;
  onSelect: (ticker: string) => void;
}) {
  return (
    <aside className="side-column">
      <section className="panel manage-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Your list</p>
            <h2>Manage watchlist</h2>
          </div>
          <span className="count-pill">{items.length}</span>
        </div>
        <form className="add-form" onSubmit={onAdd}>
          <input
            value={symbol}
            onChange={(event) => onSymbolChange(event.target.value)}
            placeholder="Add symbol"
            aria-label="Ticker symbol"
          />
          <button
            type="submit"
            className="add-button"
            disabled={syncing}
            aria-label="Add ticker"
            title="Add ticker"
          >
            <Plus size={18} />
          </button>
        </form>
        <div className="watchlist-items">
          {items.length === 0 && (
            <p className="muted-copy">No stocks added yet.</p>
          )}
          {items.map((item) => (
            <div
              className="watchlist-item"
              key={item.tickerId}
              onClick={() => onSelect(item.symbol)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ")
                  onSelect(item.symbol);
              }}
              role="button"
              tabIndex={0}
            >
              <button
                className="watchlist-item__select"
                type="button"
                onClick={() => onSelect(item.symbol)}
              >
                <strong>{item.symbol}</strong>
                <span>{item.name}</span>
              </button>
              <button
                className="remove-button"
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(item);
                }}
                aria-label={`Remove ${item.symbol}`}
                title={`Remove ${item.symbol}`}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </section>
      <section className="panel how-panel">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">In plain English</p>
            <h2>How this works</h2>
          </div>
          <CircleHelp size={18} className="panel-icon" />
        </div>
        <p>
          Cards get bigger when a stock moves in a way that is unusual for its
          own history and sector.
        </p>
        <p className="legend-line">
          <span className="legend-swatch legend-swatch--green" />
          Green means it is doing better than its sector.
        </p>
        <p className="legend-line">
          <span className="legend-swatch legend-swatch--red" />
          Red means it is doing worse than its sector.
        </p>
        <p className="muted-copy">
          Small, muted cards mean nothing unusual is happening. That is normal.
        </p>
      </section>
    </aside>
  );
}

function Terminal({
  change,
  fallbackItem,
  loading,
  error,
  ohlcData,
  ohlcLoading,
  ohlcError,
  onRetryOhlc,
  onBack,
  onCandleLongPress,
  onAskAboutStock,
  replayData,
  replayLoading,
  replayError,
  onOpenReplay,
  onRetryReplay,
  onCloseReplay,
}: {
  change?: Change;
  fallbackItem?: WatchlistItem;
  loading: boolean;
  error: string;
  ohlcData: OhlcResponse | null;
  ohlcLoading: boolean;
  ohlcError: string;
  onRetryOhlc: () => void;
  onBack: () => void;
  onCandleLongPress: (candle: OhlcCandle, x: number, y: number) => void;
  onAskAboutStock: () => void;
  replayData: MarketReplayData | null;
  replayLoading: boolean;
  replayError: string;
  onOpenReplay: () => void;
  onRetryReplay: () => void;
  onCloseReplay: () => void;
}) {
  const ticker = change?.ticker ?? fallbackItem?.symbol;
  const candles = ohlcData?.candles ?? [];
  const latestCandle = candles[candles.length - 1];
  const previousCandle = candles[candles.length - 2];
  const latestPrice = latestCandle?.close;
  const previousPrice = previousCandle?.close;
  const totalMove =
    latestPrice !== undefined && previousPrice !== undefined
      ? latestPrice - previousPrice
      : null;
  const totalMovePercent =
    totalMove !== null && previousPrice !== undefined && previousPrice !== 0
      ? totalMove / previousPrice
      : null;
  const lowRange = candles.length ? Math.min(...candles.map((c) => c.low)) : null;
  const highRange = candles.length ? Math.max(...candles.map((c) => c.high)) : null;
  const relativeMove = change?.relativeMove;
  const marketStatus = ohlcData?.marketStatus ?? "UNKNOWN";
  const dataStatus = ohlcData?.dataStatus ?? "HISTORICAL";
  const analysisMarketStatus = change?.marketStatus ?? marketStatus;
  const analysisDataStatus = change?.dataStatus ?? dataStatus;
  const hasComparisonBenchmark = change?.analysisStatus !== "NO_COMPARISON_BENCHMARK";
  const stockMovement = change?.rawMove ?? totalMovePercent;
  const hasBenchmarkData = hasComparisonBenchmark &&
    hasRelativeMove(change?.benchmarkMove) &&
    hasRelativeMove(change?.relativeMove);
  const marketStatusLabel = marketStatus === "CLOSED"
    ? "Market Closed"
    : marketStatus === "DELAYED"
      ? "Delayed data"
      : marketStatus === "OPEN"
        ? "Market Open"
        : "Market status unknown";
  const [replayMode, setReplayMode] = useState(false);
  const [replayIndex, setReplayIndex] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);

  useEffect(() => {
    if (!replayData?.interactiveReplayAvailable) {
      setReplayMode(false);
      setReplayPlaying(false);
      setReplayIndex(0);
      return;
    }
    setReplayMode(true);
    setReplayPlaying(false);
    setReplayIndex(0);
  }, [replayData]);

  useEffect(() => {
    if (!replayMode || !replayPlaying || !replayData?.timeline.length) return;
    const interval = window.setInterval(() => {
      setReplayIndex((currentIndex) => {
        const nextIndex = currentIndex + 1;
        if (nextIndex >= replayData.timeline.length - 1) {
          setReplayPlaying(false);
          return replayData.timeline.length - 1;
        }
        return nextIndex;
      });
    }, 500 / replaySpeed);
    return () => window.clearInterval(interval);
  }, [replayData, replayMode, replayPlaying, replaySpeed]);

  const visibleCandles = useMemo(() => {
    if (!replayMode || !replayData?.interactiveReplayAvailable) return candles;
    return replayData.timeline.slice(0, replayIndex + 1).map((point) => ({
      timestamp: point.timestamp,
      open: point.price,
      high: point.price,
      low: point.price,
      close: point.price,
      volume: null,
    }));
  }, [candles, replayData, replayIndex, replayMode]);

  if (loading && !ticker)
    return (
      <main className="terminal-page">
        <div className="terminal-empty">
          <RefreshCw className="spin" size={22} />
          <p>Loading analysis workspace...</p>
        </div>
      </main>
    );
  if (error && !ticker)
    return (
      <main className="terminal-page">
        <div className="terminal-empty">
          <CircleHelp size={22} />
          <p className="eyebrow">Terminal</p>
          <h1>Could not load data</h1>
          <p>{error}</p>
          <button className="primary-button" onClick={onBack}>
            Back to Dashboard
          </button>
        </div>
      </main>
    );
  if (!ticker)
    return (
      <main className="terminal-page">
        <div className="terminal-empty">
          <p className="eyebrow">Terminal</p>
          <h1>No stock selected</h1>
          <p>
            Select a stock from your dashboard or watchlist to view its
            analysis.
          </p>
          <button className="primary-button" onClick={onBack}>
            Go to Dashboard
          </button>
        </div>
      </main>
    );

  return (
    <main className="terminal-page">
      <button className="back-button" onClick={onBack}>
        <ArrowLeft size={16} /> Back to Dashboard
      </button>
      <div className="terminal-heading">
        <p className="eyebrow">Terminal</p>
        <h1>{ticker}</h1>
        <p className="heading-copy">
          {change?.name ?? fallbackItem?.name ?? "Selected stock"}
        </p>
        <div className="terminal-stock-header">
          <div>
            <span>Latest price</span>
            <strong>{latestPrice !== undefined ? formatPrice(latestPrice) : "--"}</strong>
          </div>
          <div className={moveClass({ tier: change?.tier, relativeMove: stockMovement })}>
            <span>Daily movement</span>
            <strong>
              {stockMovement !== null && hasRelativeMove(stockMovement) && stockMovement > 0 && <ArrowUpRight size={17} />}
              {stockMovement !== null && hasRelativeMove(stockMovement) && stockMovement < 0 && <ArrowDownRight size={17} />}
              {formatPercent(stockMovement)}
            </strong>
          </div>
          <span className={`attention-pill attention-pill--${change?.attentionLevel ?? "unknown"}`}>
            {formatAttentionLevel(change?.attentionLevel)}
          </span>
        </div>
      </div>
      {error && (
        <div className="alert">
          <CircleHelp size={16} />
          {error}
        </div>
      )}
      <section className="terminal-summary">
        <div>
          <p className="eyebrow">How it is doing today</p>
          <div
            className={`terminal-move ${moveClass(change ?? { tier: "none", relativeMove })}`}
          >
            {hasComparisonBenchmark && hasRelativeMove(relativeMove) && relativeMove > 0 ? (
              <ArrowUpRight size={24} />
            ) : hasComparisonBenchmark && hasRelativeMove(relativeMove) && relativeMove < 0 ? (
              <ArrowDownRight size={24} />
            ) : null}
            <strong>
              {hasComparisonBenchmark
                ? formatPercent(relativeMove)
                : "No comparison benchmark available"}
            </strong>
            {hasComparisonBenchmark && hasRelativeMove(relativeMove) && (
              <span>{relativeMove > 0 ? "Up" : relativeMove < 0 ? "Down" : "Flat"}</span>
            )}
          </div>
        </div>
        <span className="attention-pill">
          {formatAttentionLevel(change?.attentionLevel)}
        </span>
      </section>
      <section className="price-history">
        <div className="price-history__heading">
          <div>
            <p className="eyebrow">Market history</p>
            <h2>90D · Daily</h2>
          </div>
          {ohlcError && (
            <button className="retry-button" onClick={onRetryOhlc}>
              Retry
            </button>
          )}
        </div>

        {!ohlcLoading && !ohlcError && candles.length > 0 && (
          <div className={`market-data-status market-data-status--${marketStatus.toLowerCase()}`}>
            <div>
              <strong>{marketStatusLabel}</strong>
              <span>
                {marketStatus === "CLOSED"
                  ? "Data unchanged since the latest trading session."
                  : dataStatus === "DELAYED"
                    ? "The provider reports delayed market data."
                    : "Latest available market data from the provider."}
              </span>
            </div>
            <div className="market-data-times">
              <span>
                Last updated {ohlcData?.lastUpdated ? formatDateTime(ohlcData.lastUpdated) : "--"}
              </span>
              <span>
                Refreshed {ohlcData?.fetchedAt ? formatDateTime(ohlcData.fetchedAt) : "--"}
              </span>
            </div>
          </div>
        )}

        {!ohlcLoading && !ohlcError && candles.length > 0 && (
          <div className="price-chart-header">
            <div>
              <span>Selected ticker</span>
              <strong>{ticker}</strong>
            </div>
            <div>
              <span>Latest price</span>
              <strong>{latestPrice !== undefined ? formatPrice(latestPrice) : "--"}</strong>
            </div>
            <div>
              <span>Daily change</span>
              <strong
                className={
                  totalMove !== null && totalMove >= 0 ? "move-positive" : "move-negative"
                }
              >
                {totalMove !== null
                  ? `${totalMove >= 0 ? "+" : ""}${formatPrice(totalMove)} ${totalMovePercent !== null ? `(${formatSignedPercent(totalMovePercent)})` : ""}`
                  : "--"}
              </strong>
            </div>
          </div>
        )}

        {ohlcLoading && (
          <div className="chart-state">
            <RefreshCw className="spin" size={20} />
            <p>Loading market history...</p>
          </div>
        )}

        {!ohlcLoading && ohlcError && (
          <div className="chart-state">
            <CircleHelp size={20} />
            <p>Unable to load market history.</p>
            <button className="retry-button" onClick={onRetryOhlc}>
              Retry
            </button>
          </div>
        )}

        {!ohlcLoading && !ohlcError && candles.length === 0 && (
          <div className="chart-state">
            <Activity size={20} />
            <p>No market history available for this ticker.</p>
          </div>
        )}

        {!ohlcLoading && !ohlcError && candles.length > 0 && (
          <>
            <div className="chart-toolbar">
              <span>OHLC</span>
              <span>90D</span>
            </div>

            <div className="ohlc-chart-wrap">
              <CandlestickChart
                candles={visibleCandles}
                onLongPress={(candle, _index, x, y) => onCandleLongPress(candle, x, y)}
              />
            </div>

            <div className="price-summary">
              <div>
                <span>Open</span>
                <strong>{formatPrice(candles[0].open)}</strong>
              </div>
              <div>
                <span>Latest close</span>
                <strong>{latestPrice !== undefined ? formatPrice(latestPrice) : "--"}</strong>
              </div>
              <div>
                <span>Range</span>
                <strong>
                  {lowRange !== null && highRange !== null
                    ? `${formatPrice(lowRange)} – ${formatPrice(highRange)}`
                    : "--"}
                </strong>
              </div>
            </div>
          </>
        )}
      </section>
      <div className="terminal-replay-action">
        <div>
          <p className="eyebrow">Session intelligence</p>
          <h2>Replay how the movement developed</h2>
        </div>
        <button className="retry-button" type="button" onClick={onOpenReplay}>
          {replayData ? "Refresh Market Replay" : "Open Market Replay"}
        </button>
      </div>
      {(replayLoading || replayError || replayData) && (
        <MarketReplayPanel
          symbol={ticker}
          data={replayData}
          loading={replayLoading}
          error={replayError}
          onRetry={onRetryReplay}
          replayIndex={replayIndex}
          replayPlaying={replayPlaying}
          replaySpeed={replaySpeed}
          onPlayPause={() => setReplayPlaying((playing) => !playing)}
          onReset={() => { setReplayPlaying(false); setReplayIndex(0); }}
          onSeek={(index) => { setReplayPlaying(false); setReplayIndex(index); }}
          onSpeedChange={setReplaySpeed}
          onEventSelect={(index) => { setReplayPlaying(false); setReplayIndex(index); }}
          onClose={() => { setReplayPlaying(false); setReplayMode(false); onCloseReplay(); }}
        />
      )}
      <section className="terminal-performance">
        <div className="terminal-section-heading">
          <div>
            <p className="eyebrow">Performance summary</p>
            <h2>What the numbers say</h2>
          </div>
        </div>
        <div className="terminal-metrics">
          <div title="How much the stock price changed.">
            <span>Raw Move</span>
            <strong>{formatPercent(change?.rawMove)}</strong>
          </div>
          <div title="How the stock performed compared with its benchmark.">
            <span>Relative Move</span>
            <strong>{formatRelative(relativeMove)}</strong>
          </div>
          <div title="How unusual today's movement is compared with normal movement.">
            <span>Z-score</span>
            <strong>{change?.zScore !== null && change?.zScore !== undefined ? change.zScore.toFixed(2) : "--"}</strong>
          </div>
          <div title="How strongly the system thinks this stock deserves attention.">
            <span>Attention Score</span>
            <strong>{change?.attentionScore !== null && change?.attentionScore !== undefined ? `${change.attentionScore} / 100` : "--"}</strong>
          </div>
        </div>
      </section>
      <section className="terminal-analysis">
        <div className="terminal-analysis__heading">
          <div>
            <p className="eyebrow">AI explanation</p>
            <h2>Why is this stock getting attention?</h2>
          </div>
          <button className="primary-button terminal-ai-button" type="button" onClick={onAskAboutStock}>
            Ask Market AI about this stock
          </button>
        </div>
        <p className="terminal-explanation">
          {change?.explanation ?? "No unusual market signal was detected."}
        </p>
        <div className="analysis-grid">
          {hasComparisonBenchmark && hasRelativeMove(relativeMove) && (
            <div className="analysis-metric">
              <span>Relative Performance</span>
              <strong>{formatRelative(relativeMove)}</strong>
            </div>
          )}
          {change?.attentionScore !== null && change?.attentionScore !== undefined && (
            <div className="analysis-metric">
              <span>Attention Score</span>
              <strong>{change.attentionScore} / 100</strong>
              <span className={`attention-score__bar attention-score--${getAttentionTone(change.attentionScore, change.attentionLevel)}`}>
                <span
                  className="attention-score__fill"
                  style={{ width: `${Math.min(Math.max(change.attentionScore, 0), 100)}%` }}
                />
              </span>
            </div>
          )}
          {change?.attentionLevel && (
            <div className="analysis-metric">
              <span>Attention Level</span>
              <strong>{formatAttentionLevel(change.attentionLevel)}</strong>
            </div>
          )}
          {change?.tier && (
            <div className="analysis-metric">
              <span>Meaningful Movement</span>
              <strong>{formatMovementTier(change.tier)}</strong>
            </div>
          )}
          {change?.analysisStatus && (
            <div className="analysis-metric">
              <span>Analysis Status</span>
              <strong className="analysis-status">{formatAnalysisStatus(change.analysisStatus)}</strong>
            </div>
          )}
          {change?.dataSource && (
            <div className="analysis-metric">
              <span>Data Source</span>
              <strong>{formatDataSource(change.dataSource)}</strong>
            </div>
          )}
          {analysisMarketStatus && analysisMarketStatus !== "UNKNOWN" && (
            <div className="analysis-metric">
              <span>Market Status</span>
              <strong className="market-status">{formatMarketStatus(analysisMarketStatus)}</strong>
            </div>
          )}
          {analysisDataStatus && analysisDataStatus !== "HISTORICAL" && (
            <div className="analysis-metric">
              <span>Data Status</span>
              <strong>{formatDataStatus(analysisDataStatus)}</strong>
            </div>
          )}
          {change?.latestDataTimestamp && (
            <div className="analysis-metric">
              <span>Latest Data</span>
              <strong>{formatDateTime(change.latestDataTimestamp)}</strong>
            </div>
          )}
          {change?.dataStatus && (
            <div className="analysis-metric">
              <span>Data Freshness</span>
              <strong className={change.isStale ? "text-amber" : ""}>
                {formatFreshness(change)}
              </strong>
            </div>
          )}
        </div>
      </section>
      <section className="terminal-benchmark">
        <div className="terminal-section-heading">
          <div>
            <p className="eyebrow">Market context</p>
            <h2>Benchmark comparison</h2>
          </div>
        </div>
        {hasBenchmarkData ? (
          <>
            <div className="benchmark-comparison">
              <div>
                <span>{ticker}</span>
                <strong>{formatPercent(stockMovement)}</strong>
              </div>
              <b>VS</b>
              <div>
                <span>Benchmark</span>
                <strong>{formatPercent(change?.benchmarkMove)}</strong>
              </div>
            </div>
            <p className={`benchmark-result ${relativeMove !== null && relativeMove !== undefined && relativeMove >= 0 ? "move-positive" : "move-negative"}`}>
              {relativeMove !== null && relativeMove !== undefined && relativeMove >= 0
                ? `Outperformed benchmark by ${formatPercent(relativeMove)}`
                : `Underperformed benchmark by ${formatPercent(relativeMove === null || relativeMove === undefined ? null : Math.abs(relativeMove))}`}
            </p>
          </>
        ) : (
          <p className="terminal-muted-state">No benchmark comparison is available for this instrument.</p>
        )}
      </section>
    </main>
  );
}

const suggestedQuestions = [
  "Why is SENSEX getting attention?",
  "Which stock needs the most attention?",
  "What changed in my watchlist today?",
  "Compare the most significant stocks",
];

function ChatView({
  messages,
  question,
  loading,
  error,
  onQuestionChange,
  onAsk,
}: {
  messages: ChatMessage[];
  question: string;
  loading: boolean;
  error: string;
  onQuestionChange: (value: string) => void;
  onAsk: (value?: string) => void;
}) {
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <main className="chat-page">
      <div className="chat-heading">
        <p className="eyebrow">Market intelligence</p>
        <h1>Ask Market AI</h1>
        <p className="heading-copy">Ask questions about your watchlist.</p>
      </div>

      <section className="chat-panel" aria-label="Ask Market AI conversation">
        <div className="chat-messages" aria-live="polite">
          {messages.length === 0 && (
            <div className="chat-empty">
              <MessageCircle size={22} />
              <p>Ask about attention, relative performance, or meaningful movements.</p>
            </div>
          )}
          {messages.map((message, index) => (
            <article className={`chat-message chat-message--${message.role}`} key={`${message.role}-${index}`}>
              <span className="chat-message__role">{message.role === "user" ? "You" : "Market AI"}</span>
              <p>{message.content}</p>
              {message.role === "assistant" && (message.sources?.length || message.dataTimestamp) && (
                <small className="chat-message__meta">
                  {message.sources?.length ? `Analyzed: ${message.sources.join(", ")}` : "Based on current watchlist data"}
                  {message.dataTimestamp && ` · ${formatDateTime(message.dataTimestamp)}`}
                </small>
              )}
            </article>
          ))}
          {loading && (
            <article className="chat-message chat-message--assistant chat-message--loading">
              <span className="chat-message__role">Market AI</span>
              <p>Market AI is analyzing your watchlist...</p>
            </article>
          )}
          <div ref={endRef} />
        </div>

        {messages.length === 0 && (
          <div className="chat-suggestions">
            <span className="eyebrow">Suggested questions</span>
            <div>
              {suggestedQuestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => onAsk(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && (
          <div className="alert chat-alert">
            <CircleHelp size={16} />
            {error}
          </div>
        )}

        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            onAsk();
          }}
        >
          <textarea
            ref={inputRef}
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onAsk();
              }
            }}
            placeholder="Type your question about the market..."
            aria-label="Question for Market AI"
            rows={2}
            disabled={loading}
          />
          <button type="submit" disabled={loading || !question.trim()} aria-label="Send question" title="Send question">
            <Send size={17} />
          </button>
        </form>
      </section>
    </main>
  );
}

function AskAiContextMenu({
  context,
  onAsk,
}: {
  context: AskAiContext;
  onAsk: () => void;
}) {
  return (
    <div
      className="ask-ai-context-menu"
      data-ask-ai-menu="true"
      style={{ left: `${context.x}px`, top: `${context.y}px` }}
      role="menu"
    >
      <button type="button" onClick={onAsk} role="menuitem">
        <MessageCircle size={15} />
        Ask Market AI
      </button>
    </div>
  );
}

function MarketAiLauncher({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="market-ai-launcher"
      type="button"
      onClick={onClick}
      aria-label="Ask Market AI"
      title="Ask Market AI"
    >
      <span className="market-ai-launcher__icon" aria-hidden="true">
        <svg viewBox="0 0 40 40" role="presentation">
          <defs>
            <linearGradient id="market-ai-ring" x1="7" y1="5" x2="34" y2="35" gradientUnits="userSpaceOnUse">
              <stop stopColor="#61e0ad" />
              <stop offset="0.48" stopColor="#16b8c8" />
              <stop offset="1" stopColor="#3978ed" />
            </linearGradient>
          </defs>
          <circle className="market-ai-launcher__ring" cx="20" cy="20" r="16" fill="none" stroke="#10aabd" strokeWidth="4.5" />
          <circle className="market-ai-launcher__ring market-ai-launcher__ring--gloss" cx="20" cy="20" r="16" fill="none" stroke="url(#market-ai-ring)" strokeWidth="4.5" strokeDasharray="66 35" strokeLinecap="round" transform="rotate(-58 20 20)" />
        </svg>
      </span>
      <span className="market-ai-launcher__label">Ask Market AI</span>
    </button>
  );
}

function MarketWatchlistApp() {
  const appRef = useRef<HTMLDivElement | null>(null);
  const textSelectionTimer = useRef<number | null>(null);
  const [activePage, setActivePage] = useState<Page>("dashboard");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [changes, setChanges] = useState<ChangesResponse>({
    lastSeenAt: null,
    patterns: [],
    changes: [],
  });
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [symbol, setSymbol] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState("");
  const [ohlcData, setOhlcData] = useState<OhlcResponse | null>(null);
  const [ohlcLoading, setOhlcLoading] = useState(false);
  const [ohlcError, setOhlcError] = useState("");
  const [ohlcRequest, setOhlcRequest] = useState(0);
  const [replayData, setReplayData] = useState<MarketReplayData | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);
  const [replayError, setReplayError] = useState("");
  const [replayOpen, setReplayOpen] = useState(false);
  const [replayRequest, setReplayRequest] = useState(0);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatQuestion, setChatQuestion] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState("");
  const [askAiContext, setAskAiContext] = useState<AskAiContext | null>(null);
  const [showMarketBrief, setShowMarketBrief] = useState(false);
  const marketBriefShown = useRef(false);

  function clearAskAiContext() {
    setAskAiContext(null);
    if (textSelectionTimer.current !== null) {
      window.clearTimeout(textSelectionTimer.current);
      textSelectionTimer.current = null;
    }
  }

  useEffect(() => {
    const showSelectedTextContext = () => {
      const selection = window.getSelection();
      const selectedText = selection?.toString().trim() ?? "";
      if (
        !selection ||
        selectedText.length < 2 ||
        /^[\p{P}\p{S}]+$/u.test(selectedText) ||
        !appRef.current?.contains(selection.anchorNode)
      ) {
        clearAskAiContext();
        return;
      }
      const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
      const rect = range?.getBoundingClientRect();
      if (!rect) return;
      setAskAiContext({
        question: `Explain the following market information in simple terms:\n\n${selectedText.slice(0, 800)}`,
        contextType: "selected_text",
        selectedText: selectedText.slice(0, 800),
        x: clamp(rect.left + rect.width / 2, 12, window.innerWidth - 180),
        y: clamp(rect.bottom + 8, 12, window.innerHeight - 58),
      });
    };
    const onPointerDown = (event: PointerEvent) => {
      if ((event.target as HTMLElement).closest("[data-ask-ai-menu]")) return;
      clearAskAiContext();
      textSelectionTimer.current = window.setTimeout(() => {
        showSelectedTextContext();
        textSelectionTimer.current = null;
      }, 2000);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (textSelectionTimer.current !== null) {
        window.clearTimeout(textSelectionTimer.current);
        textSelectionTimer.current = null;
      }
      if (!(event.target as HTMLElement).closest("[data-ask-ai-menu]")) {
        window.setTimeout(showSelectedTextContext, 0);
      }
    };
    const onSelectionChange = () => {
      window.setTimeout(showSelectedTextContext, 0);
    };
    const onScroll = () => clearAskAiContext();

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
      if (textSelectionTimer.current !== null) window.clearTimeout(textSelectionTimer.current);
    };
  }, []);

  const staleCount = useMemo(
    () => changes.changes.filter((change) => change.isStale).length,
    [changes],
  );
  const activeCount = useMemo(
    () =>
      changes.changes.filter(
        (change) => change.tier === "significant" || change.tier === "notable",
      ).length,
    [changes],
  );
  const sortedChanges = useMemo(() => {
    const tierPriority: Record<NonNullable<Change["tier"]>, number> = {
      significant: 0,
      notable: 1,
      none: 3,
      "insufficient-history": 4,
    };

    return [...changes.changes].sort((first, second) => {
      const firstPriority = tierPriority[first.tier ?? "none"] ?? 3;
      const secondPriority = tierPriority[second.tier ?? "none"] ?? 3;
      if (firstPriority !== secondPriority) return firstPriority - secondPriority;
      return (second.attentionScore ?? -1) - (first.attentionScore ?? -1);
    });
  }, [changes.changes]);
  const selectedChange = useMemo(
    () => changes.changes.find((change) => change.ticker === selectedTicker),
    [changes.changes, selectedTicker],
  );
  const selectedItem = useMemo(
    () => items.find((item) => item.symbol === selectedTicker),
    [items, selectedTicker],
  );

  async function loadDashboard(showSync = false) {
    if (showSync) setSyncing(true);
    setError("");
    try {
      const [changesResponse, itemsResponse] = await Promise.all([
        fetch(`${API_BASE}/watchlist/${WATCHLIST_ID}/changes`, { cache: "no-store" }),
        fetch(`${API_BASE}/watchlist/${WATCHLIST_ID}/items`, { cache: "no-store" }),
      ]);
      if (!changesResponse.ok || !itemsResponse.ok)
        throw new Error("Could not load your watchlist");
      const nextChanges = await changesResponse.json();
      const nextItems = await itemsResponse.json();
      setChanges(nextChanges);
      setItems(nextItems.items);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load your watchlist",
      );
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  }

  useEffect(() => {
    void loadDashboard();
  }, []);

  useEffect(() => {
    if (
      !loading &&
      !marketBriefShown.current &&
      buildMarketBrief(changes.changes)
    ) {
      marketBriefShown.current = true;
      setShowMarketBrief(true);
    }
  }, [changes.changes, loading]);

  useEffect(() => {
    if (!selectedTicker) {
      setOhlcData(null);
      setOhlcLoading(false);
      setOhlcError("");
      return;
    }

    const controller = new AbortController();
    setOhlcData(null);
    setOhlcLoading(true);
    setOhlcError("");

    fetch(
      `${API_BASE}/tickers/${encodeURIComponent(selectedTicker)}/ohlc?interval=1d&limit=90`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as OhlcResponse & {
          error?: string;
        };
        if (!response.ok)
          throw new Error(body.error ?? "Unable to load market history");
        return body;
      })
      .then((body) => setOhlcData(body))
      .catch((historyError: unknown) => {
        if (
          historyError instanceof DOMException &&
          historyError.name === "AbortError"
        )
          return;
        setOhlcError(
          historyError instanceof Error
            ? historyError.message
            : "Unable to load market history",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setOhlcLoading(false);
      });

    return () => controller.abort();
  }, [selectedTicker, ohlcRequest]);

  useEffect(() => {
    if (!selectedTicker || !replayOpen) return;

    const controller = new AbortController();
    setReplayLoading(true);
    setReplayError("");
    fetch(
      `${API_BASE}/tickers/${encodeURIComponent(selectedTicker)}/replay`,
      { signal: controller.signal, cache: "no-store" },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as MarketReplayData & { error?: string };
        if (!response.ok) throw new Error(body.error ?? "Unable to load Market Replay");
        return body;
      })
      .then((body) => setReplayData(body))
      .catch((replayLoadError: unknown) => {
        if (replayLoadError instanceof DOMException && replayLoadError.name === "AbortError") return;
        setReplayError(replayLoadError instanceof Error ? replayLoadError.message : "Unable to load Market Replay");
      })
      .finally(() => {
        if (!controller.signal.aborted) setReplayLoading(false);
      });

    return () => controller.abort();
  }, [selectedTicker, replayOpen, replayRequest]);

  function openTicker(ticker: string) {
    if (selectedTicker !== ticker) {
      setOhlcData(null);
      setOhlcLoading(true);
      setOhlcError("");
    }
    setReplayData(null);
    setReplayError("");
    setReplayOpen(false);
    setSelectedTicker(ticker);
    setActivePage("terminal");
  }

  function openReplay() {
    setReplayOpen(true);
  }

  function closeReplay() {
    setReplayOpen(false);
    setReplayData(null);
    setReplayError("");
  }

  async function addTicker(event: FormEvent) {
    event.preventDefault();
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol || syncing) return;
    setError("");
    setSyncing(true);
    try {
      const response = await fetch(
        `${API_BASE}/watchlist/${WATCHLIST_ID}/items`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: cleanSymbol }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not add ticker");
      setSymbol("");
      await loadDashboard();
      if (body.initialDataStatus === "unavailable") {
        setError("Ticker added, but initial market data is temporarily unavailable. It will be retried on the next sync.");
      }
    } catch (addError) {
      setError(
        addError instanceof Error ? addError.message : "Could not add ticker",
      );
      setSyncing(false);
    }
  }

  async function refreshAll() {
    if (selectedTicker) setOhlcRequest((request) => request + 1);
    await loadDashboard(true);
  }

  async function askMarketAi(
    value = chatQuestion,
    options: {
      contextType?: "general_question" | "selected_text" | "candle" | "watchlist_summary";
      selectedText?: string;
      candleData?: AskAiContext["candleData"];
    } = {},
  ) {
    const nextQuestion = value.trim();
    if (!nextQuestion || chatLoading) return;

    const history = chatMessages.slice(-10).map(({ role, content }) => ({ role, content }));
    setChatMessages((messages) => [...messages, { role: "user", content: nextQuestion }]);
    setChatQuestion("");
    setChatError("");
    setChatLoading(true);

    try {
      const response = await fetch(`${API_BASE}/watchlist/${WATCHLIST_ID}/ask-ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: nextQuestion,
          contextType: options.contextType ?? "general_question",
          selectedText: options.selectedText,
          candleData: options.candleData,
          history,
        }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        answer?: string;
        dataTimestamp?: string | null;
        sources?: string[];
        error?: string;
      };
      if (!response.ok) throw new Error(body.error ?? "Market AI could not answer right now.");
      setChatMessages((messages) => [
        ...messages,
        {
          role: "assistant",
          content: body.answer ?? "Market AI returned no answer.",
          dataTimestamp: body.dataTimestamp,
          sources: body.sources,
        },
      ]);
    } catch (askError) {
      setChatError(
        askError instanceof Error
          ? askError.message
          : "Market AI could not answer right now.",
      );
    } finally {
      setChatLoading(false);
    }
  }

  function askAboutCandle(candle: OhlcCandle, x: number, y: number) {
    const tickerName = ohlcData?.ticker.name ?? selectedItem?.name ?? "this stock";
    const ticker = ohlcData?.ticker.symbol ?? selectedTicker ?? "the selected ticker";
    const previous = candlesForContext(candle, ohlcData?.candles ?? []);
    const { change, changePercent } = getDailyChange(candle, previous);
    const direction = candle.close >= candle.open ? "bullish" : "bearish";
    const volume = candle.volume == null ? "not available" : candle.volume.toLocaleString("en-IN");
    setAskAiContext({
      question: `Analyze this ${direction} candle for ${ticker} (${tickerName}). Date: ${formatDateTime(candle.timestamp)}. Open: ${formatPrice(candle.open)}. High: ${formatPrice(candle.high)}. Low: ${formatPrice(candle.low)}. Close: ${formatPrice(candle.close)}. Volume: ${volume}. Price movement versus the previous close: ${formatPrice(change ?? 0)} (${formatSignedPercent(changePercent)}). Explain what this candle and its movement might indicate using the available watchlist context.`,
      contextType: "candle",
      candleData: {
        ticker,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        timestamp: candle.timestamp,
      },
      x: clamp(x + 12, 12, window.innerWidth - 180),
      y: clamp(y + 12, 12, window.innerHeight - 58),
    });
  }

  function askAboutStock() {
    if (!selectedTicker) return;
    setChatQuestion(`Explain why ${selectedTicker} is getting attention today in simple terms.`);
    setChatError("");
    setActivePage("chat");
  }

  function candlesForContext(candle: OhlcCandle, candleList: OhlcCandle[]) {
    const index = candleList.findIndex((candidate) => candidate.timestamp === candle.timestamp);
    return index > 0 ? candleList[index - 1] : undefined;
  }

  function sendContextQuestion() {
    if (!askAiContext) return;
    const question = askAiContext.question;
    const context = askAiContext;
    clearAskAiContext();
    setActivePage("chat");
    void askMarketAi(question, {
      contextType: context.contextType,
      selectedText: context.selectedText,
      candleData: context.candleData,
    });
  }

  async function removeTicker(item: WatchlistItem) {
    setError("");
    setSyncing(true);
    try {
      const response = await fetch(
        `${API_BASE}/watchlist/${WATCHLIST_ID}/items/${item.symbol}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Could not remove ticker");
      if (selectedTicker === item.symbol) setSelectedTicker(null);
      await loadDashboard();
    } catch (removeError) {
      setError(
        removeError instanceof Error
          ? removeError.message
          : "Could not remove ticker",
      );
      setSyncing(false);
    }
  }

  return (
    <div className="app-shell" ref={appRef}>
      <header className="topbar">
        <button
          className="brand"
          onClick={() => setActivePage("dashboard")}
          aria-label="Meaningful Change home"
        >
          <span className="brand-mark">
            <Activity size={15} strokeWidth={2.5} />
          </span>
          <span>Meaningful Change</span>
        </button>
        <nav className="main-nav" aria-label="Main navigation">
          <button
            className={
              activePage === "dashboard"
                ? "nav-link nav-link--active"
                : "nav-link"
            }
            onClick={() => setActivePage("dashboard")}
          >
            Dashboard
          </button>
          <button
            className={
              activePage === "terminal"
                ? "nav-link nav-link--active"
                : "nav-link"
            }
            onClick={() => setActivePage("terminal")}
          >
            Terminal
          </button>
        </nav>
        <div className="status-bar" aria-live="polite">
          <span
            className={`status-dot ${syncing ? "status-dot--syncing" : ""}`}
          />
          <span>{syncing ? "Syncing" : "Live"}</span>
          {staleCount > 0 && (
            <span className="stale-count">
              <span>{staleCount}</span> stale
            </span>
          )}
        </div>
      </header>

      {activePage === "dashboard" ? (
        <Dashboard
          changes={changes}
          items={items}
          symbol={symbol}
          selectedTicker={selectedTicker}
          loading={loading}
          syncing={syncing}
          error={error}
          activeCount={activeCount}
          sortedChanges={sortedChanges}
          onRefresh={() => void refreshAll()}
          onAdd={addTicker}
          onSymbolChange={setSymbol}
          onRemove={removeTicker}
          onSelect={openTicker}
        />
      ) : activePage === "terminal" ? (
        <Terminal
          change={selectedChange}
          fallbackItem={selectedItem}
          loading={loading}
          error={error}
          ohlcData={ohlcData}
          ohlcLoading={ohlcLoading}
          ohlcError={ohlcError}
          onRetryOhlc={() => setOhlcRequest((request) => request + 1)}
          onBack={() => setActivePage("dashboard")}
          onCandleLongPress={askAboutCandle}
          onAskAboutStock={askAboutStock}
          replayData={replayData}
          replayLoading={replayLoading}
          replayError={replayError}
          onOpenReplay={openReplay}
          onRetryReplay={() => setReplayRequest((request) => request + 1)}
          onCloseReplay={closeReplay}
        />
      ) : (
        <ChatView
          messages={chatMessages}
          question={chatQuestion}
          loading={chatLoading}
          error={chatError}
          onQuestionChange={setChatQuestion}
          onAsk={(value) => void askMarketAi(value)}
        />
      )}
      <MarketAiLauncher onClick={() => setActivePage("chat")} />
      {askAiContext && <AskAiContextMenu context={askAiContext} onAsk={sendContextQuestion} />}
      {showMarketBrief && (
        <MarketBriefModal
          changes={changes.changes}
          onClose={() => setShowMarketBrief(false)}
          onSelect={(ticker) => {
            setShowMarketBrief(false);
            openTicker(ticker);
          }}
        />
      )}
    </div>
  );
}

function App() {
  const [hasEntered, setHasEntered] = useState(false);

  if (!hasEntered) {
    return <Landing onEnter={() => setHasEntered(true)} />;
  }

  return <MarketWatchlistApp />;
}

export default App;
