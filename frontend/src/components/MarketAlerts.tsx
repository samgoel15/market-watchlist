import { useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowDownRight, ArrowUpRight, BellRing, CircleAlert, TrendingUp } from "lucide-react";

export type MarketAlertChange = {
  ticker: string;
  name?: string;
  rawMove?: number | null;
  relativeMove?: number | null;
  zScore?: number | null;
  tier?: "significant" | "notable" | "insufficient-history" | "none";
  attentionScore?: number;
  attentionLevel?: "high" | "medium" | "low";
  explanation?: string;
  latestDataTimestamp?: string | null;
};

export type MarketAlert = {
  id: string;
  type: "positive" | "negative" | "warning" | "info";
  priority: number;
  ticker: string;
  name?: string;
  title: string;
  message: string;
  metric?: string;
  timestamp?: string | null;
};

type MarketAlertsProps = {
  changes: MarketAlertChange[];
  loading: boolean;
  onSelect?: (ticker: string) => void;
};

const HIGH_ATTENTION_SCORE = 70;
const UNUSUAL_Z_SCORE = 2;
const MEANINGFUL_RELATIVE_MOVE = 0.01;
const MAX_ALERTS = 5;

function finite(value?: number | null): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function formatPercent(value?: number | null) {
  if (!finite(value)) return null;
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(2)}%`;
}

function meaningfulMove(change: MarketAlertChange) {
  return change.tier === "significant" || change.tier === "notable";
}

function timestampFor(changes: MarketAlertChange[]) {
  return changes
    .map((change) => change.latestDataTimestamp)
    .filter((timestamp): timestamp is string => Boolean(timestamp))
    .sort((first, second) => new Date(second).getTime() - new Date(first).getTime())[0] ?? null;
}

function makeAlert(change: MarketAlertChange): MarketAlert | null {
  const highAttention = change.attentionLevel === "high" ||
    (finite(change.attentionScore) && change.attentionScore >= HIGH_ATTENTION_SCORE);
  const unusual = finite(change.zScore) && Math.abs(change.zScore) >= UNUSUAL_Z_SCORE;
  const outperforming = finite(change.relativeMove) && change.relativeMove >= MEANINGFUL_RELATIVE_MOVE;
  const underperforming = finite(change.relativeMove) && change.relativeMove <= -MEANINGFUL_RELATIVE_MOVE;
  const movement = change.rawMove ?? change.relativeMove;
  const meaningful = meaningfulMove(change);
  const strongGain = meaningful && finite(movement) && movement > 0;
  const strongDrop = meaningful && finite(movement) && movement < 0;

  if (!highAttention && !unusual && !outperforming && !underperforming && !strongGain && !strongDrop) {
    return null;
  }

  const priority = Math.round(Math.max(
    unusual ? 100 + Math.abs(change.zScore ?? 0) * 10 : 0,
    highAttention ? 80 + (change.attentionScore ?? 0) : 0,
    underperforming ? 70 + Math.abs(change.relativeMove ?? 0) * 100 : 0,
    outperforming ? 60 + Math.abs(change.relativeMove ?? 0) * 100 : 0,
    strongDrop ? 55 + Math.abs(movement ?? 0) * 100 : 0,
    strongGain ? 45 + Math.abs(movement ?? 0) * 100 : 0,
  ));
  const signals: string[] = [];

  if (finite(movement)) signals.push(`${formatPercent(movement)} movement`);
  if (outperforming) signals.push(`${formatPercent(change.relativeMove)} versus its benchmark`);
  if (underperforming) signals.push(`${formatPercent(change.relativeMove)} versus its benchmark`);
  if (unusual) signals.push(`z-score ${change.zScore?.toFixed(2)}`);
  if (highAttention && finite(change.attentionScore)) signals.push(`attention score ${change.attentionScore}/100`);

  const type: MarketAlert["type"] = underperforming || strongDrop
    ? "negative"
    : unusual || highAttention
      ? "warning"
      : outperforming || strongGain
        ? "positive"
        : "info";
  const title = highAttention
    ? "High attention"
    : unusual
      ? "Unusual movement"
      : underperforming
        ? "Underperforming"
        : outperforming
          ? "Outperforming"
          : strongDrop
            ? "Significant drop"
            : "Strong gain";
  const explanation = change.explanation ?? "Meaningful movement detected in the latest market data.";

  return {
    id: `market-alert-${change.ticker}`,
    type,
    priority,
    ticker: change.ticker,
    name: change.name,
    title,
    message: `${signals.join(" and ")}. ${explanation}`,
    metric: formatPercent(movement) ?? undefined,
    timestamp: change.latestDataTimestamp,
  };
}

export function generateMarketAlerts(changes: MarketAlertChange[]) {
  return changes
    .map(makeAlert)
    .filter((alert): alert is MarketAlert => alert !== null)
    .sort((first, second) => second.priority - first.priority)
    .slice(0, MAX_ALERTS);
}

function AlertIcon({ alert }: { alert: MarketAlert }) {
  if (alert.type === "positive") return <TrendingUp size={17} />;
  if (alert.type === "negative") return <ArrowDownRight size={17} />;
  if (alert.title === "High attention") return <BellRing size={17} />;
  if (alert.title === "Unusual movement") return <CircleAlert size={17} />;
  return <AlertTriangle size={17} />;
}

export default function MarketAlerts({ changes, loading, onSelect }: MarketAlertsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const alertsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      if (!alertsRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  if (loading) return null;

  const alerts = generateMarketAlerts(changes);
  const updatedAt = timestampFor(changes);

  function selectAlert(ticker: string) {
    setIsOpen(false);
    onSelect?.(ticker);
  }

  return (
    <div className="market-alerts" ref={alertsRef}>
      <button
        className="market-alerts__trigger"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-label="Market alerts"
        aria-expanded={isOpen}
        aria-controls="market-alerts-panel"
        title="Market alerts"
      >
        <BellRing size={18} />
        {alerts.length > 0 && <span className="market-alerts__badge">{alerts.length}</span>}
      </button>

      {isOpen && (
        <section className="market-alerts__panel" id="market-alerts-panel" aria-label="Market Alerts">
          <div className="market-alerts__header">
            <div>
              <p className="eyebrow">Watchlist signals</p>
              <h2>Market Alerts</h2>
            </div>
            <BellRing className="market-alerts__header-icon" size={18} aria-hidden="true" />
          </div>

          {alerts.length === 0 ? (
            <div className="market-alerts__empty">
              <span aria-hidden="true">&#10003;</span>
              <div>
                <strong>No significant market movements detected.</strong>
                <p>Your watchlist is currently showing normal market behavior.</p>
              </div>
            </div>
          ) : (
            <div className="market-alerts__list">
              {alerts.map((alert) => (
                <button
                  className={`market-alert market-alert--${alert.type}`}
                  key={alert.id}
                  type="button"
                  onClick={() => selectAlert(alert.ticker)}
                >
                  <span className="market-alert__icon" aria-hidden="true"><AlertIcon alert={alert} /></span>
                  <span className="market-alert__body">
                    <span className="market-alert__topline">
                      <span>{alert.title}</span>
                      {alert.metric && <strong>{alert.metric}</strong>}
                    </span>
                    <strong className="market-alert__ticker">{alert.ticker}</strong>
                    <span className="market-alert__message">{alert.message}</span>
                  </span>
                  <ArrowUpRight className="market-alert__open" size={15} />
                </button>
              ))}
            </div>
          )}

          {updatedAt && <p className="market-alerts__updated">Updated {new Date(updatedAt).toLocaleString("en-IN")}</p>}
        </section>
      )}
    </div>
  );
}
