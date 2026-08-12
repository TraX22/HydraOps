import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ToolRegistry } from "./registry.js";
import { HydraTool } from "./types.js";

export async function loadDirectoryAddons(
  dirPath: string,
  source: "native" | "my_addons",
  registry: ToolRegistry,
) {
  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = join(dirPath, entry);
      const fileStat = await stat(entryPath);

      if (fileStat.isDirectory()) {
        // Look for index.ts or index.js
        const tsPath = join(entryPath, "index.ts");
        const jsPath = join(entryPath, "index.js");
        let moduleToImport: string | null = null;

        try {
          if ((await stat(tsPath)).isFile()) moduleToImport = tsPath;
        } catch {
          try {
            if ((await stat(jsPath)).isFile()) moduleToImport = jsPath;
          } catch {}
        }

        if (moduleToImport) {
          try {
            const module = await import(pathToFileURL(moduleToImport).href);

            // Search for exported tools matching HydraTool interface
            for (const key of Object.keys(module)) {
              const exported = module[key];
              if (
                exported &&
                typeof exported === "object" &&
                exported.name &&
                exported.description &&
                exported.execute &&
                exported.schema
              ) {
                const tool = exported as HydraTool;
                tool.source = source;
                registry.registerNative(tool);
                console.log(
                  `[Addons] Loaded tool '${tool.name}' from ${source}/${entry}`,
                );
              }
            }
          } catch (e) {
            console.error(
              `[Addons] Failed to load tool from ${moduleToImport}:`,
              e,
            );
          }
        }
      }
    }
  } catch (e) {
    console.warn(
      `[Addons] Directory ${dirPath} not found or unreadable, skipping...`,
    );
  }
}
