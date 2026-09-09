/**
 * Brightspace tools, shaped for voice.
 *
 * The functions in src/tools/ are already the hard part — this file does not
 * reimplement them. What it adds is the shape a spoken conversation needs:
 * the raw functions take an orgUnitId, which would force Claude to list
 * courses and then ask again, spending a whole extra round trip before it can
 * say anything. These tools take a course *name*, resolve it here, and fan out
 * across courses in parallel, so "what's due this week" is one call.
 *
 * They also return far less: assignment instructions and announcement bodies
 * are long HTML, and every token of it is latency the user waits through.
 */
import Anthropic from "@anthropic-ai/sdk";

import { loadConfig } from "../../src/config.js";
import { D2LClient } from "../../src/d2lClient.js";
import { listCourses, type CourseSummary } from "../../src/tools/courses.js";
import { listAssignments } from "../../src/tools/assignments.js";
import { listGrades } from "../../src/tools/grades.js";
import { listAnnouncements } from "../../src/tools/announcements.js";
import { listQuizzes } from "../../src/tools/quizzes.js";
import { listContentTopics } from "../../src/tools/content.js";
import { upcomingOnly, type ConnectAssignment } from "../../src/tools/connect.js";
import {
  connectSessionAvailable,
  fetchConnectAssignments,
} from "../../src/tools/connect-session.js";

/** Courses rarely change mid-conversation, and every lookup needs them. */
const COURSE_CACHE_MS = 5 * 60 * 1000;
/** Guards against an account with a decade of enrollments fanning out. */
const MAX_COURSES = 12;
const MAX_ITEMS = 25;

