/**
 * Skills: step-by-step know-how an agent reads when a task calls for it.
 *
 * A skill is a folder with a SKILL.md (the open Agent Skills format: YAML frontmatter
 * with name + description, then Markdown instructions) and optional reference files.
 * They live in `skillsDir` and are global; an agent uses them only when its tools.md
 * grants `skills`, and writes new ones only with `create_skill` (always held for the
 * user's approval, see provenance.ts).
 *
 * Progressive disclosure: the system prompt carries only each skill's name and
 * description (skillsPromptSection); the agent opens the full text with skills_view
 * when a request matches, and a reference file only when the skill points to it.
 * That keeps the prompt small for local models.
 *
 * Installed skills are trusted instructions (the user installed or approved them), so
 * what skills_view returns is NOT wrapped as external content. The trust decision is
 * made before a skill lands here: the Skills panel shows it and scanSkill's findings
 * before installing, and a skill an agent writes waits for the user's approval.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { builtinSkillsDir, skillsDir } from '@hydraops/config';
import { redactSecrets } from './guard.js';

export const SKILL_FILE = 'SKILL.md';
/** Where HydraOps records how a skill got here (catalog / agent). Hidden from listings. */
export const SKILL_SIDECAR = '.hydraops.json';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isValidSkillName = (name: unknown): name is string => typeof name === 'string' && NAME_RE.test(name);

export const SKILL_LIMITS = {
  maxFiles: 40,
  maxFileBytes: 128 * 1024,
  maxTotalBytes: 512 * 1024,
  /** Skills listed in the system prompt; past this the list is cut (and says so). */
  maxInPrompt: 60,
  maxDescriptionInPrompt: 300,
  /** What skills_view hands back at most. */
  maxViewChars: 40_000,
};

/** Text files only. Script files may travel with a skill, but HydraOps never runs them. */
const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.csv']);
const SCRIPT_EXTENSIONS = new Set(['.py', '.js', '.mjs', '.ts', '.sh', '.ps1', '.bat', '.cmd', '.rb']);

export interface SkillMeta {
  name: string;
  description: string;
  author: string;
  version: string;
  /** HydraOps tools the skill relies on (metadata.tools), shown as requirements. */
  tools: string[];
}

export interface InstalledSkill extends SkillMeta {
  /** catalog = downloaded from the skills repository; agent = written by an agent and
   *  approved; manual = copied into the folder by hand; builtin = ships with the app
   *  (read-only, cannot be deleted or shadowed). */
  source: 'catalog' | 'agent' | 'manual' | 'builtin';
  agentId?: string;
  installedAt?: string;
  files: string[];
  hasScripts: boolean;
  /** SKILL.md unreadable or without name/description: listed so the user can remove it. */
  invalid?: string;
}

export interface SkillFile { path: string; content: string }

// ── SKILL.md frontmatter ───────────────────────────────────────────────────────

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
};

function parseScalar(v: string): string | string[] {
  const t = v.trim();
  if (t.startsWith('[') && t.endsWith(']')) {
    return t.slice(1, -1).split(',').map(unquote).map((s) => s.trim()).filter(Boolean);
  }
  return unquote(t);
}

/** `key: value` → [key, value] without a regex (a backtracking one is slow on crafted lines). */
function splitKeyValue(line: string): [string, string] | null {
  const colon = line.indexOf(':');
  if (colon <= 0) return null;
  const key = line.slice(0, colon);
  if (!/^[\w-]+$/.test(key)) return null;
  return [key, line.slice(colon + 1).trim()];
}

/**
 * The subset of YAML that skill frontmatter uses: `key: value`, quoted strings, inline
 * lists, folded/literal blocks (`>` / `|`), `- item` lists and one level of nesting
 * (`metadata:`). Anything fancier is ignored rather than guessed.
 */
