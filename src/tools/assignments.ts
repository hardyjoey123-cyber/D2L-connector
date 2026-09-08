import type { D2LClient } from "../d2lClient.js";

interface RichText {
  Text?: string;
  Html?: string;
}

interface DropboxFolder {
  Id: number;
  Name: string;
  CustomInstructions?: RichText;
  DueDate?: string | null;
  Availability?: { StartDate?: string | null; EndDate?: string | null };
  TotalFiles?: number;
  GradeItemId?: number | null;
  Categories?: unknown;
  IsHidden?: boolean;
  [key: string]: unknown;
}

export interface AssignmentSummary {
  id: number;
  name: string;
  instructions: string | null;
  dueDate: string | null;
  availableFrom: string | null;
  availableUntil: string | null;
  linkedGradeItemId: number | null;
  isHidden: boolean | null;
}

/** Lists dropbox (assignment) folders for a given course/org unit. */
export async function listAssignments(
  client: D2LClient,
  orgUnitId: number
): Promise<AssignmentSummary[]> {
  const folders = await client.leGet<DropboxFolder[]>(`/${orgUnitId}/dropbox/folders/`);

  return folders.map((folder) => ({
    id: folder.Id,
    name: folder.Name,
    instructions: folder.CustomInstructions?.Text ?? null,
    dueDate: folder.DueDate ?? null,
    availableFrom: folder.Availability?.StartDate ?? null,
    availableUntil: folder.Availability?.EndDate ?? null,
    linkedGradeItemId: folder.GradeItemId ?? null,
    isHidden: folder.IsHidden ?? null,
  }));
}
