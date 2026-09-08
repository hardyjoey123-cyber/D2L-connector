import type { D2LClient } from "../d2lClient.js";

interface RichText {
  Text?: string;
  Html?: string;
}

interface Quiz {
  QuizId: number;
  Name: string;
  Instructions?: RichText;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  IsHidden?: boolean;
  GradeItemId?: number | null;
  AttemptsAllowed?: { IsUnlimited?: boolean; NumberOfAttemptsAllowed?: number | null };
}

export interface QuizSummary {
  id: number;
  name: string;
  instructions: string | null;
  startDate: string | null;
  endDate: string | null;
  dueDate: string | null;
  isHidden: boolean | null;
  linkedGradeItemId: number | null;
  attemptsAllowed: number | "unlimited" | null;
}

/** Lists quizzes for a given course/org unit. */
export async function listQuizzes(client: D2LClient, orgUnitId: number): Promise<QuizSummary[]> {
  const quizzes = await client.leGet<Quiz[]>(`/${orgUnitId}/quizzes/`);

  return quizzes.map((quiz) => ({
    id: quiz.QuizId,
    name: quiz.Name,
    instructions: quiz.Instructions?.Text ?? null,
    startDate: quiz.StartDate ?? null,
    endDate: quiz.EndDate ?? null,
    dueDate: quiz.DueDate ?? null,
    isHidden: quiz.IsHidden ?? null,
    linkedGradeItemId: quiz.GradeItemId ?? null,
    attemptsAllowed: quiz.AttemptsAllowed?.IsUnlimited
      ? "unlimited"
      : (quiz.AttemptsAllowed?.NumberOfAttemptsAllowed ?? null),
  }));
}
