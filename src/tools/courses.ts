import type { D2LClient } from "../d2lClient.js";

interface MyOrgUnitInfo {
  OrgUnit: {
    Id: number;
    Name: string;
    Code: string | null;
    Type?: { Id: number; Code: string; Name: string };
  };
  Access?: {
    IsActive: boolean;
    StartDate: string | null;
    EndDate: string | null;
  };
  Role?: { Id: number; Name: string };
}

export interface CourseSummary {
  id: number;
  name: string;
  code: string | null;
  role: string | null;
  isActive: boolean | null;
  startDate: string | null;
  endDate: string | null;
}

/** Lists the current user's course enrollments (org unit type 3 = Course Offering). */
export async function listCourses(client: D2LClient): Promise<CourseSummary[]> {
  const enrollments = await client.paginateLp<MyOrgUnitInfo>("/enrollments/myenrollments/", {
    orgUnitTypeId: 3,
  });

  return enrollments.map((enrollment) => ({
    id: enrollment.OrgUnit.Id,
    name: enrollment.OrgUnit.Name,
    code: enrollment.OrgUnit.Code,
    role: enrollment.Role?.Name ?? null,
    isActive: enrollment.Access?.IsActive ?? null,
    startDate: enrollment.Access?.StartDate ?? null,
    endDate: enrollment.Access?.EndDate ?? null,
  }));
}
