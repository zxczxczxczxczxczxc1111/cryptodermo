import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearNow, copyWithAutoClear } from "./clipboard";

function mockClipboard() {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
  return writeText;
}

describe("copyWithAutoClear", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the given value to the clipboard immediately", async () => {
    const writeText = mockClipboard();

    await copyWithAutoClear("s3cr3t-value");

    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("s3cr3t-value");
  });

  it("clears the clipboard after the given delay has elapsed", async () => {
    const writeText = mockClipboard();

    await copyWithAutoClear("s3cr3t-value", 30000);
    expect(writeText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29999);
    expect(writeText).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("");
  });
});

describe("clearNow", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the clipboard immediately without waiting for the timer", async () => {
    const writeText = mockClipboard();

    await copyWithAutoClear("s3cr3t-value", 30000);
    expect(writeText).toHaveBeenCalledTimes(1);

    clearNow();

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(writeText).toHaveBeenLastCalledWith("");
  });

  it("does not fire the original auto-clear timer again after clearNow ran", async () => {
    const writeText = mockClipboard();

    await copyWithAutoClear("s3cr3t-value", 30000);
    clearNow();
    expect(writeText).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30000);

    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("does nothing if nothing was copied by this module (does not clobber unrelated clipboard content)", () => {
    const writeText = mockClipboard();

    clearNow();

    expect(writeText).not.toHaveBeenCalled();
  });
});
