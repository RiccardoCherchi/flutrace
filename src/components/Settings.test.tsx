// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App.tsx";
import { CaptureSession } from "../vm/session.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("changes theme and rebinds shortcuts, and remembers both", async () => {
  const user = userEvent.setup();
  const { unmount } = render(<App session={new CaptureSession()} />);
  fireEvent.keyDown(window, { key: ",", metaKey: true });
  const dialog = screen.getByRole("dialog", { name: "Settings" });
  await user.click(screen.getByRole("button", { name: "Fjord" }));
  await user.click(screen.getByRole("button", { name: "Light" }));
  expect(document.documentElement.dataset.theme).toBe("fjord");
  expect(document.documentElement.dataset.mode).toBe("light");

  const palette = screen.getByRole("button", {
    name: "Show command palette: ⌘P",
  });
  await user.click(palette);
  fireEvent.keyDown(palette, { key: "c", code: "KeyC", metaKey: true });
  expect(screen.getByText(/Reserved/)).toBeDefined();
  fireEvent.keyDown(palette, { key: "j", code: "KeyJ", metaKey: true });
  expect(palette.getAttribute("aria-label")).toBe("Show command palette: ⌘J");
  // Taking a shortcut that is in use moves it.
  const clear = screen.getByRole("button", { name: "Clear log: ⌘K" });
  await user.click(clear);
  fireEvent.keyDown(clear, { key: "j", code: "KeyJ", metaKey: true });
  expect(screen.getByText(/Removed from “Show command palette”/)).toBeDefined();
  await user.click(
    screen.getByRole("button", { name: "Show command palette: not set" }),
  );
  fireEvent.keyDown(document.activeElement!, {
    key: "p",
    code: "KeyP",
    metaKey: true,
    shiftKey: true,
  });
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull();

  fireEvent.keyDown(window, { key: "p", code: "KeyP", metaKey: true });
  expect(screen.queryByRole("dialog", { name: "Command palette" })).toBeNull();
  fireEvent.keyDown(window, {
    key: "p",
    code: "KeyP",
    metaKey: true,
    shiftKey: true,
  });
  expect(screen.getByRole("dialog", { name: "Command palette" })).toBeDefined();

  unmount();
  render(<App session={new CaptureSession()} />);
  expect(
    screen.getByRole("button", { name: /Search commands/ }).textContent,
  ).toContain("⇧⌘P");
  expect(document.documentElement.dataset.theme).toBe("fjord");
});