export function parseFrontmatter(text: string): { data: Record<string, any>; body: string } {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const lines = m[1].split(/\r?\n/);
  const data: Record<string, any> = {};
  const indentOf = (l: string) => l.length - l.trimStart().length;

  const readBlock = (start: number, parentIndent: number): { value: any; next: number } => {
    // Collects the indented lines under a key: a nested map, a list or a text block.
    const block: string[] = [];
    let i = start;
    while (i < lines.length && (lines[i].trim() === '' || indentOf(lines[i]) > parentIndent)) block.push(lines[i++]);
    const nonEmpty = block.filter((l) => l.trim());
    if (!nonEmpty.length) return { value: '', next: i };
    if (nonEmpty.every((l) => l.trim().startsWith('- '))) {
      return { value: nonEmpty.map((l) => unquote(l.trim().slice(2))), next: i };
    }
    const inner = Math.min(...nonEmpty.map(indentOf));
    if (nonEmpty.filter((l) => indentOf(l) === inner).every((l) => /^[\w-]+:/.test(l.trim()))) {
      const map: Record<string, any> = {};
      for (let j = 0; j < block.length; j++) {
        const l = block[j];
        if (!l.trim() || indentOf(l) !== inner) continue;
        const kv = splitKeyValue(l.trim());
        if (!kv) continue;
        if (kv[1] === '') {
          const items: string[] = [];
          while (j + 1 < block.length && indentOf(block[j + 1]) > inner && block[j + 1].trim().startsWith('- ')) items.push(unquote(block[++j].trim().slice(2)));
          map[kv[0]] = items;
        } else {
          map[kv[0]] = parseScalar(kv[1]);
        }
      }
      return { value: map, next: i };
    }
    return { value: nonEmpty.map((l) => l.trim()).join(' '), next: i };
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    const kv = indentOf(line) === 0 ? splitKeyValue(line) : null;
    if (!kv) { i++; continue; }
    const [key, raw] = kv;
    if (raw === '' || raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const { value, next } = readBlock(i + 1, 0);
      data[key] = value;
      i = next;
    } else {
      data[key] = parseScalar(raw);
      i++;
    }
  }
  return { data, body: m[2] };
}

export function skillMetaFrom(data: Record<string, any>, fallbackName: string): SkillMeta {
  const meta = (data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)) ? data.metadata : {};
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? [v] : []);
  return {
    name: str(data.name) || fallbackName,
    description: str(data.description),
    author: str(meta.author) || str(data.author),
    version: str(meta.version) || str(data.version),
    tools: list(meta.tools ?? data.tools),
  };
}

// ── Paths ──────────────────────────────────────────────────────────────────────

