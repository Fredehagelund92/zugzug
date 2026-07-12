import { describe, test, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { CursorOverlay } from "../src/components/datagrid/CursorOverlay";
import type { PeerState } from "../src/lib/use-presence";

function makePeer(over: Partial<PeerState> = {}): PeerState {
  return {
    userId: "u_mia",
    displayName: "Mia Berg",
    color: "coral",
    cell: { rowKey: "r3", field: "col2" },
    selection: null,
    away: false,
    ...over,
  };
}

describe("CursorOverlay", () => {
  test("renders one cursor per peer with a known cell", () => {
    const peers = [
      makePeer({ userId: "u_a", displayName: "Alice" }),
      makePeer({ userId: "u_b", displayName: "Bob", cell: { rowKey: "r5", field: "col7" } }),
    ];
    render(
      <CursorOverlay
        peers={peers}
        cellRect={() => ({ top: 0, left: 0, width: 100, height: 30 })}
      />,
    );
    expect(screen.getByText(/alice/i)).toBeInTheDocument();
    expect(screen.getByText(/bob/i)).toBeInTheDocument();
  });

  test("skips peers with null cell", () => {
    render(
      <CursorOverlay
        peers={[makePeer({ cell: null })]}
        cellRect={() => ({ top: 0, left: 0, width: 100, height: 30 })}
      />,
    );
    expect(screen.queryByText(/mia/i)).not.toBeInTheDocument();
  });

  test("skips peers whose cellRect returns null", () => {
    render(<CursorOverlay peers={[makePeer()]} cellRect={() => null} />);
    expect(screen.queryByText(/mia/i)).not.toBeInTheDocument();
  });

  test("positions cursor at the cell's rect", () => {
    const peer = makePeer({ cell: { rowKey: "r1", field: "col1" } });
    const cellRect = vi.fn(() => ({ top: 50, left: 80, width: 100, height: 30 }));
    render(<CursorOverlay peers={[peer]} cellRect={cellRect} />);
    expect(cellRect).toHaveBeenCalledWith("r1", "col1");
    const cell = screen.getByText(/mia berg/i).parentElement;
    expect(cell?.style.top).toBe("50px");
    expect(cell?.style.left).toBe("80px");
    expect(cell?.style.width).toBe("100px");
    expect(cell?.style.height).toBe("30px");
  });

  test("uses peer.color in the inline styles", () => {
    render(
      <CursorOverlay
        peers={[makePeer({ color: "sky" })]}
        cellRect={() => ({ top: 0, left: 0, width: 100, height: 30 })}
      />,
    );
    const label = screen.getByText(/mia berg/i);
    expect(label.getAttribute("style")).toContain("--tint-sky");
  });
});
