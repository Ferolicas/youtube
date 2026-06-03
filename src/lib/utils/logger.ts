/* eslint-disable no-console */
type Level = "debug" | "info" | "warn" | "error";

const COLORS: Record<Level, string> = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
};
const RESET = "\x1b[0m";

function emit(level: Level, scope: string, msg: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const color = COLORS[level];
  const head = `${color}${ts} [${level.toUpperCase()}] (${scope})${RESET}`;
  if (meta !== undefined) {
    console[level === "debug" ? "log" : level](head, msg, meta);
  } else {
    console[level === "debug" ? "log" : level](head, msg);
  }
}

/** Logger con scope. Nunca silencia errores: siempre van a stderr/stdout. */
export function createLogger(scope: string) {
  return {
    debug: (m: string, meta?: unknown) => emit("debug", scope, m, meta),
    info: (m: string, meta?: unknown) => emit("info", scope, m, meta),
    warn: (m: string, meta?: unknown) => emit("warn", scope, m, meta),
    error: (m: string, meta?: unknown) => emit("error", scope, m, meta),
  };
}

export type Logger = ReturnType<typeof createLogger>;
