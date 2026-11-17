import type { FastkoreContext } from './fastkore-context.js';

export const personalInstructionLimits = { instructions: 6_000, notes: 24, title: 100, note: 600 };
export const personalInstructionsTool = 'my_instructions';

export interface InstructionTile {
  tileId: string;
  tileName: string;
}

export interface InstructionComponent {
  entitySetId: string;
  name: string;
  typeIds?: string[];
  types?: { id: string; name: string }[];
}

export function instructionTile(context?: FastkoreContext): InstructionTile | undefined {
  if (context?.view === 'list' && context.tile_id && context.tile_name) {
    return { tileId: context.tile_id, tileName: context.tile_name };
  }
}

export interface WorkNote {
  id: string;
  title: string;
  text: string;
  scope?: { kind: 'erp' | 'project'; id: string; label: string };
  tile?: InstructionTile;
  component?: InstructionComponent;
  roleId?: string;
  common?: true;
}

export interface PersonalInstructions {
  text: string;
  autoInstructions: boolean;
  notes: WorkNote[];
  revision: number;
}

export type PersonalInstructionsEdit = Pick<PersonalInstructions, 'text' | 'autoInstructions' | 'revision'> & {
  notes: (Pick<WorkNote, 'title' | 'text'> & { id?: string; scope?: 'erp' | 'project'; common?: boolean })[];
  projectId?: string;
  context?: FastkoreContext;
};

export type SharedWorkNote = WorkNote & { authorName: string };
export type PersonalInstructionsView = PersonalInstructions & { sharedNotes?: SharedWorkNote[] };
