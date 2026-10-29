import { expect, it } from "vitest";
import { matchesStatus, requestName, sortRequests } from "./request-list.ts";
import type { RequestRow } from "./vm/types.ts";

function row(id: string, status?: number, size?: number): RequestRow {
  return {
    key: id,
    id,
    session: 1,
    isolateId: "i",
    method: id === "a" ? "GET" : "POST",
    uri: `https://example.test/${id}`,
    startTime: id === "a" ? 2000 : 1000,
    response:
      status === undefined
        ? undefined
        : { statusCode: status, contentLength: size, endTime: 8000 },
  };
}
it("sorts numeric columns numerically, keeps unknowns last both ways, and never mutates capture order", () => {
  const rows = [row("a", 500, 90), row("b", 200, 1000), row("pending")];
  expect(
    sortRequests(rows, { column: "size", direction: "asc" }).map((r) => r.id),
  ).toEqual(["a", "b", "pending"]);
  expect(
    sortRequests(rows, { column: "size", direction: "desc" }).map((r) => r.id),
  ).toEqual(["b", "a", "pending"]);
  expect(
    sortRequests(rows, { column: "status", direction: "asc" }).map((r) => r.id),
  ).toEqual(["b", "a", "pending"]);
  expect(rows.map((r) => r.id)).toEqual(["a", "b", "pending"]);
});
it("sorts names and durations and recognizes status filters", () => {
  const rows = [row("b", 200), row("a", 500)];
  expect(requestName("https://example.test/path/item?x=1")).toBe("item");
  expect(sortRequests(rows, { column: "name", direction: "asc" })[0].id).toBe(
    "a",
  );
  expect(sortRequests(rows, { column: "time", direction: "asc" })[0].id).toBe(
    "a",
  );
  expect(matchesStatus(rows[0], "2xx")).toBe(true);
  expect(matchesStatus(rows[1], "2xx")).toBe(false);
  expect(matchesStatus(row("pending"), "pending")).toBe(true);
  expect(
    matchesStatus({ ...row("fail"), request: { error: "failed" } }, "failed"),
  ).toBe(true);
  expect(matchesStatus(row("pending"), "failed")).toBe(false);
});
