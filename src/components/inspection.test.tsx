// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RequestDetails } from "./RequestDetails.tsx";
import { makeDetail } from "../vm/body.ts";
import type { RequestRow } from "../vm/types.ts";
import App from "../App.tsx";
import { CaptureSession } from "../vm/session.ts";
import { Vm, request } from "../test/fake-vm.ts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const base64url = (value: string) =>
  btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
const token = `${base64url('{"alg":"HS256","typ":"JWT"}')}.${base64url('{"sub":"example","exp":1700000000}')}.c2lnbmF0dXJl`;
function showBody(text: string, mime = "application/json", jwt = false) {
  const row: RequestRow = {
    key: "r",
    session: 1,
    ...request(),
    request: { headers: jwt ? { authorization: [`Bearer ${token}`] } : {} },
    response: {
      statusCode: 200,
      endTime: 103,
      headers: { "content-type": [mime] },
    },
  };
  return render(
    <RequestDetails
      row={row}
      detail={makeDetail({
        ...row,
        responseBody: [...new TextEncoder().encode(text)],
      })}
      loading={false}
      onClose={() => {}}
    />,
  );
}
it("highlights JSON and XML while preserving response text and never creating captured HTML", () => {
  const { container, unmount } = showBody('{"count":12,"ok":true}');
  fireEvent.click(screen.getByRole("tab", { name: "Response" }));
  expect(container.querySelector(".token.property")?.textContent).toBe(
    '"count"',
  );
  expect(container.querySelector(".token.number")?.textContent).toBe("12");
  expect(container.querySelector("pre")?.textContent).toBe(
    '{\n  "count": 12,\n  "ok": true\n}',
  );
  unmount();
  const xml = '<item onclick="alert(1)">hello</item>';
  const other = showBody(xml, "application/xml");
  fireEvent.click(screen.getByRole("tab", { name: "Response" }));
  expect(other.container.querySelector(".token.tag")).not.toBeNull();
  expect(other.container.querySelector("item")).toBeNull();
  expect(other.container.querySelector("pre")?.textContent).toBe(xml);
});
it("expands and collapses every JSON branch in preview", async () => {
  showBody('{"nested":{"deep":{"flag":true}},"other":{"count":2}}');
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.queryByText("flag:")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Expand all" }));
  expect(screen.getByText("flag:")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Collapse all" }));
  expect(screen.queryByText("nested:")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Expand all" }));
  expect(screen.getByText("count:")).toBeDefined();
});
it("opens JWTs from headers and responses in a local dialog with Escape and focus restoration", async () => {
  showBody(JSON.stringify({ token }), "application/json", true);
  const user = userEvent.setup();
  const trigger = screen.getByRole("button", { name: "Decode JWT" });
  await user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: "Decoded JWT" });
  expect(within(dialog).getByText("Signature not verified.")).toBeDefined();
  expect(within(dialog).getByText('"example"')).toBeDefined();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
  await user.click(screen.getByRole("tab", { name: "Response" }));
  await user.click(screen.getByRole("button", { name: "Decode JWT" }));
  expect(screen.getByRole("dialog", { name: "Decoded JWT" })).toBeDefined();
});
it("temporarily changes the copy button label and resets it without persistent text", async () => {
  vi.useFakeTimers();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
  showBody("{}");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Copy URL" }));
  });
  expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  expect(screen.queryByText("Copied", { selector: "p" })).toBeNull();
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(screen.getByRole("button", { name: "Copy URL" })).toBeDefined();
});
it("combines multiple method filters with status and sorts without changing waterfall coordinates", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  vm.profiles.set(
    "i",
    ["a", "b", "c"].map((id, i) => ({
      ...request(id, "i", 101 + i * 100),
      method: id === "b" ? "POST" : "GET",
      uri: `https://example.test/${id}`,
      endTime: 111 + i * 100,
      response: { statusCode: id === "b" ? 500 : 200, endTime: 201 + i * 100 },
    })),
  );
  await session.refresh();
  const { container } = render(<App session={session} />);
  const user = userEvent.setup();
  try {
    await user.click(screen.getByText("Methods"));
    await user.click(screen.getByRole("checkbox", { name: "GET" }));
    expect(container.querySelectorAll("tbody .request-name")).toHaveLength(2);
    await user.click(screen.getByRole("checkbox", { name: "POST" }));
    expect(container.querySelectorAll("tbody .request-name")).toHaveLength(3);
    await user.selectOptions(screen.getByLabelText("Filter by status"), "5xx");
    expect(
      container.querySelector("tbody .request-name")?.getAttribute("title"),
    ).toBe("https://example.test/b");
    await user.selectOptions(screen.getByLabelText("Filter by status"), "all");
    const waterfall = () =>
      container
        .querySelector<HTMLSpanElement>(
          'button[title="https://example.test/c"]',
        )
        ?.closest("tr")
        ?.querySelector<HTMLElement>(".waterfall-bar")?.style.left;
    expect(waterfall()).toBe("20%");
    await user.click(screen.getByRole("button", { name: "Sort by Name" }));
    await user.click(screen.getByRole("button", { name: "Sort by Name" }));
    expect(
      container.querySelector("tbody .request-name")?.getAttribute("title"),
    ).toBe("https://example.test/c");
    expect(
      screen
        .getByRole("button", { name: "Sort by Name" })
        .closest("th")
        ?.getAttribute("aria-sort"),
    ).toBe("descending");
    expect(waterfall()).toBe("20%");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Sort by Name" }),
    );
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("falls back to text for large responses and bounds expand-all work", async () => {
  const raw = JSON.stringify({ text: "a".repeat(110000) });
  const view = showBody(raw);
  fireEvent.click(screen.getByRole("tab", { name: "Response" }));
  expect(screen.getByText(/too large to highlight/)).toBeDefined();
  expect(view.container.querySelector(".token")).toBeNull();
  expect(view.container.querySelector("pre")?.textContent).toBe(
    JSON.stringify(JSON.parse(raw), null, 2),
  );
  view.unmount();
  const large = Object.fromEntries(
    Array.from({ length: 150 }, (_, i) => [
      `key${i}`,
      { nested: { value: i } },
    ]),
  );
  const tree = showBody(JSON.stringify(large));
  const user = userEvent.setup();
  await user.click(screen.getByRole("tab", { name: "Preview" }));
  await user.click(screen.getByRole("button", { name: "Expand all" }));
  expect(screen.getByText(/Large tree/)).toBeDefined();
  expect(
    tree.container.querySelectorAll(".json-entry").length,
  ).toBeLessThanOrEqual(1000);
  expect(screen.queryByText("key149:")).toBeNull();
  await user.click(
    screen.getByRole("button", { name: "Show next 100 entries" }),
  );
  expect(screen.getByText("key149:")).toBeDefined();
});

it("copies cURL only after the complete request body is available", async () => {
  const user = userEvent.setup();
  const row = { ...request(), key: "curl", session: 1, method: "POST" };
  const props = { row, loading: false, onClose: () => {} };
  const view = render(<RequestDetails {...props} />);
  expect(
    (screen.getByRole("button", { name: "Copy cURL" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  view.rerender(
    <RequestDetails
      {...props}
      detail={makeDetail({ ...row, requestBody: [123, 125] })}
    />,
  );
  await user.click(screen.getByRole("button", { name: "Copy cURL" }));
  expect(await navigator.clipboard.readText()).toContain("--data-raw '{}'");
  expect(screen.getByRole("button", { name: "Copied" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Copy URL" })).toBeDefined();
});
