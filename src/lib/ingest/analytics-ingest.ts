import { query, queryOne, withTransaction } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";
import { hasMonetaryScope } from "@/lib/auth/tokens";
import {
  dailyVideoStats,
  retentionCurve,
  trafficSources,
  trafficSourceDetail,
  demographics,
  geography,
  devices,
  revenueDaily,
  revenueByCountry,
  channelDailyStats,
  channelSearchTerms,
  today,
  isoDaysAgo,
} from "@/lib/youtube/analytics-api";

const log = createLogger("ingest:analytics");
const num = (v: unknown): number | null =>
  v === undefined || v === null || v === "" ? null : Number(v);

/** Ingesta de TODAS las métricas privadas de un vídeo. Tolerante a datos vacíos
 *  (los vídeos de poca vista pueden no devolver demografía/geografía por umbral). */
export async function ingestVideoAnalytics(
  videoId: string,
  publishedAt: string,
  monetary?: boolean
): Promise<void> {
  const start = publishedAt.slice(0, 10) || "2010-01-01";
  const end = today();
  const isMonetary = monetary ?? (await hasMonetaryScope());

  // --- serie diaria ---
  try {
    const daily = await dailyVideoStats(videoId, start, end);
    for (const r of daily) {
      await query(
        `INSERT INTO video_stats_daily (video_id, date, views, estimated_minutes_watched,
           average_view_duration, average_view_percentage, likes, comments, shares,
           subscribers_gained, subscribers_lost, card_impressions, card_clicks, card_click_rate, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'analytics')
         ON CONFLICT (video_id, date) DO UPDATE SET
           views=EXCLUDED.views, estimated_minutes_watched=EXCLUDED.estimated_minutes_watched,
           average_view_duration=EXCLUDED.average_view_duration,
           average_view_percentage=EXCLUDED.average_view_percentage,
           likes=EXCLUDED.likes, comments=EXCLUDED.comments, shares=EXCLUDED.shares,
           subscribers_gained=EXCLUDED.subscribers_gained, subscribers_lost=EXCLUDED.subscribers_lost,
           card_impressions=EXCLUDED.card_impressions, card_clicks=EXCLUDED.card_clicks,
           card_click_rate=EXCLUDED.card_click_rate, source='analytics'`,
        [
          videoId, r.day, num(r.views), num(r.estimatedMinutesWatched),
          num(r.averageViewDuration), num(r.averageViewPercentage),
          num(r.likes), num(r.comments), num(r.shares),
          num(r.subscribersGained), num(r.subscribersLost),
          num(r.cardImpressions), num(r.cardClicks), num(r.cardClickRate),
        ]
      );
    }
  } catch (e) {
    log.warn(`daily stats ${videoId}: ${String(e)}`);
  }

  // --- retención ---
  try {
    const ret = await retentionCurve(videoId, start, end);
    if (ret.length > 0) {
      await withTransaction(async (c) => {
        await c.query(`DELETE FROM video_retention WHERE video_id=$1`, [videoId]);
        for (const r of ret) {
          await c.query(
            `INSERT INTO video_retention (video_id, elapsed_ratio, audience_watch_ratio,
               relative_retention_performance, computed_through)
             VALUES ($1,$2,$3,$4,$5)`,
            [videoId, num(r.elapsedVideoTimeRatio), num(r.audienceWatchRatio),
             num(r.relativeRetentionPerformance), end]
          );
        }
      });
    }
  } catch (e) {
    log.warn(`retention ${videoId}: ${String(e)}`);
  }

  // --- tráfico ---
  await replacePeriodRows(videoId, start, end, "video_traffic_sources",
    async () => trafficSources(videoId, start, end),
    (r) => [r.insightTrafficSourceType ?? "", "", num(r.views), num(r.estimatedMinutesWatched)],
    ["source_type", "source_detail", "views", "estimated_minutes_watched"]
  );

  // --- detalle de tráfico (SEO): búsquedas reales + vídeos que nos recomiendan ---
  for (const st of ["YT_SEARCH", "RELATED_VIDEO"] as const) {
    try {
      const rows = await trafficSourceDetail(videoId, st, start, end);
      await withTransaction(async (c) => {
        await c.query(
          `DELETE FROM video_traffic_details WHERE video_id=$1 AND source_type=$2`,
          [videoId, st]
        );
        for (const r of rows) {
          const detail = String(r.insightTrafficSourceDetail ?? "").trim();
          if (!detail) continue;
          await c.query(
            `INSERT INTO video_traffic_details (video_id, source_type, detail, views,
               estimated_minutes_watched, period_start, period_end)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
            [videoId, st, detail, num(r.views), num(r.estimatedMinutesWatched), start, end]
          );
        }
      });
    } catch (e) {
      // esperable en vídeos sin tráfico de ese tipo o bajo umbral; no es error
      log.warn(`traffic detail ${st} ${videoId}: ${String(e).slice(0, 160)}`);
    }
  }

  // --- demografía (puede venir vacía por umbral de privacidad) ---
  await replacePeriodRows(videoId, start, end, "video_demographics",
    async () => demographics(videoId, start, end),
    (r) => [r.ageGroup ?? "", r.gender ?? "", num(r.viewerPercentage)],
    ["age_group", "gender", "viewer_percentage"]
  );

  // --- geografía ---
  await replacePeriodRows(videoId, start, end, "video_geography",
    async () => geography(videoId, start, end),
    (r) => [r.country ?? "", num(r.views), num(r.estimatedMinutesWatched), num(r.averageViewDuration)],
    ["country_code", "views", "estimated_minutes_watched", "average_view_duration"]
  );

  // --- dispositivos ---
  await replacePeriodRows(videoId, start, end, "video_devices",
    async () => devices(videoId, start, end),
    (r) => [r.deviceType ?? "", r.operatingSystem ?? "", num(r.views), num(r.estimatedMinutesWatched)],
    ["device_type", "operating_system", "views", "estimated_minutes_watched"]
  );

  // --- monetización (solo si scope monetario + YPP) ---
  if (isMonetary) {
    try {
      const rev = await revenueDaily(videoId, start, end);
      for (const r of rev) {
        await query(
          `INSERT INTO video_revenue_daily (video_id, date, estimated_revenue, estimated_ad_revenue,
             estimated_red_partner_revenue, gross_revenue, cpm, playback_based_cpm, ad_impressions, monetized_playbacks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (video_id, date) DO UPDATE SET
             estimated_revenue=EXCLUDED.estimated_revenue, estimated_ad_revenue=EXCLUDED.estimated_ad_revenue,
             estimated_red_partner_revenue=EXCLUDED.estimated_red_partner_revenue,
             gross_revenue=EXCLUDED.gross_revenue, cpm=EXCLUDED.cpm,
             playback_based_cpm=EXCLUDED.playback_based_cpm, ad_impressions=EXCLUDED.ad_impressions,
             monetized_playbacks=EXCLUDED.monetized_playbacks`,
          [videoId, r.day, num(r.estimatedRevenue), num(r.estimatedAdRevenue),
           num(r.estimatedRedPartnerRevenue), num(r.grossRevenue), num(r.cpm),
           num(r.playbackBasedCpm), num(r.adImpressions), num(r.monetizedPlaybacks)]
        );
      }
    } catch (e) {
      log.warn(`revenue ${videoId}: ${String(e)}`);
    }

    await replacePeriodRows(videoId, start, end, "video_revenue_geo",
      async () => revenueByCountry(videoId, start, end),
      (r) => [r.country ?? "", num(r.estimatedRevenue), num(r.cpm), num(r.playbackBasedCpm), num(r.monetizedPlaybacks)],
      ["country_code", "estimated_revenue", "cpm", "playback_based_cpm", "monetized_playbacks"]
    );
  }
}

/**
 * Helper: mantiene UN ÚNICO set acumulado (publicación→hoy) por vídeo.
 * Borra por video_id (no por periodo exacto): antes, al mover period_end cada
 * día, los sets viejos quedaban huérfanos y los SUM() de los consumidores
 * inflaban vistas/ingresos ×(nº de syncs). El periodo queda como metadato.
 */
async function replacePeriodRows(
  videoId: string,
  start: string,
  end: string,
  table: string,
  fetch: () => Promise<Record<string, string | number>[]>,
  mapCols: (r: Record<string, string | number>) => (string | number | null)[],
  cols: string[]
): Promise<void> {
  try {
    const rows = await fetch();
    await withTransaction(async (c) => {
      await c.query(`DELETE FROM ${table} WHERE video_id=$1`, [videoId]);
      for (const r of rows) {
        const vals = mapCols(r);
        const placeholders = ["$1", "$2", "$3", ...vals.map((_, i) => `$${i + 4}`)];
        await c.query(
          `INSERT INTO ${table} (video_id, period_start, period_end, ${cols.join(", ")})
           VALUES (${placeholders.join(", ")}) ON CONFLICT DO NOTHING`,
          [videoId, start, end, ...vals]
        );
      }
    });
  } catch (e) {
    log.warn(`${table} ${videoId}: ${String(e)}`);
  }
}

/**
 * Itera vídeos refrescando analytics. En modo incremental usa VÍDEOS ACTIVOS,
 * no solo recién publicados: publicados <45d, O con vistas en los últimos 14d
 * (lo sabemos por la serie diaria), O outliers. Así los vídeos viejos que
 * siguen generando vistas/ingresos no se quedan congelados.
 */
export async function ingestAllAnalytics(opts: { onlyRecent?: boolean } = {}): Promise<number> {
  const monetary = await hasMonetaryScope();
  const activeWhere = `
    WHERE v.published_at > now() - interval '45 days'
       OR EXISTS (SELECT 1 FROM video_stats_daily d
                   WHERE d.video_id = v.video_id
                     AND d.date >= (now() - interval '14 days')::date
                     AND COALESCE(d.views,0) > 0)
       OR EXISTS (SELECT 1 FROM outlier_analysis o
                   WHERE o.video_id = v.video_id AND o.is_outlier)`;
  const rows = await query<{ video_id: string; published_at: string }>(
    `SELECT v.video_id, v.published_at::text AS published_at FROM videos v
     ${opts.onlyRecent ? activeWhere : ""}
     ORDER BY v.published_at DESC NULLS LAST`
  );
  let n = 0;
  for (const v of rows) {
    try {
      await ingestVideoAnalytics(v.video_id, v.published_at ?? "2010-01-01", monetary);
      n++;
      if (n % 10 === 0) log.info(`analytics ${n}/${rows.length}`);
    } catch (e) {
      log.error(`analytics falló ${v.video_id}`, String(e));
    }
  }
  await ingestChannelAnalytics(opts.onlyRecent ?? true);
  log.info(`analytics refrescado para ${n} vídeos (monetary=${monetary})`);
  return n;
}

/**
 * Serie diaria a nivel CANAL (channel_stats_daily) + top búsquedas del canal
 * (channel_search_terms). Incremental: últimos 90 días; full: toda la historia.
 */
export async function ingestChannelAnalytics(onlyRecent = true): Promise<void> {
  const ch = await queryOne<{ channel_id: string; published_at: string | null; subscriber_count: string | null }>(
    `SELECT channel_id, published_at::text AS published_at, subscriber_count::text AS subscriber_count
     FROM channels LIMIT 1`
  );
  if (!ch) return;
  const start = onlyRecent
    ? isoDaysAgo(90)
    : (ch.published_at?.slice(0, 10) ?? "2010-01-01");
  const end = today();

  try {
    const daily = await channelDailyStats(start, end);
    for (const r of daily) {
      await query(
        `INSERT INTO channel_stats_daily (channel_id, date, views, estimated_minutes_watched,
           subscribers_gained, subscribers_lost)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (channel_id, date) DO UPDATE SET
           views=EXCLUDED.views, estimated_minutes_watched=EXCLUDED.estimated_minutes_watched,
           subscribers_gained=EXCLUDED.subscribers_gained, subscribers_lost=EXCLUDED.subscribers_lost`,
        [ch.channel_id, r.day, num(r.views), num(r.estimatedMinutesWatched),
         num(r.subscribersGained), num(r.subscribersLost)]
      );
    }
    // snapshot del total de subs de hoy (de channels.list del catálogo)
    if (ch.subscriber_count) {
      await query(
        `UPDATE channel_stats_daily SET subscribers=$2 WHERE channel_id=$1 AND date=$3`,
        [ch.channel_id, Number(ch.subscriber_count), end]
      );
    }
    log.info(`canal: ${daily.length} días de serie diaria (${start}..${end})`);
  } catch (e) {
    log.warn(`channel daily stats: ${String(e)}`);
  }

  try {
    const terms = await channelSearchTerms(isoDaysAgo(90), end);
    for (const r of terms) {
      const term = String(r.insightTrafficSourceDetail ?? "").trim();
      if (!term) continue;
      await query(
        `INSERT INTO channel_search_terms (term, views, estimated_minutes_watched, period_start, period_end)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (term, period_end) DO UPDATE SET
           views=EXCLUDED.views, estimated_minutes_watched=EXCLUDED.estimated_minutes_watched,
           captured_at=now()`,
        [term, num(r.views), num(r.estimatedMinutesWatched), isoDaysAgo(90), end]
      );
    }
    log.info(`canal: ${terms.length} términos de búsqueda (90d)`);
  } catch (e) {
    log.warn(`channel search terms: ${String(e)}`);
  }
}