/** Resolves a file inside a skill folder, or null if the path leaves it or is not allowed. */
export function skillFilePath(name: string, relPath: string, root = skillsDir): string | null {
  if (!isValidSkillName(name)) return null;
  const rel = String(relPath ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel || rel.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'))) return null;
  const base = path.resolve(root, name);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

const extOf = (p: string) => path.extname(p).toLowerCase();
export const isScriptPath = (p: string) => SCRIPT_EXTENSIONS.has(extOf(p));
export const isAllowedSkillPath = (p: string) => TEXT_EXTENSIONS.has(extOf(p)) || isScriptPath(p);

async function listFilesRec(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...await listFilesRec(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
    if (out.length > SKILL_LIMITS.maxFiles * 2) break;
  }
  return out.sort();
}

// ── Reading installed skills ─────────────────────────────────────────────────

async function readInstalled(name: string, root: string, builtin = false): Promise<InstalledSkill> {
  const dir = path.join(root, name);
  const files = await listFilesRec(dir);
  let sidecar: any = {};
  if (!builtin) {
    try { sidecar = JSON.parse(await readFile(path.join(dir, SKILL_SIDECAR), 'utf-8')); } catch { /* manual copy */ }
  }
  const source: InstalledSkill['source'] = builtin ? 'builtin' : sidecar.source === 'catalog' || sidecar.source === 'agent' ? sidecar.source : 'manual';
  const base = {
    source,
    ...(typeof sidecar.agentId === 'string' ? { agentId: sidecar.agentId } : {}),
    ...(typeof sidecar.installedAt === 'string' ? { installedAt: sidecar.installedAt } : {}),
    files,
    hasScripts: files.some(isScriptPath),
  };
  try {
    const text = await readFile(path.join(dir, SKILL_FILE), 'utf-8');
    const meta = skillMetaFrom(parseFrontmatter(text).data, name);
    const invalid = !meta.description ? 'SKILL.md has no description' : meta.name !== name ? `SKILL.md says its name is "${meta.name}"` : undefined;
    return { ...meta, name, ...base, ...(invalid ? { invalid } : {}) };
  } catch {
    return { name, description: '', author: '', version: '', tools: [], ...base, invalid: 'no SKILL.md' };
  }
}

async function skillFolderNames(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && isValidSkillName(e.name)).map((e) => e.name).sort();
}

/** Names of the skills that ship with the app: reserved, never written or deleted. */
export async function builtinSkillNames(builtinRoot = builtinSkillsDir): Promise<string[]> {
  return skillFolderNames(builtinRoot);
}

/**
 * Every skill: the built-in ones plus the user's folder, sorted by name (a stable order
 * keeps local-model prompt caches warm). A user folder with a built-in's name is ignored.
 */
export async function listInstalledSkills(root = skillsDir, builtinRoot = builtinSkillsDir): Promise<InstalledSkill[]> {
  const builtin = await skillFolderNames(builtinRoot);
  const user = (await skillFolderNames(root)).filter((n) => !builtin.includes(n));
  const all = await Promise.all([
    ...builtin.map((n) => readInstalled(n, builtinRoot, true)),
    ...user.map((n) => readInstalled(n, root)),
  ]);
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function skillExists(name: string, root = skillsDir, builtinRoot = builtinSkillsDir): Promise<boolean> {
  if (!isValidSkillName(name)) return false;
  const isDir = (dir: string) => stat(path.join(dir, name)).then((s) => s.isDirectory()).catch(() => false);
  return (await isDir(builtinRoot)) || (await isDir(root));
}

/** One file of an installed skill as text (SKILL.md by default), or an error message. */
export async function readSkillFile(name: string, relPath = SKILL_FILE, root = skillsDir, builtinRoot = builtinSkillsDir): Promise<{ ok: true; content: string } | { ok: false; error: string }> {
  if ((await builtinSkillNames(builtinRoot)).includes(name)) root = builtinRoot;
  const full = skillFilePath(name, relPath, root);
  if (!full) return { ok: false, error: 'invalid skill name or file path' };
  try {
    const s = await stat(full);
    if (!s.isFile()) return { ok: false, error: 'not a file' };
    if (s.size > SKILL_LIMITS.maxFileBytes) return { ok: false, error: 'file too large' };
    return { ok: true, content: await readFile(full, 'utf-8') };
  } catch {
    return { ok: false, error: 'not found' };
  }
}

// ── Safety scan ────────────────────────────────────────────────────────────────

export interface SkillFinding {
  /** high = the user should read this before installing; info = worth knowing. */
  severity: 'high' | 'info';
  code: 'override' | 'secret' | 'credentials_path' | 'remote_exec' | 'hidden_text' | 'encoded_blob' | 'scripts' | 'links';
  file: string;
  detail: string;
}

const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|guidelines?)/i,
  /\byou are now\b[^.\n]{0,60}\b(unrestricted|jailbroken|DAN|no longer)/i,
  /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|inform|show|mention)\b[^.\n]{0,20}\b(the )?user\b/i,
  /\bwithout (asking|telling|notifying) the user\b/i,
];
const CREDENTIAL_PATHS = /(\.ssh[\\/]|id_rsa|id_ed25519|keys\.json|\.aws[\\/]credentials|\.npmrc|\.git-credentials|%APPDATA%[\\/]hydraops|[\\/]\.env\b|wallet\.dat|Login Data|cookies\.sqlite)/i;
const REMOTE_EXEC = /(curl|wget|iwr|Invoke-WebRequest|Invoke-Expression|iex)\b[^\n]{0,120}(\|\s*(ba|z)?sh\b|\|\s*iex\b|\|\s*python)|powershell[^\n]{0,40}-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{20,}|base64\s+(-d|--decode)/i;
const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]/u;
const BASE64_BLOB = /[A-Za-z0-9+/]{240,}={0,2}/;
const URL_RE = /https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi;

/**
 * Heuristics shown to the user before a skill is installed: phrases that try to take
 * over the agent, credential paths, "download and run", hidden text, secrets. Findings
 * inform the decision; they are not proof either way (a skill about security may
 * legitimately mention ~/.ssh).
 */
