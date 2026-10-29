// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  within,
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.tsx";
import { CaptureSession } from "../vm/session.ts";
import { Vm, request } from "../test/fake-vm.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function connected() {
  const vm = new Vm();
  vm.profiles.set("i", [
    {
      ...request("slow"),
      uri: "https://example.test/search?q=shoes&page=2&blank=",
      response: {
        statusCode: 200,
        endTime: 101 + 1_500_000,
        headers: { "content-type": ["application/json"] },
      },
    },
  ]);
  vm.detail = {
    ...vm.profiles.get("i")![0],
    responseBody: [...new TextEncoder().encode('{"a":1}')],
  };
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  await session.refresh();
  return session;
}

it("opens with Cmd+P, filters fuzzily and runs a command", async () => {
  const session = await connected();
  const user = userEvent.setup();
  render(<App session={session} />);
  try {
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    const input = screen.getByPlaceholderText("Type a command");
    await user.type(input, "pause rec");
    const first = within(screen.getByRole("listbox")).getAllByRole("option")[0];
    expect(first.querySelector(".label")?.textContent).toBe(
      "Capture: Pause recording",
    );
    expect(first.querySelector("kbd")?.textContent).toBe("⌘E");
    await user.keyboard("{Enter}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
    expect(session.getSnapshot().recording).toBe(false);
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    await user.type(screen.getByPlaceholderText("Type a command"), "zzzz");
    expect(screen.getByText("No matching commands")).toBeDefined();
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).toBeNull();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("shows query parameters, copies formatted bodies and flags slow requests", async () => {
  const session = await connected();
  const user = userEvent.setup();
  render(<App session={session} />);
  try {
    const time = screen.getByText("1.50 s");
    expect(time.className).toContain("slow");
    await user.click(screen.getByRole("button", { name: /search/ }));
    await user.click(screen.getByRole("tab", { name: "Query" }));
    expect(screen.getByText("q").nextSibling?.textContent).toBe("shoes");
    expect(screen.getByText("blank").nextSibling?.textContent).toBe("empty");
    await user.click(screen.getByRole("tab", { name: "Response" }));
    await user.click(screen.getByRole("button", { name: "Copy" }));
    expect(await navigator.clipboard.readText()).toBe('{\n  "a": 1\n}');
    fireEvent.keyDown(window, { key: "p", metaKey: true });
    await user.type(
      screen.getByPlaceholderText("Type a command"),
      "show timing",
    );
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("tab", { name: "Timing" }).getAttribute("aria-selected"),
    ).toBe("true");
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("remembers the details width", async () => {
  localStorage.setItem("flutrace.detailWidth", "500");
  const session = await connected();
  const user = userEvent.setup();
  const view = render(<App session={session} />);
  try {
    await user.click(screen.getByRole("button", { name: /search/ }));
    const workspace = view.container.querySelector<HTMLElement>(".workspace")!;
    expect(workspace.style.getPropertyValue("--detail-width")).toBe("500px");
    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowLeft" });
    expect(localStorage.getItem("flutrace.detailWidth")).not.toBe("500");
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("opens a row menu on right click and supports DevTools shortcuts", async () => {
  const session = await connected();
  const user = userEvent.setup();
  render(<App session={session} />);
  try {
    const row = screen.getByText("search").closest("tr")!;
    fireEvent.contextMenu(row, { clientX: 40, clientY: 40 });
    const menu = screen.getByRole("menu");
    // Bodies load after the menu opens; their items enable when ready.
    await waitFor(() =>
      expect(
        (
          within(menu).getByRole("menuitem", {
            name: "Copy response body",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(
      within(menu).getByRole("menuitem", { name: "Show only example.test" }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      (screen.getByLabelText("Filter requests by URL") as HTMLInputElement)
        .value,
    ).toBe("example.test");
    fireEvent.contextMenu(screen.getByText("search").closest("tr")!);
    await user.click(screen.getByRole("menuitem", { name: "Copy URL" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://example.test/search?q=shoes&page=2&blank=",
    );
    await act(async () => {
      fireEvent.keyDown(window, { key: "e", metaKey: true });
    });
    expect(session.getSnapshot().recording).toBe(false);
    await act(async () => {
      fireEvent.keyDown(window, { key: "k", metaKey: true });
    });
    expect(screen.queryByText("search")).toBeNull();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});
