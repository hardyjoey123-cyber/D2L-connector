#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "./config.js";
import { D2LClient, D2LApiError } from "./d2lClient.js";
import { listCourses } from "./tools/courses.js";
import { listAssignments } from "./tools/assignments.js";
import { listGrades } from "./tools/grades.js";
import { listAnnouncements } from "./tools/announcements.js";
import { listQuizzes } from "./tools/quizzes.js";
import { listDiscussionTopics, listDiscussionPosts } from "./tools/discussions.js";

const config = loadConfig();
const client = new D2LClient(config);

const server = new McpServer({
  name: "d2l-brightspace-mcp-server",
  version: "0.1.0",
});

function toResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function toErrorResult(error: unknown) {
  const message =
    error instanceof D2LApiError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

server.registerTool(
  "list_courses",
  {
    title: "List Brightspace courses",
    description:
      "Lists the current user's active and past course enrollments from D2L Brightspace, " +
      "including each course's org unit ID (needed for the other tools), name, code, and enrollment dates.",
    inputSchema: {},
  },
  async () => {
    try {
      const courses = await listCourses(client);
      return toResult({ count: courses.length, courses });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

server.registerTool(
  "list_assignments",
  {
    title: "List Brightspace assignments",
    description:
      "Lists dropbox/assignment folders for a specific Brightspace course. Requires the course's " +
      "org unit ID, obtained from list_courses.",
    inputSchema: {
      orgUnitId: z
        .number()
        .int()
        .positive()
        .describe("The course's org unit ID, from list_courses."),
    },
  },
  async ({ orgUnitId }) => {
    try {
      const assignments = await listAssignments(client, orgUnitId);
      return toResult({ orgUnitId, count: assignments.length, assignments });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

server.registerTool(
  "list_grades",
  {
    title: "List Brightspace grades",
    description:
      "Lists the current user's grade values for a specific Brightspace course. Requires the " +
      "course's org unit ID, obtained from list_courses.",
    inputSchema: {
      orgUnitId: z
        .number()
        .int()
        .positive()
        .describe("The course's org unit ID, from list_courses."),
    },
  },
  async ({ orgUnitId }) => {
    try {
      const grades = await listGrades(client, orgUnitId);
      return toResult({ orgUnitId, count: grades.length, grades });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

server.registerTool(
  "list_announcements",
  {
    title: "List Brightspace announcements",
    description:
      "Lists announcements (news items) posted in a specific Brightspace course. Requires the " +
      "course's org unit ID, obtained from list_courses.",
    inputSchema: {
      orgUnitId: z
        .number()
        .int()
        .positive()
        .describe("The course's org unit ID, from list_courses."),
    },
  },
  async ({ orgUnitId }) => {
    try {
      const announcements = await listAnnouncements(client, orgUnitId);
      return toResult({ orgUnitId, count: announcements.length, announcements });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

server.registerTool(
  "list_quizzes",
  {
    title: "List Brightspace quizzes",
    description:
      "Lists quizzes for a specific Brightspace course. Requires the course's org unit ID, " +
      "obtained from list_courses.",
    inputSchema: {
      orgUnitId: z
        .number()
        .int()
        .positive()
        .describe("The course's org unit ID, from list_courses."),
    },
  },
  async ({ orgUnitId }) => {
    try {
      const quizzes = await listQuizzes(client, orgUnitId);
      return toResult({ orgUnitId, count: quizzes.length, quizzes });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

server.registerTool(
  "list_discussion_topics",
  {
    title: "List Brightspace discussion topics",
    description:
      "Lists discussion topics (across all forums) for a specific Brightspace course. Requires " +
      "the course's org unit ID, obtained from list_courses. Use the returned topicId with " +
      "list_discussion_posts to read a topic's actual posts.",
    inputSchema: {
      orgUnitId: z
        .number()
        .int()
        .positive()
        .describe("The course's org unit ID, from list_courses."),
    },
  },
  async ({ orgUnitId }) => {
    try {
      const topics = await listDiscussionTopics(client, orgUnitId);
      return toResult({ orgUnitId, count: topics.length, topics });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

server.registerTool(
  "list_discussion_posts",
  {
    title: "List posts in a Brightspace discussion topic",
    description:
      "Lists the posts within one discussion topic. Requires the course's org unit ID and a " +
      "topicId, both obtained from list_discussion_topics.",
    inputSchema: {
      orgUnitId: z
        .number()
        .int()
        .positive()
        .describe("The course's org unit ID, from list_courses."),
      topicId: z
        .number()
        .int()
        .positive()
        .describe("The discussion topic's ID, from list_discussion_topics."),
    },
  },
  async ({ orgUnitId, topicId }) => {
    try {
      const posts = await listDiscussionPosts(client, orgUnitId, topicId);
      return toResult({ orgUnitId, topicId, count: posts.length, posts });
    } catch (error) {
      return toErrorResult(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[d2l-mcp] D2L Brightspace MCP server running on stdio.\n");
}

main().catch((error) => {
  process.stderr.write(`[d2l-mcp] Fatal error: ${error instanceof Error ? error.stack : error}\n`);
  process.exit(1);
});
