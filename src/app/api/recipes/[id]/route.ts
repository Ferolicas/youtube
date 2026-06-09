import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { deleteRecipe } from "@/lib/dashboard/queries";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "no autenticado" }, { status: 401 });
  }
  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: "id inválido" }, { status: 400 });
  }
  const ok = await deleteRecipe(parsed.data.id);
  if (!ok) return NextResponse.json({ error: "receta no encontrada" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
