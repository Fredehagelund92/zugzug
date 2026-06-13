import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ReadOnly } from "../src/components/settings/ReadOnly";

describe("ReadOnly", () => {
  test("renders children with no disabling when enabled=false", () => {
    render(
      <ReadOnly enabled={false}>
        <button>click me</button>
      </ReadOnly>,
    );
    // fieldset should not have disabled attribute
    const btn = screen.getByRole("button", { name: /click me/i });
    const fieldset = btn.closest("fieldset")!;
    expect(fieldset.disabled).toBe(false);
  });

  test("wraps in disabled fieldset when enabled=true", () => {
    render(
      <ReadOnly enabled={true}>
        <button>click me</button>
        <input data-testid="i" defaultValue="x" />
      </ReadOnly>,
    );
    const btn = screen.getByRole("button", { name: /click me/i });
    const fieldset = btn.closest("fieldset")!;
    // The fieldset itself is disabled — this is what disables child controls in browsers.
    // jsdom does not propagate .disabled to child elements (known limitation),
    // but real browsers do. We verify the fieldset is disabled and has opacity class.
    expect(fieldset.disabled).toBe(true);
    expect(fieldset.className).toMatch(/opacity-70/);
    expect(fieldset.className).toMatch(/cursor-not-allowed/);
  });

  test("sets aria-disabled on the wrapper for screen readers", () => {
    render(
      <ReadOnly enabled={true}>
        <span data-testid="kid">x</span>
      </ReadOnly>,
    );
    const wrapper = screen.getByTestId("kid").parentElement!;
    expect(wrapper.getAttribute("aria-disabled")).toBe("true");
  });

  test("no aria-disabled when enabled=false", () => {
    render(
      <ReadOnly enabled={false}>
        <span data-testid="kid">x</span>
      </ReadOnly>,
    );
    const wrapper = screen.getByTestId("kid").parentElement!;
    expect(wrapper.getAttribute("aria-disabled")).toBeNull();
  });
});
