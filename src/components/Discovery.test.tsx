// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Discovery, DiscoveryPanel } from "./Discovery.tsx";
import { invoke } from "@tauri-apps/api/core";
import { RpcClient } from "../vm/rpc.ts";
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("discovers sessions and connects only after selection without displaying tokens", async () => {
  const onSelect = vi.fn();
  const uri = "http://127.0.0.1:123/private-token=/";
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "start_discovery"
      ? undefined
      : ({
          searching: false,
          message: "Search finished.",
          sessions: [{ name: "Test iPhone", uri }],
          dtdUris: [],
        } as never),
  );
  const view = render(<Discovery disabled={false} onSelect={onSelect} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Find app" }));
  const button = await screen.findByRole("button", {
    name: "Connect to Test iPhone",
  });
  expect(onSelect).not.toHaveBeenCalled();
  expect(view.container.textContent).not.toContain("private-token");
  await user.click(button);
  expect(onSelect).toHaveBeenCalledWith(uri);
  expect(screen.queryByRole("region", { name: "Find Flutter app" })).toBeNull();
});
it("queries DTD registered VMs and closes its temporary RPC connection", async () => {
  const close = vi.fn();
  const call = vi.fn().mockResolvedValue({
    vmServices: [
      { name: "Debug app", uri: "http://localhost:123/vm=/" },
      { name: "Remote", uri: "http://example.com/vm=/" },
    ],
  });
  vi.spyOn(RpcClient, "connect").mockResolvedValue({
    call,
    close,
  } as unknown as RpcClient);
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "start_discovery"
      ? undefined
      : ({
          searching: true,
          message: "Searching",
          sessions: [],
          dtdUris: ["ws://localhost:123/dtd="],
        } as never),
  );
  render(<Discovery disabled={false} onSelect={() => {}} />);
  await userEvent.click(screen.getByRole("button", { name: "Find app" }));
  expect(
    await screen.findByRole("button", { name: "Connect to Debug app" }),
  ).toBeDefined();
  expect(screen.queryByText("Remote")).toBeNull();
  await waitFor(() => expect(close).toHaveBeenCalled());
  expect(call).toHaveBeenCalledWith("ConnectedApp.getVmServices");
});
it("searches as soon as the inline panel mounts", async () => {
  const onSelect = vi.fn();
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "start_discovery"
      ? undefined
      : ({
          searching: false,
          message: "",
          sessions: [{ name: "Pixel 9", uri: "http://127.0.0.1:9/a=/" }],
          dtdUris: [],
        } as never),
  );
  render(<DiscoveryPanel disabled={false} onSelect={onSelect} />);
  await userEvent.click(
    await screen.findByRole("button", { name: "Connect to Pixel 9" }),
  );
  expect(invoke).toHaveBeenCalledWith("start_discovery", {
    sdk: "",
    appId: "",
  });
  expect(onSelect).toHaveBeenCalledWith("http://127.0.0.1:9/a=/");
  expect(screen.queryByRole("button", { name: "Close discovery" })).toBeNull();
});
