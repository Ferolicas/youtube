import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/session";
import { generateScript } from "@/lib/ideas/scripts";
import { getScript } from "@/lib/dashboard/queries";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ id: z.coerce.number().int().positive() });

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "no autenticado" }, { status: 401 });
  }
  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) return NextResponse.json({ error: "id inválido" }, { status: 400 });
  const script = await getScript(String(parsed.data.id));
  if (!script) return NextResponse.json({ error: "sin guion" }, { status: 404 });
  return NextResponse.json(script);
}

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!(await getSession())) {
    return NextResponse.json({ error: "no autenticado" }, { status: 401 });
  }
  const parsed = paramsSchema.safeParse(await ctx.params);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await generateScript(parsed.data.id);
  if (!result.ok) return NextResponse.json({ error: result.reason }, { status: 422 });
  return NextResponse.json({ ok: true });
}
