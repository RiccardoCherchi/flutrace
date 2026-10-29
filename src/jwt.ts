export type DecodedJwt = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
};

export function decodeJwt(token: string): DecodedJwt | undefined {
  if (token.length > 32768) return undefined;
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    !parts.slice(0, 2).every((part) => /^[A-Za-z0-9_-]+$/.test(part)) ||
    !/^[A-Za-z0-9_-]*$/.test(parts[2])
  )
    return undefined;
  try {
    const decode = (part: string) => {
      const value = part.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
      const parsed: unknown = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error();
      return parsed as Record<string, unknown>;
    };
    return { header: decode(parts[0]), payload: decode(parts[1]) };
  } catch {
    return undefined;
  }
}

export function findJwts(
  text: string,
): { start: number; end: number; token: string }[] {
  if (!text.includes(".")) return [];
  const matches: { start: number; end: number; token: string }[] = [];
  const pattern =
    /(?:^|[^A-Za-z0-9_.-])([A-Za-z0-9_-]{2,32768}\.[A-Za-z0-9_-]{2,32768}\.[A-Za-z0-9_-]{0,32768})(?![A-Za-z0-9_.-])/g;
  for (const match of text.matchAll(pattern)) {
    const token = match[1];
    if (!decodeJwt(token)) continue;
    const start = match.index + match[0].length - token.length;
    matches.push({ start, end: start + token.length, token });
  }
  return matches;
}
