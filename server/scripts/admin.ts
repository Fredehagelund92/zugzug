#!/usr/bin/env bun
/* admin.ts — super-admin CLI.
 *
 * Usage:
 *   bun run admin -- create-tenant <id> <label> [--warehouse=<id>] [--slug=<slug>]
 *   bun run admin -- promote-super-admin <email>
 *   bun run admin -- demote-super-admin <email>
 *   bun run admin -- list-tenants
 *
 * The CLI reads DATABASE_URL from .env (Bun auto-loads). Run from server/.
 */

import { provisionTenant, listTenants } from "../src/tenant.ts";
import { promoteSuperAdmin, demoteSuperAdmin } from "../src/admin.ts";
import { AppError } from "../src/errors.ts";

const HELP = `Zug Zug admin CLI

Usage:
  bun run admin -- create-tenant <id> <label> [--warehouse=<id>] [--slug=<slug>]
  bun run admin -- promote-super-admin <email>
  bun run admin -- demote-super-admin <email>
  bun run admin -- list-tenants

Examples:
  bun run admin -- create-tenant sportsbook "Sportsbook"
  bun run admin -- promote-super-admin frederik.hagelund@example.com
`;

interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(argv: string[]): Args {
  // argv comes from process.argv.slice(2) — already strips bun + script path.
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (const arg of rest) {
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq === -1) {
        flags[arg.slice(2)] = "true";
      } else {
        flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: command ?? "", positional, flags };
}

async function run(args: Args): Promise<void> {
  switch (args.command) {
    case "create-tenant": {
      const [id, ...labelParts] = args.positional;
      if (!id || labelParts.length === 0) {
        console.error("usage: bun run admin -- create-tenant <id> <label> [--warehouse=<id>] [--slug=<slug>]");
        process.exit(1);
      }
      const label = labelParts.join(" ");
      const t = await provisionTenant({
        id,
        label,
        slug: args.flags.slug,
        warehouseId: args.flags.warehouse,
      });
      console.log(`✓ created tenant ${t.id} (${t.label}) → warehouse ${t.warehouse_id}`);
      return;
    }
    case "promote-super-admin": {
      const [email] = args.positional;
      if (!email) {
        console.error("usage: bun run admin -- promote-super-admin <email>");
        process.exit(1);
      }
      const u = await promoteSuperAdmin(email);
      console.log(`✓ promoted ${u.email} (id=${u.id}) to super-admin`);
      return;
    }
    case "demote-super-admin": {
      const [email] = args.positional;
      if (!email) {
        console.error("usage: bun run admin -- demote-super-admin <email>");
        process.exit(1);
      }
      const u = await demoteSuperAdmin(email);
      console.log(`✓ demoted ${u.email} (id=${u.id}) from super-admin`);
      return;
    }
    case "list-tenants": {
      const tenants = await listTenants();
      for (const t of tenants) {
        console.log(`${t.id.padEnd(24)} ${t.label.padEnd(32)} warehouse=${t.warehouse_id}`);
      }
      return;
    }
    case "":
    case "--help":
    case "-h":
    case "help":
      console.log(HELP);
      return;
    default:
      console.error(`unknown command: ${args.command}\n`);
      console.error(HELP);
      process.exit(1);
  }
}

// Only invoke the dispatcher when run as a script — keeps parseArgs() importable
// from the test file without triggering DB calls at import time.
if (import.meta.path === Bun.main) {
  try {
    await run(parseArgs(process.argv.slice(2)));
  } catch (e) {
    if (e instanceof AppError) {
      console.error(`✗ ${e.code}: ${e.message}`);
      process.exit(1);
    }
    console.error("✗ unexpected error:", e);
    process.exit(1);
  }
}
