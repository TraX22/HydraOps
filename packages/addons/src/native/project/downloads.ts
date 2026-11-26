import path from "node:path";
import { open, stat } from "node:fs/promises";

// What a project command is likely to bring from the internet, for its approval card.
//
// A command that installs dependencies does not say so: `cmake --build` on a project with a
// vcpkg.json downloads and compiles libraries, and the user who approves it sees only
// "cmake". Nothing here blocks or changes a command; it names the package tools the command
// is known to reach the network through, so the card can say it before the approval. Any
// command may download something this does not recognize: the card's own note says that
// too. It errs on the side of naming a tool (a `cargo build` with everything cached is
// still named), never on the side of silence for the ones it knows.

interface Rule {
  /** What the card names. */
  label: string;
  /** The words after the program that make it a download; absent = any use of it. */
  when?: RegExp;
}

// By program name (lower case, without its folder or .exe / .cmd / .bat / .ps1).
const RULES: Record<string, Rule> = {
  npm: { label: "npm", when: /^(install|i|ci|add|update|up|upgrade|exec|create|init)\b/ },
  pnpm: { label: "pnpm", when: /^(install|i|add|update|up|upgrade|dlx|create|fetch|import)\b/ },
  yarn: { label: "Yarn", when: /^($|install\b|add\b|up\b|upgrade\b|dlx\b|create\b)/ },
  bun: { label: "Bun", when: /^(install|i|add|update|x|create)\b/ },
  npx: { label: "npx" }, pnpx: { label: "pnpm" }, bunx: { label: "Bun" },
  pip: { label: "pip", when: /^(install|download)\b/ }, pip3: { label: "pip", when: /^(install|download)\b/ },
  python: { label: "pip", when: /^-m\s+pip\s+(install|download)\b/ }, python3: { label: "pip", when: /^-m\s+pip\s+(install|download)\b/ }, py: { label: "pip", when: /^(-\S+\s+)*-m\s+pip\s+(install|download)\b/ },
  pipx: { label: "pipx", when: /^(install|run|upgrade)\b/ },
  uv: { label: "uv", when: /^(pip\s+install|sync|add|lock|tool\s+install|run|venv)\b/ },
  poetry: { label: "Poetry", when: /^(install|add|update|lock)\b/ },
  conda: { label: "Conda", when: /^(install|create|update|env)\b/ }, mamba: { label: "Conda", when: /^(install|create|update|env)\b/ },
  cargo: { label: "Cargo", when: /^(build|b|run|r|test|t|check|c|install|fetch|update|add|bench|doc|clippy)\b/ },
  go: { label: "Go modules", when: /^(get|install|build|run|test|generate|vet|mod\s+(download|tidy|vendor))\b/ },
  dotnet: { label: "NuGet", when: /^(restore|build|run|test|publish|add|new|tool\s+(install|update|restore)|workload)\b/ },
  nuget: { label: "NuGet", when: /^(install|restore|update)\b/ },
  msbuild: { label: "NuGet", when: /[-/](restore|t:restore)\b/i },
  mvn: { label: "Maven" }, mvnw: { label: "Maven" }, gradle: { label: "Gradle" }, gradlew: { label: "Gradle" },
  composer: { label: "Composer", when: /^(install|update|require|create-project)\b/ },
  bundle: { label: "Bundler", when: /^($|install\b|update\b|add\b)/ }, gem: { label: "RubyGems", when: /^(install|update)\b/ },
  vcpkg: { label: "vcpkg" }, conan: { label: "Conan", when: /^(install|create|build)\b/ },
  apt: { label: "apt", when: /^(-\S+\s+)*(install|update|upgrade|full-upgrade|dist-upgrade)\b/ }, "apt-get": { label: "apt", when: /^(-\S+\s+)*(install|update|upgrade|dist-upgrade)\b/ },
  dnf: { label: "dnf", when: /^(-\S+\s+)*(install|update|upgrade)\b/ }, yum: { label: "yum", when: /^(-\S+\s+)*(install|update|upgrade)\b/ },
  pacman: { label: "pacman", when: /^-S/ }, zypper: { label: "zypper", when: /^(-\S+\s+)*(install|in|update|up)\b/ }, apk: { label: "apk", when: /^(add|update|upgrade)\b/ },
  brew: { label: "Homebrew", when: /^(install|upgrade|bundle|tap)\b/ },
  winget: { label: "winget", when: /^(install|upgrade|import|add)\b/ }, choco: { label: "Chocolatey", when: /^(install|upgrade)\b/ }, scoop: { label: "Scoop", when: /^(install|update)\b/ },
  curl: { label: "curl" }, wget: { label: "wget" },
  "invoke-webrequest": { label: "Invoke-WebRequest" }, iwr: { label: "Invoke-WebRequest" }, "invoke-restmethod": { label: "Invoke-RestMethod" }, irm: { label: "Invoke-RestMethod" }, "start-bitstransfer": { label: "BITS" },
  git: { label: "Git", when: /^(-\S+\s+\S+\s+)*(clone|pull|fetch|submodule\s+(update|add))\b/ },
  gh: { label: "GitHub CLI", when: /^(repo\s+clone|release\s+download|run\s+download)\b/ },
  docker: { label: "Docker", when: /^(pull|build|run|compose|buildx)\b/ }, podman: { label: "Podman", when: /^(pull|build|run|compose)\b/ },
  "docker-compose": { label: "Docker", when: /^(up|pull|build|run)\b/ },
};

