import OpenAI from "openai";
import { query } from "@/lib/db/pool";
import { env } from "@/config/env";
import { longOnlySql } from "@/lib/analysis/scope";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("analysis:embeddings");

/**
 * Embeddings semánticos por vídeo (título + arranque de transcripción) con
 * OpenAI text-embedding-3-small (barato: ~$0.02/1M tokens). Se guardan como
 * float32 little-endian en BYTEA (video_embeddings), sin requerir pgvector.
 * Si no hay OPENAI_API_KEY, se omite y el clustering usa el fallback TF-IDF.
 */
export async function computeEmbeddings(): Promise<number> {
  if (!env.OPENAI_API_KEY) {
    log.info("sin OPENAI_API_KEY: embeddings omitidos (clustering usará TF-IDF)");
    return 0;
  }

  const pending = await query<{ video_id: string; text: string }>(`
    SELECT v.video_id,
           (coalesce(v.title,'') || '. ' || coalesce(left(t.full_text, 2000), coalesce(v.description,''))) AS text
    FROM videos v
    LEFT JOIN transcripts t ON t.video_id = v.video_id
    LEFT JOIN video_embeddings e ON e.video_id = v.video_id AND e.model = $1
    WHERE ${longOnlySql("v")} AND e.video_id IS NULL
  `, [env.EMBEDDINGS_MODEL]);

  const usable = pending.filter((p) => p.text.trim().length > 20);
  if (usable.length === 0) {
    log.info("embeddings al día");
    return 0;
  }

  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  let done = 0;
  for (let i = 0; i < usable.length; i += 64) {
    const batch = usable.slice(i, i + 64);
    try {
      const res = await client.embeddings.create({
        model: env.EMBEDDINGS_MODEL,
        input: batch.map((b) => b.text.slice(0, 8000)),
      });
      for (let j = 0; j < batch.length; j++) {
        const vec = res.data[j]?.embedding;
        if (!vec) continue;
        const buf = Buffer.alloc(vec.length * 4);
        for (let k = 0; k < vec.length; k++) buf.writeFloatLE(vec[k]!, k * 4);
        await query(
          `INSERT INTO video_embeddings (video_id, model, dims, embedding, created_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (video_id) DO UPDATE SET model=EXCLUDED.model, dims=EXCLUDED.dims,
             embedding=EXCLUDED.embedding, created_at=now()`,
          [batch[j]!.video_id, env.EMBEDDINGS_MODEL, vec.length, buf]
        );
        done++;
      }
      log.info(`embeddings ${Math.min(i + 64, usable.length)}/${usable.length}`);
    } catch (e) {
      log.warn(`lote embeddings falló: ${String(e).slice(0, 200)}`);
      break;
    }
  }
  log.info(`${done} embeddings nuevos (${env.EMBEDDINGS_MODEL})`);
  return done;
}

/** Carga embeddings (model actual) como Float32Array por video_id. */
export async function loadEmbeddings(): Promise<Map<string, Float32Array>> {
  const rows = await query<{ video_id: string; dims: number; embedding: Buffer }>(
    `SELECT e.video_id, e.dims, e.embedding FROM video_embeddings e
     JOIN videos v ON v.video_id = e.video_id
     WHERE e.model = $1 AND ${longOnlySql("v")}`,
    [env.EMBEDDINGS_MODEL]
  );
  const out = new Map<string, Float32Array>();
  for (const r of rows) {
    const arr = new Float32Array(r.dims);
    for (let i = 0; i < r.dims; i++) arr[i] = r.embedding.readFloatLE(i * 4);
    out.set(r.video_id, arr);
  }
  return out;
}

// ---------- k-means con distancia coseno (vectores ya ~normalizados) ----------

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}
function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a)) || 1;
}
function cosineDist(a: Float32Array, b: Float32Array): number {
  return 1 - dot(a, b) / (norm(a) * norm(b));
}

export interface KmCluster {
  members: { id: string; distance: number }[];
}

/** k-means simple (init k-means++ aproximado, 25 iteraciones máx). */
export function kmeansCosine(
  items: { id: string; vec: Float32Array }[],
  k: number
): KmCluster[] {
  if (items.length === 0) return [];
  k = Math.min(k, items.length);
  const dims = items[0]!.vec.length;

  // init: primer centro aleatorio determinista, resto el más lejano (k-means++ greedy)
  const centers: Float32Array[] = [Float32Array.from(items[0]!.vec)];
  while (centers.length < k) {
    let best: { idx: number; d: number } = { idx: 0, d: -1 };
    for (let i = 0; i < items.length; i++) {
      const dmin = Math.min(...centers.map((c) => cosineDist(items[i]!.vec, c)));
      if (dmin > best.d) best = { idx: i, d: dmin };
    }
    centers.push(Float32Array.from(items[best.idx]!.vec));
  }

  let assign = new Array<number>(items.length).fill(0);
  for (let iter = 0; iter < 25; iter++) {
    let changed = false;
    for (let i = 0; i < items.length; i++) {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = cosineDist(items[i]!.vec, centers[c]!);
        if (d < bd) { bd = d; bi = c; }
      }
      if (assign[i] !== bi) { assign[i] = bi; changed = true; }
    }
    // recomputar centros
    const sums = centers.map(() => new Float64Array(dims));
    const counts = new Array<number>(centers.length).fill(0);
    for (let i = 0; i < items.length; i++) {
      const c = assign[i]!;
      counts[c]!++;
      const v = items[i]!.vec;
      const s = sums[c]!;
      for (let d = 0; d < dims; d++) s[d]! += v[d]!;
    }
    for (let c = 0; c < centers.length; c++) {
      if (counts[c]! === 0) continue;
      const ctr = centers[c]!;
      for (let d = 0; d < dims; d++) ctr[d] = sums[c]![d]! / counts[c]!;
    }
    if (!changed) break;
  }

  const clusters: KmCluster[] = centers.map(() => ({ members: [] }));
  for (let i = 0; i < items.length; i++) {
    const c = assign[i]!;
    clusters[c]!.members.push({
      id: items[i]!.id,
      distance: Number(cosineDist(items[i]!.vec, centers[c]!).toFixed(4)),
    });
  }
  return clusters.filter((c) => c.members.length > 0);
}
