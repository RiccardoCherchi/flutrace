import { expect, it } from "vitest";
import { BODY_LIMIT, decodeBody, makeDetail } from "./body.ts";

it("keeps missing, pending and empty bodies distinct", () => {
  expect(decodeBody(undefined, false, "").state).toBe("pending");
  expect(decodeBody(undefined, true, "").state).toBe("unavailable");
  expect(decodeBody([], true, "").bytes?.length).toBe(0);
});
it("omits oversized bytes and decodes UTF-8 JSON", () => {
  expect(decodeBody(new Array(BODY_LIMIT + 1).fill(0), true, "").state).toBe(
    "omitted",
  );
  expect(
    decodeBody(
      [...new TextEncoder().encode('{"city":"Cagliari"}')],
      true,
      "application/json",
    ).text,
  ).toBe('{"city":"Cagliari"}');
});
it("previews validated raster signatures, never SVG or HTML as images", () => {
  expect(
    decodeBody([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80], true, "image/webp")
      .imageMime,
  ).toBe("image/webp");
  expect(
    decodeBody(
      [...new TextEncoder().encode('<svg onload="alert(1)"/>')],
      true,
      "image/svg+xml",
    ).imageMime,
  ).toBeUndefined();
  expect(
    decodeBody([60, 104, 116, 109, 108, 62], true, "image/png").imageMime,
  ).toBeUndefined();
});
it("treats 304 as an empty body and releases original body arrays", () => {
  const result = makeDetail({
    id: "r",
    isolateId: "i",
    method: "GET",
    uri: "https://example.test/",
    startTime: 1,
    endTime: 2,
    response: { statusCode: 304, endTime: 3 },
    responseBody: [],
  });
  expect(result.response.state).toBe("ready");
  expect(result.response.bytes?.length).toBe(0);
  expect(result.metadata.responseBody).toBeUndefined();
});
