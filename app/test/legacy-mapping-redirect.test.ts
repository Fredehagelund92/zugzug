import { describe, test, expect } from "vitest";
import { redirectTarget } from "../src/lib/legacy-mapping-redirect";

describe("legacy /app/mapping redirect rules", () => {
  test("bare /app/mapping → /app/triage", () => {
    expect(redirectTarget(new URLSearchParams(""), new Set(["country"]))).toBe("/app/triage");
  });
  test("?view=all → /app/triage", () => {
    expect(redirectTarget(new URLSearchParams("view=all"), new Set(["country"]))).toBe(
      "/app/triage",
    );
  });
  test("?view=all&filter=mapped → /app/triage?filter=mapped", () => {
    expect(
      redirectTarget(new URLSearchParams("view=all&filter=mapped"), new Set(["country"])),
    ).toBe("/app/triage?filter=mapped");
  });
  test("?dimId=country → /app/tables?open=country&active=country&mode=match", () => {
    expect(redirectTarget(new URLSearchParams("dimId=country"), new Set(["country"]))).toBe(
      "/app/tables?open=country&active=country&mode=match",
    );
  });
  test("?dimId=country&value=US → adds &value=US", () => {
    expect(
      redirectTarget(new URLSearchParams("dimId=country&value=US"), new Set(["country"])),
    ).toBe("/app/tables?open=country&active=country&mode=match&value=US");
  });
  test("?dimId=country&view=single behaves like ?dimId=country", () => {
    expect(
      redirectTarget(new URLSearchParams("dimId=country&view=single"), new Set(["country"])),
    ).toBe("/app/tables?open=country&active=country&mode=match");
  });
  test("unknown dimId → /app/tables (no open) and signals a toast", () => {
    const out = redirectTarget(new URLSearchParams("dimId=ghost"), new Set(["country"]));
    expect(out).toBe("/app/tables?toast=missing-table");
  });
});
