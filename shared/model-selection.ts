import type { ModelCatalog, ReasoningEffort } from './types.js';
import { providerForModel } from './execution-accounts.js';

const antigravityVariant = /^(antigravity\/.+)-(low|medium|high|xhigh)$/;
export function modelEffort(id?: string) {
  return id?.match(antigravityVariant)?.[2] as ReasoningEffort | undefined;
}

// Option values stay real CLI IDs. Only the displayed rows are grouped.
export function groupModelOptions(options: { value: string; label: string }[], selected: string, preferred?: ReasoningEffort) {
  const groups = new Map<string, typeof options>();
  for (const option of options) {
    const key = option.value.match(antigravityVariant)?.[1] ?? option.value;
    const group = groups.get(key);
    if (group) group.push(option); else groups.set(key, [option]);
  }
  const family = selected.match(antigravityVariant)?.[1];
  const variants = new Map<ReasoningEffort, string>();
  for (const option of family ? groups.get(family) ?? [] : []) {
    const effort = modelEffort(option.value);
    if (effort) variants.set(effort, option.value);
  }
  const rows = [...groups.values()].map(group => {
    const option = group.find(item => item.value === selected)
      ?? group.find(item => preferred && modelEffort(item.value) === preferred) ?? group[0];
    return modelEffort(option.value) ? { ...option, label: option.label.replace(/\s*\((?:low|medium|high|xhigh|extra high)\)$/i, '') } : option;
  });
  return { rows, variants };
}

export const isAutomaticModel = (id: string) => /(?:^|\/)(?:auto|(?:glm|gemini|antigravity)-auto)$/.test(id);

export function concreteModel(catalog: ModelCatalog | null | undefined, selected?: string): string {
  if (selected && !isAutomaticModel(selected)) return selected;
  const models = catalog?.models ?? [];
  const preferred = selected || models.find(model => model.isDefault)?.id;
  if (preferred && !isAutomaticModel(preferred)) return preferred;
  const provider = preferred && providerForModel(preferred);
  const available = models.filter(model => !isAutomaticModel(model.id) && (!provider || providerForModel(model.id) === provider));
  return available.find(model => model.id === 'glm/glm-5.3')?.id ?? available[0]?.id ?? '';
}
