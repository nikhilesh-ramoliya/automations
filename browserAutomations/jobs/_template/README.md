# Job template

Copy this folder to add a new automation:

```powershell
Copy-Item -Recurse jobs\_template jobs\my-new-job
# Edit jobs\my-new-job\job.json (id must match folder name)
# Implement jobs\my-new-job\run.ts → export async function run()
```

Then:

```powershell
npm run jobs:list
npm run jobs:run -- my-new-job --dry-run
```

## job.json

Required: `id`, `name`, `description`, `entry`, `tags`, `requiresAuth`, `env`.

Optional: `run.defaultDryRun`, `run.dryRunEnv`, `run.npmScript`, `heal.*`.

## run.ts contract

```ts
export async function run(): Promise<{ exitCode: number; message?: string }>
```

Throw on failures you want the runner to auto-heal (login redirect, profile lock, selector miss). Return `{ exitCode: 0, softSuccess: true }` for “nothing to do” cases.
