import type { D2LClient } from "../d2lClient.js";

interface GradeObject {
  Id: number;
  Name: string;
  ShortName?: string;
  GradeType?: string;
  MaxPoints?: number;
  CanExceedMaxPoints?: boolean;
  IsBonus?: boolean;
}

interface GradeValue {
  GradeObjectIdentifier: string;
  GradeObjectName: string;
  GradeObjectTypeName?: string;
  DisplayedGrade?: string;
  PointsNumerator?: number;
  PointsDenominator?: number;
  WeightedNumerator?: number;
  WeightedDenominator?: number;
}

export interface GradeSummary {
  id: string;
  name: string;
  type: string | null;
  displayedGrade: string | null;
  pointsNumerator: number | null;
  pointsDenominator: number | null;
  weightedNumerator: number | null;
  weightedDenominator: number | null;
}

/**
 * Lists the current user's grade values for a course/org unit, combining the
 * grade item definitions with the authenticated user's grade values.
 */
export async function listGrades(client: D2LClient, orgUnitId: number): Promise<GradeSummary[]> {
  const [definitions, values] = await Promise.all([
    client.leGet<GradeObject[]>(`/${orgUnitId}/grades/`).catch(() => [] as GradeObject[]),
    client.leGet<GradeValue[]>(`/${orgUnitId}/grades/values/myGradeValues/`),
  ]);

  const definitionById = new Map(definitions.map((d) => [String(d.Id), d]));

  return values.map((value) => {
    const definition = definitionById.get(value.GradeObjectIdentifier);
    return {
      id: value.GradeObjectIdentifier,
      name: value.GradeObjectName ?? definition?.Name ?? "Unknown",
      type: value.GradeObjectTypeName ?? definition?.GradeType ?? null,
      displayedGrade: value.DisplayedGrade ?? null,
      pointsNumerator: value.PointsNumerator ?? null,
      pointsDenominator: value.PointsDenominator ?? definition?.MaxPoints ?? null,
      weightedNumerator: value.WeightedNumerator ?? null,
      weightedDenominator: value.WeightedDenominator ?? null,
    };
  });
}
