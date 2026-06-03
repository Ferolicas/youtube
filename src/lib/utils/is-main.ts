import { pathToFileURL } from "node:url";

/**
 * True solo si el módulo dado es el entrypoint ejecutado directamente
 * (p. ej. `tsx src/workers/sync.ts`), no cuando se importa desde otro módulo.
 * Evita que importar un worker en una API route dispare sus crons/loops.
 */
export function isMain(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return importMetaUrl === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}
