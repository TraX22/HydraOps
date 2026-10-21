// GitHub as a source of skills. Any public repository that keeps skills in the open Agent
// Skills format (a folder with a SKILL.md) can be read, shown and installed from here: a
// whole repository, one folder of it, or the SKILL.md itself. Nothing is redistributed by
// HydraOps: each user fetches the skill from its author's repository, under its own license,
// and the installed copy remembers where it came from (repository, ref, commit, folder) so
// it can be checked for a newer version and updated.
//
// Only github.com is read, through the public API (api.github.com) and the raw files
// (raw.githubusercontent.com), with every address built from the parsed owner, repository,
// ref and path: no address from the outside is ever fetched as it came. The public API allows
// 60 requests an hour without a token; a preview spends three of them (the repository, the
// commit, the tree), the files come from the raw host, which does not count, and what the
// API answered is remembered a while so reading and installing what was just previewed
// spends none.
import path from 'node:path';
import {
  SKILL_FILE, SKILL_LIMITS, isValidSkillName, isAllowedSkillPath, isScriptPath, isCodePath,
  parseFrontmatter, skillMetaFrom, type SkillFile, type SkillMeta,
} from './skills.js';

export interface GitHubRef {
  owner: string;
  repo: string;
  /** Branch, tag or commit as given; undefined = the repository's default branch. */
  ref?: string;
  /** Folder inside the repository, '' for the root. */
  path: string;
}

/** Where an installed skill came from, kept in its sidecar. */
export interface GitHubOrigin {
  /** owner/repo */
  repo: string;
  ref: string;
  commit: string;
  path: string;
}

export type GitHubFileStatus = 'text' | 'code' | 'script' | 'too-large' | 'not-allowed';

export interface GitHubSkillFile { path: string; size: number; status: GitHubFileStatus }

export interface GitHubSkillPreview extends SkillMeta {
  /** The folder in the repository (''= root). */
  path: string;
  /** The name the skill would be installed under: the folder's name; the frontmatter must agree. */
  folder: string;
  /** `license` from the frontmatter, when the author declared one there. */
  license: string;
  /** The frontmatter asks for a terminal (allowed-tools: Bash …): written for a CLI agent. */
  needsTerminal: boolean;
  files: GitHubSkillFile[];
  /** Bytes of the files that would be installed. */
  totalBytes: number;
  installable: boolean;
  /** Why it cannot be installed as it is. */
  reason?: string;
  /** The SKILL.md could not be read: name and description are the folder's. */
  unread?: boolean;
}

export interface GitHubRepoPreview {
  owner: string;
  repo: string;
  ref: string;
  commit: string;
  description: string;
  stars: number;
  /** SPDX id of the repository's license file, or null when it has none. */
  license: string | null;
  /** The folder the address pointed at ('' = the whole repository). */
  path: string;
  skills: GitHubSkillPreview[];
  /** SKILL.md files left out: copies for other agents under hidden folders, node_modules. */
  skipped: number;
  /** The tree was too large for GitHub to list whole; some skills may be missing. */
  truncated: boolean;
}

export interface GitHubSkillDetail {
  preview: GitHubSkillPreview;
  /** The SKILL.md as it is in the repository (cut at the view limit). */
  text: string;
  /** Every file that would be installed, with its content. */
  files: SkillFile[];
  /** Files in the folder that are left out, with the reason. */
  skipped: GitHubSkillFile[];
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API_HOST = 'https://api.github.com';
const RAW_HOST = 'https://raw.githubusercontent.com';
const TIMEOUT_MS = 15_000;
/** How many SKILL.md files a repository preview reads to fill in descriptions. */
export const PREVIEW_DESCRIPTIONS = 80;
/** Folders whose SKILL.md are copies for other agents or dependencies, not skills to offer. */
const SKIPPED_DIRS = new Set(['node_modules', 'vendor', 'dist', 'build']);
const NAME_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;

// ── The address ────────────────────────────────────────────────────────────────

/**
 * Reads a GitHub address: `https://github.com/owner/repo`, `…/tree/<ref>/<folder>`,
 * `…/blob/<ref>/<folder>/SKILL.md`, with or without the scheme or a trailing `.git`.
 * Anything else (another host, a user page, a gist) is null.
 */
export function parseGitHubSkillUrl(input: string): GitHubRef | null {
  let raw = String(input ?? '').trim();
  if (!raw) return null;
  if (!/^[a-z]+:\/\//i.test(raw)) raw = `https://${raw}`;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname.toLowerCase() !== 'github.com' && u.hostname.toLowerCase() !== 'www.github.com') return null;
  const parts = u.pathname.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } });
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!NAME_PART.test(owner) || !NAME_PART.test(repo) || owner.startsWith('.') || repo.startsWith('.')) return null;
  if (parts.length === 2) return { owner, repo, path: '' };
  const kind = parts[2];
  if (kind !== 'tree' && kind !== 'blob') return null;
  if (parts.length < 4) return null;
  const ref = parts[3];
  if (!NAME_PART.test(ref)) return null;
  let rest = parts.slice(4);
  if (kind === 'blob') {
    if (rest[rest.length - 1] !== SKILL_FILE) return null;
    rest = rest.slice(0, -1);
  }
  if (rest.some((seg) => seg === '..' || seg === '.' || !/^[^\\\x00-\x1f]{1,120}$/.test(seg))) return null;
  return { owner, repo, ref, path: rest.join('/') };
}

