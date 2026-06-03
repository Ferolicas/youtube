import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { query } from "@/lib/db/pool";
import { env } from "@/config/env";
import { createLogger } from "@/lib/utils/logger";
import type { YtThumbnails } from "@/types/youtube";

const log = createLogger("ingest:thumbnails");

function bestThumb(t: YtThumbnails | null): { url: string; w: number; h: number } | null {
  if (!t) return null;
  const cand = t.maxres ?? t.standard ?? t.high ?? t.medium ?? t.default;
  return cand ? { url: cand.url, w: cand.width, h: cand.height } : null;
}

/**
 * Análisis visual de miniatura con sharp (sin dependencias externas):
 *  - brillo, contraste, saturación, "colorfulness", colores dominantes.
 * Caras y OCR (has_face/detected_text) quedan opcionales — requieren OpenCV/Tesseract
 * (script python). Se dejan NULL si no se ejecuta ese paso; ver scripts/.
 */
export async function analyzeThumbnail(videoId: string, thumbs: YtThumbnails | null): Promise<void> {
  const best = bestThumb(thumbs);
  if (!best) return;

  const res = await fetch(best.url);
  if (!res.ok) {
    log.warn(`no se pudo descargar miniatura ${videoId}: ${res.status}`);
    return;
  }
  const buf = Buffer.from(await res.arrayBuffer());

  const dir = join(process.cwd(), env.MEDIA_DIR, "thumbnails");
  await mkdir(dir, { recursive: true });
  const localPath = join(dir, `${videoId}.jpg`);
  await writeFile(localPath, buf);

  const img = sharp(buf).removeAlpha();
  const stats = await img.stats();
  // canales RGB
  const [r, g, b] = stats.channels;
  const brightness = r && g && b ? (r.mean * 0.299 + g.mean * 0.587 + b.mean * 0.114) / 255 : null;
  const contrast = r && g && b ? ((r.stdev + g.stdev + b.stdev) / 3) / 128 : null;

  // saturación y colorfulness (métrica de Hasler & Süsstrunk)
  let saturation: number | null = null;
  let colorfulness: number | null = null;
  if (r && g && b) {
    const rg = Math.abs(r.mean - g.mean);
    const yb = Math.abs(0.5 * (r.mean + g.mean) - b.mean);
    colorfulness = Math.sqrt(r.stdev ** 2 + g.stdev ** 2) + 0.3 * Math.sqrt(rg ** 2 + yb ** 2);
    const maxc = Math.max(r.mean, g.mean, b.mean);
    const minc = Math.min(r.mean, g.mean, b.mean);
    saturation = maxc > 0 ? (maxc - minc) / maxc : 0;
  }

  // colores dominantes: reducimos a 5 colores con sharp + quantización por muestreo
  const dominant = await dominantColors(buf);

  await query(
    `INSERT INTO thumbnails (video_id, image_url, local_path, width, height,
       dominant_colors, brightness, contrast, saturation, colorfulness, analysis_model, analyzed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'sharp-stats', now())
     ON CONFLICT (video_id) DO UPDATE SET image_url=EXCLUDED.image_url, local_path=EXCLUDED.local_path,
       width=EXCLUDED.width, height=EXCLUDED.height, dominant_colors=EXCLUDED.dominant_colors,
       brightness=EXCLUDED.brightness, contrast=EXCLUDED.contrast, saturation=EXCLUDED.saturation,
       colorfulness=EXCLUDED.colorfulness, analysis_model='sharp-stats', analyzed_at=now()`,
    [videoId, best.url, localPath, best.w, best.h, JSON.stringify(dominant),
     brightness, contrast, saturation, colorfulness]
  );
}

async function dominantColors(buf: Buffer): Promise<{ hex: string; ratio: number }[]> {
  // Reducimos a 16x16 y contamos buckets de color groseros.
  const { data, info } = await sharp(buf)
    .resize(16, 16, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const counts = new Map<string, number>();
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    const r = Math.round((data[i] ?? 0) / 64) * 64;
    const g = Math.round((data[i + 1] ?? 0) / 64) * 64;
    const b = Math.round((data[i + 2] ?? 0) / 64) * 64;
    const key = `${r},${g},${b}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = 256;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, c]) => {
      const [r, g, b] = key.split(",").map(Number) as [number, number, number];
      const hex = `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
      return { hex, ratio: Number((c / total).toFixed(3)) };
    });
}

export async function ingestAllThumbnails(): Promise<number> {
  const rows = await query<{ video_id: string; thumbnails: YtThumbnails | null }>(
    `SELECT v.video_id, v.thumbnails FROM videos v
     LEFT JOIN thumbnails t ON t.video_id = v.video_id
     WHERE t.video_id IS NULL OR t.analyzed_at < now() - interval '30 days'`
  );
  let n = 0;
  for (const r of rows) {
    try {
      await analyzeThumbnail(r.video_id, r.thumbnails);
      n++;
    } catch (e) {
      log.warn(`thumbnail ${r.video_id}: ${String(e)}`);
    }
  }
  log.info(`miniaturas analizadas: ${n}`);
  return n;
}
