import { header, mimeType } from "./types.ts";
import type { HttpRequest } from "./types.ts";

export const BODY_LIMIT = 2 * 1024 * 1024;
export type Body = {
  state: "ready" | "pending" | "unavailable" | "omitted";
  bytes?: Uint8Array;
  text?: string;
  imageMime?: string;
};
export type RequestDetail = {
  request: Body;
  response: Body;
  metadata: HttpRequest;
};

export function decodeBody(
  values: number[] | undefined,
  complete: boolean,
  mime: string,
): Body {
  if (!complete) return { state: "pending" };
  if (!Array.isArray(values)) return { state: "unavailable" };
  if (values.length > BODY_LIMIT) return { state: "omitted" };
  if (
    values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  )
    return { state: "unavailable" };
  const bytes = new Uint8Array(values);
  const starts = (prefix: number[]) =>
    prefix.every((value, index) => bytes[index] === value);
  let imageMime: string | undefined;
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) imageMime = "image/png";
  else if (starts([255, 216, 255])) imageMime = "image/jpeg";
  else if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))
    imageMime = "image/gif";
  else if (
    starts([82, 73, 70, 70]) &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  )
    imageMime = "image/webp";
  const textual =
    mime.startsWith("text/") ||
    /json|xml|javascript|x-www-form-urlencoded/.test(mime);
  return {
    state: "ready",
    bytes,
    imageMime,
    text: textual ? new TextDecoder().decode(bytes) : undefined,
  };
}

export function makeDetail(request: HttpRequest): RequestDetail {
  const { requestBody, responseBody, ...metadata } = request;
  const noResponseBody =
    request.response?.statusCode === 304 ||
    request.response?.statusCode === 204 ||
    request.method === "HEAD";
  return {
    metadata,
    request: decodeBody(
      requestBody,
      request.endTime !== undefined,
      header(request.request?.headers, "content-type"),
    ),
    response: decodeBody(
      noResponseBody ? [] : responseBody,
      request.response?.endTime !== undefined,
      mimeType(request),
    ),
  };
}
