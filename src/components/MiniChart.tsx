// Tiny dependency-free SVG charts for the analytics page. Bars and a running
// line are enough to give a sense of trend without dragging in a charting
// library. Sizing is responsive via SVG viewBox.

interface Point {
  label: string;
  value: number;
}

export function BarChart({ points, height = 140, color = '#0ea5e9' }: { points: Point[]; height?: number; color?: string }) {
  if (points.length === 0) {
    return <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-500">No data.</div>;
  }
  const max = Math.max(0, ...points.map((p) => p.value));
  const min = Math.min(0, ...points.map((p) => p.value));
  const range = max - min || 1;
  const barWidth = 100 / points.length;

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
        <line x1="0" x2="100" y1={height - ((0 - min) / range) * height} y2={height - ((0 - min) / range) * height} stroke="#cbd5e1" strokeWidth="0.2" />
        {points.map((p, i) => {
          const top = height - ((p.value - min) / range) * height;
          const baseY = height - ((0 - min) / range) * height;
          const y = Math.min(top, baseY);
          const h = Math.abs(top - baseY) || 0.4;
          return (
            <g key={`${i}-${p.label}`}>
              <rect x={i * barWidth + 0.3} y={y} width={Math.max(0.2, barWidth - 0.6)} height={h} fill={p.value >= 0 ? color : '#ef4444'} />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>{points[0]?.label}</span>
        {points.length > 2 ? <span>{points[Math.floor(points.length / 2)]?.label}</span> : null}
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}

export function LineChart({ points, height = 140, color = '#0ea5e9' }: { points: Point[]; height?: number; color?: string }) {
  if (points.length === 0) {
    return <div className="rounded-md border border-dashed border-slate-300 bg-slate-50 p-4 text-center text-xs text-slate-500">No data.</div>;
  }
  const max = Math.max(...points.map((p) => p.value));
  const min = Math.min(...points.map((p) => p.value));
  const range = max - min || 1;
  const stepX = points.length > 1 ? 100 / (points.length - 1) : 100;
  const path = points
    .map((p, i) => {
      const x = i * stepX;
      const y = height - ((p.value - min) / range) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(' ');

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
        <path d={path} fill="none" stroke={color} strokeWidth="0.6" />
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-slate-500">
        <span>{points[0]?.label}</span>
        <span>{points[points.length - 1]?.label}</span>
      </div>
    </div>
  );
}