export interface CourseTools {
  definitions: Anthropic.Tool[];
  run(name: string, input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Returns null when Brightspace isn't configured, so the voice interface runs
 * perfectly well without it rather than failing to start.
 */
export function createCourseTools(): CourseTools | null {
  if (!process.env.BRIGHTSPACE_DOMAIN?.trim()) return null;

  let client: D2LClient;
  try {
    client = new D2LClient(loadConfig());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Brightspace tools disabled: ${message}`);
    return null;
  }

  let cache: { at: number; courses: CourseSummary[] } | null = null;

  async function courses(): Promise<CourseSummary[]> {
    if (cache && Date.now() - cache.at < COURSE_CACHE_MS) return cache.courses;
    const fetched = await listCourses(client);
    cache = { at: Date.now(), courses: fetched };
    return fetched;
  }

  /**
   * Resolves a spoken course name. Speech recognition mangles course codes, so
   * matching is loose and an ambiguous result is reported rather than guessed
   * at — Claude can then ask which one was meant.
   */
  async function resolve(query: unknown): Promise<CourseSummary[] | { ambiguous: string[] }> {
    const all = await courses();
    const active = all.filter((course) => course.isActive !== false);
    const pool = (active.length ? active : all).slice(0, MAX_COURSES);
    if (typeof query !== "string" || !query.trim()) return pool;

    const needle = normalize(query);
    const matches = pool.filter((course) => {
      const haystack = normalize(`${course.name ?? ""} ${course.code ?? ""}`);
      return haystack.includes(needle) || needle.includes(normalize(course.name ?? ""));
    });

    if (matches.length === 0) return pool;
    if (matches.length > 3) return { ambiguous: matches.map((c) => c.name) };
    return matches;
  }

  /** Runs a per-course fetch across courses without letting one failure sink the rest. */
  async function forEachCourse<T>(
    selected: CourseSummary[],
    fetch: (course: CourseSummary) => Promise<T[]>
  ): Promise<Array<{ course: string; items: T[] }>> {
    const settled = await Promise.allSettled(
      selected.map(async (course) => ({ course: course.name, items: await fetch(course) }))
    );
    const results: Array<{ course: string; items: T[] }> = [];
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === "fulfilled") results.push(outcome.value);
      else {
        console.warn(`Brightspace lookup failed for ${selected[i].name}:`, outcome.reason);
      }
    }
    return results;
  }

  const definitions: Anthropic.Tool[] = [
    {
      name: "list_courses",
      description:
        "Lists the user's Brightspace course enrollments. Use when they ask what classes " +
        "they are taking, or when you need to know which courses exist before answering.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "get_coursework",
      description:
        "Lists coursework with due dates from every source: Brightspace assignments and " +
        "quizzes, publisher work the course links out to, and — when a Connect session has " +
        "been captured — homework that lives in McGraw-Hill Connect and is not in " +
        "Brightspace at all. Use for anything about what is due, upcoming work, deadlines, " +
        "or homework. Omit `course` to cover everything, which is what a question like " +
        "'what's due this week' needs.",
      input_schema: {
        type: "object",
        properties: {
          course: {
            type: "string",
            description: "Course name or code to narrow to. Omit for all active courses.",
          },
          includePast: {
            type: "boolean",
            description: "Include work whose due date has passed. Defaults to false.",
          },
        },
      },
    },
    {
      name: "get_grades",
      description:
        "Lists the user's grades. Use for questions about marks, scores, or how they are " +
        "doing in a class. Omit `course` to cover every active course.",
      input_schema: {
        type: "object",
        properties: {
          course: { type: "string", description: "Course name or code. Omit for all." },
        },
      },
    },
    {
      name: "get_announcements",
      description:
        "Lists recent course announcements. Use for questions about news, updates, or what " +
        "an instructor has posted.",
      input_schema: {
        type: "object",
        properties: {
          course: { type: "string", description: "Course name or code. Omit for all." },
        },
      },
    },
  ];

  async function run(name: string, input: Record<string, unknown>): Promise<unknown> {
    if (name === "list_courses") {
      const all = await courses();
      return {
        courses: all
          .filter((course) => course.isActive !== false)
          .map((course) => ({ name: course.name, code: course.code, endsOn: course.endDate })),
      };
    }

    // A Brightspace outage must not take Connect down with it: for a student
    // whose homework lives in Connect, that is the entire answer.
    let selected: CourseSummary[] = [];
    let brightspaceNote: string | null = null;
    try {
      const resolved = await resolve(input.course);
      if ("ambiguous" in resolved) {
        return {
          needsClarification: "Several courses match. Ask which one.",
          options: resolved.ambiguous,
        };
      }
      selected = resolved;
    } catch (error) {
      brightspaceNote = error instanceof Error ? error.message : String(error);
      console.warn("Brightspace course lookup failed:", brightspaceNote);
    }

    switch (name) {
      case "get_coursework": {
        const includePast = input.includePast === true;
        const now = Date.now();

        const perCourse = await forEachCourse(selected, async (course) => {
          // The content table of contents is fetched alongside the native
          // endpoints because publisher homework only exists there — it is a
          // launch link, not a dropbox or a quiz.
          const [assignments, quizzes, content] = await Promise.all([
            listAssignments(client, course.id),
            listQuizzes(client, course.id),
            listContentTopics(client, course.id).catch(() => []),
          ]);

          const native = [
            ...assignments
              .filter((a) => a.isHidden !== true)
              .map((a) => ({ title: a.name, kind: "assignment", due: a.dueDate })),
            ...quizzes
              .filter((q) => q.isHidden !== true)
              .map((q) => ({ title: q.name, kind: "quiz", due: q.dueDate ?? q.endDate })),
          ];

          // A dropbox or quiz usually also appears as a content topic; match on
          // title so the same piece of work isn't announced twice.
          const seen = new Set(native.map((item) => item.title.trim().toLowerCase()));
          const external = content
            .filter(
              (topic) =>
                topic.isExternal &&
                topic.dueDate &&
                topic.isHidden !== true &&
                !seen.has(topic.title.trim().toLowerCase())
            )
            .map((topic) => ({ title: topic.title, kind: "publisher", due: topic.dueDate }));

          return [...native, ...external];
        });

        const items = perCourse
          .flatMap(({ course, items }) => items.map((item) => ({ course, ...item })))
          .filter((item) => {
            if (!item.due) return includePast;
            return includePast || Date.parse(item.due) >= now;
          })
          // Soonest first: a voice answer only ever mentions the first few.
          .sort((a, b) => (Date.parse(a.due ?? "") || Infinity) - (Date.parse(b.due ?? "") || Infinity))
          .slice(0, MAX_ITEMS);

        // Connect is account-wide rather than per Brightspace course, so it is
        // fetched once and filtered by name afterwards.
        let connect: ConnectAssignment[] = [];
        let connectNote: string | null = null;
        if (connectSessionAvailable()) {
          try {
            connect = await fetchConnectAssignments();
          } catch (error) {
            connectNote = error instanceof Error ? error.message : String(error);
          }
        }

        const query = typeof input.course === "string" ? normalize(input.course) : null;
        const connectItems = (includePast ? connect : upcomingOnly(connect, now))
          .filter((item) => {
            if (!query) return true;
            const haystack = normalize(`${item.course ?? ""} ${item.section ?? ""}`);
            return haystack.includes(query) || query.includes(haystack);
          })
          .slice(0, MAX_ITEMS)
          .map((item) => ({
            course: item.course ?? item.section ?? "Connect",
            title: item.title,
            kind: "connect",
            due: item.dueDate,
          }));

        const coursework = [...items, ...connectItems].sort(
          (a, b) => (Date.parse(a.due ?? "") || Infinity) - (Date.parse(b.due ?? "") || Infinity)
        );

        return {
          today: new Date().toISOString(),
          coursework,
          ...(connectNote ? { connectUnavailable: connectNote } : {}),
          ...(brightspaceNote ? { brightspaceUnavailable: brightspaceNote } : {}),
        };
      }

      case "get_grades": {
        const perCourse = await forEachCourse(selected, (course) => listGrades(client, course.id));
        return {
          ...(brightspaceNote ? { brightspaceUnavailable: brightspaceNote } : {}),
          grades: perCourse.map(({ course, items }) => ({
            course,
            items: items
              .filter((g) => g.displayedGrade || g.pointsNumerator !== null)
              .slice(0, MAX_ITEMS)
              .map((g) => ({
                name: g.name,
                grade: g.displayedGrade,
                points:
                  g.pointsNumerator !== null && g.pointsDenominator !== null
                    ? `${g.pointsNumerator}/${g.pointsDenominator}`
                    : null,
              })),
          })),
        };
      }

      case "get_announcements": {
        const perCourse = await forEachCourse(selected, (course) =>
          listAnnouncements(client, course.id)
        );
        return {
          ...(brightspaceNote ? { brightspaceUnavailable: brightspaceNote } : {}),
          announcements: perCourse.flatMap(({ course, items }) =>
            items
              .filter((a) => a.isPublished !== false)
              .sort((a, b) => Date.parse(b.startDate ?? "") - Date.parse(a.startDate ?? ""))
              .slice(0, 5)
              .map((a) => ({
                course,
                title: a.title,
                posted: a.startDate,
                summary: summarize(a.body),
              }))
          ),
        };
      }

      default:
        throw new Error(`Unknown course tool: ${name}`);
    }
  }

  return { definitions, run };
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Announcement bodies are HTML; a spoken answer needs a couple of sentences. */
function summarize(html: string | null): string | null {
  if (!html) return null;
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}
