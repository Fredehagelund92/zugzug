#!/usr/bin/env bun
/* quickstart.ts — first-run interactive setup.
 *
 *   bun run quickstart
 *
 * Writes server/.env from prompts, then runs bootstrap. After this, the user
 * can `bun run start` (in server/) and `bun run dev` (in app/) and visit
 * http://localhost:5173/login to create the first admin account.
 *
 * Safe to re-run. If server/.env already exists, the script asks before
 * overwriting it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ENV_PATH = resolve(import.meta.dir, "..", ".env");
const EXAMPLE_PATH = resolve(import.meta.dir, "..", ".env.example");

const DEFAULT_DATABASE_URL = "postgres://zugzug:zugzug@localhost:55432/zugzug";

const rl = createInterface({ input, output });

const banner = `
================================================
  Zugzug quickstart
================================================
  Walks you through:
    1. server/.env  — the credentials this app needs
    2. bootstrap    — create Postgres tables + seed system rows
    3. next steps   — how to launch the dev servers
================================================
`;

console.log(banner);

async function ask(question: string, fallback?: string): Promise<string> {
  const hint = fallback ? ` (${fallback})` : "";
  const answer = (await rl.question(`${question}${hint}: `)).trim();
  return answer || fallback || "";
}

async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
  if (!answer) return fallback;
  return answer === "y" || answer === "yes";
}

// --- Step 1: write .env ---

if (existsSync(ENV_PATH)) {
  console.log(`Found existing ${ENV_PATH}`);
  const overwrite = await askYesNo("Overwrite it?", false);
  if (!overwrite) {
    console.log("Keeping existing .env. Skipping to bootstrap.");
  } else {
    await writeEnv();
  }
} else {
  await writeEnv();
}

async function writeEnv(): Promise<void> {
  console.log("\n--- Database ---");
  const databaseUrl = await ask("Postgres DATABASE_URL", DEFAULT_DATABASE_URL);

  console.log("\n--- Warehouse ---");
  console.log(
    "ATTACH_WAREHOUSE pulls source values from MotherDuck. Off by default — you can flip it on later.",
  );
  const attachWarehouse = await askYesNo("Attach a MotherDuck warehouse now?", false);

  let motherduckToken = "";
  if (attachWarehouse) {
    console.log(
      "Get a MotherDuck token at https://app.motherduck.com → Settings → Access Tokens.",
    );
    motherduckToken = await ask("MOTHERDUCK_TOKEN");
    if (!motherduckToken) {
      console.log("No token entered. Defaulting ATTACH_WAREHOUSE back to false.");
    }
  }

  const lines: string[] = [];
  if (existsSync(EXAMPLE_PATH)) {
    // Seed with the .env.example so optional vars are documented inline.
    const example = readFileSync(EXAMPLE_PATH, "utf8");
    lines.push(example);
  }

  // Append (or replace) the values the user just provided. .env supports
  // later-wins semantics, so plain appending is safe.
  lines.push("\n# Set by `bun run quickstart`");
  lines.push(`DATABASE_URL=${databaseUrl}`);
  if (motherduckToken) {
    lines.push(`MOTHERDUCK_TOKEN=${motherduckToken}`);
    lines.push(`ATTACH_WAREHOUSE=true`);
  } else {
    lines.push(`ATTACH_WAREHOUSE=false`);
  }

  writeFileSync(ENV_PATH, lines.join("\n") + "\n");
  console.log(`\nWrote ${ENV_PATH}`);
}

// --- Step 2: run bootstrap ---

rl.close();

console.log("\n--- Bootstrap ---");
console.log("Running `bun run bootstrap` — creates Postgres tables and seeds system rows.\n");

const bootstrap = spawn("bun", ["run", "bootstrap"], {
  cwd: resolve(import.meta.dir, ".."),
  stdio: "inherit",
});

const bootstrapExit = await new Promise<number>((res) => {
  bootstrap.on("exit", (code) => res(code ?? 1));
});

if (bootstrapExit !== 0) {
  console.error(`\nBootstrap exited with code ${bootstrapExit}. Fix the error above and retry.`);
  process.exit(bootstrapExit);
}

// --- Step 3: print next steps ---

const nextSteps = `
================================================
  Quickstart complete.
================================================

  Start the backend (this terminal):
    cd server && bun run start

  Start the frontend (a second terminal):
    cd app && bun run dev

  Visit http://localhost:5173/login. The first user to sign up
  is promoted to admin and added to the team allowlist.

================================================
`;

console.log(nextSteps);
