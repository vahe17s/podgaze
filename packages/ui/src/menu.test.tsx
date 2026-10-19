import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { menuFor, RowMenu } from "./menu";

afterEach(cleanup);

describe("RowMenu", () => {
  // In a browser the right-click that opens the menu reaches window after the menu's listener is added.
  it("stays open for the right-click that opened it and for one that moves it to another row", () => {
    const onClose = vi.fn();
    render(<RowMenu x={10} y={10} title="Pod · api" sections={menuFor("Pod")} onPick={() => undefined} onClose={onClose} />);
    const opening = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    opening.preventDefault();
    document.body.dispatchEvent(opening);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("closes on a click or a plain right-click outside, and on Escape", () => {
    const onClose = vi.fn();
    render(<RowMenu x={10} y={10} sections={menuFor("Pod")} onPick={() => undefined} onClose={onClose} />);
    fireEvent.click(document.body);
    document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
