import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logo, WatchingLogo } from "./logo";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.inactive;
});

describe("WatchingLogo", () => {
  it("glances around with one-off moves while idle, never an endless animation", () => {
    const { container } = render(<WatchingLogo />);
    const pupil = container.querySelector<SVGGElement>(".logo-pupil")!;
    expect(container.querySelector("svg")!.getAttribute("class")).not.toContain("gazing");
    expect(pupil.style.transform).toBe("");
    act(() => vi.advanceTimersByTime(2600));
    expect(pupil.style.transform).toMatch(/^translate\(/);
    const first = pupil.style.transform;
    act(() => vi.advanceTimersByTime(2600 + 0.5 * 3400));
    expect(pupil.style.transform).not.toBe(first);
  });

  it("holds still while the window is in the background", () => {
    document.documentElement.dataset.inactive = "";
    const { container } = render(<WatchingLogo />);
    act(() => vi.advanceTimersByTime(20_000));
    expect(container.querySelector<SVGGElement>(".logo-pupil")!.style.transform).toBe("");
  });
});

describe("Logo while loading", () => {
  it("looks around with timed glances and stops when the loader goes away", () => {
    const { container, rerender } = render(<Logo gazing />);
    const pupil = container.querySelector<SVGGElement>(".logo-pupil")!;
    act(() => vi.advanceTimersByTime(250));
    expect(pupil.style.transform).toMatch(/^translate\(/);
    rerender(<Logo />);
    const still = pupil.style.transform;
    act(() => vi.advanceTimersByTime(10_000));
    expect(pupil.style.transform).toBe(still);
  });

  it("holds still with Reduce motion on", () => {
    document.documentElement.dataset.motion = "reduce";
    try {
      const { container } = render(<Logo gazing />);
      act(() => vi.advanceTimersByTime(10_000));
      expect(container.querySelector<SVGGElement>(".logo-pupil")!.style.transform).toBe("");
    } finally {
      delete document.documentElement.dataset.motion;
    }
  });
});
