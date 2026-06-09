import { getRecipes } from "@/lib/dashboard/queries";
import { EmptyState } from "@/components/ui/primitives";
import { RecipeCard, type RecipeDTO } from "@/components/recipe-card";

export const dynamic = "force-dynamic";

export default async function RecipesPage() {
  const recipes = await getRecipes();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-bold">Recetas</h1>
        {recipes.length > 0 && <span className="text-sm text-muted">{recipes.length} guardadas</span>}
      </div>

      {recipes.length === 0 ? (
        <EmptyState
          title="Aún no has guardado recetas"
          hint="Genera un guion desde “Ideas diarias”: la idea + el guion se guardan aquí para siempre (sobreviven al borrado diario de las ideas)."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {recipes.map((r) => <RecipeCard key={r.id} recipe={r as unknown as RecipeDTO} />)}
        </div>
      )}
    </div>
  );
}
