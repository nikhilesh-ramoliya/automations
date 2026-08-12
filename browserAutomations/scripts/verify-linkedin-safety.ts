/**
 * Quick unit-style checks for LinkedIn safety cap math + delay smoke.
 * Run: npx tsx scripts/verify-linkedin-safety.ts
 */
import assert from "node:assert/strict";
import {
  ProfileBusyError,
  SafetyLimitError,
  acquireLinkedInJobLock,
  clampDesiredToCap,
  holdsLinkedInJobLock,
  humanDelay,
  jobNeedsLinkedInLock,
  listDelayOps,
  looksLikeRestrictionOrChallenge,
  releaseLinkedInJobLock,
  resolveDelayOp,
  sampleHumanDelayMs,
} from "../lib/linkedin-safety.js";
import { classifyFailure, decideHeal } from "../lib/heal.js";
import type { JobDefinition } from "../lib/job-types.js";

function testClamp() {
  assert.equal(clampDesiredToCap(10, 0, 20), 10);
  assert.equal(clampDesiredToCap(10, 15, 20), 5);
  assert.equal(clampDesiredToCap(10, 20, 20), 0);
  assert.equal(clampDesiredToCap(10, 25, 20), 0);
  assert.equal(clampDesiredToCap(-3, 0, 20), 0);
  console.log("ok clampDesiredToCap");
}

function testRestrictionUrls() {
  assert.equal(
    looksLikeRestrictionOrChallenge(
      "https://www.linkedin.com/checkpoint/challenge/...",
    ),
    true,
  );
  assert.equal(
    looksLikeRestrictionOrChallenge("https://www.linkedin.com/feed/"),
    false,
  );
  console.log("ok looksLikeRestrictionOrChallenge");
}

function testHealClassification() {
  const job = {
    id: "t",
    name: "t",
    description: "",
    entry: "run.ts",
    tags: [],
    requiresAuth: true,
    env: [],
  } as JobDefinition;

  const cap = classifyFailure(
    new SafetyLimitError("invite", 20, 20),
  );
  assert.equal(cap.kind, "safety_limit");
  assert.equal(decideHeal(job, cap, 0).action, "soft_success");

  const rest = classifyFailure(
    new Error(
      "LinkedIn restriction/checkpoint detected (url=https://www.linkedin.com/checkpoint/x). Cool down.",
    ),
  );
  assert.equal(rest.kind, "linkedin_restriction");
  assert.equal(decideHeal(job, rest, 0).action, "abort");

  console.log("ok heal safety_limit + restriction");
}

function testDelayOps() {
  assert.equal(resolveDelayOp("short"), "idle_micro");
  assert.equal(resolveDelayOp("read"), "read_card");
  assert.equal(resolveDelayOp("type"), "type_burst");
  assert.equal(resolveDelayOp("click"), "click");

  const sampleOps = [
    "click",
    "type_char",
    "read_card",
    "read_profile",
    "read_website",
    "search",
    "nav",
    "invite_think",
    "between_companies",
    "between_actions",
    "idle_micro",
  ] as const;

  console.log("\nSample delay ranges (ms, LI_SAFE_DELAY_MULT applied, no distraction):");
  console.log(
    `${"op".padEnd(20)} ${"spec[lo/mode/hi]".padEnd(22)} n=8 samples`,
  );
  for (const op of sampleOps) {
    const spec = listDelayOps().find((s) => s.op === op)!;
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      samples.push(
        sampleHumanDelayMs(op, {
          distraction: false,
          distribution: i % 2 === 0 ? "triangular" : "lognormal",
        }),
      );
    }
    const rangeLabel = `${spec.lo}/${spec.mode}/${spec.hi}`;
    console.log(
      `  ${op.padEnd(18)} ${rangeLabel.padEnd(22)} ${samples.join(", ")}`,
    );
    for (const ms of samples) {
      // Allow distraction-off samples to sit in [lo, hi] × mult (mult default 1)
      assert.ok(
        ms >= Math.floor(spec.lo * 0.5) && ms <= Math.ceil(spec.hi * 1.05),
        `${op} sample ${ms} outside expected band`,
      );
    }
  }
  console.log("ok delay op samples + legacy aliases\n");
}

async function testDelaySmoke() {
  const started = Date.now();
  const ms = await humanDelay("idle_micro", {
    minMs: 50,
    maxMs: 80,
    distraction: false,
    skipBurstCheck: true,
  });
  const elapsed = Date.now() - started;
  assert.ok(ms >= 50 && ms <= 80, `ms=${ms}`);
  assert.ok(elapsed >= 40, `elapsed=${elapsed}`);
  console.log(`ok humanDelay smoke (${ms}ms)`);
}

function testJobNeedsLock() {
  assert.equal(
    jobNeedsLinkedInLock({
      requiresAuth: true,
      tags: [],
    }),
    true,
  );
  assert.equal(
    jobNeedsLinkedInLock({
      requiresAuth: false,
      tags: ["linkedin"],
    }),
    true,
  );
  assert.equal(
    jobNeedsLinkedInLock({
      requiresAuth: false,
      tags: ["leads"],
    }),
    false,
  );
  assert.equal(
    jobNeedsLinkedInLock({
      requiresAuth: true,
      tags: ["linkedin"],
      linkedinLock: false,
    }),
    false,
  );
  console.log("ok jobNeedsLinkedInLock");
}

function testLockNestDepth() {
  acquireLinkedInJobLock("verify-outer");
  assert.equal(holdsLinkedInJobLock(), true);
  acquireLinkedInJobLock("verify-inner");
  assert.equal(holdsLinkedInJobLock(), true);
  assert.equal(releaseLinkedInJobLock(), false); // still held
  assert.equal(holdsLinkedInJobLock(), true);
  assert.equal(releaseLinkedInJobLock(), true); // fully released
  assert.equal(holdsLinkedInJobLock(), false);
  console.log("ok linkedin lock nest depth");
}

function testHealBusyAbort() {
  const job = {
    id: "t",
    name: "t",
    description: "",
    entry: "run.ts",
    tags: [],
    requiresAuth: true,
    env: [],
  } as JobDefinition;

  const busy = classifyFailure(
    new ProfileBusyError("lead-pipeline pid=1 since 2026-01-01"),
  );
  assert.equal(busy.kind, "profile_lock");
  assert.equal(decideHeal(job, busy, 0).action, "abort");
  console.log("ok ProfileBusyError aborts (no retry)");
}

async function main() {
  testClamp();
  testRestrictionUrls();
  testHealClassification();
  testJobNeedsLock();
  testLockNestDepth();
  testHealBusyAbort();
  testDelayOps();
  await testDelaySmoke();
  console.log("\nAll linkedin-safety checks passed.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
