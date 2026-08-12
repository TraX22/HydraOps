import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Único sitio donde se resuelven rutas. Antes cada servicio se inventaba las
 * suyas con `import.meta.url`, `process.cwd()` o `__dirname`, lo que ataba los
 * datos al árbol del repositorio.
 *
 * Hay dos raíces y conviene no mezclarlas:
 *
 *   appRoot  — el código y los recursos que viajan con la aplicación y que
 *              nadie modifica en caliente (migraciones de drizzle, img/).
 *   dataRoot — lo que el usuario crea y edita: la base de datos, los agentes,
 *              su perfil, los adjuntos, los logs, sus add-ons y el .env.
 *
 * En desarrollo las dos apuntan a la raíz del repositorio y todo sigue
 * exactamente donde estaba. La app de escritorio pone HYDRA_DATA_DIR a
 * `app.getPath("userData")`, así una instalación real nunca escribe dentro de
 * Archivos de programa.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Este archivo acaba en packages/config/{src,dist}/ y, si tsup lo empaqueta
// dentro de un servicio, en apps/<app>/{src,dist}/. Los dos casos están tres
// niveles por debajo de la raíz. HYDRA_APP_ROOT lo fuerza si algún día el
// empaquetado cambia esa profundidad.
export const appRoot = process.env.HYDRA_APP_ROOT
  ? path.resolve(process.env.HYDRA_APP_ROOT)
  : path.resolve(HERE, "../../..");

export const dataRoot = process.env.HYDRA_DATA_DIR
  ? path.resolve(process.env.HYDRA_DATA_DIR)
  : appRoot;

/** Los 5 (o los que haya) agentes, cada uno con sus .md y su avatar. */
export const agentsDir = path.join(dataRoot, "agents");
/** profile.json y avatar.png del usuario. */
export const usersDir = path.join(dataRoot, "users");
export const storageDir = path.join(dataRoot, "storage");
export const logsDir = path.join(storageDir, "logs");
export const uploadsDir = path.join(storageDir, "uploads");
export const resultsDir = path.join(storageDir, "results");
/** Herramientas que escribe el usuario, cargadas en caliente por @hydraops/addons. */
export const myAddonsDir = path.join(dataRoot, "my_addons");
export const dbFile = path.join(dataRoot, "db.sqlite3");
export const envFile = path.join(dataRoot, ".env");

/**
 * El almacén de credenciales del key-proxy.
 *
 * Vive FUERA de dataRoot a propósito: las herramientas de archivo de los
 * agentes trabajan dentro del proyecto, así que un almacén que colgara de ahí
 * sería alcanzable desde un prompt. Va al directorio de configuración del
 * usuario, el que cada sistema tenga por costumbre.
 *
 * Antes esto se construía a mano en dos sitios con `%APPDATA%` y un respaldo
 * que fabricaba `AppData/Roaming` incluso en Linux y macOS, donde esa carpeta
 * no significa nada.
 */
function configHome(): string {
  if (process.platform === "win32") {
    return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support");
  }
  // Linux y demás: XDG.
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

export const keyStoreDir = path.join(configHome(), "hydraops");
export const keyStoreFile = path.join(keyStoreDir, "keys.json");

/** Recursos de solo lectura: viajan con el código, no con los datos. */
export const imgDir = path.join(appRoot, "img");
/** El manual de uso en Markdown; la API lo sirve bajo /api/docs. */
export const docsDir = path.join(appRoot, "docs");
/** El oficio de cada tipo de worker (coder/general/graphic/video.md): la
 * teoría del rol, inyectada en el prompt junto a los .md del agente. */
export const craftDir = path.join(appRoot, "craft");
export const migrationsDir = path.join(appRoot, "packages", "db", "drizzle");
/** Solo lo usa la API para enumerar servicios; no existe en una instalación. */
export const appsDir = path.join(appRoot, "apps");

/** Todos los directorios de datos que deben existir antes de arrancar. */
export const writableDirs = [
  dataRoot,
  agentsDir,
  usersDir,
  storageDir,
  logsDir,
  uploadsDir,
  resultsDir,
];
