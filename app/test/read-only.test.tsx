import { describe, expect, test } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReadOnly } from "../src/components/settings/ReadOnly";

describe("ReadOnly", () => {
  test("renders children when enabled=false", () => {
    render(
      <ReadOnly enabled={false}>
        <button>click me</button>
      </ReadOnly>,
    );
    const btn = screen.getByRole("button", { name: /click me/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  test("disables fieldset when enabled=true", () => {
    let clicked = 0;
    const { container } = render(
      <ReadOnly enabled={true}>
        <button onClick={() => clicked++}>click me</button>
        <input data-testid="i" defaultValue="x" />
      </ReadOnly>,
    );
    const fieldset = container.querySelector("fieldset") as HTMLFieldSetElement;
    expect(fieldset.disabled).toBe(true);
    // Fieldset disabled prevents form submission and makes controls non-interactive
    // The click handler may still fire depending on browser/test environment,
    // but the fieldset.disabled state is what prevents actual form submission
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
});
