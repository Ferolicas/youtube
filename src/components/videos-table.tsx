"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Th, Td } from "@/components/ui/primitives";
import { fmtNum, fmtPct } from "@/lib/utils/cn";
import { formatSeconds } from "@/lib/utils/duration";
import type { VideoListRow } from "@/lib/dashboard/queries";

type SortKey = "views" | "retention" | "published_at" | "duration_seconds" | "subs";

export function VideosTable({ rows }: { rows: VideoListRow[] }) {
  const [filter, setFilter] = useState<"all" | "long" | "short">("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("views");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const filtered = useMemo(() => {
    let r = rows;
    if (filter !== "all") r = r.filter((v) => v.is_short === (filter === "short"));
    if (q) r = r.filter((v) => (v.title ?? "").toLowerCase().includes(q.toLowerCase()));
    const sgn = dir === "asc" ? 1 : -1;
    const pick = (row: VideoListRow) => Number((row as unknown as Record<string, unknown>)[sort] ?? 0);
    return [...r].sort((a, b) => {
      if (sort === "published_at") return sgn * ((new Date(a.published_at).getTime() || 0) - (new Date(b.published_at).getTime() || 0));
      return sgn * (pick(a) - pick(b));
    });
  }, [rows, filter, q, sort, dir]);

  function header(label: string, key: SortKey, align = "right") {
    const active = sort === key;
    return (
      <Th className={align === "right" ? "text-right" : ""}>
        <button
          className={`hover:text-fg ${active ? "text-accent" : ""}`}
          onClick={() => { active ? setDir(dir === "asc" ? "desc" : "asc") : (setSort(key), setDir("desc")); }}
        >
          {label}{active ? (dir === "asc" ? " ↑" : " ↓") : ""}
        </button>
      </Th>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {(["all", "long", "short"] as const).map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`rounded-lg px-3 py-1.5 text-xs ${filter === f ? "bg-accent/15 text-accent" : "bg-panel2 text-muted hover:text-fg"}`}>
            {f === "all" ? "Todos" : f === "long" ? "Largos" : "Shorts"}
          </button>
        ))}
        <input
          value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar título…"
          className="ml-auto w-64 rounded-lg border border-border bg-panel2 px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
        <span className="text-xs text-muted">{filtered.length} vídeos</span>
      </div>

      <div className="overflow-auto rounded-xl border border-border">
        <table className="w-full">
          <thead className="bg-panel">
            <tr>
              <Th>Título</Th>
              <Th>Tipo</Th>
              {header("Vistas", "views")}
              {header("Retención", "retention")}
              {header("Duración", "duration_seconds")}
              {header("Subs", "subs")}
              {header("Publicado", "published_at")}
            </tr>
          </thead>
          <tbody>
            {filtered.map((v) => (
              <tr key={v.video_id} className="hover:bg-panel/50">
                <Td><Link href={`/videos/${v.video_id}`} className="hover:text-accent">{v.title ?? v.video_id}</Link></Td>
                <Td>{v.is_short ? <Badge tone="info">Short</Badge> : <Badge>Largo</Badge>}</Td>
                <Td className="text-right tabular">{fmtNum(Number(v.views))}</Td>
                <Td className="text-right tabular">{v.retention ? fmtPct(Number(v.retention)) : "—"}</Td>
                <Td className="text-right tabular">{formatSeconds(v.duration_seconds ?? 0)}</Td>
                <Td className="text-right tabular">{v.subs ? fmtNum(Number(v.subs)) : "—"}</Td>
                <Td className="text-right text-muted">{v.published_at?.slice(0, 10)}</Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
