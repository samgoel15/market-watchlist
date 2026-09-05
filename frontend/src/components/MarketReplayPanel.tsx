import { AlertTriangle, ArrowUpRight, CircleAlert, Flag, RefreshCw, Zap } from "lucide-react";

type ReplayEvent = {
  id: string;
  timestamp: string;
  timeLabel: string;
  type: string;
  severity: "info" | "low" | "medium" | "high" | "critical";
  title: string;
  description: string;
  price: number;
  rawMove: number | null;
  benchmarkMove: number | null;
  relativeMove: number | null;
  zScore: number | null;
};

export type MarketReplayData = {
  symbol: string;
  name: string;
  sessionDate: string | null;
  summary: {
    startPrice: number | null;
    endPrice: number | null;
    rawMove: number | null;
    benchmarkMove: number | null;
    relativeMove: number | null;
    benchmarkName?: string | null;
  };
  timeline: Array<{
    timestamp: string;
    price: number;
    benchmarkPrice: number | null;
  }>;
  interactiveReplayAvailable: boolean;
  events: ReplayEvent[];
  limitations?: {
    historicalAttention: string;
    historicalZScore: string;
    note: string;
  };
};

type MarketReplayPanelProps = {
  symbol: string;
  data: MarketReplayData | null;
  loading: boolean;
  error: string;
  onRetry: () => void;
  replayIndex: number;
  replayPlaying: boolean;
  replaySpeed: number;
  onPlayPause: () => void;
  onReset: () => void;
  onSeek: (index: number) => void;
  onSpeedChange: (speed: number) => void;
  onEventSelect: (index: number) => void;
  onClose: () => void;
};

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(value);
}

function eventIcon(type: string) {
  if (type === "market_open") return <Flag size={16} />;
  if (type === "momentum") return <Zap size={16} />;
  if (type === "benchmark_divergence") return <ArrowUpRight size={16} />;
  if (type === "major_move") return <AlertTriangle size={16} />;
  if (type === "market_close") return <Flag size={16} />;
  return <CircleAlert size={16} />;
}

