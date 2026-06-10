/**
 * import:studio — Importa el CSV "Datos de la tabla.csv" de YouTube Studio.
 *
 * Solo carga métricas Studio-only (grupo A): que la API NO da o da mal
 * (CTR/impresiones de miniatura, pantallas finales, shopping, espectadores
 * nuevos/recurrentes, engaged views, tarjetas). NO toca vistas, retención,
 * ingresos ni subs (eso lo mantiene la API a diario), ni la clasificación is_short.
 *
 *   npm run import:studio -- "ruta/Datos de la tabla.csv"
 *   npm run import:studio -- "ruta/Datos de la tabla.csv" --from 2024-08-30 --to 2026-06-03
 */
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { query } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("import:studio");

/** Parser CSV que respeta comillas dobles y comas internas. */
function parseLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else {
      if (c === '"') q = true;
      else if (c === ",") { out.push(cur); cur = ""; }
      else cur += c;
    }
  }
  out.push(cur);
  return out;
}

function num(s: string | undefined): number | null {
  if (s === undefined) return null;
  const t = s.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
function int(s: string | undefined): number | null {
  const n = num(s);
  return n === null ? null : Math.round(n);
}
function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  const d = new Date(s.trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith("--"));
  if (!csvPath) {
    console.error('Uso: npm run import:studio -- "ruta/Datos de la tabla.csv" [--from YYYY-MM-DD --to YYYY-MM-DD]');
    process.exit(1);
  }
  // periodo: de --from/--to, o derivado del nombre de carpeta (..._2024-08-30_2026-06-03 ...)
  const fromArg = args[args.indexOf("--from") + 1];
  const toArg = args[args.indexOf("--to") + 1];
  const m = (dirname(csvPath) + "/" + basename(csvPath)).match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
  const periodStart = (args.includes("--from") ? fromArg : undefined) ?? m?.[1] ?? null;
  const periodEnd = (args.includes("--to") ? toArg : undefined) ?? m?.[2] ?? null;
  if (!periodStart || !periodEnd) {
    console.error("No pude determinar el periodo. Pásalo con --from YYYY-MM-DD --to YYYY-MM-DD.");
    process.exit(1);
  }
  log.info(`periodo ${periodStart} … ${periodEnd}`);

  const text = await readFile(csvPath, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = parseLine(lines[0]!);
  const col = new Map<string, number>();
  header.forEach((h, i) => col.set(h.trim(), i));
  const get = (row: string[], name: string): string | undefined => {
    const i = col.get(name);
    return i === undefined ? undefined : row[i];
  };

  const dataRows = lines.slice(1).map(parseLine).filter((r) => {
    const id = (r[0] ?? "").trim();
    return id !== "" && id !== "Total";
  });

  let videosCreated = 0, ctrRows = 0, studioRows = 0, skipped = 0;
  for (const r of dataRows) {
    const id = (get(r, "Contenido") ?? "").trim();
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) { skipped++; continue; }

    // 1) asegurar el vídeo (sin tocar is_short ni datos existentes)
    const created = await query<{ video_id: string }>(
      `INSERT INTO videos (video_id, title, published_at, duration_seconds, fetched_at, updated_at)
       VALUES ($1,$2,$3,$4, now(), now())
       ON CONFLICT (video_id) DO NOTHING
       RETURNING video_id`,
      [id, get(r, "Título del vídeo") ?? null, parseDate(get(r, "Hora de publicación del vídeo")), int(get(r, "Duración"))]
    );
    if (created.length > 0) videosCreated++;

    // 2) CTR + impresiones -> thumbnail_ctr_import (lo consume el análisis de miniaturas)
    const imp = int(get(r, "Impresiones"));
    const ctr = num(get(r, "Porcentaje de clics de las impresiones (%)"));
    if (imp !== null || ctr !== null) {
      await query(
        `INSERT INTO thumbnail_ctr_import (video_id, period_start, period_end, impressions, ctr)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (video_id, period_start, period_end)
         DO UPDATE SET impressions=EXCLUDED.impressions, ctr=EXCLUDED.ctr, imported_at=now()`,
        [id, periodStart, periodEnd, imp, ctr]
      );
      ctrRows++;
    }

    // 3) resto del grupo A -> studio_content_stats (+ volcado raw de toda la fila)
    const raw: Record<string, string> = {};
    header.forEach((h, i) => { const v = r[i]; if (v !== undefined && v !== "") raw[h.trim()] = v; });
    await query(
      `INSERT INTO studio_content_stats (
         video_id, period_start, period_end,
         engaged_views, unique_viewers, avg_views_per_viewer,
         new_viewers, returning_viewers, casual_viewers, regular_viewers, stayed_to_watch_pct,
         impressions, impressions_ctr,
         endscreen_clicks, endscreens_shown, endscreen_ctr,
         card_clicks, cards_shown, card_ctr,
         product_clicks, product_impressions, product_sales_eur, product_orders,
         raw)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
       ON CONFLICT (video_id) DO UPDATE SET
         period_start=EXCLUDED.period_start, period_end=EXCLUDED.period_end,
         engaged_views=EXCLUDED.engaged_views, unique_viewers=EXCLUDED.unique_viewers,
         avg_views_per_viewer=EXCLUDED.avg_views_per_viewer,
         new_viewers=EXCLUDED.new_viewers, returning_viewers=EXCLUDED.returning_viewers,
         casual_viewers=EXCLUDED.casual_viewers, regular_viewers=EXCLUDED.regular_viewers,
         stayed_to_watch_pct=EXCLUDED.stayed_to_watch_pct,
         impressions=EXCLUDED.impressions, impressions_ctr=EXCLUDED.impressions_ctr,
         endscreen_clicks=EXCLUDED.endscreen_clicks, endscreens_shown=EXCLUDED.endscreens_shown,
         endscreen_ctr=EXCLUDED.endscreen_ctr,
         card_clicks=EXCLUDED.card_clicks, cards_shown=EXCLUDED.cards_shown, card_ctr=EXCLUDED.card_ctr,
         product_clicks=EXCLUDED.product_clicks, product_impressions=EXCLUDED.product_impressions,
         product_sales_eur=EXCLUDED.product_sales_eur, product_orders=EXCLUDED.product_orders,
         raw=EXCLUDED.raw, imported_at=now()`,
      [
        id, periodStart, periodEnd,
        int(get(r, "Visualizaciones interesadas")), int(get(r, "Usuarios únicos")), num(get(r, "Media de visualizaciones por usuario")),
        int(get(r, "Usuarios nuevos")), int(get(r, "Usuarios recurrentes")), int(get(r, "Usuarios ocasionales")), int(get(r, "Usuarios habituales")), num(get(r, "Se quedaron viendo (%)")),
        imp, ctr,
        int(get(r, "Clics en elementos de pantalla final")), int(get(r, "Elementos de pantalla final mostrados")), num(get(r, "Clics por elemento de pantalla final mostrado (%)")),
        int(get(r, "Clics en tarjetas")), int(get(r, "Tarjetas mostradas")), num(get(r, "Clics por tarjeta mostrada (%)")),
        int(get(r, "Clics en producto")), int(get(r, "Impresiones de producto")), num(get(r, "Ventas en total (EUR)")), int(get(r, "Pedidos")),
        JSON.stringify(raw),
      ]
    );
    studioRows++;
  }

  log.info(`import OK: ${studioRows} vídeos (studio), ${ctrRows} con CTR/impresiones, ${videosCreated} vídeos nuevos creados, ${skipped} saltados`);
  console.log(`\n=== IMPORT STUDIO ===`);
  console.log(`Filas procesadas:        ${dataRows.length}`);
  console.log(`studio_content_stats:    ${studioRows}`);
  console.log(`thumbnail_ctr_import:    ${ctrRows}`);
  console.log(`Vídeos nuevos creados:   ${videosCreated}  ${videosCreated > 0 ? "(SIN channel_id ni metadatos → el Sync los adopta si son tuyos; los ajenos se limpian con `npm run reconcile`)" : ""}`);
  console.log(`Saltados (id inválido):  ${skipped}`);
  console.log(`NO se tocó: is_short, vistas, retención, ingresos, subs (los mantiene la API).`);
}

main()
  .then(() => process.exit(0))
  .catch((e: unknown) => { log.error("import falló", String(e)); process.exit(1); });
