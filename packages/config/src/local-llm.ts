/**
 * Ajustes del LLM local, leídos del .env en caliente.
 *
 * Estos tres valores viven SOLO en el .env: la API los borra de system_configs
 * a propósito (POST /config) para que la base de datos no pueda tapar al
 * archivo. El problema es que los servicios cargan el .env una única vez al
 * arrancar, así que cambiar el servidor local desde la vista Config no surtía
 * efecto hasta reiniciar la aplicación entera — y sin ningún aviso: el worker
 * seguía llamando a la dirección vieja.
 *
 * Releyendo el archivo aquí (solo cuando cambia su fecha de modificación) el
 * cambio se aplica en la siguiente tarea.
 */
import { readFileSync, statSync } from "node:fs";
import { envFile } from "./paths.js";

export const LOCAL_ENV_KEYS = new Set(["LOCAL_LLM_URL", "LOCAL_LLM_KEY", "LOCAL_LLM_MODEL"]);

let cache: { mtimeMs: number; values: Record<string, string> } = { mtimeMs: -1, values: {} };

/**
 * Los valores LOCAL_LLM_* que haya ahora mismo en el .env. Devuelve solo las
 * claves presentes en el archivo, para que quien llame distinga "no está" de
 * "está vacío" y pueda decidir el respaldo.
 */
export function readLocalLlmEnv(): Record<string, string> {
  try {
    const { mtimeMs } = statSync(envFile);
    if (mtimeMs === cache.mtimeMs) return cache.values;

    const values: Record<string, string> = {};
    for (const line of readFileSync(envFile, "utf-8").split(/\r?\n/)) {
      if (!line.trim() || line.startsWith("#")) continue;
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      const key = line.slice(0, idx).trim();
      if (LOCAL_ENV_KEYS.has(key)) values[key] = line.slice(idx + 1).trim();
    }
    cache = { mtimeMs, values };
    return values;
  } catch {
    // Sin .env, o pillado a medio reescribir por la API: nos quedamos con lo
    // último que leímos bien (vacío si nunca hubo) y que decida quien llame.
    return cache.values;
  }
}
