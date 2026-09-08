import type { D2LClient } from "../d2lClient.js";

interface RichText {
  Text?: string;
  Html?: string;
}

interface Forum {
  ForumId: number;
  Name: string;
  Description?: RichText;
  IsHidden?: boolean;
}

interface Topic {
  TopicId: number;
  ForumId: number;
  Name: string;
  Description?: RichText;
  IsHidden?: boolean;
  PostStartDate?: string | null;
  PostEndDate?: string | null;
}

interface Post {
  PostId: number;
  Subject?: string | null;
  Message?: RichText;
  PostedDate?: string | null;
  Author?: { Identifier?: string; DisplayName?: string };
  IsDeleted?: boolean;
}

export interface DiscussionTopicSummary {
  forumId: number;
  forumName: string;
  topicId: number;
  topicName: string;
  description: string | null;
  isHidden: boolean | null;
  opensAt: string | null;
  closesAt: string | null;
}

export interface DiscussionPostSummary {
  id: number;
  subject: string | null;
  message: string | null;
  postedDate: string | null;
  author: string | null;
  isDeleted: boolean | null;
}

/**
 * Lists discussion topics across all forums in a course/org unit. Brightspace
 * organizes discussions as Forums containing Topics, so this fetches each
 * forum's topics and flattens them into one list.
 */
export async function listDiscussionTopics(
  client: D2LClient,
  orgUnitId: number
): Promise<DiscussionTopicSummary[]> {
  const forums = await client.leGet<Forum[]>(`/${orgUnitId}/discussions/forums/`);

  const topicsByForum = await Promise.all(
    forums.map((forum) =>
      client
        .leGet<Topic[]>(`/${orgUnitId}/discussions/forums/${forum.ForumId}/topics/`)
        .then((topics) => topics.map((topic) => ({ forum, topic })))
    )
  );

  return topicsByForum.flat().map(({ forum, topic }) => ({
    forumId: forum.ForumId,
    forumName: forum.Name,
    topicId: topic.TopicId,
    topicName: topic.Name,
    description: topic.Description?.Text ?? null,
    isHidden: topic.IsHidden ?? null,
    opensAt: topic.PostStartDate ?? null,
    closesAt: topic.PostEndDate ?? null,
  }));
}

/** Lists posts within a specific discussion topic (from list_discussion_topics). */
export async function listDiscussionPosts(
  client: D2LClient,
  orgUnitId: number,
  topicId: number
): Promise<DiscussionPostSummary[]> {
  const posts = await client.leGet<Post[]>(`/${orgUnitId}/discussions/topics/${topicId}/posts/`);

  return posts
    .filter((post) => !post.IsDeleted)
    .map((post) => ({
      id: post.PostId,
      subject: post.Subject ?? null,
      message: post.Message?.Text ?? null,
      postedDate: post.PostedDate ?? null,
      author: post.Author?.DisplayName ?? null,
      isDeleted: post.IsDeleted ?? null,
    }));
}
