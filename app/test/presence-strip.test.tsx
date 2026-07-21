import { describe, test, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PresenceStrip } from "../src/components/datagrid/PresenceStrip";
import type { PeerState } from "../src/lib/use-presence";

function makePeer(over: Partial<PeerState> = {}): PeerState {
  return {
    userId: "u_mia",
    displayName: "Mia Berg",
    color: "coral",
    cell: null,
    selection: null,
    away: false,
    ...over,
  };
}

describe("PresenceStrip", () => {
  test("renders one avatar per peer with initials", () => {
    const peers = [
      makePeer({ userId: "u_a", displayName: "Alice Wonder" }),
      makePeer({ userId: "u_b", displayName: "Bob Smith" }),
    ];
    render(<PresenceStrip peers={peers} />);
    expect(screen.getByText("AW")).toBeInTheDocument();
    expect(screen.getByText("BS")).toBeInTheDocument();
  });

  test("renders nothing when peers is empty", () => {
    const { container } = render(<PresenceStrip peers={[]} />);
    // The outer div may render but it shouldn't contain any avatars
    expect(container.querySelectorAll("[data-presence-avatar]")).toHaveLength(0);
  });

  test("away peer has lower opacity / grayscale", () => {
    render(<PresenceStrip peers={[makePeer({ away: true })]} />);
    const avatar = screen.getByText("MB");
    expect(avatar.className).toMatch(/grayscale|opacity-/);
  });

  test("active peer uses peer.color in its ring style", () => {
    render(<PresenceStrip peers={[makePeer({ color: "sky" })]} />);
    const avatar = screen.getByText("MB");
    expect(avatar.getAttribute("style")).toContain("--tint-sky");
  });

  test("ring uses the surface color so it separates the avatar from its fill", () => {
    render(<PresenceStrip peers={[makePeer({ color: "sky" })]} />);
    const avatar = screen.getByText("MB");
    const style = avatar.getAttribute("style") ?? "";
    // A ring the same color as the fill is invisible — it must contrast.
    expect(style).toMatch(/box-shadow:[^;]*var\(--surface\)/);
    expect(style).not.toMatch(/box-shadow:[^;]*--tint-/);
  });

  test("overflow: shows first 8 avatars + '+N' counter when peers > 8", () => {
    const peers = Array.from({ length: 11 }, (_, i) =>
      makePeer({ userId: `u_${i}`, displayName: `User Number${i}` }),
    );
    render(<PresenceStrip peers={peers} />);
    expect(screen.getByText(/\+3/)).toBeInTheDocument();
  });

  test("handles single-word display names", () => {
    render(<PresenceStrip peers={[makePeer({ displayName: "Cher" })]} />);
    expect(screen.getByText("C")).toBeInTheDocument();
  });
});
