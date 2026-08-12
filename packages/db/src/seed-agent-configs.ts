/**
 * Da de alta en agent_configs los agentes que existen en disco pero todavía no
 * tienen fila. Se ejecuta en el primer arranque de una instalación, después de
 * copiar la carpeta agents/ y de correr las migraciones.
 *
 * Es idempotente y no destructivo: nunca toca una fila existente, así que la
 * configuración que el usuario haya ajustado en la vista Agentes sobrevive a
 * cualquier reejecución o actualización.
 */
import { config as loadDotenv } from "dotenv";
import { readdir } from "node:fs/promises";
import { envFile, agentsDir } from "@hydraops/config";

loadDotenv({ path: envFile });

import { createDb, agentConfigs } from "./index.js";

const { db, pool } = createDb(process.env.DATABASE_URL ?? "sqlite://db.sqlite3");

/**
 * Tipo de worker por defecto para los agentes conocidos. El único que viaja con
 * el repositorio es "hydra"; los demás nombres son los del plantel histórico y
 * se mantienen para que una instalación anterior conserve su reparto.
 *
 * Un agente que no esté aquí (creado por el usuario, o añadido más tarde) entra
 * como "general", que es el que funciona sin configuración extra.
 */
const DEFAULT_WORKER_TYPES: Record<string, string> = {
  hydra: "general",
  elena: "general",
  karen: "coder",
  lucia: "general",
  luna: "graphic",
  sofia: "coder",
  valentina: "video",
};

// Un modelo de API barato y sin dependencias locales. El LLM local no sirve de
// defecto: en una máquina recién instalada no hay ningún llama-server escuchando.
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || "gemini-2.5-flash-lite";

async function main() {
  let dirs: string[];
  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });
    dirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
  } catch {
    console.log(`[seed] no hay carpeta de agentes en ${agentsDir}, nada que sembrar`);
    await pool.end();
    return;
  }

  const existing = new Set(
    (await (db as any).select({ id: agentConfigs.agentId }).from(agentConfigs)).map(
      (r: any) => r.id as string,
    ),
  );

  let added = 0;
  for (const agentId of dirs) {
    if (existing.has(agentId)) continue;
    await (db as any)
      .insert(agentConfigs)
      .values({
        agentId,
        model: DEFAULT_MODEL,
        workerType: DEFAULT_WORKER_TYPES[agentId] ?? "general",
        graphicEngine: "auto",
        graphicFormat: "png",
        resolution: "auto",
        updatedAt: new Date(),
      })
      .onConflictDoNothing()
      .run();
    console.log(`[seed] alta de ${agentId} (${DEFAULT_WORKER_TYPES[agentId] ?? "general"})`);
    added += 1;
  }

  console.log(added ? `[seed] ${added} agente(s) dados de alta` : "[seed] sin cambios");
  await pool.end();
}

main().catch((err) => {
  console.error("[seed] falló:", err);
  process.exit(1);
});
