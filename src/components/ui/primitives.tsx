import { cn } from "@/lib/utils/cn";

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("rounded-xl border border-border bg-panel p-5 shadow-sm", className)}>
      {children}
    </div>
  );
}

export function CardTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-3 flex items-baseline justify-between">
      <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h3>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

export function Stat({
  label, value, sub, accent,
}: { label: string; value: React.ReactNode; sub?: string; accent?: boolean }) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wide text-muted">{label}</span>
      <span className={cn("text-2xl font-bold tabular", accent && "text-accent")}>{value}</span>
      {sub && <span className="text-xs text-muted">{sub}</span>}
    </Card>
  );
}

export function Badge({
  children, tone = "default",
}: { children: React.ReactNode; tone?: "default" | "good" | "warn" | "bad" | "info" }) {
  const tones: Record<string, string> = {
    default: "bg-panel2 text-muted border-border",
    good: "bg-accent/15 text-accent border-accent/30",
    warn: "bg-warn/15 text-warn border-warn/30",
    bad: "bg-danger/15 text-danger border-danger/30",
    info: "bg-accent2/15 text-accent2 border-accent2/30",
  };
  return (
    <span className={cn("inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium", tones[tone])}>
      {children}
    </span>
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <Card className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm font-medium text-fg">{title}</p>
      {hint && <p className="max-w-md text-xs text-muted">{hint}</p>}
    </Card>
  );
}

export function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn("border-b border-border px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-muted", className)}>
      {children}
    </th>
  );
}

export function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={cn("border-b border-border/50 px-3 py-2 text-sm", className)}>{children}</td>;
}
