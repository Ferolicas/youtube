import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { query, withTransaction } from "@/lib/db/pool";
import { env } from "@/config/env";
import { longOnlySql } from "@/lib/analysis/scope";
import { loadEmbeddings, kmeansCosine } from "@/lib/analysis/embeddings";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:clusters");

interface ClusterOut {
  label: string;
  keywords: string[];
  members: { video_id: string; distance: number }[];
}

/**
 * Agrupa vídeos por tema. Vía preferente: EMBEDDINGS semánticos (k-means coseno
 * en proceso, sin python) si cubren >=60% de los vídeos con texto. Fallback:
 * TF-IDF + KMeans (script python con scikit-learn). Correlaciona cada cluster
 * con el rendimiento (vistas/retención/RPM).
 */
export async function computeClusters(): Promise<void> {
  const rows = await query<{
    video_id: string; title: string | null; is_short: boolean | null;
    transcript: string | null; views: number; retention: number | null; rpm: number | null;
  }>(`
    WITH snap AS (
      SELECT DISTINCT ON (video_id) video_id, view_count FROM video_stats_snapshot
      ORDER BY video_id, captured_at DESC
    ),
    ret AS (SELECT video_id, AVG(average_view_percentage) AS r FROM video_stats_daily GROUP BY video_id),
    rev AS (
      SELECT video_id, (CASE WHEN SUM(monetized_playbacks)>0
        THEN SUM(estimated_revenue)/NULLIF(SUM(monetized_playbacks),0)*1000 END)::float AS rpm
      FROM video_revenue_daily GROUP BY video_id
    )
    SELECT v.video_id, v.title, v.is_short,
           left(t.full_text, 4000) AS transcript,
           COALESCE(snap.view_count,0)::float AS views, ret.r::float AS retention, rev.rpm
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id=v.video_id
    LEFT JOIN snap ON snap.video_id=v.video_id
    LEFT JOIN ret ON ret.video_id=v.video_id
    LEFT JOIN rev ON rev.video_id=v.video_id
    WHERE ${longOnlySql("v")}
  `);

  const usable = rows.filter((r) => (r.title ?? "").length + (r.transcript ?? "").length > 20);
  if (usable.length < 6) {
    log.warn("muy pocos vídeos con texto para clustering");
    return;
  }

  // --- Vía 1: embeddings semánticos (sin python) ---
  const embeddings = await loadEmbeddings();
  const withEmb = usable.filter((r) => embeddings.has(r.video_id));
  if (withEmb.length >= Math.max(6, Math.floor(usable.length * 0.6))) {
    const k = Math.max(3, Math.min(12, Math.round(Math.sqrt(withEmb.length / 2))));
    const km = kmeansCosine(
      withEmb.map((r) => ({ id: r.video_id, vec: embeddings.get(r.video_id)! })),
      k
    );
    const titleById = new Map(usable.map((r) => [r.video_id, r.title ?? ""]));
    const clusters: ClusterOut[] = km.map((c) => {
      const kws = topTerms(c.members.map((m) => titleById.get(m.id) ?? ""), 6);
      return {
        label: kws.slice(0, 3).join(" · ") || "tema",
        keywords: kws,
        members: c.members.map((m) => ({ video_id: m.id, distance: m.distance })),
      };
    });
    await persistClusters(clusters, usable);
    log.info(`clusters por embeddings: ${clusters.length} (k=${k}, ${withEmb.length} vídeos)`);
    return;
  }
  log.info(`embeddings insuficientes (${withEmb.length}/${usable.length}); fallback TF-IDF python`);

  const dir = join(process.cwd(), env.DATA_DIR, "analysis");
  await mkdir(dir, { recursive: true });
  const inPath = join(dir, "cluster_input.json");
  await writeFile(
    inPath,
    JSON.stringify({
      videos: usable.map((r) => ({
        id: r.video_id,
        text: `${r.title ?? ""}. ${r.transcript ?? ""}`,
        format: r.is_short ? "short" : "long",
        views: r.views,
        retention: r.retention,
        rpm: r.rpm,
      })),
    })
  );

  const script = join(process.cwd(), "scripts", "cluster_videos.py");
  const result = await runPython(script, [inPath]);
  await rm(inPath, { force: true }).catch(() => undefined);

  if (!result) {
    log.warn("clustering omitido (python/sklearn no disponible). Ver scripts/cluster_videos.py");
    return;
  }

  await persistClusters(result.clusters as ClusterOut[], usable);
  log.info(`clusters guardados (TF-IDF): ${(result.clusters as ClusterOut[]).length}`);
}

