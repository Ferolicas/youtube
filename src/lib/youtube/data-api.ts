import { ytCall, DATA_BASE } from "@/lib/youtube/client";
import { env } from "@/config/env";
import type {
  YtChannel,
  YtPage,
  YtPlaylistItem,
  YtVideo,
  YtSearchResult,
} from "@/types/youtube";

/** Canal del usuario autenticado (mine=true). */
export async function getMyChannel(): Promise<YtChannel | null> {
  const res = await ytCall<YtPage<YtChannel>>(`${DATA_BASE}/channels`, {
    api: "data",
    endpoint: "channels.list(mine)",
    cost: 1,
    query: {
      part: "snippet,contentDetails,statistics,brandingSettings,topicDetails,status",
      mine: true,
    },
  });
  return res.items?.[0] ?? null;
}

/** Todos los IDs de vídeo de la playlist de uploads (paginación completa). */
export async function listAllUploadIds(
  uploadsPlaylistId: string
): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const res = await ytCall<YtPage<YtPlaylistItem>>(
      `${DATA_BASE}/playlistItems`,
      {
        api: "data",
        endpoint: "playlistItems.list",
        cost: 1,
        query: {
          part: "contentDetails",
          playlistId: uploadsPlaylistId,
          maxResults: 50,
          pageToken,
        },
      }
    );
    for (const it of res.items ?? []) {
      const vid = it.contentDetails?.videoId;
      if (vid) ids.push(vid);
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return ids;
}

/** Metadata completa por lotes de 50. */
export async function getVideosByIds(ids: string[]): Promise<YtVideo[]> {
  const out: YtVideo[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const res = await ytCall<YtPage<YtVideo>>(`${DATA_BASE}/videos`, {
      api: "data",
      endpoint: "videos.list",
      cost: 1,
      query: {
        part: "snippet,contentDetails,statistics,status,topicDetails",
        id: batch.join(","),
        maxResults: 50,
      },
    });
    out.push(...(res.items ?? []));
  }
  return out;
}

export interface PlaylistRow {
  id: string;
  title?: string;
  description?: string;
  itemCount?: number;
}
export async function listPlaylists(channelId: string): Promise<PlaylistRow[]> {
  const out: PlaylistRow[] = [];
  let pageToken: string | undefined;
  do {
    const res = await ytCall<
      YtPage<{
        id: string;
        snippet?: { title?: string; description?: string };
        contentDetails?: { itemCount?: number };
      }>
    >(`${DATA_BASE}/playlists`, {
      api: "data",
      endpoint: "playlists.list",
      cost: 1,
      query: {
        part: "snippet,contentDetails",
        channelId,
        maxResults: 50,
        pageToken,
      },
    });
    for (const p of res.items ?? []) {
      out.push({
        id: p.id,
        title: p.snippet?.title,
        description: p.snippet?.description,
        itemCount: p.contentDetails?.itemCount,
      });
    }
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

export async function listChannelSections(channelId: string) {
  const res = await ytCall<
    YtPage<{
      id: string;
      snippet?: { type?: string; style?: string; position?: number };
      contentDetails?: unknown;
    }>
  >(`${DATA_BASE}/channelSections`, {
    api: "data",
    endpoint: "channelSections.list",
    cost: 1,
    query: { part: "snippet,contentDetails", channelId },
  });
  return res.items ?? [];
}

/**
 * Búsqueda (competidores / tendencias). Coste alto: 100 unidades.
 * Usa API key si está disponible para no consumir el contexto OAuth.
 */
export async function searchVideos(params: {
  q: string;
  regionCode?: string;
  order?: "relevance" | "viewCount" | "date" | "rating";
  publishedAfter?: string;
  maxResults?: number;
  relevanceLanguage?: string;
}): Promise<YtSearchResult[]> {
  const res = await ytCall<YtPage<YtSearchResult>>(`${DATA_BASE}/search`, {
    api: "data",
    endpoint: "search.list",
    cost: 100,
    useApiKey: env.YOUTUBE_API_KEY || undefined,
    query: {
      part: "snippet",
      type: "video",
      q: params.q,
      regionCode: params.regionCode,
      order: params.order ?? "viewCount",
      publishedAfter: params.publishedAfter,
      maxResults: params.maxResults ?? 25,
      relevanceLanguage: params.relevanceLanguage ?? "es",
    },
  });
  return res.items ?? [];
}
