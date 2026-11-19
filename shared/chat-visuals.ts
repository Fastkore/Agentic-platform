export type VisualCell = string | number | boolean | null;

export type ChatVisual =
  | { type: 'metrics'; items: { label: string; value: string | number; unit?: string }[] }
  | { type: 'chart'; title: string; unit?: string; points: { label: string; value: number }[] }
  | { type: 'table'; title: string; columns: string[]; rows: VisualCell[][] };
