/**
 * CLI: list / run browser automation jobs.
 *
 *   npx tsx scripts/jobs-cli.ts list [--json]
 *   npx tsx scripts/jobs-cli.ts run <jobId> [--dry-run|--no-dry-run] [--no-heal]
 */
import "dotenv/config";
import { discoverJobs, writeRegistrySnapshot } from "../lib/registry.js";
import { runJob } from "../lib/runner.js";

function printHelp(): void {
  console.log(`
Browser automation jobs

  npm run jobs:list [-- --json]
  npm run jobs:run -- <jobId> [--dry-run|--no-dry-run] [--no-heal]

Examples:
  npm run jobs:list
  npm run jobs:run -- linkedin-invite-follow-lanatus --dry-run
  npm run invite:lanatus
`.trim());
}

function listJobs(asJson: boolean): number {
  const jobs = discoverJobs();
  writeRegistrySnapshot();

  if (asJson) {
    console.log(JSON.stringify(jobs, null, 2));
    return 0;
  }

  if (jobs.length === 0) {
    console.log("No jobs found under jobs/*/job.json");
    return 0;
  }

  console.log("\nAvailable jobs:\n");
  for (const j of jobs) {
    const tags = j.tags.length ? ` [${j.tags.join(", ")}]` : "";
    console.log(`  ${j.id}`);
    console.log(`    ${j.name}${tags}`);
    console.log(`    ${j.description}`);
    if (j.run?.npmScript) {
      console.log(`    alias: npm run ${j.run.npmScript}`);
    }
    console.log("");
  }
  console.log(`Registry snapshot → jobs/registry.json (${jobs.length} job(s))\n`);
  return 0;
}

function parseRunArgs(argv: string[]): {
  jobId: string;
  dryRun?: boolean;
  noHeal: boolean;
} {
  const positional: string[] = [];
  let dryRun: boolean | undefined;
  let noHeal = false;

  for (const a of argv) {
    if (a === "--dry-run" || a === "--dryRun") {
      dryRun = true;
    } else if (a === "--no-dry-run" || a === "--noDryRun") {
      dryRun = false;
    } else if (a === "--no-heal" || a === "--noHeal") {
      noHeal = true;
    } else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    } else if (a.startsWith("-")) {
      console.warn(`Unknown flag: ${a}`);
    } else {
      positional.push(a);
    }
  }

  const jobId = positional[0];
  if (!jobId) {
    console.error("Usage: npm run jobs:run -- <jobId> [--dry-run|--no-dry-run]");
    process.exit(1);
  }
  return { jobId, dryRun, noHeal };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    process.exit(0);
  }

  if (cmd === "list") {
    const asJson = argv.includes("--json");
    process.exit(listJobs(asJson));
  }

  if (cmd === "run") {
    const { jobId, dryRun, noHeal } = parseRunArgs(argv.slice(1));
    console.log(`\n→ Running job: ${jobId}` +
      (dryRun === true ? " (dry-run)" : dryRun === false ? " (live)" : "") +
      "\n");
    const result = await runJob(jobId, { dryRun, noHeal });
    if (result.message && result.exitCode !== 0) {
      console.error(result.message);
    } else if (result.message && result.softSuccess) {
      console.log(result.message);
    }
    process.exit(result.exitCode);
  }

  // Convenience: `jobs-cli.ts <jobId>` → run
  if (!cmd.startsWith("-") && !["list", "run", "help"].includes(cmd)) {
    const { jobId, dryRun, noHeal } = parseRunArgs(argv);
    const result = await runJob(jobId, { dryRun, noHeal });
    if (result.message && result.exitCode !== 0) {
      console.error(result.message);
    }
    process.exit(result.exitCode);
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
