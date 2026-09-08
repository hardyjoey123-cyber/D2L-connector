import type { D2LClient } from "../d2lClient.js";

interface RichText {
  Text?: string;
  Html?: string;
}

interface NewsItem {
  Id: number;
  Title: string;
  Body?: RichText;
  StartDate?: string | null;
  EndDate?: string | null;
  IsPublished?: boolean;
  LastModified?: string | null;
}

export interface AnnouncementSummary {
  id: number;
  title: string;
  body: string | null;
  startDate: string | null;
  endDate: string | null;
  isPublished: boolean | null;
  lastModified: string | null;
}

/** Lists announcements (news items) for a given course/org unit. */
export async function listAnnouncements(
  client: D2LClient,
  orgUnitId: number
): Promise<AnnouncementSummary[]> {
  const items = await client.leGet<NewsItem[]>(`/${orgUnitId}/news/`);

  return items.map((item) => ({
    id: item.Id,
    title: item.Title,
    body: item.Body?.Text ?? null,
    startDate: item.StartDate ?? null,
    endDate: item.EndDate ?? null,
    isPublished: item.IsPublished ?? null,
    lastModified: item.LastModified ?? null,
  }));
}