// Programs that only run another one: the rule is looked up for what follows them.
const WRAPPERS = new Set(["sudo", "time", "nice", "env", "command", "exec", "call", "start"]);
const MAX_COMMAND = 20_000;

/** The command cut where the shell would: `;`, `&&`, `||`, `|`, `&`, new lines, and what a quoted `-c "..."` carries. */
function segments(command: string): string[] {
  const out: string[] = [];
  let cur = "", quote = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      // Inside quotes the separators still split: `bash -c "a && b"` is two commands to look at.
      if (ch === quote) { quote = ""; cur += " "; continue; }
      if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") { push(); continue; }
      cur += ch; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += " "; continue; }
    if (ch === ";" || ch === "\n" || ch === "\r" || ch === "|" || ch === "&" || ch === "(" || ch === ")" || ch === "{" || ch === "}" || ch === "`") { push(); continue; }
    cur += ch;
  }
  push();
  return out;
}

/** The program a segment runs and the words after it, past variables set in front and wrappers. */
function programOf(segment: string): { name: string; rest: string } | null {
  let words = segment.split(/\s+/).filter(Boolean);
  for (let guard = 0; guard < 8 && words.length; guard++) {
    const w = words[0];
    // NAME=value in front, `export NAME=value`, PowerShell's $env:NAME=value.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || /^\$env:/i.test(w)) { words = words.slice(1); continue; }
    if (w === "export" || w === "set" || w === "setx") return null;
    const base = baseName(w);
    if (WRAPPERS.has(base)) { words = words.slice(1); continue; }
    // A shell asked to run a string: what it runs is in the next segments (see segments()).
    if ((base === "bash" || base === "sh" || base === "zsh" || base === "cmd" || base === "powershell" || base === "pwsh") && words.length > 1) { words = words.slice(1).filter((x) => !/^[-/]/.test(x)); continue; }
    return { name: base, rest: words.slice(1).join(" ") };
  }
  return null;
}

function baseName(word: string): string {
  const cut = Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\"));
  return word.slice(cut + 1).toLowerCase().replace(/\.(exe|cmd|bat|ps1|sh)$/, "");
}

/** The package tools a command reaches the network through, by its own words. */
export function commandFetches(commandRaw: unknown): string[] {
  const command = String(commandRaw ?? "").slice(0, MAX_COMMAND);
  const found = new Set<string>();
  for (const seg of segments(command)) {
    const p = programOf(seg);
    if (!p) continue;
    const rule = RULES[p.name];
    if (rule && (!rule.when || rule.when.test(p.rest.toLowerCase()))) found.add(rule.label);
  }
  return [...found];
}

const exists = async (p: string) => (await stat(p).catch(() => null))?.isFile() === true;

/** True when the file's start mentions something CMake downloads at configure or build time. */
async function cmakeDownloads(file: string): Promise<boolean> {
  const fh = await open(file, "r").catch(() => null);
  if (!fh) return false;
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(200_000), 0, 200_000, 0);
    return /\b(FetchContent_Declare|FetchContent_Populate|ExternalProject_Add|CPMAddPackage)\b|\bfile\s*\(\s*DOWNLOAD\b/i.test(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await fh.close().catch(() => {}); }
}

/**
 * What a build command brings in because of what the project declares, not what the command
 * says: `cmake` on a project with a vcpkg manifest, a Conan file or a CMakeLists that
 * downloads. `dirs`: the folder the command runs in and the top of its working copy.
 */
export async function folderFetches(commandRaw: unknown, dirs: string[]): Promise<string[]> {
  const command = String(commandRaw ?? "").slice(0, MAX_COMMAND);
  if (!segments(command).some((s) => programOf(s)?.name === "cmake")) return [];
  const found = new Set<string>();
  for (const dir of [...new Set(dirs.filter(Boolean))].slice(0, 4)) {
    if (await exists(path.join(dir, "vcpkg.json"))) found.add("vcpkg (CMake)");
    if (await exists(path.join(dir, "conanfile.txt")) || await exists(path.join(dir, "conanfile.py"))) found.add("Conan (CMake)");
    if (await cmakeDownloads(path.join(dir, "CMakeLists.txt"))) found.add("CMake FetchContent");
  }
  return [...found];
}

/** Both: what the card names when a command is likely to download and install things. */
export async function commandDownloads(command: unknown, dirs: string[] = []): Promise<string[]> {
  const byWords = commandFetches(command);
  const byFolder = await folderFetches(command, dirs).catch(() => [] as string[]);
  return [...new Set([...byWords, ...byFolder])].slice(0, 6);
}
