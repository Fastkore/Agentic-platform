export type FilterNode =
  | { kind: 'condition'; field_name: string; operator_name: string; values: { label: string }[] }
  | { kind: 'group'; not: boolean; items: { join: 'and' | 'or' | null; node: FilterNode }[] };

export interface FastkoreFilterDisplay { complete: boolean; root: FilterNode }

export function parseFilterDisplay(value: unknown): FastkoreFilterDisplay | undefined {
  if (!value || typeof value !== 'object') return;
  const { complete, root } = value as Record<string, unknown>;
  if (typeof complete !== 'boolean') return;
  let remaining = 100;
  const label = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 160) : '';
  function parse(value: unknown, depth: number): FilterNode | undefined {
    if (!value || typeof value !== 'object' || depth > 12 || --remaining < 0) return;
    const node = value as Record<string, unknown>;
    if (node.kind === 'condition' && Array.isArray(node.values) && node.values.length <= remaining) {
      const field_name = label(node.field_name) || label(node.field_id);
      const operator_name = label(node.operator_name) || label(node.operator);
      remaining -= node.values.length;
      const values = node.values.map(value => value && typeof value === 'object' ? label(value.label) || label(value.id) : '');
      if (field_name && operator_name && values.every(Boolean)) return { kind: 'condition', field_name, operator_name, values: values.map(label => ({ label })) };
    }
    if (node.kind === 'group' && typeof node.not === 'boolean' && Array.isArray(node.items) && node.items.length && node.items.length <= remaining) {
      const items: Extract<FilterNode, { kind: 'group' }>['items'] = [];
      for (const item of node.items) {
        if (!item || (items.length ? item.join !== 'and' && item.join !== 'or' : item.join !== null)) return;
        const child = parse(item.node, depth + 1);
        if (!child) return;
        items.push({ join: item.join, node: child });
      }
      return { kind: 'group', not: node.not, items };
    }
  }
  const parsed = parse(root, 0);
  if (parsed) return { complete, root: parsed };
}

export function formatFilterNode(node: FilterNode): string {
  if (node.kind === 'condition') {
    return [node.field_name, node.operator_name, node.values.map(({ label }) => '«' + label + '»').join(', ')].filter(Boolean).join(' ');
  }
  const text = node.items.map(({ join, node }) => (join === 'and' ? ' И ' : join === 'or' ? ' ИЛИ ' : '') + formatFilterNode(node)).join('');
  return node.not ? 'НЕ (' + text + ')' : node.items.length > 1 ? '(' + text + ')' : text;
}
