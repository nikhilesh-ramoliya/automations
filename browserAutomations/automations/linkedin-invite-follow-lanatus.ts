/**
 * @deprecated Prefer `npm run jobs:run -- linkedin-invite-follow-lanatus`
 * or `npm run invite:lanatus`. Kept as a thin shim for old scripts/paths.
 */
import { run } from "../jobs/linkedin-invite-follow-lanatus/run.js";

run()
  .then((result) => {
    if (result.message && result.exitCode !== 0) {
      console.error(result.message);
    }
    process.exit(result.exitCode);
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
