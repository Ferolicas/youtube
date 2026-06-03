import { runMigrations } from "@/lib/db/migrate";
import { pool } from "@/lib/db/pool";
import { createLogger } from "@/lib/utils/logger";

const log = createLogger("worker:migrate");

runMigrations()
  .then(() => log.info("migraciones OK"))
  .catch((e) => {
    log.error("migraciones fallaron", String(e));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
