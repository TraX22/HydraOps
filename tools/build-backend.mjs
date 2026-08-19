/**
 * build-backend.mjs — construye el backend autocontenido que se embarca en el
 * instalador de escritorio.
 *
 * La idea: cada servicio se compila a un único .js con TODAS sus dependencias
 * JavaScript dentro. Solo quedan fuera los módulos nativos (better-sqlite3,
 * sharp), que no se pueden meter en un bundle porque cargan un .node desde
 * disco; esos se copian tal cual a un node_modules mínimo.
 *
 * Así se evita tener que desplegar el node_modules de pnpm, que en Windows
 * depende de enlaces simbólicos y de la tienda global.
 *
 * Salida:
 *   build/backend/
 *     apps/<servicio>/dist/index.js
 *     packages/db/dist/{migrate,seed-agent-configs}.js
 *     packages/db/drizzle/**            (migraciones, las lee el migrador)
 *     node_modules/**                   (nativos + lo que importan los add-ons)
 */
import { build } from "tsup";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(REPO, "build", "backend");

const SERVICES = [
  "api",
  "key-proxy",
  "orchestrator",
  "outbox-worker",
  "worker-coder",
  "worker-general",
  "worker-graphic",
  "worker-video",
  "telegram-bot",
];

/**
 * Módulos que NO se pueden meter en el bundle porque cargan binarios .node.
 * Se copian enteros al node_modules de salida.
 */
const NATIVE = ["better-sqlite3", "sharp"];

/** Cualquier módulo que NO sea uno de los nativos (ni un subcamino suyo). */
const NOT_NATIVE = new RegExp(`^(?!(${NATIVE.join("|")})($|/))`);

/**
 * Paquetes que los add-ons del usuario importan en tiempo de ejecución.
 *
 * Los add-ons de my_addons no se compilan con nadie: son archivos sueltos que
 * el cargador importa en caliente desde el directorio de datos, así que sus
 * imports se resuelven desde ahí. En desarrollo funcionan porque my_addons está
 * dentro del repositorio; instalado, la carpeta está sola y hay que dejarles un
 * node_modules al lado (lo siembra data-dir.js).
 */
const ADDON_RUNTIME = ["zod"];

function log(msg) {
  console.log(`[build-backend] ${msg}`);
}

/**
 * Dónde buscar los paquetes nativos. pnpm crea un node_modules por paquete del
 * workspace con enlaces a la tienda, así que hay que mirar en varios sitios.
 */
const RESOLVE_BASES = [
  path.join(REPO, "packages", "db"),
  path.join(REPO, "apps", "api"),
  path.join(REPO, "packages", "llm"),
  REPO,
];

/**
 * Localiza el directorio de un paquete mirando el disco.
 *
 * No sirve require.resolve: sharp y otros declaran un mapa "exports" que no
 * expone ./package.json, así que la resolución estándar falla.
 */
function findPackageDir(name, extraBases = []) {
  for (const base of [...extraBases, ...RESOLVE_BASES]) {
    const candidate = path.join(base, "node_modules", ...name.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) {
      return fs.realpathSync(candidate); // pnpm enlaza a la tienda
    }
  }
  return null;
}

/**
 * Base desde la que buscar los hermanos de un paquete ya resuelto. En la tienda
 * de pnpm las dependencias de X viven en .pnpm/X@version/node_modules/, junto
 * al propio X, así que hay que subir tantos niveles como tenga el nombre
 * (uno normal, dos si lleva ámbito) y luego uno más para salir de node_modules.
 */
function siblingBase(pkgDir, name) {
  let dir = pkgDir;
  for (let i = 0; i <= name.split("/").length; i++) dir = path.dirname(dir);
  return dir;
}

/** Nombres de variantes de sharp para otras plataformas: no hacen falta aquí. */
const FOREIGN_PLATFORM = /^@img\/sharp-(?!win32-x64)/;

