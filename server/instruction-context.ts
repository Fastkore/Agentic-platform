import { Parser } from 'saxen';
import type { FastkoreContext } from '../shared/fastkore-context.js';
import type { InstructionComponent } from '../shared/personal-instructions.js';

const guid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
type FilterNode = { name: string; attributes: Record<string, string>; text: string; children: FilterNode[] };

function typeRestriction(node: FilterNode): Set<string> | undefined {
  const attrs = node.attributes;
  if (attrs.Not === 'True') return;
  if (node.name === 'EntitySetFilter' || node.name === 'Group') {
    let result: Set<string> | undefined;
    for (const [index, child] of node.children.entries()) {
      const next = typeRestriction(child);
      if (index === 0) result = next;
      else if (child.attributes.Or === 'True') result = result && next ? new Set([...result, ...next]) : undefined;
      else if (next) result = result ? new Set([...result].filter(id => next.has(id))) : next;
    }
    return result;
  }
  // [$Type] is the platform's system descriptor. A linked descriptor describes another component.
  if (attrs.FirstValueDescriptor !== '[$Type]') return;
  const raw = node.name === 'EqualTo' ? [attrs.SecondValue] :
    node.name === 'IsAnyOf' && node.children.length === 1 && node.children[0].name === 'Values'
      ? node.children[0].children.map(child => child.name === 'Value' && !child.children.length ? child.text.trim() : '') : [];
  if (raw.length && raw.length <= 128 && raw.every(value => typeof value === 'string' && guid.test(value))) {
    return new Set(raw.map(value => value.toLowerCase()));
  }
}

function filterTypes(xml: string, componentId: string): string[] | undefined {
  const parser = new Parser();
  const stack: FilterNode[] = [];
  let root: FilterNode | undefined;
  let valid = true;
  const invalidate = () => { valid = false; };
  parser.on('error', invalidate);
  parser.on('warn', invalidate);
  parser.on('attention', invalidate);
  parser.on('openTag', (name, attributes, decode) => {
    if (!valid || stack.length >= 32) { invalidate(); return; }
    const node = {
      name, attributes: Object.fromEntries(Object.entries(attributes()).map(([key, value]) => [key, decode(value)])),
      children: [], text: '',
    };
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) invalidate();
    else root = node;
    stack.push(node);
  });
  parser.on('text', value => {
    const current = stack.at(-1);
    if (valid && current?.name === 'Value') current.text += value;
  });
  parser.on('closeTag', name => { if (valid && stack.pop()?.name !== name) invalidate(); });
  try { parser.parse(xml); } catch { return; }
  if (!valid || stack.length || root?.name !== 'EntitySetFilter' || root.attributes.EntitySetGuid?.toLowerCase() !== componentId) return;
  const types = typeRestriction(root);
  if (types?.size && types.size <= 128) return [...types].sort();
}

export function instructionComponent(context?: FastkoreContext): InstructionComponent | undefined {
  if (!context || context.view === 'none') return;
  const typeIds = context.entity_type_ids?.length ? context.entity_type_ids :
    context.scope_reproducible && context.filter_xml ? filterTypes(context.filter_xml, context.entity_set_id) : undefined;
  return { entitySetId: context.entity_set_id, name: context.entity_set_name?.trim() || 'Компонент Fastkore', typeIds,
    ...(context.entity_types?.length ? { types: context.entity_types } : {}) };
}