export function scanSkill(files: SkillFile[]): SkillFinding[] {
  const out: SkillFinding[] = [];
  const domains = new Set<string>();
  for (const f of files) {
    const text = f.content;
    const add = (severity: SkillFinding['severity'], code: SkillFinding['code'], detail: string) => {
      if (out.length < 50 && !out.some((o) => o.code === code && o.file === f.path)) out.push({ severity, code, file: f.path, detail: detail.slice(0, 160) });
    };
    for (const re of OVERRIDE_PATTERNS) { const m = re.exec(text); if (m) { add('high', 'override', m[0]); break; } }
    if (redactSecrets(text) !== text) add('high', 'secret', 'looks like an API key or token');
    { const m = CREDENTIAL_PATHS.exec(text); if (m) add('high', 'credentials_path', m[0]); }
    { const m = REMOTE_EXEC.exec(text); if (m) add('high', 'remote_exec', m[0]); }
    if (HIDDEN_CHARS.test(text)) add('high', 'hidden_text', 'invisible or direction-changing characters');
    {
      // An HTML comment is invisible once rendered. indexOf, not a regex: see splitKeyValue.
      const open = text.indexOf('<!--');
      const close = open >= 0 ? text.indexOf('-->', open + 4) : -1;
      if (close > open + 8) add('info', 'hidden_text', text.slice(open, close + 3));
    }
    if (BASE64_BLOB.test(text)) add('high', 'encoded_blob', 'long encoded block');
    if (isScriptPath(f.path)) add('info', 'scripts', f.path);
    for (const m of text.matchAll(URL_RE)) domains.add(m[1].toLowerCase());
  }
  if (domains.size) out.push({ severity: 'info', code: 'links', file: '', detail: [...domains].slice(0, 12).join(', ') });
  return out;
}

// ── Validation and writing ───────────────────────────────────────────────────

/** Checks a skill's files before they are written; returns the problem or null. */
export function validateSkillFiles(name: string, files: SkillFile[]): string | null {
  if (!isValidSkillName(name)) return 'invalid name: use lowercase letters, digits and hyphens (max 64)';
  if (!files.some((f) => f.path === SKILL_FILE)) return 'missing SKILL.md';
  if (files.length > SKILL_LIMITS.maxFiles) return `too many files (max ${SKILL_LIMITS.maxFiles})`;
  let total = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (!skillFilePath(name, f.path)) return `invalid file path: ${f.path}`;
    if (!isAllowedSkillPath(f.path)) return `file type not allowed: ${f.path}`;
    if (seen.has(f.path.toLowerCase())) return `duplicate file: ${f.path}`;
    seen.add(f.path.toLowerCase());
    const bytes = Buffer.byteLength(f.content, 'utf-8');
    if (bytes > SKILL_LIMITS.maxFileBytes) return `file too large: ${f.path}`;
    total += bytes;
  }
  if (total > SKILL_LIMITS.maxTotalBytes) return 'skill too large';
  const meta = skillMetaFrom(parseFrontmatter(files.find((f) => f.path === SKILL_FILE)!.content).data, name);
  if (meta.name !== name) return `SKILL.md name "${meta.name}" does not match "${name}"`;
  if (!meta.description) return 'SKILL.md has no description';
  return null;
}

/**
 * Writes a skill folder atomically: into a hidden temp folder first, then renamed into
 * place, so a half-written skill is never listed. `replace` swaps an existing folder
 * (a catalog update); without it an existing skill is never touched.
 */
