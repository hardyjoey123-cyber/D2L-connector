import type { D2LClient } from "../d2lClient.js";

/**
 * A topic in a course's table of contents.
 *
 * This is how publisher coursework becomes visible. Homework hosted on
 * McGraw-Hill Connect, Pearson MyLab, WileyPLUS and the like is not a
 * Brightspace dropbox or quiz, so it never appears in those endpoints — but
 * the launch link almost always sits in the course content, usually carrying
 * the due date the instructor set. That link is what this surfaces.
 */
export interface ContentTopicSummary {
  id: number;
  /** The module the topic sits under, joined with " / " when nested. */
  module: string | null;
  title: string;
  /** Brightspace's TypeIdentifier, e.g. "File", "Link", "Quiz", "Dropbox". */
  type: string | null;
  /**
   * True when the topic launches something outside Brightspace — an LTI tool
   * or an external link. Publisher coursework lands here.
   */
  isExternal: boolean;
  url: string | null;
  dueDate: string | null;
  startDate: string | null;
  endDate: string | null;
  isHidden: boolean | null;
}

interface TocTopic {
  TopicId?: number;
  Title?: string;
  TypeIdentifier?: string;
  Url?: string | null;
  StartDate?: string | null;
  EndDate?: string | null;
  DueDate?: string | null;
  IsHidden?: boolean;
  IsBroken?: boolean;
}

interface TocModule {
  ModuleId?: number;
  Title?: string;
  Modules?: TocModule[];
  Topics?: TocTopic[];
}

interface TableOfContents {
  Modules?: TocModule[];
}

/**
 * Type identifiers that resolve to something inside Brightspace. Anything else
 * — plus anything with an absolute URL — is treated as leaving the platform.
 */
const NATIVE_TYPES = new Set([
  "File",
  "Dropbox",
  "Quiz",
  "Discussion",
  "Checklist",
  "Survey",
  "SelfAssessment",
  "ContentService",
]);

/** Depth cap: content trees are shallow, and a cycle would otherwise hang. */
const MAX_DEPTH = 8;

/** Lists the course's table of contents, flattened to topics. */
export async function listContentTopics(
  client: D2LClient,
  orgUnitId: number
): Promise<ContentTopicSummary[]> {
  const toc = await client.leGet<TableOfContents>(`/${orgUnitId}/content/toc`);
  const topics: ContentTopicSummary[] = [];

  const walk = (modules: TocModule[] | undefined, trail: string[], depth: number) => {
    if (!modules || depth > MAX_DEPTH) return;
    for (const module of modules) {
      const path = module.Title ? [...trail, module.Title] : trail;
      for (const topic of module.Topics ?? []) {
        topics.push(toSummary(topic, path));
      }
      walk(module.Modules, path, depth + 1);
    }
  };

  walk(toc.Modules, [], 0);
  return topics;
}

function toSummary(topic: TocTopic, trail: string[]): ContentTopicSummary {
  const url = topic.Url ?? null;
  const type = topic.TypeIdentifier ?? null;
  // An absolute URL is the strongest signal: Brightspace's own topics are
  // served from relative paths.
  const looksExternal = Boolean(url && /^https?:\/\//i.test(url));

  return {
    id: topic.TopicId ?? 0,
    module: trail.length ? trail.join(" / ") : null,
    title: topic.Title ?? "(untitled)",
    type,
    isExternal: looksExternal || (type !== null && !NATIVE_TYPES.has(type)),
    url,
    dueDate: topic.DueDate ?? null,
    startDate: topic.StartDate ?? null,
    endDate: topic.EndDate ?? null,
    isHidden: topic.IsHidden ?? null,
  };
}
