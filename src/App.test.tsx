// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App.tsx";
import { CaptureSession } from "./vm/session.ts";
import { makeDetail } from "./vm/body.ts";
import { RequestDetails } from "./components/RequestDetails.tsx";
import { Vm, request, socket } from "./test/fake-vm.ts";
import { JsonTree } from "./components/JsonTree.tsx";

afterEach(cleanup);

it("mounts nested JSON entries only when expanded", async () => {
  render(<JsonTree value={{ branch: { message: "nested-value" } }} />);
  expect(screen.queryByText('"nested-value"')).toBeNull();
  await userEvent.click(screen.getAllByText("{1}")[1]);
  expect(await screen.findByText('"nested-value"')).toBeDefined();
});

it("keeps deeply nested JSON inspectable without a rendering crash", () => {
  const raw = "[".repeat(10000) + "0" + "]".repeat(10000);
  const row = {
    key: "deep",
    session: 1,
    id: "deep",
    isolateId: "i",
    method: "GET",
    uri: "https://example.test/deep",
    startTime: 1,
    endTime: 2,
    response: {
      statusCode: 200,
      endTime: 3,
      headers: { "content-type": ["application/json"] },
    },
  };
  const detail = makeDetail({
    ...row,
    responseBody: [...new TextEncoder().encode(raw)],
  });
  render(
    <RequestDetails
      row={row}
      detail={detail}
      loading={false}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Response" }));
  expect(screen.getByText(raw, { selector: "pre" })).toBeDefined();
});
it("offers a private connection field and honest empty state", () => {
  render(<App session={new CaptureSession()} />);
  expect(screen.getByLabelText("VM Service URL").getAttribute("type")).toBe(
    "password",
  );
  expect(screen.getByRole("button", { name: "Connect" })).toBeDefined();
  expect(
    screen.getByText(/Flutrace reads its HTTP traffic through the Dart VM/),
  ).toBeDefined();
  expect(screen.getByText("Connect to your Flutter app")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Images" }));
  expect(
    screen.getByRole("button", { name: "Images" }).getAttribute("aria-pressed"),
  ).toBe("true");
});
it("renders captured HTML as text, not executable markup", () => {
  const raw = '<img src="https://example.test/track" onerror="alert(1)">';
  const row = {
    key: "a",
    session: 1,
    id: "r",
    isolateId: "i",
    method: "GET",
    uri: "https://example.test/",
    startTime: 1,
    endTime: 2,
    response: {
      statusCode: 200,
      endTime: 3,
      headers: { "content-type": ["text/html"] },
    },
  };
  const detail = makeDetail({
    ...row,
    responseBody: [...new TextEncoder().encode(raw)],
  });
  const { container } = render(
    <RequestDetails
      row={row}
      detail={detail}
      loading={false}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Response" }));
  expect(container.querySelector("pre")?.textContent).toBe(raw);
  expect(container.querySelector("img")).toBeNull();
});
it("explains 304 without trying to load an image", () => {
  const row = {
    key: "a",
    session: 1,
    id: "r",
    isolateId: "i",
    method: "GET",
    uri: "https://example.test/",
    startTime: 1,
    endTime: 2,
    response: { statusCode: 304, endTime: 3 },
  };
  render(
    <RequestDetails
      row={row}
      detail={makeDetail(row)}
      loading={false}
      onClose={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Preview" }));
  expect(screen.getByText(/304 Not Modified/)).toBeDefined();
});

it("connects, filters captured requests, opens JSON, pauses and clears", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  const user = userEvent.setup();
  render(<App session={session} />);
  try {
    await user.type(
      screen.getByLabelText("VM Service URL"),
      "http://localhost:8181/test=/",
    );
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeDefined();
    vm.profiles.set("i", [
      request(),
      {
        ...request("image"),
        uri: "https://example.test/cover.png",
        response: {
          statusCode: 200,
          endTime: 103,
          headers: { "content-type": ["image/png"] },
        },
      },
    ]);
    await act(async () => {
      await session.refresh();
    });
    await user.click(screen.getByRole("button", { name: "Images" }));
    expect(screen.getByRole("button", { name: /cover.png/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: "{}data" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "JSON" }));
    await user.click(screen.getByRole("button", { name: /data$/ }));
    await user.click(screen.getByRole("button", { name: "Copy URL" }));
    expect(await navigator.clipboard.readText()).toBe(
      "https://example.test/data",
    );
    await user.click(screen.getByRole("tab", { name: "Response" }));
    expect(document.querySelector(".response-text")?.textContent).toBe("{}");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Response" }), {
      key: "ArrowRight",
    });
    expect(
      screen.getByRole("tab", { name: "Timing" }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Timing" }),
    );
    await user.click(screen.getByRole("button", { name: "All" }));
    fireEvent.keyDown(
      screen.getByRole("region", { name: "Captured requests" }),
      { key: "ArrowUp" },
    );
    expect(session.getSnapshot().selectedKey).toBe(
      session.getSnapshot().rows.find((row) => row.id === "image")?.key,
    );
    await user.click(screen.getByRole("button", { name: "Pause recording" }));
    expect(vm.enabled.get("i")).toBe(false);
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      screen.queryByRole("complementary", { name: "Request details" }),
    ).toBeNull();
    expect(session.getSnapshot().rows).toHaveLength(0);
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("renders only a viewport of a large log and filters the entire log", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  vm.profiles.set(
    "i",
    Array.from({ length: 2000 }, (_, n) => ({
      ...request(String(n), "i", 101 + n),
      uri: `https://example.test/item-${n}`,
    })),
  );
  await session.refresh();
  render(<App session={session} />);
  try {
    expect(screen.getAllByRole("row").length).toBeLessThan(50);
    fireEvent.change(screen.getByLabelText("Filter requests by URL"), {
      target: { value: "item-1999" },
    });
    expect(screen.getByRole("button", { name: /item-1999/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /item-1998/ })).toBeNull();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("switches to a socket view with byte counts and an address filter", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  vm.socketProfiles.set("i", [
    socket("a", 150, { readBytes: 2048, writeBytes: 12, endTime: 1150 }),
    socket("b", 160, { address: "10.0.0.9", port: 8080 }),
  ]);
  await session.refresh();
  render(<App session={session} />);
  try {
    await userEvent.click(screen.getByRole("button", { name: "Sockets" }));
    expect(screen.getByText("93.184.216.34:443")).toBeDefined();
    expect(screen.getByText("2.0 kB")).toBeDefined();
    expect(screen.getByText("Closed")).toBeDefined();
    expect(screen.getByText("Open")).toBeDefined();
    expect(screen.getByText("2 sockets")).toBeDefined();
    // HTTP-only filters stay in the toolbar, disabled, so the layout is stable.
    expect(
      (screen.getByLabelText("Filter by status") as HTMLSelectElement).disabled,
    ).toBe(true);
    await userEvent.click(screen.getByText("93.184.216.34:443"));
    expect(screen.getByLabelText("Socket details")).toBeDefined();
    await userEvent.click(screen.getByLabelText("Close socket details"));
    expect(screen.queryByLabelText("Socket details")).toBeNull();
    fireEvent.change(screen.getByLabelText("Filter sockets by address"), {
      target: { value: "10.0" },
    });
    expect(screen.queryByText("93.184.216.34:443")).toBeNull();
    expect(screen.getByText("10.0.0.9:8080")).toBeDefined();
    expect(screen.getByText("1 of 2 sockets")).toBeDefined();
    await userEvent.click(screen.getByRole("button", { name: "HTTP" }));
    expect(
      (screen.getByLabelText("Filter by status") as HTMLSelectElement).disabled,
    ).toBe(false);
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("shows a WebSocket's live messages under its handshake request, newest first", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  const handshake = {
    ...request("ws", "i", 150),
    uri: "https://stream.example.test:9443/ws/trades",
    response: {
      statusCode: 101,
      endTime: 160,
      error: "Socket has been detached",
    },
  };
  vm.profiles.set("i", [handshake]);
  vm.detail = handshake;
  await session.refresh();
  render(<App session={session} />);
  try {
    await act(async () => {
      vm.ws({
        type: "open",
        id: "1",
        url: "wss://stream.example.test:9443/ws/trades",
      });
      vm.ws({
        type: "message",
        id: "1",
        direction: "in",
        size: 5,
        text: "first",
        at: 1,
      });
      vm.ws({
        type: "message",
        id: "1",
        direction: "in",
        size: 6,
        text: "second",
        at: 2,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    await userEvent.click(screen.getByRole("button", { name: /trades/ }));
    await userEvent.click(await screen.findByRole("tab", { name: "Messages" }));
    const items = screen.getAllByRole("listitem").map((li) => li.textContent);
    expect(items[0]).toContain("second");
    expect(items[1]).toContain("first");
    expect(screen.getByText("2 messages")).toBeDefined();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("holds the message list while a message is open and offers a jump to new ones", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  const handshake = {
    ...request("ws", "i", 150),
    uri: "https://stream.example.test:9443/ws/trades",
    response: { statusCode: 101, endTime: 160 },
  };
  vm.profiles.set("i", [handshake]);
  vm.detail = handshake;
  await session.refresh();
  render(<App session={session} />);
  const post = async (text: string, at: number) =>
    act(async () => {
      vm.ws({
        type: "message",
        id: "1",
        url: "wss://stream.example.test:9443/ws/trades",
        direction: "in",
        size: text.length,
        text,
        at,
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
  try {
    await post('{"n":1}', 1);
    await userEvent.click(screen.getByRole("button", { name: /trades/ }));
    await userEvent.click(await screen.findByRole("tab", { name: "Messages" }));
    // Open the message: the list pauses.
    await userEvent.click(screen.getByRole("button", { expanded: false }));
    expect(screen.getByText("Paused")).toBeDefined();
    await post('{"n":2}', 2);
    await post('{"n":3}', 3);
    const texts = () =>
      screen
        .getAllByRole("listitem")
        .map((item) => item.querySelector(".ws-text")?.textContent);
    expect(texts()).toEqual(['{"n":1}']);
    expect(screen.getByText("3 messages")).toBeDefined();
    await userEvent.click(
      screen.getByRole("button", { name: /2 new messages/ }),
    );
    expect(texts()).toEqual(['{"n":3}', '{"n":2}', '{"n":1}']);
    expect(screen.getByText("Live")).toBeDefined();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});

it("keeps an open request in place when newer requests arrive", async () => {
  const vm = new Vm();
  const session = new CaptureSession({
    connect: async () => vm,
    intervalMs: 60000,
  });
  await session.connect("unused");
  vm.timestamp = 200;
  vm.profiles.set("i", [
    { ...request("a", "i", 101), uri: "https://example.test/first" },
  ]);
  await session.refresh();
  render(<App session={session} />);
  try {
    await userEvent.click(screen.getByRole("button", { name: /first/ }));
    expect(screen.queryByRole("button", { name: /new request/ })).toBeNull();
    vm.profiles.set("i", [
      { ...request("b", "i", 150), uri: "https://example.test/second" },
    ]);
    await act(async () => {
      await session.refresh();
    });
    // Newest first: the new request is on top, and the open one is held.
    const names = screen
      .getAllByRole("row")
      .slice(1)
      .map((row) => row.querySelector(".label")?.textContent);
    expect(names).toEqual(["second", "first"]);
    await userEvent.click(
      screen.getByRole("button", { name: "↑ 1 new request" }),
    );
    expect(screen.queryByRole("button", { name: /new request/ })).toBeNull();
  } finally {
    await act(async () => {
      await session.disconnect();
    });
  }
});
