import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components/Button";

interface Tenant {
  id: string;
  slug: string;
  label: string;
  warehouse_id: string;
}

export function AdminTenants() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [slug, setSlug] = useState("");
  const [label, setLabel] = useState("");
  const [warehouseId, setWarehouseId] = useState("default");

  const refresh = async () => {
    const r = await apiFetch("/tenants");
    if (r.ok) setTenants(((await r.json()) as { tenants: Tenant[] }).tenants);
  };
  useEffect(() => {
    void refresh();
  }, []);

  const create = async () => {
    const r = await apiFetch("/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, label, warehouseId }),
    });
    if (r.ok) {
      setSlug("");
      setLabel("");
      void refresh();
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h1 className="font-display text-2xl font-bold mb-3">Workspaces</h1>
        <ul className="divide-y divide-line">
          {tenants.map((t) => (
            <li key={t.id} className="py-2 flex gap-4">
              <span className="font-mono text-sm">{t.slug}</span>
              <span>{t.label}</span>
              <span className="text-ink-2">{t.warehouse_id}</span>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="font-display text-lg font-bold mb-2">New workspace</h2>
        <div className="flex gap-2">
          <input
            className="rounded-sm border px-2 py-1"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="slug"
          />
          <input
            className="rounded-sm border px-2 py-1"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="label"
          />
          <input
            className="rounded-sm border px-2 py-1"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            placeholder="warehouse_id"
          />
          <Button onClick={create}>Create</Button>
        </div>
      </section>
    </div>
  );
}
