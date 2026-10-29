// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.tsx";
import { CaptureSession } from "../vm/session.ts";
import { makeDetail } from "../vm/body.ts";
import { RequestDetails } from "./RequestDetails.tsx";
import { Vm, request } from "../test/fake-vm.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
const json = '{"user":{"name":"Ada","role":"admin"},"tags":["admin","ops"]}';
function row() {
  return {
    ...request("r"),
    key: "r",
    session: 1,
  };
}

it("finds text in the body and switches between pretty and raw JSON", async () => {
  const user = userEvent.setup();
  const detail = makeDetail({
    ...row(),
    responseBody: [...new TextEncoder().encode(json)],
  });
  render(
    <RequestDetails
      row={row()}
      detail={detail}
      loading={false}
      onClose={() => {}}
    />,
  );
  await user.click(screen.getByRole("tab", { name: "Response" }));
  expect(document.querySelector(".response-text")?.textContent).toContain(
    '\n  "user"',
  );
  await user.type(screen.getByLabelText("Find in body"), "admin");
  expect(screen.getByText("1 of 2")).toBeDefined();
  await user.keyboard("{Enter}");
  expect(screen.getByText("2 of 2")).toBeDefined();
  await user.keyboard("{Shift>}{Enter}{/Shift}");
  expect(screen.getByText("1 of 2")).toBeDefined();
  await user.click(screen.getByRole("button", { name: "Raw" }));
  expect(document.querySelector(".response-text")?.textContent).toBe(json);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(await navigator.clipboard.readText()).toBe(json);
  await user.clear(screen.getByLabelText("Find in body"));
  await user.type(screen.getByLabelText("Find in body"), "zzz");
  expect(screen.getByText("No results")).toBeDefined();
});

it("searches bodies of every request and opens the match", async () => {
  const vm = new Vm();
  vm.profiles.set("i", [request("a", "i", 101), request("b", "i", 102)]);
  vm.detail = {
    ...request("b"),
    responseBody: [...new TextEncoder().encode(json)],
  };
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  await session.refresh();
  const user = userEvent.setup();
  render(<App session={session} />);
  try {
    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    await user.type(
      screen.getByLabelText("Search URLs, headers and bodies"),
      "role{Enter}",
    );
    expect(await screen.findByText(/2 matches in 2 requests/)).toBeDefined();
    const before = vm.calls.filter((c) =>
      c.method.endsWith("getHttpProfileRequest"),
    ).length;
    await user.click(screen.getAllByText("Response body")[0]);
    expect(
      screen
        .getByRole("tab", { name: "Response" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      (screen.getByLabelText("Find in body") as HTMLInputElement).value,
    ).toBe("role");
    // Bodies fetched for search are cached, so opening the hit does not refetch.
    expect(
      vm.calls.filter((c) => c.method.endsWith("getHttpProfileRequest")).length,
    ).toBe(before);
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("searches while typing and steps through matches with arrow keys", async () => {
  const vm = new Vm();
  vm.profiles.set("i", [request("a", "i", 101), request("b", "i", 102)]);
  vm.detail = {
    ...request("b"),
    responseBody: [...new TextEncoder().encode(json)],
  };
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  await session.refresh();
  const user = userEvent.setup();
  render(<App session={session} />);
  try {
    fireEvent.keyDown(window, { key: "f", metaKey: true, shiftKey: true });
    const input = screen.getByLabelText("Search URLs, headers and bodies");
    await user.type(input, "admin");
    expect(await screen.findByText(/matches in 2 requests/)).toBeDefined();
    // Every occurrence on a line is marked, not just the first.
    await user.clear(input);
    await user.type(input, "a");
    const [name] = await screen.findAllByText(
      (_, element) =>
        element?.tagName === "CODE" &&
        /"name": "Ada"/.test(element.textContent ?? ""),
    );
    expect(name.querySelectorAll("mark").length).toBe(3);
    await user.clear(input);
    await user.type(input, "admin");
    expect(await screen.findByText(/matches in 2 requests/)).toBeDefined();
    await user.keyboard("{ArrowDown}");
    expect(document.querySelectorAll(".search-hit")[1].className).toContain(
      "active",
    );
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("tab", { name: "Response" })).toBeDefined();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});
