// Tipos parciales de las respuestas de YouTube (solo lo que consumimos).

export interface YtPage<T> {
  items?: T[];
  nextPageToken?: string;
  pageInfo?: { totalResults: number; resultsPerPage: number };
}

export interface YtThumbnails {
  default?: { url: string; width: number; height: number };
  medium?: { url: string; width: number; height: number };
  high?: { url: string; width: number; height: number };
  standard?: { url: string; width: number; height: number };
  maxres?: { url: string; width: number; height: number };
}

export interface YtChannel {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    customUrl?: string;
    publishedAt?: string;
    country?: string;
    defaultLanguage?: string;
    thumbnails?: YtThumbnails;
  };
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
  statistics?: {
    viewCount?: string;
    subscriberCount?: string;
    videoCount?: string;
  };
  brandingSettings?: { channel?: { keywords?: string; defaultLanguage?: string } };
  topicDetails?: { topicIds?: string[] };
}

export interface YtPlaylistItem {
  contentDetails?: { videoId?: string; videoPublishedAt?: string };
  snippet?: { position?: number };
}

export interface YtVideo {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    publishedAt?: string;
    channelId?: string;
    channelTitle?: string;
    tags?: string[];
    categoryId?: string;
    defaultLanguage?: string;
    defaultAudioLanguage?: string;
    thumbnails?: YtThumbnails;
    liveBroadcastContent?: string;
  };
  contentDetails?: {
    duration?: string;
    definition?: string;
    dimension?: string;
    caption?: string;
    licensedContent?: boolean;
  };
  statistics?: {
    viewCount?: string;
    likeCount?: string;
    commentCount?: string;
    favoriteCount?: string;
  };
  status?: { privacyStatus?: string; madeForKids?: boolean };
  topicDetails?: { topicIds?: string[] };
}

export interface YtSearchResult {
  id?: { videoId?: string };
  snippet?: {
    channelId?: string;
    channelTitle?: string;
    title?: string;
    description?: string;
    publishedAt?: string;
  };
}

// Analytics API
export interface AnalyticsResponse {
  columnHeaders: { name: string; columnType: string; dataType: string }[];
  rows?: (string | number)[][];
}
