import { describe, test, expect } from "vitest";
import { render } from "@testing-library/react";
import { DataGrid } from "../src/components/datagrid/DataGrid";
import { UndoStackProvider } from "../src/components/datagrid/UndoStack";
import type { ColumnDef } from "../src/components/datagrid/types";

interface Row {
  id: string;
  text: string;
  email: string;
  url: string;
}

const LONG_TEXT = "This is a very long value that will definitely be truncated in the cell";
const LONG_EMAIL = "user.with.a.very.long.name@example-domain-that-is-quite-long.com";
const LONG_URL = "https://example.com/path/to/some/very/long/resource/that-is-definitely-truncated";

const columns: ColumnDef<Row>[] = [
  { field: "text", label: "Text", config: { type: "text" }, editable: false },
  { field: "email", label: "Email", config: { type: "email" }, editable: false },
  { field: "url", label: "URL", config: { type: "url" }, editable: false },
];

function setup() {
  const rows: Row[] = [
    { id: "1", text: LONG_TEXT, email: LONG_EMAIL, url: LONG_URL },
  ];
  return render(
    <UndoStackProvider>
      <DataGrid
        rows={rows}
        columns={columns}
        rowKey={(r) => r.id}
        onCommit={async () => {}}
      />
    </UndoStackProvider>,
  );
}

describe("truncated cell hover reveal (title attribute)", () => {
  test("TextCell Renderer span carries title equal to the full value", () => {
    const { container } = setup();
    const span = container.querySelector<HTMLElement>(
      `span.truncate[title="${LONG_TEXT}"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.title).toBe(LONG_TEXT);
  });

  test("EmailCell Renderer span carries title equal to the full email", () => {
    const { container } = setup();
    const span = container.querySelector<HTMLElement>(
      `span.truncate[title="${LONG_EMAIL}"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.title).toBe(LONG_EMAIL);
  });

  test("UrlCell Renderer span carries title equal to the full URL", () => {
    const { container } = setup();
    const span = container.querySelector<HTMLElement>(
      `span.truncate[title="${LONG_URL}"]`,
    );
    expect(span).not.toBeNull();
    expect(span!.title).toBe(LONG_URL);
  });

  test("empty TextCell (—) has no title", () => {
    const emptyRows: Row[] = [{ id: "2", text: "", email: "", url: "" }];
    const { container } = render(
      <UndoStackProvider>
        <DataGrid
          rows={emptyRows}
          columns={columns}
          rowKey={(r) => r.id}
          onCommit={async () => {}}
        />
      </UndoStackProvider>,
    );
    // The em-dash spans should not have a title
    const dashSpans = Array.from(container.querySelectorAll<HTMLElement>("span")).filter(
      (s) => s.textContent === "—",
    );
    expect(dashSpans.length).toBeGreaterThan(0);
    for (const s of dashSpans) {
      expect(s.title).toBe("");
    }
  });
});
