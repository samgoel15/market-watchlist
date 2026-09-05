import { ArrowRight, BarChart3, CircleAlert, TrendingUp, X } from "lucide-react";

export type MarketBriefChange = {
  ticker: string;
  name?: string;
  rawMove?: number | null;
  relativeMove?: number | null;
  zScore?: number | null;
  tier?: "significant" | "notable" | "insufficient-history" | "none";
  attentionScore?: number;
  explanation?: string;
  marketStatus?: "OPEN" | "CLOSED" | "DELAYED" | "UNKNOWN";
  latestDataTimestamp?: string | null;
};

type MarketBriefModalProps = {
  changes: MarketBriefChange[];
  onClose: () => void;
  onSelect?: (ticker: string) => void;
};

type BriefInsight = {
  change: MarketBriefChange;
  movement: number | null;
};

function finite(value?: number | null): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function movementFor(change: MarketBriefChange) {
  if (finite(change.rawMove)) return change.rawMove;
  if (finite(change.relativeMove)) return change.relativeMove;
  return null;
}

function formatMovement(value: number | null) {
  if (value === null) return "Movement unavailable";
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function formatMarketStatus(status?: MarketBriefChange["marketStatus"]) {
  if (status === "OPEN") return "Market Open";
  if (status === "CLOSED") return "Market Closed";
  if (status === "DELAYED") return "Market Data Delayed";
  return "Market Status Unknown";
}

function selectMostImportant(changes: MarketBriefChange[]): BriefInsight | null {
  const meaningful = changes.filter(
    (change) => finite(change.attentionScore) || finite(change.zScore) || finite(change.relativeMove),
  );
  if (meaningful.length === 0) return null;

  const change = [...meaningful].sort((first, second) =>
    (second.attentionScore ?? -1) - (first.attentionScore ?? -1) ||
    Math.abs(second.zScore ?? 0) - Math.abs(first.zScore ?? 0) ||
    Math.abs(second.relativeMove ?? 0) - Math.abs(first.relativeMove ?? 0),
  )[0];
  return { change, movement: movementFor(change) };
}

function selectTopPerformer(changes: MarketBriefChange[]): BriefInsight | null {
  const performers = changes.filter((change) => movementFor(change) !== null && (movementFor(change) ?? 0) > 0);
  if (performers.length === 0) return null;
  const change = [...performers].sort((first, second) =>
    (second.relativeMove ?? second.rawMove ?? 0) - (first.relativeMove ?? first.rawMove ?? 0),
  )[0];
  return { change, movement: movementFor(change) };
}

function selectNeedsAttention(changes: MarketBriefChange[]): BriefInsight | null {
  const decliners = changes.filter((change) => movementFor(change) !== null && (movementFor(change) ?? 0) < 0);
  if (decliners.length === 0) return null;
  const change = [...decliners].sort((first, second) =>
    (first.relativeMove ?? first.rawMove ?? 0) - (second.relativeMove ?? second.rawMove ?? 0),
  )[0];
  return { change, movement: movementFor(change) };
}

function latestTimestamp(changes: MarketBriefChange[]) {
  const timestamps = changes
    .map((change) => change.latestDataTimestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort((first, second) => new Date(second).getTime() - new Date(first).getTime());
  return timestamps[0] ?? null;
}

export function buildMarketBrief(changes: MarketBriefChange[]) {
  const mostImportant = selectMostImportant(changes);
  if (!mostImportant) return null;

  return {
    mostImportant,
    topPerformer: selectTopPerformer(changes),
    needsAttention: selectNeedsAttention(changes),
    marketStatus: changes.find((change) => change.marketStatus && change.marketStatus !== "UNKNOWN")?.marketStatus,
    timestamp: latestTimestamp(changes),
  };
}

function Insight({
  eyebrow,
  icon,
  insight,
  detail,
  tone,
  onSelect,
}: {
  eyebrow: string;
  icon: React.ReactNode;
  insight: BriefInsight;
  detail?: string;
  tone: "important" | "positive" | "negative";
  onSelect?: (ticker: string) => void;
}) {
  const { change, movement } = insight;
  return (
    <section
      className={`market-brief__insight market-brief__insight--${tone} ${onSelect ? "market-brief__insight--clickable" : ""}`}
      onClick={() => onSelect?.(change.ticker)}
      onKeyDown={(event) => {
        if (onSelect && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onSelect(change.ticker);
        }
      }}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
    >
      <div className="market-brief__eyebrow">
        {icon}
        <span>{eyebrow}</span>
      </div>
      <strong>{change.ticker} {tone === "important" ? "is getting attention" : ""}</strong>
      <b>{formatMovement(movement)}</b>
      <p>{detail ?? change.explanation ?? "Meaningful movement detected in the latest market data."}</p>
    </section>
  );
}

export default function MarketBriefModal({ changes, onClose, onSelect }: MarketBriefModalProps) {
  const brief = buildMarketBrief(changes);
  if (!brief) return null;

  return (
    <div className="market-brief-backdrop" role="presentation">
      <section className="market-brief" role="dialog" aria-modal="true" aria-labelledby="market-brief-title">
        <div className="market-brief__header">
          <div>
            <p className="eyebrow">Market Intelligence</p>
            <h2 id="market-brief-title">Your market brief</h2>
          </div>
          <button className="market-brief__close" type="button" onClick={onClose} aria-label="Close market brief" title="Close market brief">
            <X size={18} />
          </button>
        </div>

        <div className="market-brief__status">
          <BarChart3 size={16} />
          <span>{formatMarketStatus(brief.marketStatus)}</span>
        </div>

        <div className="market-brief__insights">
          <Insight
            eyebrow="Most Important Move"
            icon={<CircleAlert size={15} />}
            insight={brief.mostImportant}
            tone="important"
            onSelect={onSelect}
          />
          {brief.topPerformer && (
            <Insight
              eyebrow="Top Performer"
              icon={<TrendingUp size={15} />}
              insight={brief.topPerformer}
              detail="Strongest positive movement in the watchlist."
              tone="positive"
              onSelect={onSelect}
            />
          )}
          {brief.needsAttention && (
            <Insight
              eyebrow="Needs Attention"
              icon={<CircleAlert size={15} />}
              insight={brief.needsAttention}
              detail="Strongest negative movement in the watchlist."
              tone="negative"
              onSelect={onSelect}
            />
          )}
        </div>

        {brief.timestamp && <p className="market-brief__timestamp">Based on market data from {new Date(brief.timestamp).toLocaleString("en-IN")}</p>}

        <button className="market-brief__explore" type="button" onClick={onClose}>
          Explore Dashboard <ArrowRight size={16} />
        </button>
      </section>
    </div>
  );
}
