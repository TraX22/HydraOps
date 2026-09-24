import { z } from "zod";
import { HydraTool, ToolContext } from "../../types.js";
import {
  SKILL_FILE, SKILL_LIMITS, isValidSkillName, listInstalledSkills, readSkillFile, scanSkill,
  skillExists, writeSkillFolder, type SkillFile,
} from "../../skills.js";

// skills_view — open an installed skill (granted by `skills` in tools.md, a prefix
// grant like `github`). The system prompt lists the installed skills by name and
// description; this returns the full text, or one of its reference files.
async function viewSkill(name: string, file?: string): Promise<string> {
  if (!isValidSkillName(name)) return `"${name}" is not a valid skill name. Use a name from the installed skills list.`;
  const skills = await listInstalledSkills();
  const skill = skills.find((s) => s.name === name);
  if (!skill) {
    const names = skills.filter((s) => !s.invalid).map((s) => s.name);
    return `No installed skill named "${name}".` + (names.length ? ` Installed: ${names.join(", ")}.` : " No skills are installed.");
  }
  const rel = file?.trim() || SKILL_FILE;
  const r = await readSkillFile(name, rel);
  if (!r.ok) {
    return `Could not open ${rel} in skill "${name}" (${r.error}). Files in this skill: ${skill.files.join(", ") || "none"}.`;
  }
  let text = r.content;
  if (text.length > SKILL_LIMITS.maxViewChars) text = text.slice(0, SKILL_LIMITS.maxViewChars) + "\n\n[… cut: the file is longer than this tool returns]";
  if (rel === SKILL_FILE) {
    const others = skill.files.filter((f) => f !== SKILL_FILE);
    if (others.length) text += `\n\n---\nOther files in this skill (open one with skills_view + file, only when the instructions point to it): ${others.join(", ")}`;
    if (skill.hasScripts) text += `\nThis skill includes script files. HydraOps does not run them for you; treat them as reference.`;
  }
  return text;
}

export const skillsViewTool: HydraTool = {
  name: "skills_view",
  title: "Skills",
  // Reads files the user installed or approved: local, trusted instructions.
  risk: {},
  description:
    "Open an installed skill: step-by-step instructions for a kind of task. Call it with the skill's name (from the installed skills list in your instructions) BEFORE starting a task that matches it, then follow it. Pass `file` to open one of the skill's reference files when the skill tells you to.",
  schema: z.object({
    name: z.string().describe("The skill's name, exactly as listed (lowercase-with-hyphens)."),
    file: z.string().optional().describe("Optional: a file inside the skill, e.g. references/checklist.md. Omit to get SKILL.md."),
  }),
  execute: async ({ name, file }) => await viewSkill(String(name ?? "").trim(), file),
};

// create_skill — write a new skill (granted separately: `create_skill` in tools.md).
// Every call is held for the user's approval, whatever the task read and whatever the
// security mode (risk.approval = 'always'): a skill becomes instructions for every
// agent that uses skills. It runs only when the user approves, and it never replaces
// an existing skill. The skill stays on this computer.
const referenceSchema = z.object({
  path: z.string().describe("Relative path inside the skill: references/<name>.md or templates/<name>.md"),
  content: z.string().describe("The file's Markdown content."),
});

function buildSkillMd(name: string, description: string, instructions: string, agentId: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim().replace(/"/g, "'");
  return [
    "---",
    `name: ${name}`,
    `description: "${oneLine}"`,
    "metadata:",
    `  author: ${agentId || "agent"}`,
    "  version: 1.0.0",
    "---",
    "",
    instructions.trim(),
    "",
  ].join("\n");
}

async function createSkill(args: any, ctx?: ToolContext): Promise<string> {
  const name = String(args?.name ?? "").trim();
  const description = String(args?.description ?? "").trim();
  const instructions = String(args?.instructions ?? "").trim();
  const agentId = ctx?.agentId?.trim() || "";
  if (!isValidSkillName(name)) return "Invalid name: use lowercase letters, digits and hyphens (max 64), e.g. release-checklist.";
  if (description.length < 20) return "The description is too short: say what the skill does AND when to use it (1-3 sentences).";
  if (description.length > 600) return "The description is too long (max 600 characters).";
  if (instructions.length < 80) return "The instructions are too short to be a useful skill.";
  if (await skillExists(name)) return `A skill named "${name}" already exists, and existing skills cannot be changed. Pick another name.`;

  const refs: SkillFile[] = Array.isArray(args?.references) ? args.references.slice(0, 5).map((r: any) => ({
    path: String(r?.path ?? "").trim().replace(/\\/g, "/"),
    content: String(r?.content ?? ""),
  })) : [];
  for (const r of refs) {
    if (!/^(references|templates)\/[a-z0-9][a-z0-9._-]*\.md$/i.test(r.path)) {
      return `Invalid reference path "${r.path}": use references/<name>.md or templates/<name>.md.`;
    }
  }
  const files: SkillFile[] = [{ path: SKILL_FILE, content: buildSkillMd(name, description, instructions, agentId) }, ...refs];
  // Hard stops only: secrets and hidden characters have no place in a skill. The rest of
  // the scan is for the user, who saw the content on the approval card.
  const hard = scanSkill(files).filter((f) => f.code === "secret" || (f.code === "hidden_text" && f.severity === "high"));
  if (hard.length) return `The skill was not saved: it contains ${hard.map((f) => f.detail).join("; ")}.`;
  try {
    await writeSkillFolder(name, files, { source: "agent", ...(agentId ? { agentId } : {}) });
  } catch (e: any) {
    return `The skill was not saved: ${e?.message || e}`;
  }
  return `Skill "${name}" saved. Agents with the skills tool will see it from their next task.`;
}

export const createSkillTool: HydraTool = {
  name: "create_skill",
  title: "Create skill",
  risk: { sensitive: true, approval: "always" },
  description:
    "Propose a NEW skill: reusable step-by-step instructions for a kind of task you worked out and expect to repeat (not one-off facts; those go to memory). It is saved only after the user approves it, and existing skills cannot be changed. Write the description as what it does + when to use it; keep the instructions concrete (steps, checks, a short example); put long material in references.",
  schema: z.object({
    name: z.string().describe("lowercase-with-hyphens, max 64 chars, e.g. weekly-market-report"),
    description: z.string().describe("1-3 sentences: what the skill does and when to use it."),
    instructions: z.string().describe("The SKILL.md body in Markdown: steps, checks, examples. No secrets or personal data."),
    references: z.array(referenceSchema).max(5).optional().describe("Optional extra files (references/*.md, templates/*.md)."),
  }),
  execute: async (args, ctx) => await createSkill(args, ctx),
};

export const skillsTools: HydraTool[] = [skillsViewTool, createSkillTool];
