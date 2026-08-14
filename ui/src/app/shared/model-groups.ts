import { ModelOption } from '../services/api.service';

// Display names for the model-dropdown <optgroup> headers, keyed by the provider
// slug the API returns on each model. Anything not listed falls back to the slug.
export const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  glm: 'GLM (Z.ai)',
  google: 'Google Gemini',
  groq: 'Groq',
  kimi: 'Kimi (Moonshot)',
  leonardo: 'Leonardo AI',
  local: 'Local',
  mistral: 'Mistral',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  qwen: 'Qwen',
  xai: 'xAI / Grok',
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

// The API prefixes every model name with its access source and company
// ("APIkey · OpenAI: gpt-4o", "Local: LM Studio"). Inside a company group that
// prefix is redundant, so strip it down to just the model.
export function modelLabel(name: string): string {
  return name.replace(/^APIkey · [^:]+:\s*/, '').replace(/^Local:\s*/, '').trim() || name;
}

export interface ModelGroup {
  provider: string;
  label: string;
  models: ModelOption[];
}

// Models grouped by company, both companies and their models sorted A→Z, so a
// flat list of hundreds of models stays readable in a <select>.
export function groupModels(models: ModelOption[]): ModelGroup[] {
  const groups = new Map<string, ModelOption[]>();
  for (const m of models) {
    const arr = groups.get(m.provider) ?? [];
    arr.push(m);
    groups.set(m.provider, arr);
  }
  return [...groups.entries()]
    .map(([provider, items]) => ({
      provider,
      label: providerLabel(provider),
      models: [...items].sort((a, b) =>
        modelLabel(a.name).localeCompare(
          modelLabel(b.name), undefined, { numeric: true, sensitivity: 'base' })),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
