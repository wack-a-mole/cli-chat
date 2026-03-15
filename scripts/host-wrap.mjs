#!/usr/bin/env node
/**
 * host-wrap — wraps `claude-duet host --tunnel cloudflare`, intercepts the
 * session credentials once the tunnel is up, and POSTs them directly to the
 * always-on EC2 guest machine so it can join automatically.
 *
 * Required env vars:
 *   LAMBDA_URL             — your EC2 webhook endpoint
 *                            e.g. https://join.yourdomain.com/session
 *
 * Optional env vars:
 *   CLAUDE_DUET_GUEST_URL  — the URL you tell the guest to open (your EC2 DNS)
 *                            defaults to https://join.yourdomain.com
 *
 * No AWS credentials needed — posts directly to the EC2 over HTTPS.
 *
 * Usage:
 *   npm run host-wrap -- [any extra claude-duet host flags]
 *   e.g. npm run host-wrap -- --name alice --no-approval
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LAMBDA_URL = process.env.LAMBDA_URL;
const GUEST_URL = process.env.CLAUDE_DUET_GUEST_URL ?? "https://join.yourdomain.com";

if (!LAMBDA_URL) {
  console.error("\n  Error: LAMBDA_URL env var is required.\n");
  process.exit(1);
}

const sessionFile = join(tmpdir(), `claude-duet-session-${Date.now()}.json`);

const extraArgs = process.argv.slice(2);

const child = spawn(
  "claude-duet",
  ["host", "--tunnel", "cloudflare", ...extraArgs],
  {
    env: { ...process.env, CLAUDE_DUET_SESSION_FILE: sessionFile },
    stdio: "inherit", // full TTY passthrough — Ink UI renders normally
  }
);

// Poll for the temp file written by host.ts once the tunnel is ready
const poll = setInterval(async () => {
  if (!existsSync(sessionFile)) return;
  clearInterval(poll);

  let session;
  try {
    session = JSON.parse(readFileSync(sessionFile, "utf8"));
    unlinkSync(sessionFile);
  } catch {
    console.error("\n  Failed to read session file.\n");
    return;
  }

  try {
    const res = await fetch(LAMBDA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(session),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    console.log(`\n  Guest join URL → ${GUEST_URL}\n`);
  } catch (err) {
    console.error(`\n  Failed to reach Lambda: ${err.message}\n`);
    console.error("  Session info (send manually if needed):");
    console.error(`  ${JSON.stringify(session)}\n`);
  }
}, 500);

child.on("exit", (code) => {
  clearInterval(poll);
  if (existsSync(sessionFile)) unlinkSync(sessionFile);
  process.exit(code ?? 0);
});
