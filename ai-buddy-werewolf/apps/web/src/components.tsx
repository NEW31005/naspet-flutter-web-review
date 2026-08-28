/** 汎用UI部品 */
import { useEffect, useState, type ReactNode } from 'react';

export function TopBar({ title, back, right }: { title: string; back?: string; right?: ReactNode }) {
  return (
    <div className="topbar">
      {back != null && (
        <button className="back" onClick={() => (location.hash = back)} aria-label="戻る">
          ‹
        </button>
      )}
      <div className="title">{title}</div>
      {right}
    </div>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);

  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-heading">
          <h2>{title}</h2>
          <button className="sheet-close" onClick={onClose} aria-label="閉じる">×</button>
        </div>
        {children}
      </div>
    </>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="errorbox">
      <div>{error}</div>
      {onRetry && (
        <div style={{ marginTop: 6 }}>
          <button className="ghost" onClick={onRetry}>
            再試行
          </button>
        </div>
      )}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="spin" /> {label && <span className="muted small">{label}</span>}
    </span>
  );
}

/** ハッシュルーター(依存なし) */
export function useHashRoute(): string {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const fn = () => setHash(location.hash);
    window.addEventListener('hashchange', fn);
    return () => window.removeEventListener('hashchange', fn);
  }, []);
  return hash.replace(/^#/, '') || '/';
}

const PALETTE = ['#8b5cf6', '#4f9cf9', '#3dd68c', '#f5a623', '#e5484d', '#e879f9', '#22d3ee', '#a3e635'];

export function colorFor(index: number): string {
  return PALETTE[index % PALETTE.length] ?? '#888';
}

/** シンプルな折れ線チャート(0-100スケール) */
export function LineChart({
  series,
  labels,
}: {
  series: { name: string; color: string; points: (number | null)[] }[];
  labels?: string[];
}) {
  const len = Math.max(1, ...series.map((s) => s.points.length));
  const w = 320;
  const h = 90;
  const px = (i: number) => (len <= 1 ? w / 2 : 8 + (i * (w - 16)) / (len - 1));
  const py = (v: number) => h - 8 - (v / 100) * (h - 16);
  return (
    <div>
      <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {[25, 50, 75].map((g) => (
          <line key={g} x1={0} x2={w} y1={py(g)} y2={py(g)} stroke="#2a2d3a" strokeWidth={1} />
        ))}
        {series.map((s) => {
          const d = s.points
            .map((v, i) => (v == null ? null : `${px(i)},${py(v)}`))
            .filter((p): p is string => p != null);
          if (d.length === 0) return null;
          return (
            <polyline
              key={s.name}
              points={d.join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
            />
          );
        })}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span key={s.name}>
            <span className="dot" style={{ background: s.color }} />
            {s.name}
          </span>
        ))}
        {labels && labels.length > 0 && (
          <span className="muted">({labels[0]} → {labels[labels.length - 1]})</span>
        )}
      </div>
    </div>
  );
}
