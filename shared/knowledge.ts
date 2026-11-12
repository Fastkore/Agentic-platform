export type KnowledgeSection = 'fastkore' | 'company';
export interface KnowledgeFile {
  id: string;
  section: KnowledgeSection;
  name: string;
  size: number;
  revision: string;
  updatedAt: string;
  editable: boolean;
  extraction: 'full' | 'excerpt' | 'unavailable';
}
export interface KnowledgeOverview {
  summary: string;
  revision: string;
  files: KnowledgeFile[];
}
