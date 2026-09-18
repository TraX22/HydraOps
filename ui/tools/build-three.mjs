// Bundles Three.js (core + the addons the 3D plugin needs) into ONE minified
// ES module under public/vendor/three/, so the app ships it and works with
// no internet. Runs before `ng serve` / `ng build` (see package.json scripts).
// The output is not versioned in git: it is derived from node_modules.
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.resolve(here, "..");
const outDir = path.join(uiRoot, "public", "vendor", "three");
const outFile = path.join(outDir, "three.bundle.js");

// three's "exports" map hides package.json, so read it by path.
const version = JSON.parse(await readFile(path.join(uiRoot, "node_modules", "three", "package.json"), "utf8")).version;

await mkdir(outDir, { recursive: true });
await build({
  stdin: {
    contents: `
      export * from "three";
      export { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
      export { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
      export * as BufferGeometryUtils from "three/examples/jsm/utils/BufferGeometryUtils.js";
      export { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
      export { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
    `,
    resolveDir: uiRoot,
    loader: "js",
  },
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  legalComments: "inline",
  outfile: outFile,
  logLevel: "error",
});
await writeFile(path.join(outDir, "VERSION"), `three ${version}\n`);
const size = (await readFile(outFile)).length;
console.log(`[three] bundled three ${version} → public/vendor/three/three.bundle.js (${(size / 1024).toFixed(0)} kB)`);
