"use client";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Area, AreaChart, Cell,
} from "recharts";

const AXIS = { stroke: "hsl(218 12% 50%)", fontSize: 11 };
const GRID = "hsl(222 20% 18%)";

const tooltipStyle = {
  contentStyle: {
    background: "hsl(222 30% 10%)",
    border: "1px solid hsl(222 20% 20%)",
    borderRadius: 8,
    fontSize: 12,
  },
  labelStyle: { color: "hsl(210 30% 96%)" },
};

export function RetentionChart({ data }: { data: { x: number; ratio: number }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id="ret" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(152 65% 45%)" stopOpacity={0.5} />
            <stop offset="100%" stopColor="hsl(152 65% 45%)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey="x" {...AXIS} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
        <YAxis {...AXIS} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
        <Tooltip {...tooltipStyle}
          formatter={(v: number) => [`${(v * 100).toFixed(0)}%`, "Retención"]}
          labelFormatter={(v: number) => `Posición ${(v * 100).toFixed(0)}%`} />
        <Area type="monotone" dataKey="ratio" stroke="hsl(152 65% 45%)" fill="url(#ret)" strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function SimpleBar({
  data, xKey, yKey, color = "hsl(199 89% 55%)", height = 240,
}: { data: Record<string, unknown>[]; xKey: string; yKey: string; color?: string; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} {...AXIS} interval={0} angle={-20} textAnchor="end" height={50} />
        <YAxis {...AXIS} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "hsl(222 26% 13%)" }} />
        <Bar dataKey={yKey} fill={color} radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ScatterLikeBars({
  data,
}: { data: { label: string; value: number; highlight?: boolean }[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} layout="vertical" margin={{ left: 80 }}>
        <CartesianGrid stroke={GRID} horizontal={false} />
        <XAxis type="number" {...AXIS} />
        <YAxis type="category" dataKey="label" {...AXIS} width={80} />
        <Tooltip {...tooltipStyle} cursor={{ fill: "hsl(222 26% 13%)" }} />
        <Bar dataKey="value" radius={[0, 4, 4, 0]}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.highlight ? "hsl(152 65% 45%)" : "hsl(199 89% 55%)"} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function TimeSeries({
  data, xKey, yKey,
}: { data: Record<string, unknown>[]; xKey: string; yKey: string }) {
  return (
    <ResponsiveContainer width="100%" height={240}>
      <LineChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={GRID} vertical={false} />
        <XAxis dataKey={xKey} {...AXIS} />
        <YAxis {...AXIS} />
        <Tooltip {...tooltipStyle} />
        <Line type="monotone" dataKey={yKey} stroke="hsl(152 65% 45%)" strokeWidth={2} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
