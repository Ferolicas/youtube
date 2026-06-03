import { getIdeasData } from "@/lib/dashboard/queries";
import { EmptyState } from "@/components/ui/primitives";
import { IdeaCard, type IdeaDTO } from "@/components/idea-card";

export const dynamic = "force-dynamic";

export default async function IdeasPage() {
  const { forDate, ideas } = await getIdeasData();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Ideas diarias</h1>
        {forDate && <span className="text-sm text-muted">Generadas para {forDate}</span>}
      </div>

      {ideas.length === 0 ? (
        <EmptyState
          title="Sin ideas todavía"
          hint="Ejecuta “Tendencias” para generar las ideas del día (combina lo que ya funciona en tu canal + tendencias). Los guiones requieren OPENAI_API_KEY."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {ideas.map((idea) => <IdeaCard key={idea.id} idea={idea as unknown as IdeaDTO} />)}
        </div>
      )}
    </div>
  );
}
