import Link from "next/link";
import { getCommentsData } from "@/lib/dashboard/queries";
import { Card, CardTitle, Stat, Badge, EmptyState, Th, Td } from "@/components/ui/primitives";

export const dynamic = "force-dynamic";

interface CommentsSnap {
  available: boolean;
  reason?: string;
  total_comments?: number;
  questions_count?: number;
  top_questions?: { video_id: string; video_title: string | null; text: string; likes: number }[];
  asked_topics?: { topic: string; questions: number; total_likes: number; example: string }[];
  sentiment_worst?: { video_id: string; title: string | null; comments: number; negative_pct: number; positive_pct: number }[];
  sentiment_best?: { video_id: string; title: string | null; comments: number; negative_pct: number; positive_pct: number }[];
  note?: string;
}

export default async function CommentsPage() {
  const snap = (await getCommentsData()) as CommentsSnap | null;

  if (!snap || !snap.available) {
    return (
      <EmptyState
        title="Sin insights de comentarios todavía"
        hint={snap?.reason ?? "Corre un Sync (ingesta 'comments') y luego Analizar. Los comentarios son demanda directa de contenido de tu audiencia."}
      />
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Comentarios — la voz de tu audiencia</h1>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
        <Stat label="Comentarios analizados" value={snap.total_comments ?? 0} />
        <Stat label="Preguntas detectadas" value={snap.questions_count ?? 0} accent />
        <Stat label="Temas pedidos" value={snap.asked_topics?.length ?? 0} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle hint="ordenadas por likes — ideas de contenido directas">Preguntas más votadas</CardTitle>
          <ul className="space-y-3">
            {(snap.top_questions ?? []).slice(0, 12).map((q, i) => (
              <li key={i} className="rounded-lg border border-border bg-panel2 p-3">
                <p className="text-sm text-fg">«{q.text}»</p>
                <p className="mt-1 text-xs text-muted">
                  <Badge tone="info">{q.likes} ♥</Badge>{" "}
                  en <Link href={`/videos/${q.video_id}`} className="hover:text-accent">{q.video_title}</Link>
                </p>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardTitle hint="temas que tu audiencia pide repetidamente">Demanda recurrente</CardTitle>
          <table className="w-full">
            <thead><tr><Th>Tema</Th><Th className="text-right">Preguntas</Th><Th className="text-right">Likes</Th></tr></thead>
            <tbody>
              {(snap.asked_topics ?? []).map((t) => (
                <tr key={t.topic} title={t.example}>
                  <Td>{t.topic}</Td>
                  <Td className="text-right tabular">{t.questions}</Td>
                  <Td className="text-right tabular text-muted">{t.total_likes}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardTitle hint="% comentarios negativos (heurístico)">Vídeos con más fricción</CardTitle>
          <table className="w-full">
            <thead><tr><Th>Vídeo</Th><Th className="text-right">Neg.</Th><Th className="text-right">Pos.</Th><Th className="text-right">N</Th></tr></thead>
            <tbody>
              {(snap.sentiment_worst ?? []).map((s) => (
                <tr key={s.video_id}>
                  <Td><Link href={`/videos/${s.video_id}`} className="hover:text-accent">{s.title}</Link></Td>
                  <Td className="text-right tabular"><Badge tone={s.negative_pct >= 20 ? "bad" : "default"}>{s.negative_pct}%</Badge></Td>
                  <Td className="text-right tabular text-muted">{s.positive_pct}%</Td>
                  <Td className="text-right tabular text-muted">{s.comments}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card>
          <CardTitle>Vídeos más queridos</CardTitle>
          <table className="w-full">
            <thead><tr><Th>Vídeo</Th><Th className="text-right">Pos.</Th><Th className="text-right">N</Th></tr></thead>
            <tbody>
              {(snap.sentiment_best ?? []).map((s) => (
                <tr key={s.video_id}>
                  <Td><Link href={`/videos/${s.video_id}`} className="hover:text-accent">{s.title}</Link></Td>
                  <Td className="text-right tabular"><Badge tone="good">{s.positive_pct}%</Badge></Td>
                  <Td className="text-right tabular text-muted">{s.comments}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      {snap.note && <p className="text-xs text-muted">{snap.note}</p>}
    </div>
  );
}