export default function MarketReplayPanel({ symbol, data, loading, error, onRetry, replayIndex, replayPlaying, replaySpeed, onPlayPause, onReset, onSeek, onSpeedChange, onEventSelect, onClose }: MarketReplayPanelProps) {
  const lastTimelinePoint = data?.timeline.at(-1);
  const currentTimelinePoint = data?.timeline[replayIndex];
  const firstBenchmarkPrice = data?.timeline[0]?.benchmarkPrice ?? null;
  const currentBenchmarkMove = firstBenchmarkPrice && currentTimelinePoint?.benchmarkPrice
    ? (currentTimelinePoint.benchmarkPrice - firstBenchmarkPrice) / firstBenchmarkPrice
    : null;
  const currentStockMove = data?.summary.startPrice && currentTimelinePoint
    ? (currentTimelinePoint.price - data.summary.startPrice) / data.summary.startPrice
    : null;
  const currentRelativeMove = currentStockMove !== null && currentBenchmarkMove !== null
    ? currentStockMove - currentBenchmarkMove
    : null;

  return (
    <section className="market-replay" aria-label="Market Replay Intelligence">
      <div className="market-replay__heading">
        <div>
          <p className="eyebrow">Market Replay</p>
          <h2>{symbol} intelligence timeline</h2>
          {data?.sessionDate && <p className="heading-copy">Session {data.sessionDate}</p>}
        </div>
        {loading && <RefreshCw className="spin" size={18} aria-label="Building market replay" />}
      </div>

      {loading && (
        <div className="market-replay__state">
          <RefreshCw className="spin" size={20} />
          <p>Preparing market replay...</p>
          <span>Loading session history...</span>
        </div>
      )}

      {!loading && error && (
        <div className="market-replay__state">
          <CircleAlert size={20} />
          <p>Unable to load Market Replay.</p>
          <button className="retry-button" type="button" onClick={onRetry}>Retry</button>
        </div>
      )}

      {!loading && !error && data && !data.interactiveReplayAvailable && (
        <div className="market-replay__state">
          <CircleAlert size={20} />
          <p>Not enough intraday market data is available for an interactive replay yet.</p>
          <p>Available data: {data.timeline.length} snapshots</p>
        </div>
      )}

      {!loading && !error && data && data.interactiveReplayAvailable && (
        <>
          <div className="market-replay__controls">
            <button className="retry-button" type="button" onClick={onReset}>Reset</button>
            <button className="primary-button market-replay__play" type="button" onClick={onPlayPause}>{replayPlaying ? "Pause" : "Play"}</button>
            <label>
              <span>Speed</span>
              <select value={replaySpeed} onChange={(event) => onSpeedChange(Number(event.target.value))}>
                <option value={0.5}>0.5x</option>
                <option value={1}>1x</option>
                <option value={2}>2x</option>
                <option value={4}>4x</option>
              </select>
            </label>
            <button className="retry-button" type="button" onClick={onClose}>Exit Replay</button>
          </div>
          <div className="market-replay__scrubber">
            <time>{data.timeline[0]?.timestamp ? new Date(data.timeline[0].timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "--"}</time>
            <input type="range" min="0" max={Math.max(data.timeline.length - 1, 0)} step="1" value={replayIndex} onChange={(event) => onSeek(Number(event.target.value))} aria-label="Replay timeline" />
            <time>{lastTimelinePoint?.timestamp ? new Date(lastTimelinePoint.timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "--"}</time>
          </div>
          <p className="market-replay__current-time">Current replay time: {data.timeline[replayIndex]?.timestamp ? new Date(data.timeline[replayIndex].timestamp).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" }) : "--"}</p>
          <div className="market-replay__summary">
            <div><span>Replay price</span><strong>{formatPrice(data.timeline[replayIndex]?.price ?? null)}</strong></div>
            <div><span>Session start</span><strong>{formatPrice(data.summary.startPrice)}</strong></div>
            <div><span>Replay move</span><strong>{formatPercent(data.summary.startPrice && data.timeline[replayIndex] ? (data.timeline[replayIndex].price - data.summary.startPrice) / data.summary.startPrice : null)}</strong></div>
            <div><span>Benchmark move</span><strong>{formatPercent(currentBenchmarkMove)}</strong></div>
            <div><span>Relative move</span><strong>{formatPercent(currentRelativeMove)}</strong></div>
          </div>

          <div className="market-replay__timeline">
            {data.events.map((event) => {
              const eventIndex = data.timeline.findIndex((point) => new Date(point.timestamp).getTime() >= new Date(event.timestamp).getTime());
              const reached = eventIndex >= 0 && eventIndex <= replayIndex;
              const current = eventIndex === replayIndex;
              return <article className={`market-replay__event market-replay__event--${event.severity} ${reached ? "market-replay__event--reached" : "market-replay__event--future"} ${current ? "market-replay__event--current" : ""}`} key={event.id} onClick={() => onEventSelect(Math.max(eventIndex, 0))} role="button" tabIndex={0} onKeyDown={(keyboardEvent) => { if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") onEventSelect(Math.max(eventIndex, 0)); }}>
                <div className="market-replay__event-marker" aria-hidden="true">{eventIcon(event.type)}</div>
                <div className="market-replay__event-content">
                  <div className="market-replay__event-meta">
                    <time dateTime={event.timestamp}>{event.timeLabel}</time>
                    <span>{event.severity}</span>
                  </div>
                  <h3>{event.title}</h3>
                  <p>{event.description}</p>
                  <div className="market-replay__event-metrics">
                    <span>Price {formatPrice(event.price)}</span>
                    {event.rawMove !== null && <span>Move {formatPercent(event.rawMove)}</span>}
                    {event.relativeMove !== null && <span>Relative {formatPercent(event.relativeMove)}</span>}
                  </div>
                </div>
              </article>;
            })}
          </div>

          {data.limitations?.note && <p className="market-replay__note">{data.limitations.note}</p>}
        </>
      )}
    </section>
  );
}
