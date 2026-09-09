/**
 * McGraw-Hill Connect coursework.
 *
 * Connect has no public API. This reads the same endpoint its own web app
 * uses — /openapi/paam/studentAssignments — by replaying a browser session
 * captured with `npm run connect:capture`. Expect it to break when McGraw-Hill
 * changes their site; there is no contract here.
 *
 * The payload is normalized rather than nested: assignments, the student's
 * copy of each, attempts, sections and courses arrive as five parallel lists
 * joined by id. Everything below is the join.
 */

/** The student's instance of an assignment. */
interface StudentAssignmentRaw {
  id?: string;
  sectionAssignment?: string;
  section?: string;
  status?: string;
  isTodo?: boolean;
}

/** The assignment as the instructor set it up, including its due date. */
interface SectionAssignmentRaw {
  id?: string;
  name?: string;
  section?: string;
  startDateTime?: string;
  endDateTime?: string;
  maximumPoints?: number;
  assignmentType?: string;
  hidden?: boolean;
}

interface AttemptRaw {
  studentAssignment?: string;
  submittedDateTime?: string;
  machineScore?: number;
  manualScore?: number;
  awaitingGrading?: boolean;
}

interface SectionRaw {
  id?: string;
  name?: string;
  course?: number;
}

interface CourseRaw {
  id?: number;
  name?: string;
}

export interface ConnectAssignment {
  id: string;
  title: string;
  course: string | null;
  section: string | null;
  /** Connect's endDateTime — what it displays as "Due". */
  dueDate: string | null;
  availableFrom: string | null;
  status: string | null;
  /** Connect's own "to do" flag: outstanding work it wants you to see. */
  isTodo: boolean;
  submitted: boolean;
  score: number | null;
  maximumPoints: number | null;
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/**
 * Joins the five lists into one flat list of assignments.
 *
 * Written defensively: every field is optional because this payload is
 * undocumented and can change without warning. A missing piece drops that one
 * assignment rather than throwing away the whole answer.
 */
export function parseStudentAssignments(payload: unknown): ConnectAssignment[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;

  const definitions = new Map<string, SectionAssignmentRaw>();
  for (const item of asArray<SectionAssignmentRaw>(root.sectionAssignments)) {
    if (item.id) definitions.set(item.id, item);
  }

  const courses = new Map<number, string>();
  for (const course of asArray<CourseRaw>(root.courses)) {
    if (course.id !== undefined && course.name) courses.set(course.id, course.name);
  }

  const sections = new Map<string, { name: string | null; course: string | null }>();
  for (const section of asArray<SectionRaw>(root.sections)) {
    if (!section.id) continue;
    sections.set(section.id, {
      name: section.name ?? null,
      course: section.course !== undefined ? (courses.get(section.course) ?? null) : null,
    });
  }

  // Best attempt per student assignment: Connect keeps every attempt, and the
  // useful signal is whether any of them was submitted and the best score.
  const attempts = new Map<string, { submitted: boolean; score: number | null }>();
  for (const attempt of asArray<AttemptRaw>(root.assignmentAttempts)) {
    if (!attempt.studentAssignment) continue;
    const score = attempt.manualScore ?? attempt.machineScore ?? null;
    const existing = attempts.get(attempt.studentAssignment);
    attempts.set(attempt.studentAssignment, {
      submitted: Boolean(existing?.submitted || attempt.submittedDateTime),
      score:
        score === null
          ? (existing?.score ?? null)
          : Math.max(score, existing?.score ?? Number.NEGATIVE_INFINITY),
    });
  }

  const out: ConnectAssignment[] = [];
  for (const student of asArray<StudentAssignmentRaw>(root.studentAssignments)) {
    if (!student.id || !student.sectionAssignment) continue;
    const definition = definitions.get(student.sectionAssignment);
    if (!definition || definition.hidden === true) continue;

    const sectionId = student.section ?? definition.section;
    const section = sectionId ? sections.get(sectionId) : undefined;
    const attempt = attempts.get(student.id);

    out.push({
      id: student.id,
      title: definition.name ?? "(untitled)",
      course: section?.course ?? null,
      section: section?.name ?? null,
      dueDate: definition.endDateTime ?? null,
      availableFrom: definition.startDateTime ?? null,
      status: student.status ?? null,
      isTodo: student.isTodo === true,
      submitted: attempt?.submitted ?? false,
      score: attempt?.score ?? null,
      maximumPoints: definition.maximumPoints ?? null,
    });
  }

  return out;
}

/** Upcoming, unsubmitted work, soonest first — what a spoken answer needs. */
export function upcomingOnly(
  assignments: ConnectAssignment[],
  now = Date.now()
): ConnectAssignment[] {
  return assignments
    .filter((item) => !item.submitted && item.dueDate && Date.parse(item.dueDate) >= now)
    .sort((a, b) => Date.parse(a.dueDate ?? "") - Date.parse(b.dueDate ?? ""));
}