/** Copia un paquete y todo lo que arrastre (incluidas las opcionales). */
function copyPackage(name, seen = new Set(), extraBases = []) {
  if (seen.has(name)) return;
  seen.add(name);

  const src = findPackageDir(name, extraBases);
  if (!src) {
    if (!FOREIGN_PLATFORM.test(name)) log(`aviso: no encuentro ${name}, lo salto`);
    return;
  }

  const dest = path.join(OUT, "node_modules", ...name.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  log(`módulo: ${name}`);

  // Las opcionales importan: los binarios de sharp por plataforma viven ahí.
  const meta = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf-8"));
  const bases = [siblingBase(src, name), ...extraBases];
  for (const dep of [
    ...Object.keys(meta.dependencies ?? {}),
    ...Object.keys(meta.optionalDependencies ?? {}),
  ]) {
    if (FOREIGN_PLATFORM.test(dep)) continue;
    copyPackage(dep, seen, bases);
  }
}

/**
 * tsup interpreta las entradas como globs, y en Windows la barra invertida es
 * el carácter de escape: hay que pasarle rutas relativas con barras normales.
 */
const posix = (abs) => path.relative(REPO, abs).split(path.sep).join("/");

async function bundle(entryAbs, outDirAbs, label) {
  await build({
    entry: [posix(entryAbs)],
    outDir: posix(outDirAbs),
    format: "esm",
    platform: "node",
    target: "node20",
    bundle: true,
    // Todo dentro salvo los nativos. Ojo: en tsup `noExternal` gana a
    // `external`, así que un /.*/ se tragaría también los nativos; hay que
    // excluirlos en el propio patrón.
    noExternal: [NOT_NATIVE],
    external: NATIVE,
    splitting: false,
    treeshake: true,
    silent: true,
    clean: false,
    skipNodeModulesBundle: false,
    // La salida es ESM pero arrastra dependencias CommonJS (dotenv, express…)
    // que llaman a require en tiempo de ejecución. En un módulo ESM no existe,
    // así que hay que fabricarlo. Y __dirname/__filename por lo mismo.
    banner: {
      js: [
        `import { createRequire as __hydraCreateRequire } from 'node:module';`,
        `import { fileURLToPath as __hydraFileURLToPath } from 'node:url';`,
        `import { dirname as __hydraDirname } from 'node:path';`,
        `const require = __hydraCreateRequire(import.meta.url);`,
        `const __filename = __hydraFileURLToPath(import.meta.url);`,
        `const __dirname = __hydraDirname(__filename);`,
      ].join("\n"),
    },
  });
  log(`bundle: ${label}`);
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const svc of SERVICES) {
    const entry = path.join(REPO, "apps", svc, "src", "index.ts");
    if (!fs.existsSync(entry)) {
      log(`aviso: ${svc} no tiene src/index.ts, lo salto`);
      continue;
    }
    await bundle(entry, path.join(OUT, "apps", svc, "dist"), svc);
  }

  // Los dos scripts de base de datos que ejecuta el shell en cada arranque.
  for (const script of ["migrate", "seed-agent-configs"]) {
    await bundle(
      path.join(REPO, "packages", "db", "src", `${script}.ts`),
      path.join(OUT, "packages", "db", "dist"),
      `db/${script}`,
    );
  }

  // Las migraciones son archivos .sql que el migrador lee en caliente.
  fs.cpSync(
    path.join(REPO, "packages", "db", "drizzle"),
    path.join(OUT, "packages", "db", "drizzle"),
    { recursive: true },
  );
  log("copiadas las migraciones de drizzle");

  // El manual de uso: la API lo sirve bajo /api/docs desde appRoot/docs.
  fs.cpSync(path.join(REPO, "docs"), path.join(OUT, "docs"), { recursive: true });
  log("copiado el manual (docs/)");

  // El oficio de los workers: leído por cada worker desde appRoot/craft.
  fs.cpSync(path.join(REPO, "craft"), path.join(OUT, "craft"), { recursive: true });
  log("copiado el oficio de los workers (craft/)");

  for (const name of [...NATIVE, ...ADDON_RUNTIME]) copyPackage(name);

  // Un package.json mínimo para que Node trate los bundles como ESM.
  fs.writeFileSync(
    path.join(OUT, "package.json"),
    JSON.stringify({ name: "hydraops-backend", private: true, type: "module" }, null, 2),
  );

  log(`listo en ${OUT}`);
}

main().catch((err) => {
  console.error("[build-backend] falló:", err);
  process.exit(1);
});
