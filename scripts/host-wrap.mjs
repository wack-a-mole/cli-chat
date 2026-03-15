#!/usr/bin/env node
/**
 * host-wrap — wraps `claude-duet host --tunnel cloudflare`, intercepts the
 * session credentials once the tunnel is up, sends them to SQS so the
 * always-on EC2 guest machine can join automatically.
 *
 * Required env vars:
 *   SQS_QUEUE_URL          — your SQS queue URL
 *
 * Optional env vars:
 *   AWS_REGION             — defaults to us-east-1
 *   CLAUDE_DUET_GUEST_URL  — the URL you tell the guest to open (your EC2 DNS)
 *                            defaults to https://join.yourdomain.com
 *
 * AWS credentials are picked up automatically from:
 *   - AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY env vars
 *   - ~/.aws/credentials
 *   - EC2/ECS instance role (if running on AWS)
 *
 * Usage:
 *   npm run host-wrap -- [any extra claude-duet host flags]
 *   e.g. npm run host-wrap -- --name alice --no-approval
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const REGION = process.env.AWS_REGION ?? "us-east-1";
const GUEST_URL = process.env.CLAUDE_DUET_GUEST_URL ?? "https://join.yourdomain.com";

if (!QUEUE_URL) {
  console.error("\n  Error: SQS_QUEUE_URL env var is required.\n");
  process.exit(1);
}

const sessionFile = join(tmpdir(), `claude-duet-session-${Date.now()}.json`);

// Pass all extra args after -- straight through to the host command
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
    const client = new SQSClient({ region: REGION });
    await client.send(
      new SendMessageCommand({
        QueueUrl: QUEUE_URL,
        MessageBody: JSON.stringify(session),
      })
    );
    console.log(`\n  Guest join URL → ${GUEST_URL}\n`);
  } catch (err) {
    console.error(`\n  Failed to send to SQS: ${err.message}\n`);
    console.error("  Session info (send manually if needed):");
    console.error(`  ${JSON.stringify(session)}\n`);
  }
}, 500);

child.on("exit", (code) => {
  clearInterval(poll);
  if (existsSync(sessionFile)) unlinkSync(sessionFile);
  process.exit(code ?? 0);
});
