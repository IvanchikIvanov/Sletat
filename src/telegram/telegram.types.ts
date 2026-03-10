export interface WatchCallbackData {
  profileId: string;
}

export interface BookCallbackData {
  offerId: string;
  profileId: string | null;
}

export function encodeWatchCallback(profileId: string): string {
  return `watch:${profileId}`;
}

export function encodeBookCallback(offerId: string, profileId?: string | null): string {
  return `book:${offerId}:${profileId ?? ''}`;
}

export function decodeWatchCallback(data: string): WatchCallbackData | null {
  const match = /^watch:(.+)$/.exec(data);
  if (!match) return null;
  return { profileId: match[1] };
}

export function decodeBookCallback(data: string): BookCallbackData | null {
  const match = /^book:([^:]+):?(.*)$/.exec(data);
  if (!match) return null;
  return { offerId: match[1], profileId: match[2] || null };
}

