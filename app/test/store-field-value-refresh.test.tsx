import { describe, test, expect, beforeAll, afterEach, afterAll } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "./msw/server.ts";
import { initStore, setFieldValue, useRefTables } from "../src/store.ts";
import { render, act } from "@testing-library/react";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const FIELDS = [
  { field: "flag", label: "Flag", type: "boolean" },
  { field: "stars", label: "Stars", type: "rating" },
  { field: "note", label: "Note", type: "text" },
  { field: "amount", label: "Amount", type: "number" },
];

function tablePayload() {
  return [
    {
      id: "d1",
      refTable: "Vendors",
      dimTable: "dim_vendors",
      mapTable: "map_vendors",
      keyCol: "vendor_key",
      rows: 1,
      fields: FIELDS,
      record: [
        {
          key: "acme",
          label: "Acme",
          version: 1,
          unresolved: false,
          variants: 0,
          position: null,
          fields: { flag: "false", stars: "2", note: "hi", amount: "1" },
        },
      ],
      counts: {
        newCount: 0,
        mappedCount: 0,
        totalDistinct: 0,
        unmappedRowsTotal: 0,
        mappedRowsTotal: 0,
        scannedAt: null,
      },
    },
  ];
}

/** Renders on every store emit, recording the identity of the table object.
 *  TablePane's publish-state effect is keyed on exactly this identity, so a
 *  new identity is what makes the unpublished-changes count re-read. */
function useIdentityLog(log: unknown[]) {
  const tables = useRefTables();
  const t = tables.find((x) => x.id === "d1");
  if (t && log[log.length - 1] !== t) log.push(t);
  return null;
}

async function setupStore(log: unknown[]) {
  window.history.pushState({}, "", "/app/acme/tables");
  server.use(
    http.get("/api/t/:slug/tables", () => HttpResponse.json(tablePayload())),
    http.get("/api/t/:slug/tables/:id", () => HttpResponse.json(tablePayload()[0])),
  );
  await act(async () => {
    await initStore();
  });
  const Probe = () => useIdentityLog(log);
  render(<Probe />);
  await act(async () => {});
}

/** After a field write the store must notify subscribers *again* once the PUT
 *  has resolved. The optimistic notification fires before the request is even
 *  sent, so a publish-state read triggered by it races the write and reports
 *  the pre-edit count (#194). */
describe.each(FIELDS)("setFieldValue notifies after the write settles — $type", (f) => {
  test(`${f.type} field re-notifies once the PUT resolves`, async () => {
    const log: unknown[] = [];
    await setupStore(log);

    let releasePut: () => void = () => {};
    const putSent = new Promise<void>((resolveSent) => {
      server.use(
        http.put("/api/t/:slug/tables/:id/record/:key/field/:field", async () => {
          resolveSent();
          await new Promise<void>((r) => (releasePut = r));
          return HttpResponse.json({ ok: true });
        }),
      );
    });

    const write = setFieldValue("d1", "acme", f.field, f.type === "boolean" ? "true" : "9");

    // The optimistic notification has fired by now; the PUT is still in flight.
    await putSent;
    await act(async () => {});
    const beforeResolve = log.length;
    expect(beforeResolve).toBeGreaterThan(0); // optimistic emit happened

    await act(async () => {
      releasePut();
      await write;
      // let any follow-up refresh settle
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(log.length).toBeGreaterThan(beforeResolve);
  });
});
