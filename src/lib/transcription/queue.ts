import { query, queryOne } from "@/lib/db/pool";

export type TqStatus =
  | "pending"
  | "downloading"
  | "transcribing"
  | "done"
  | "failed"
  | "skipped";

export async function enqueueAllMissing(): Promise<number> {
  const res = await query(
    `INSERT INTO transcription_queue (video_id, status)
     SELECT v.video_id, 'pending' FROM videos v
     LEFT JOIN transcripts t ON t.video_id = v.video_id
     WHERE t.video_id IS NULL
     ON CONFLICT (video_id) DO NOTHING
     RETURNING video_id`
  );
  return res.length;
}

/** Reclama el siguiente vídeo pendiente de forma atómica (idempotente, reanudable). */
export async function claimNext(): Promise<{ video_id: string } | null> {
  return queryOne<{ video_id: string }>(
    `UPDATE transcription_queue SET status='downloading', started_at=now(), attempts=attempts+1, updated_at=now()
     WHERE video_id = (
       SELECT video_id FROM transcription_queue
       WHERE status IN ('pending','failed') AND attempts < 4
       ORDER BY (status='failed'), updated_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING video_id`
  );
}

export async function setStatus(
  videoId: string,
  status: TqStatus,
  patch: { last_error?: string; audio_path?: string } = {}
): Promise<void> {
  await query(
    `UPDATE transcription_queue
       SET status=$2, last_error=$3, audio_path=COALESCE($4, audio_path),
           finished_at = CASE WHEN $2 IN ('done','skipped','failed') THEN now() ELSE finished_at END,
           updated_at=now()
     WHERE video_id=$1`,
    [videoId, status, patch.last_error ?? null, patch.audio_path ?? null]
  );
}

export async function queueStats() {
  const rows = await query<{ status: string; n: string }>(
    `SELECT status, count(*)::text AS n FROM transcription_queue GROUP BY status`
  );
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]));
}