// ── Talking to GitHub ──────────────────────────────────────────────────────────

function enc(segments: string): string {
  return segments.split('/').map(encodeURIComponent).join('/');
}

async function apiJson(fetchImpl: FetchLike, rel: string): Promise<any> {
  const r = await fetchImpl(`${API_HOST}${rel}`, {
    headers: { 'User-Agent': 'HydraOps', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (r.status === 404) throw new GitHubError('not_found', 'GitHub has no such repository, ref or folder (or it is private).');
  if (r.status === 403 || r.status === 429) throw new GitHubError('rate_limited', 'GitHub is limiting requests from this computer for the moment (60 an hour without a token). Try again later.');
  if (!r.ok) throw new GitHubError('github_error', `GitHub answered ${r.status}.`);
  return r.json();
}

async function rawText(fetchImpl: FetchLike, ref: GitHubRef, commit: string, filePath: string, maxBytes: number): Promise<string | null> {
  const r = await fetchImpl(`${RAW_HOST}/${enc(ref.owner)}/${enc(ref.repo)}/${enc(commit)}/${enc(filePath)}`, {
    headers: { 'User-Agent': 'HydraOps' },
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!r?.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) return null;
  return buf.toString('utf-8');
}

export class GitHubError extends Error {
  constructor(public code: 'bad_url' | 'not_found' | 'rate_limited' | 'github_error' | 'no_skills' | 'too_large', message: string) {
    super(message);
  }
}

// ── A short memory of what the API answered ──
// Without a token GitHub allows 60 API requests an hour from one address, and one skill
// goes through the API several times on its way in: the preview, the full read behind
// "View", the install (which reads the folder again at the previewed commit). What was
// answered a moment ago is kept here, so those later steps spend nothing: a repository's
// facts and where a ref points for a few minutes (the preview shows the commit it read),
// a tree for longer, since a commit's tree never changes. The explicit update check asks
// GitHub again (`latestCommitOf`), so "is there a newer version?" is never answered from here.
const REMEMBER_REPO_MS = 10 * 60_000;
const REMEMBER_TREE_MS = 30 * 60_000;
const REMEMBER_MAX = 64;
const remembered = new Map<string, { until: number; value: Promise<unknown> }>();

async function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = remembered.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = load();
  remembered.set(key, { until: Date.now() + ttlMs, value });
  // A failed request is not kept: the next try asks GitHub again.
  value.catch(() => { if (remembered.get(key)?.value === value) remembered.delete(key); });
  while (remembered.size > REMEMBER_MAX) remembered.delete(remembered.keys().next().value!);
  return value;
}

/** Drops everything remembered (tests, or a user who wants GitHub asked again right now). */
export function forgetGitHubAnswers(): void {
  remembered.clear();
}

interface RepoInfo { description: string; stars: number; license: string | null; defaultBranch: string }

function repoInfo(fetchImpl: FetchLike, ref: GitHubRef): Promise<RepoInfo> {
  return remember(`repo:${ref.owner}/${ref.repo}`, REMEMBER_REPO_MS, async () => {
    const j = await apiJson(fetchImpl, `/repos/${enc(ref.owner)}/${enc(ref.repo)}`);
    return {
      description: typeof j?.description === 'string' ? j.description : '',
      stars: Number.isFinite(j?.stargazers_count) ? Number(j.stargazers_count) : 0,
      license: typeof j?.license?.spdx_id === 'string' && j.license.spdx_id !== 'NOASSERTION' ? j.license.spdx_id : null,
      defaultBranch: typeof j?.default_branch === 'string' ? j.default_branch : 'main',
    };
  });
}

/** The commit a branch, tag or commit id points at right now (`fresh`: asked again, not remembered). */
export function headCommit(fetchImpl: FetchLike, ref: GitHubRef, refName: string, fresh = false): Promise<string> {
  const load = async () => {
    const j = await apiJson(fetchImpl, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/commits/${enc(refName)}`);
    const sha = typeof j?.sha === 'string' ? j.sha : '';
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitHubError('github_error', 'GitHub gave no commit for that ref.');
    return sha;
  };
  if (fresh) { remembered.delete(`head:${ref.owner}/${ref.repo}@${refName}`); return load(); }
  return remember(`head:${ref.owner}/${ref.repo}@${refName}`, REMEMBER_REPO_MS, load);
}

interface TreeEntry { path: string; size: number }

function tree(fetchImpl: FetchLike, ref: GitHubRef, commit: string): Promise<{ files: TreeEntry[]; truncated: boolean }> {
  return remember(`tree:${ref.owner}/${ref.repo}@${commit}`, REMEMBER_TREE_MS, async () => {
    const j = await apiJson(fetchImpl, `/repos/${enc(ref.owner)}/${enc(ref.repo)}/git/trees/${enc(commit)}?recursive=1`);
    const files: TreeEntry[] = [];
    for (const e of Array.isArray(j?.tree) ? j.tree : []) {
      if (e?.type !== 'blob' || typeof e.path !== 'string') continue;
      files.push({ path: e.path, size: Number.isFinite(e.size) ? Number(e.size) : 0 });
    }
    return { files, truncated: j?.truncated === true };
  });
}

// ── What a folder holds ────────────────────────────────────────────────────────

const fileStatus = (p: string, size: number): GitHubFileStatus => {
  if (!isAllowedSkillPath(p)) return 'not-allowed';
  if (size > SKILL_LIMITS.maxFileBytes) return 'too-large';
  if (isScriptPath(p)) return 'script';
  if (isCodePath(p)) return 'code';
  return 'text';
};

const installableStatus = (s: GitHubFileStatus) => s === 'text' || s === 'code' || s === 'script';

/** `a/b///` -> `a/b`. A loop, not a regex: the folder comes from the address the user typed. */
function trimSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === '/') end--;
  return s.slice(0, end);
}

function hiddenOrSkipped(folder: string): boolean {
  return folder.split('/').some((seg) => seg.startsWith('.') || SKIPPED_DIRS.has(seg));
}

/** The skill folders a tree holds under `base`: every folder with a SKILL.md, hidden ones left out. */
export function skillFoldersIn(files: TreeEntry[], base: string): { folders: string[]; skipped: number } {
  const prefix = base ? trimSlashes(base) + '/' : '';
  const folders: string[] = [];
  let skipped = 0;
  for (const f of files) {
    if (path.posix.basename(f.path) !== SKILL_FILE) continue;
    const folder = path.posix.dirname(f.path) === '.' ? '' : path.posix.dirname(f.path);
    if (base && folder !== base && !folder.startsWith(prefix)) continue;
    if (hiddenOrSkipped(folder)) { skipped++; continue; }
    folders.push(folder);
  }
  folders.sort();
  return { folders, skipped };
}

/** The files of one skill folder, as paths relative to it. A skill at the repository's root
 *  takes only the root's own files, never the whole repository. Hidden files are left out. */
function filesOfFolder(all: TreeEntry[], folder: string): GitHubSkillFile[] {
  const prefix = folder ? folder + '/' : '';
  const out: GitHubSkillFile[] = [];
  for (const f of all) {
    if (folder && !f.path.startsWith(prefix)) continue;
    const rel = folder ? f.path.slice(prefix.length) : f.path;
    if (!folder && rel.includes('/')) continue;
    if (rel.split('/').some((seg) => seg.startsWith('.'))) continue;
    out.push({ path: rel, size: f.size, status: fileStatus(rel, f.size) });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function needsTerminalFrom(data: Record<string, unknown>): boolean {
  const tools = (data as any)['allowed-tools'] ?? (data as any).allowedTools;
  const list = Array.isArray(tools) ? tools : typeof tools === 'string' ? tools.split(/[,\s]+/) : [];
  return list.some((t) => /^(bash|shell|terminal|powershell|zsh)$/i.test(String(t).trim()));
}

function previewOf(folder: string, files: GitHubSkillFile[], skillText: string | null): GitHubSkillPreview {
  const folderName = folder ? path.posix.basename(folder) : '';
  let meta: SkillMeta = { name: folderName, description: '', author: '', version: '', tools: [] };
  let license = '';
  let needsTerminal = false;
  let unread = true;
  if (skillText !== null) {
    unread = false;
    const fm = parseFrontmatter(skillText).data;
    meta = skillMetaFrom(fm, folderName);
    license = typeof (fm as any).license === 'string' ? String((fm as any).license).slice(0, 80) : '';
    needsTerminal = needsTerminalFrom(fm);
  }
  const installed = files.filter((f) => installableStatus(f.status));
  const totalBytes = installed.reduce((n, f) => n + f.size, 0);
  let reason: string | undefined;
  if (!files.some((f) => f.path === SKILL_FILE)) reason = 'no SKILL.md';
  else if (skillText !== null && !meta.description) reason = 'the SKILL.md has no description';
  else if (skillText !== null && !isValidSkillName(meta.name)) reason = `the SKILL.md name "${meta.name}" is not a valid skill name`;
  else if (skillText !== null && meta.name !== folderName) reason = `the SKILL.md says its name is "${meta.name}" but the folder is "${folderName}"`;
  else if (installed.length > SKILL_LIMITS.maxFiles) reason = `too many files (${installed.length}, the limit is ${SKILL_LIMITS.maxFiles})`;
  else if (totalBytes > SKILL_LIMITS.maxTotalBytes) reason = `too large (${Math.round(totalBytes / 1024)} KB, the limit is ${Math.round(SKILL_LIMITS.maxTotalBytes / 1024)} KB)`;
  return { ...meta, path: folder, folder: folderName, license, needsTerminal, files, totalBytes, installable: !reason, ...(reason ? { reason } : {}), ...(unread ? { unread } : {}) };
}

// ── Preview and detail ─────────────────────────────────────────────────────────

/**
 * What a GitHub address holds: the repository's description, stars and license, the commit
 * its ref points at now, and every skill folder under the address, each with its files and
 * whether it can be installed. Descriptions come from the first PREVIEW_DESCRIPTIONS
 * SKILL.md files; the rest show the folder's name until opened one by one.
 */
export async function previewGitHubSkills(input: string, opts: { fetch?: FetchLike; maxDescriptions?: number } = {}): Promise<GitHubRepoPreview> {
  const ref = parseGitHubSkillUrl(input);
  if (!ref) throw new GitHubError('bad_url', 'That is not a GitHub repository, folder or SKILL.md address.');
  const fetchImpl = opts.fetch ?? fetch;
  const info = await repoInfo(fetchImpl, ref);
  const refName = ref.ref ?? info.defaultBranch;
  const commit = await headCommit(fetchImpl, ref, refName);
  const t = await tree(fetchImpl, ref, commit);
  const { folders, skipped } = skillFoldersIn(t.files, ref.path);
  if (!folders.length) throw new GitHubError('no_skills', ref.path ? `No SKILL.md under "${ref.path}" in that repository.` : 'That repository has no skill folders (no SKILL.md anywhere outside hidden folders).');
  const max = Math.max(0, opts.maxDescriptions ?? PREVIEW_DESCRIPTIONS);
  const texts = new Map<string, string | null>();
  const toRead = folders.slice(0, max);
  await Promise.all(toRead.map(async (folder) => {
    texts.set(folder, await rawText(fetchImpl, ref, commit, folder ? `${folder}/${SKILL_FILE}` : SKILL_FILE, SKILL_LIMITS.maxFileBytes));
  }));
  const skills = folders.map((folder) => previewOf(folder, filesOfFolder(t.files, folder), texts.has(folder) ? texts.get(folder)! : null));
  return { owner: ref.owner, repo: ref.repo, ref: refName, commit, description: info.description, stars: info.stars, license: info.license, path: ref.path, skills, skipped, truncated: t.truncated };
}

/**
 * One skill folder in full: its preview, the SKILL.md text, and the content of every file
 * that would be installed (text, code and scripts, within the limits), ready for the safety
 * scan and for writing. `commit` pins what is read; without it the ref's current commit.
 */
export async function readGitHubSkill(input: string, opts: { fetch?: FetchLike; commit?: string } = {}): Promise<GitHubSkillDetail & { origin: GitHubOrigin }> {
  const ref = parseGitHubSkillUrl(input);
  if (!ref) throw new GitHubError('bad_url', 'That is not a GitHub repository, folder or SKILL.md address.');
  const fetchImpl = opts.fetch ?? fetch;
  let refName = ref.ref;
  if (!refName) refName = (await repoInfo(fetchImpl, ref)).defaultBranch;
  const commit = opts.commit && /^[0-9a-f]{40}$/.test(opts.commit) ? opts.commit : await headCommit(fetchImpl, ref, refName);
  const t = await tree(fetchImpl, ref, commit);
  const entries = filesOfFolder(t.files, ref.path);
  if (!entries.some((f) => f.path === SKILL_FILE)) throw new GitHubError('no_skills', `No SKILL.md in "${ref.path || '/'}" of that repository.`);
  const skillText = await rawText(fetchImpl, ref, commit, ref.path ? `${ref.path}/${SKILL_FILE}` : SKILL_FILE, SKILL_LIMITS.maxFileBytes);
  if (skillText === null) throw new GitHubError('github_error', 'The SKILL.md could not be read from GitHub.');
  const preview = previewOf(ref.path, entries, skillText);
  const files: SkillFile[] = [];
  const skipped: GitHubSkillFile[] = [];
  let total = 0;
  for (const f of entries) {
    if (!installableStatus(f.status)) { skipped.push(f); continue; }
    if (files.length >= SKILL_LIMITS.maxFiles) { skipped.push({ ...f, status: 'too-large' }); continue; }
    const content = f.path === SKILL_FILE ? skillText : await rawText(fetchImpl, ref, commit, ref.path ? `${ref.path}/${f.path}` : f.path, SKILL_LIMITS.maxFileBytes);
    if (content === null) { skipped.push({ ...f, status: 'too-large' }); continue; }
    total += Buffer.byteLength(content, 'utf-8');
    if (total > SKILL_LIMITS.maxTotalBytes) throw new GitHubError('too_large', `The skill is larger than ${Math.round(SKILL_LIMITS.maxTotalBytes / 1024)} KB.`);
    files.push({ path: f.path, content });
  }
  let text = skillText;
  if (text.length > SKILL_LIMITS.maxViewChars) text = text.slice(0, SKILL_LIMITS.maxViewChars) + '\n\n[… cut: the file is longer than this shows]';
  return { preview, text, files, skipped, origin: { repo: `${ref.owner}/${ref.repo}`, ref: refName, commit, path: ref.path } };
}

/** The commit an installed skill's ref points at now (to tell whether its folder moved on). */
export async function latestCommitOf(origin: GitHubOrigin, fetchImpl: FetchLike = fetch): Promise<string> {
  const [owner, repo] = origin.repo.split('/');
  return headCommit(fetchImpl, { owner, repo, ref: origin.ref, path: origin.path }, origin.ref, true);
}

/** The address of a skill folder, for a later read or update from its origin. */
export function originUrl(origin: GitHubOrigin): string {
  return `https://github.com/${origin.repo}/tree/${encodeURIComponent(origin.ref)}${origin.path ? '/' + enc(origin.path) : ''}`;
}

/** A sidecar's origin, when it has the shape this module writes. */
export function originFrom(value: unknown): GitHubOrigin | null {
  const o = value as any;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(o.repo)) return null;
  if (typeof o.ref !== 'string' || !NAME_PART.test(o.ref)) return null;
  if (typeof o.commit !== 'string' || !/^[0-9a-f]{40}$/.test(o.commit)) return null;
  if (typeof o.path !== 'string' || (o.path !== '' && o.path.split('/').some((seg: string) => seg === '' || seg === '..' || seg.startsWith('.')))) return null;
  return { repo: o.repo, ref: o.ref, commit: o.commit, path: o.path };
}
