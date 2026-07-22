/**
 * Hand-rolled inline-SVG sparkline for the goal metric (no chart dep in
 * this repo — see cron-calendar for the precedent). Server-renderable:
 * pure props → markup, no hooks.
 */
export function GoalSparkline({
  values,
  target,
  direction,
  width = 560,
  height = 96,
}: {
  values: number[];
  target: number | null;
  direction: "increase" | "decrease" | null;
  width?: number;
  height?: number;
}) {
  if (values.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-[12.5px] text-[hsl(var(--notfair-ink-4))]"
        style={{ height }}
      >
        Not enough readings yet — the sparkline appears after a couple of ticks.
      </div>
    );
  }

  const pad = 6;
  const all = target !== null ? [...values, target] : values;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;

  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);

  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values[values.length - 1]!;
  const first = values[0]!;
  const improving =
    direction === "decrease" ? last <= first : direction === "increase" ? last >= first : true;
  const stroke = improving ? "hsl(var(--notfair-accent))" : "hsl(0 72% 51%)";

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      style={{ height }}
      className="w-full"
      role="img"
      aria-label={`Metric trend: ${first} → ${last}${target !== null ? `, target ${target}` : ""}`}
      preserveAspectRatio="none"
    >
      {target !== null && (
        <line
          x1={pad}
          x2={width - pad}
          y1={y(target)}
          y2={y(target)}
          stroke="hsl(var(--notfair-ink-4))"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
      )}
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={x(values.length - 1)} cy={y(last)} r="3" fill={stroke} />
    </svg>
  );
}