export async function writeSkillFolder(
  name: string,
  files: SkillFile[],
  sidecar: Record<string, unknown>,
  opts: { replace?: boolean; root?: string; builtinRoot?: string } = {},
): Promise<void> {
  const root = opts.root ?? skillsDir;
  const problem = validateSkillFiles(name, files);
  if (problem) throw new Error(problem);
  if ((await builtinSkillNames(opts.builtinRoot)).includes(name)) throw new Error(`"${name}" is a skill that ships with HydraOps`);
  await mkdir(root, { recursive: true });
  const final = path.join(root, name);
  const exists = await stat(final).then(() => true).catch(() => false);
  if (exists && !opts.replace) throw new Error(`a skill named "${name}" already exists`);
  const tmp = path.join(root, `.tmp-${name}-${randomBytes(4).toString('hex')}`);
  try {
    for (const f of files) {
      const full = path.join(tmp, path.relative(final, skillFilePath(name, f.path, root)!));
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content, 'utf-8');
    }
    await writeFile(path.join(tmp, SKILL_SIDECAR), JSON.stringify({ ...sidecar, installedAt: new Date().toISOString() }, null, 2), 'utf-8');
    if (exists) {
      const old = path.join(root, `.old-${name}-${randomBytes(4).toString('hex')}`);
      await rename(final, old);
      await rename(tmp, final);
      await rm(old, { recursive: true, force: true });
    } else {
      await rename(tmp, final);
    }
  } catch (err) {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** Deletes a skill from the user's folder. Built-in skills are never deleted. */
export async function deleteSkill(name: string, root = skillsDir, builtinRoot = builtinSkillsDir): Promise<boolean> {
  if (!isValidSkillName(name) || (await builtinSkillNames(builtinRoot)).includes(name)) return false;
  if (!(await stat(path.join(root, name)).then((s) => s.isDirectory()).catch(() => false))) return false;
  await rm(path.join(root, name), { recursive: true, force: true });
  return true;
}

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf-8').digest('hex');

// ── System prompt ─────────────────────────────────────────────────────────────

/** The skill every agent allowed to create skills follows; it ships with the app. */
export const SKILL_CREATOR = 'skill-creator';

/** skill-creator's instructions and its template, for the prompt of an agent that may create skills. */
async function creatorGuide(builtinRoot: string): Promise<string> {
  const main = await readSkillFile(SKILL_CREATOR, SKILL_FILE, builtinRoot, builtinRoot);
  if (!main.ok) return '';
  let guide = parseFrontmatter(main.content).body.trim();
  const template = await readSkillFile(SKILL_CREATOR, 'templates/SKILL.template.md', builtinRoot, builtinRoot);
  if (template.ok) guide += `\n\n### templates/SKILL.template.md\n\n${template.content.trim()}`;
  return guide;
}

/**
 * The block appended to an agent's system prompt when it may use or create skills: one
 * line per installed skill for `skills`, and the skill-creator guide itself for
 * `create_skill` (so an agent that creates always knows the format, even without
 * `skills`). Empty for other agents, so their prompts (and KV caches) do not change.
 */
export async function skillsPromptSection(allowedTools: string[], root = skillsDir, builtinRoot = builtinSkillsDir): Promise<string> {
  const canView = allowedTools.includes('skills_view');
  const canCreate = allowedTools.includes('create_skill');
  if (!canView && !canCreate) return '';
  // skill-creator is about writing skills: it reaches creators inline, never the list.
  const skills = canView ? (await listInstalledSkills(root, builtinRoot)).filter((s) => !s.invalid && s.name !== SKILL_CREATOR) : [];
  const lines: string[] = ['', '---', '[SKILLS]'];
  if (canView) {
    if (skills.length) {
      lines.push('Installed skills: tested procedures for specific kinds of work. When a request matches one, call skills_view with its name BEFORE you start and follow it; open its other files only when it points you to them. Mention which skill you used.');
      const clip = (s: string) => (s.length > SKILL_LIMITS.maxDescriptionInPrompt ? s.slice(0, SKILL_LIMITS.maxDescriptionInPrompt) + '…' : s);
      for (const s of skills.slice(0, SKILL_LIMITS.maxInPrompt)) lines.push(`- ${s.name}: ${clip(s.description.replace(/\s+/g, ' '))}`);
      if (skills.length > SKILL_LIMITS.maxInPrompt) lines.push(`- (${skills.length - SKILL_LIMITS.maxInPrompt} more not listed)`);
    } else {
      lines.push('No skills are installed yet.');
    }
  }
  if (canCreate) {
    lines.push(
      'You may propose a new skill with create_skill when you have worked out a repeatable procedure worth reusing (not one-off facts: those go to memory). ' +
      'Every new skill waits for the user\'s approval, and existing skills cannot be changed. Follow this guide when you write one:',
    );
    const guide = await creatorGuide(builtinRoot);
    if (guide) lines.push('', '[SKILL-CREATOR GUIDE]', guide, '[END SKILL-CREATOR GUIDE]');
  }
  return lines.join('\n');
}