interface UsableRow {
  video_id: string;
  title: string | null;
  is_short: boolean | null;
  views: number;
  retention: number | null;
  rpm: number | null;
}

async function persistClusters(clusters: ClusterOut[], usable: UsableRow[]): Promise<void> {
  const metricsById = new Map(usable.map((r) => [r.video_id, r]));
  await withTransaction(async (c) => {
    await c.query(`TRUNCATE cluster_members`);
    await c.query(`TRUNCATE content_clusters RESTART IDENTITY CASCADE`);
    for (const cl of clusters) {
      const members = cl.members
        .map((m) => metricsById.get(m.video_id))
        .filter((x): x is UsableRow => Boolean(x));
      const views = members.map((m) => m.views);
      const avgViews = views.length ? views.reduce((a, b) => a + b, 0) / views.length : 0;
      const medViews = median(views);
      const rets = members.map((m) => m.retention).filter((x): x is number => x !== null);
      const rpms = members.map((m) => m.rpm).filter((x): x is number => x !== null);
      const fmtSet = new Set(members.map((m) => (m.is_short ? "short" : "long")));
      const res = await c.query<{ id: string }>(
        `INSERT INTO content_clusters (label, keywords, format, size, avg_views, median_views, avg_retention, avg_rpm)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          cl.label, cl.keywords, fmtSet.size === 1 ? [...fmtSet][0] : "all",
          members.length, Math.round(avgViews), Math.round(medViews),
          rets.length ? Number((rets.reduce((a, b) => a + b, 0) / rets.length).toFixed(2)) : null,
          rpms.length ? Number((rpms.reduce((a, b) => a + b, 0) / rpms.length).toFixed(2)) : null,
        ]
      );
      const clusterId = res.rows[0]!.id;
      for (const m of cl.members) {
        await c.query(
          `INSERT INTO cluster_members (cluster_id, video_id, distance) VALUES ($1,$2,$3)
           ON CONFLICT DO NOTHING`,
          [clusterId, m.video_id, m.distance]
        );
      }
    }
  });
}

const LABEL_STOP = new Set([
  "de", "la", "que", "el", "en", "y", "a", "los", "del", "se", "las", "por", "un",
  "para", "con", "no", "una", "su", "al", "lo", "como", "mas", "más", "keto",
  "receta", "recetas", "sin", "este", "esta", "muy", "the", "como", "hacer", "casa",
]);

/** Términos más frecuentes de un grupo de títulos (para etiquetar clusters). */
function topTerms(titles: string[], n: number): string[] {
  const counts = new Map<string, number>();
  for (const t of titles) {
    const words = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9ñ ]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !LABEL_STOP.has(w));
    for (const w of new Set(words)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function runPython(script: string, args: string[]): Promise<{ clusters: ClusterOut[] } | null> {
  return new Promise((resolve) => {
    const p = spawn(env.PYTHON_BIN, [script, ...args], { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      if (code !== 0) {
        log.warn(`cluster_videos.py code ${code}: ${err.slice(-300)}`);
        return resolve(null);
      }
      try {
        resolve(JSON.parse(out.slice(out.indexOf("{"))));
      } catch {
        resolve(null);
      }
    });
  });
}
