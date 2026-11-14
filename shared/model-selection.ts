import type { ModelCatalog } from './types.js';
import { providerForModel } from './execution-accounts.js';

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
