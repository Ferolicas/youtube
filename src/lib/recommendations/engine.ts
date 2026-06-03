import { query } from "@/lib/db/pool";
import { latestSnapshot } from "@/lib/analysis/queries";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("recommendations");

interface Rec {
  area: string;
  title: string;
  detail: string;
  impact: number; // 1-5
  effort: number; // 1-5
  evidence: Record<string, unknown>;
}

/**
 * Motor de recomendaciones priorizadas por impacto, todas derivadas de TUS datos
 * (snapshots de análisis). Reescribe el set completo en cada ejecución.
 */
export async function generateRecommendations(): Promise<number> {
  const recs: Rec[] = [];

  // --- SEO ---
  const seo = await latestSnapshot<{ findings: { severity: string; issue: string; recommendation: string; area: string }[]; health_score: number }>("seo");
  if (seo) {
    for (const f of seo.findings.filter((x) => x.severity !== "baja")) {
      recs.push({
        area: "seo", title: f.issue, detail: f.recommendation,
        impact: f.severity === "alta" ? 4 : 3, effort: 2,
        evidence: { health_score: seo.health_score, area: f.area },
      });
    }
  }

  // --- Formatos / mix ---
  const outliers = await latestSnapshot<Record<string, { median_views: number; outlier_count: number; drivers: { feature: string; outliers_avg: number; normal_avg: number }[] }>>("outliers");
  if (outliers?.long?.drivers) {
    const retDriver = outliers.long.drivers.find((d) => d.feature === "retention_pct");
    if (retDriver && retDriver.outliers_avg > retDriver.normal_avg * 1.15) {
      recs.push({
        area: "format_mix",
        title: "La retención es el principal diferenciador de tus éxitos",
        detail: `Tus outliers retienen ${retDriver.outliers_avg}% vs ${retDriver.normal_avg}% del resto. Invierte en ganchos de 0-30s y estructura de micro-ganchos; replica el patrón de tus 3 vídeos top.`,
        impact: 5, effort: 3,
        evidence: { retention_outliers: retDriver.outliers_avg, retention_normal: retDriver.normal_avg },
      });
    }
    const durDriver = outliers.long.drivers.find((d) => d.feature === "duration_sec");
    if (durDriver) {
      recs.push({
        area: "format_mix",
        title: "Ajusta la duración hacia la de tus outliers",
        detail: `Tus vídeos de alto rendimiento duran en promedio ${Math.round(durDriver.outliers_avg / 60)} min vs ${Math.round(durDriver.normal_avg / 60)} min del resto. Acerca tus próximos vídeos a esa duración.`,
        impact: 3, effort: 2,
        evidence: { dur_outliers_min: Math.round(durDriver.outliers_avg / 60), dur_normal_min: Math.round(durDriver.normal_avg / 60) },
      });
    }
  }

  // --- Cadencia / timing ---
  const timing = await latestSnapshot<{ best_hours_utc: { hour_utc: number; median_score: number }[]; best_weekdays: { weekday: string }[] }>("timing", "long");
  if (timing?.best_hours_utc?.length) {
    const hours = timing.best_hours_utc.slice(0, 2).map((h) => `${h.hour_utc}:00 UTC`).join(" y ");
    const days = (timing.best_weekdays ?? []).slice(0, 2).map((d) => d.weekday).join(" y ");
    recs.push({
      area: "cadence",
      title: "Publica en tus franjas de mayor arranque",
      detail: `Tus mejores arranques (vistas 0-48h) ocurren a las ${hours}${days ? `, días ${days}` : ""}. Programa ahí tus vídeos largos.`,
      impact: 3, effort: 1,
      evidence: { best_hours: timing.best_hours_utc.slice(0, 3) },
    });
  }

  // --- Monetización AdSense ---
  const mon = await latestSnapshot<{ available: boolean; recommendations?: string[]; by_duration?: { bucket: string; avg_rpm: number | null }[]; under_monetized_long?: unknown[] }>("monetization");
  if (mon?.available && mon.recommendations) {
    for (const r of mon.recommendations) {
      recs.push({
        area: "monetization", title: "Optimización AdSense", detail: r,
        impact: 4, effort: 2, evidence: { by_duration: mon.by_duration },
      });
    }
  } else if (mon && !mon.available) {
    recs.push({
      area: "monetization", title: "Habilita los datos de ingresos",
      detail: "No hay datos de monetización. Reconecta concediendo el scope monetario y confirma que el canal está en YPP.",
      impact: 5, effort: 1, evidence: {},
    });
  }

  // --- Audiencia / branding ---
  const aud = await latestSnapshot<{ latam_share_pct: number; top_countries: { country: string; views: number; is_latam: boolean }[] }>("audience", "long");
  if (aud) {
    recs.push({
      area: "branding",
      title: "Refuerza identidad LATAM",
      detail: `El ${aud.latam_share_pct}% de tus vistas son LATAM. Usa español neutro, ejemplos de ingredientes y precios locales, y miniaturas con códigos visuales de tu top de países.`,
      impact: 3, effort: 2,
      evidence: { latam_share_pct: aud.latam_share_pct, top: aud.top_countries.slice(0, 5) },
    });
  }

  await query(`DELETE FROM recommendations WHERE status='open'`);
  for (const r of recs) {
    await query(
      `INSERT INTO recommendations (area, title, detail, impact, effort, evidence, status)
       VALUES ($1,$2,$3,$4,$5,$6,'open')`,
      [r.area, r.title, r.detail, r.impact, r.effort, JSON.stringify(r.evidence)]
    );
  }
  log.info(`${recs.length} recomendaciones generadas`);
  return recs.length;
}
