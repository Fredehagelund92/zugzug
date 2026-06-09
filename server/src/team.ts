/* team.ts — allowed_emails management. Any logged-in user can add/remove members.
   Self-removal is blocked. Domain is validated on add. */

import { pgRun as run, pgAll as all, pgGet as get } from "./pg.ts";
import { env, pg } from "./env.ts";

export interface Member {
  email: string;
  addedBy: string;
  addedAt: string;
}

export async function listMembers(): Promise<Member[]> {
  const rows = await all<{ email: string; added_by_name: string; added_at: string }>(
    `SELECT ae.email, COALESCE(u.name, ae.added_by) AS added_by_name, ae.added_at
     FROM ${pg("allowed_emails")} ae
     LEFT JOIN ${pg("users")} u ON u.id = ae.added_by
     ORDER BY ae.added_at`,
  );
  return rows.map((r) => ({ email: r.email, addedBy: r.added_by_name, addedAt: r.added_at }));
}

export async function addMember(email: string, addedById: string): Promise<void> {
  const domain = email.split("@")[1];
  if (domain !== env.allowedDomain) throw Object.assign(new Error("wrong_domain"), { status: 400 });
  await run(
    `INSERT INTO ${pg("allowed_emails")} (email, added_by, added_at) VALUES ($1, $2, current_timestamp)`,
    [email, addedById],
  );
}

export async function removeMember(email: string, requesterId: string): Promise<void> {
  const requester = await get<{ email: string }>(`SELECT email FROM ${pg("users")} WHERE id = $1`, [
    requesterId,
  ]);
  if (requester?.email === email)
    throw Object.assign(new Error("cannot_remove_self"), { status: 400 });
  await run(`DELETE FROM ${pg("allowed_emails")} WHERE email = $1`, [email]);
}

// ---------------------------------------------------------------------------
// Team users with roles
// ---------------------------------------------------------------------------

export interface TeamUser {
  id: string;
  name: string;
  email: string | null;
  role: string;
}

export async function listTeamUsers(): Promise<TeamUser[]> {
  return all<TeamUser>(`SELECT id, name, email, role FROM ${pg("users")} ORDER BY name ASC`);
}

export async function updateUserRole(targetId: string, newRole: string): Promise<void> {
  if (newRole !== "admin" && newRole !== "editor" && newRole !== "viewer") {
    throw Object.assign(new Error("invalid_role"), { status: 400 });
  }
  // Last-admin guard: if we're demoting an admin, ensure another admin exists
  if (newRole !== "admin") {
    const target = await get<{ role: string }>(`SELECT role FROM ${pg("users")} WHERE id = $1`, [
      targetId,
    ]);
    if (target?.role === "admin") {
      const adminCount = await get<{ n: string }>(
        `SELECT COUNT(*) AS n FROM ${pg("users")} WHERE role = 'admin'`,
      );
      if (Number(adminCount?.n ?? 0) <= 1) {
        throw Object.assign(new Error("last_admin"), {
          status: 400,
          reason: "Cannot demote the last admin.",
        });
      }
    }
  }
  await run(`UPDATE ${pg("users")} SET role = $1 WHERE id = $2`, [newRole, targetId]);
}
