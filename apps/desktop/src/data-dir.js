/**
 * data-dir.js — prepara el directorio de datos antes de arrancar nada.
 *
 * En desarrollo no hace falta: los datos ya están en la raíz del repositorio y
 * HYDRA_DATA_DIR se queda sin poner, así que @hydraops/config resuelve todo
 * ahí como siempre. En una instalación real los datos van a
 * app.getPath("userData"), que es escribible; el directorio de instalación no
 * tiene por qué serlo.
 *
 * Sembrado: una instalación nueva NO trae agentes, add-ons ni configuraciones —
 * el usuario los crea. Se crean vacíos los directorios agents/ y my_addons/, un
 * perfil de usuario vacío y un .env por defecto (con las claves apuntando al
 * key-proxy, nunca con claves reales dentro), y se corren las migraciones de drizzle.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

/**
 * .env inicial. Las claves valen "proxy" a propósito: el cortafuegos de
 * credenciales guarda las reales en %APPDATA%\hydraops\keys.json y el
 * key-proxy las inyecta en la frontera, así que ni el .env ni la base de datos
 * llegan a verlas nunca.
 */
const DEFAULT_ENV = `# Generado por HydraOps en el primer arranque.
DATABASE_URL=sqlite://db.sqlite3
NATS_URL=nats://127.0.0.1:4222
KEY_PROXY_URL=http://127.0.0.1:9099
RESULTS_DIR=./storage
LOG_LEVEL=info

# Las claves reales viven en %APPDATA%\\hydraops\\keys.json, no aquí.
# "proxy" es el marcador que el key-proxy sustituye al vuelo.
OPENAI_API_KEY=proxy
ANTHROPIC_API_KEY=proxy
GEMINI_API_KEY=proxy
GROQ_API_KEY=proxy
XAI_API_KEY=proxy
MISTRAL_API_KEY=proxy
LEONARDO_API_KEY=proxy
OPENROUTER_API_KEY=proxy

# LLM local (llama.cpp u otro servidor compatible con OpenAI). Vacío = sin usar.
LOCAL_LLM_URL=
LOCAL_LLM_KEY=
LOCAL_LLM_MODEL=
`;

/**
 * Lo que los add-ons del usuario necesitan poder importar desde el directorio de
 * datos. Viaja en el backend (tools/build-backend.mjs lo copia allí) y de ahí se
 * siembra. Si algún día hacen falta más paquetes, se añaden en los dos sitios.
 */
const ADDON_RUNTIME = ["zod"];

const DEFAULT_PROFILE = {
  name: "",
  occupation: "",
  interests: "",
  notes: "",
};

/**
 * Ejecuta un script de @hydraops/db en un proceso aparte y espera a que acabe.
 * Igual que los servicios, se lanza con el Node que trae Electron para no
 * depender de que el usuario tenga uno instalado.
 *
 * @param {string} name  nombre del script sin extensión, p.ej. "migrate"
 */
function runDbScript(name, { repoRoot, dataRoot, isPackaged }) {
  return new Promise((resolve, reject) => {
    const dbPkg = path.join(repoRoot, "packages", "db");
    const distEntry = path.join(dbPkg, "dist", `${name}.js`);
    const srcEntry = path.join(dbPkg, "src", `${name}.ts`);
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

    let args;
    if (isPackaged || !fs.existsSync(srcEntry) || !fs.existsSync(tsxCli)) {
      if (!fs.existsSync(distEntry)) {
        return reject(new Error(`No encuentro ${name} en ${distEntry}`));
      }
      args = [distEntry];
    } else {
      args = [tsxCli, srcEntry];
    }

    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        HYDRA_DATA_DIR: dataRoot,
        HYDRA_APP_ROOT: repoRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let output = "";
    child.stdout.on("data", (c) => { output += c; });
    child.stderr.on("data", (c) => { output += c; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) return resolve(output);
      reject(new Error(`${name} falló (código ${code}):\n${output.slice(-2000)}`));
    });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.dataRoot   dónde viven los datos del usuario
 * @param {string} opts.repoRoot   dónde está el código (para las migraciones)
 * @param {boolean} opts.isPackaged
 * @param {(msg: string) => void} [opts.onProgress]
 */
async function ensureDataDir({ dataRoot, repoRoot, isPackaged, onProgress = () => {} }) {
  const created = [];

  for (const dir of [
    dataRoot,
    // A fresh install ships NO agents and NO add-ons: create both dirs empty so
    // the app can list them, and the user creates their own from the UI (agents)
    // or by dropping a folder into my_addons.
    path.join(dataRoot, "agents"),
    path.join(dataRoot, "my_addons"),
    path.join(dataRoot, "storage"),
    path.join(dataRoot, "storage", "logs"),
    path.join(dataRoot, "storage", "uploads"),
    path.join(dataRoot, "storage", "results"),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // A user add-on imports from <dataRoot>/my_addons/<x>/index.ts, so its imports
  // resolve upward from there. zod is copied even though no add-on ships, so the
  // first add-on the user writes (which typically uses zod) loads out of the box.
  // En desarrollo no se toca nada: dataRoot es el repositorio y ya tiene el suyo.
  for (const pkg of ADDON_RUNTIME) {
    const src = path.join(repoRoot, "node_modules", pkg);
    const dest = path.join(dataRoot, "node_modules", pkg);
    if (fs.existsSync(dest) || !fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true, dereference: true });
    created.push(`node_modules/${pkg}`);
  }

  // El perfil se crea vacío: el del desarrollador no se distribuye.
  const usersDir = path.join(dataRoot, "users");
  fs.mkdirSync(usersDir, { recursive: true });
  const profilePath = path.join(usersDir, "profile.json");
  if (!fs.existsSync(profilePath)) {
    fs.writeFileSync(profilePath, JSON.stringify(DEFAULT_PROFILE, null, 2), "utf-8");
    created.push("users/profile.json");
  }

  const envPath = path.join(dataRoot, ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, DEFAULT_ENV, "utf-8");
    created.push(".env");
  }

  if (created.length) {
    onProgress("Preparando los datos del usuario…");
    console.log(`[desktop] sembrado en ${dataRoot}: ${created.join(", ")}`);
  }

  // Ambos pasos son idempotentes, así que se corren siempre: además del primer
  // arranque cubren las actualizaciones de esquema y los agentes nuevos.
  onProgress("Actualizando la base de datos…");
  await runDbScript("migrate", { repoRoot, dataRoot, isPackaged });
  await runDbScript("seed-agent-configs", { repoRoot, dataRoot, isPackaged });

  return { dataRoot, created };
}

module.exports = { ensureDataDir, runDbScript };
