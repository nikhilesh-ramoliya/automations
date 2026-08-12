/**
 * Print LinkedIn safety usage, remaining daily budget, and job lock.
 *
 *   npm run safety:status
 *   npm run safety:status -- --json
 */
import "dotenv/config";
import {
  LINKEDIN_SAFETY_PATHS,
  localDateKey,
  peekLinkedInJobLock,
  safetyStatus,
} from "../lib/linkedin-safety.js";
import path from "node:path";

function printHuman(): void {
  const s = safetyStatus();
  const lock = peekLinkedInJobLock();
  const today = localDateKey();

  console.log("\n── LinkedIn safety ──");
  console.log(` Date (local):     ${s.date}${s.date !== today ? ` (today is ${today} — counters will reset on next write)` : ""}`);
  console.log(` Delay mult:       ${s.delayMult}`);
  console.log(` Max job runtime:  ${s.maxJobRuntimeMin} min (active)`);
  console.log(
    ` Burst:            ${s.sessionActionsSinceBreak}/${s.burstThreshold} actions since last break`,
  );
  console.log("");
  console.log(" Action          used / cap   remaining");
  const actions = Object.keys(s.caps).sort() as Array<keyof typeof s.caps>;
  for (const a of actions) {
    const used = s.counts[a] ?? 0;
    const cap = s.caps[a];
    const left = s.remaining[a];
    const name = a.padEnd(14);
    const mid = `${used}/${cap}`.padEnd(10);
    console.log(` ${name} ${mid} ${left}`);
  }
  console.log("");
  if (lock) {
    console.log(
      ` Lock: HELD by "${lock.jobId}" pid=${lock.pid} since ${lock.startedAt}`,
    );
  } else {
    console.log(" Lock: free");
  }
  console.log(
    ` File: ${path.relative(process.cwd(), LINKEDIN_SAFETY_PATHS.usageFile)}`,
  );
  console.log("");
}

function main(): void {
  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          ...safetyStatus(),
          lock: peekLinkedInJobLock(),
          paths: LINKEDIN_SAFETY_PATHS,
        },
        null,
        2,
      ),
    );
    return;
  }
  printHuman();
}

main();
