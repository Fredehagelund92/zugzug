import type { ReactElement } from "react";
import { render, type RenderResult } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/** Render a component inside the app's providers (currently just the router). */
export function renderWithProviders(ui: ReactElement, opts: { route?: string } = {}): RenderResult {
  return render(ui, {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[opts.route ?? "/"]}>{children}</MemoryRouter>
    ),
  });
}
