# Railway deploy shape for the MVP

Research for #12. Question: what is the current recommended way to deploy this pnpm + Turborepo monorepo (Next.js App Router in `apps/web`, later `apps/worker`, Drizzle in `packages/db`) with Railway Postgres? It covers migrations and seeding on deploy, environment variables, and how the worker fits in.

Sources were read on 2026-11-05. Railway's docs change often, and a deprecation lands on 2026-12-01 (see section 1), so re-check the pages linked here before building.

## TL;DR

- **One Railway project and environment** with three services: `Postgres` (Railway's managed template), `web` (`apps/web`) and, later, `worker` (`apps/worker`). All three share one private network.
- **Do not add `railway.json` / `railway.toml`.** Config as Code is deprecated, new services cannot use it, and existing files stop being read on **2026-12-01**. Configure services in the dashboard, or in Railway Infrastructure as Code (`.railway/railway.ts`, TypeScript, GA).
- **Treat it as a shared monorepo:** keep the root directory at `/` and give each service its own build command, start command and watch paths:
  - web build: `pnpm turbo run build --filter=web`
  - web start: `pnpm --filter web start`
  - web watch paths: `/apps/web/**`, `/packages/**` and the root manifests
- **Migrations run in the `web` service's pre-deploy command**, for example `pnpm --filter db db:migrate`, which wraps `drizzle-kit migrate`. That command runs after the build, before the new version takes traffic, inside the private network and with the service's variables. If it fails, the deploy stops. Set a pre-deploy timeout. Only `web` migrates; `worker` never does.
- **Seeding:** reference data that must always exist goes in an idempotent seed that runs in the same pre-deploy after migrating. Demo or fake data (`drizzle-seed`, whose `reset()` truncates tables) is never part of a deploy. Run it by hand.
- **`DATABASE_URL=${{Postgres.DATABASE_URL}}`** as a reference variable on `web` and `worker`. It is the private connection string. `DATABASE_PUBLIC_URL` only exists if you turn on public access (TCP proxy, billed egress). You'd only need that to reach the database from your laptop.
- **The private network is not available during the build.** `next build` must not need the database. Keep database-backed routes dynamic.
- **Next.js output:** with Railpack (the default builder, no Dockerfile), plain `next start` works because `node_modules` is in the image. `output: "standalone"` only pays off once you move to a Dockerfile. In a monorepo it has extra steps (section 5).
- **Worker:** a second service from the same repo and root `/`, with its own build/start commands and watch paths, the same `DATABASE_URL` reference, no public domain and no pre-deploy. Use Railway's cron schedule only if it is a run-and-exit job at least 5 minutes apart. Otherwise it is a long-running process.

## 1. Service configuration: dashboard or IaC, not `railway.json`

**Config as Code is deprecated.** The Config as Code reference has a banner: "**Config as Code is deprecated.** Prefer Infrastructure as Code. Existing files keep working for legacy services until **2026-12-01**" ([config-as-code/reference](https://docs.railway.com/config-as-code/reference)). The IaC page is stricter: "New services cannot opt into Config as Code. Existing Config as Code files stop being read on **2026-12-01** (hard cutoff)" ([infrastructure-as-code](https://docs.railway.com/infrastructure-as-code)). Some older Railway pages still say otherwise:
- The monorepo page says automatic import detects `railway.json` at each package root ([deployments/monorepo](https://docs.railway.com/deployments/monorepo)).
- The Next.js guide still mentions Nixpacks ([guides/nextjs](https://docs.railway.com/guides/nextjs)).

The deprecation banner is newer, so it wins.

**The replacement is Infrastructure as Code (IaC).** It is one file, `.railway/railway.ts`, for a whole project or environment, and TypeScript authoring is "generally available". You install it with `npm install railway` and import from `railway/iac`. The Railway CLI evaluates it: `railway config plan` previews, `railway config apply` applies after confirmation, and `railway config pull` imports a project you built in the dashboard. Anything you leave out of the file gets deleted, unless you use named partials ([infrastructure-as-code](https://docs.railway.com/infrastructure-as-code)).

The relevant `service()` options in the [IaC reference](https://docs.railway.com/infrastructure-as-code/reference):

| Option | Purpose |
|---|---|
| `source: github("owner/repo", { rootDirectory })` | Repo source |
| `build`, `start` | Build and start commands |
| `preDeploy` | Pre-deploy command, e.g. `"npx drizzle-kit migrate"` |
| `healthcheck`, `healthcheckTimeout` | Healthcheck |
| `replicas` | Replica count |
| `env` | Variables, including references like `db.env.DATABASE_URL` and `ctx.shared.NAME` |
| `domains` | Custom domains |
| `volumeMounts` | Volumes |

The reference also lists `postgres("postgres")` and `group(...)`. For the CLI's `tracing` field it requires CLI 5.63.0+ and `railway` npm 3.12.0+.

**Uncertain:** the IaC reference does **not** document watch paths, cron schedule, restart policy or builder selection.
- Config as Code had all four (`watchPatterns`, `cronSchedule`, `restartPolicyType`, `builder`).
- It's unclear whether IaC preserves values set in the dashboard for those fields or can't express them yet.
- Before relying on IaC for them, run `railway config pull` on a project where they are set in the dashboard and see what comes out.

**Recommendation for the MVP:**
1. Set the services up in the dashboard first, since that is the fastest route to a first deploy.
2. Then run `railway config pull` to capture them as `.railway/railway.ts`.
3. Commit that file only if it represents watch paths faithfully.

Do not write a `railway.json` either way.

## 2. Monorepo shape: shared, root directory `/`

Railway distinguishes two kinds of monorepo ([deployments/monorepo](https://docs.railway.com/deployments/monorepo)):
- **Isolated:** each directory stands alone. You set a root directory, and "Railway will only pull down files from that directory when creating new deployments."
- **Shared:** components "share code or configuration from the root directory (eg. Yarn workspace…)". You keep the shared root and set a custom build and start command per service, for example `pnpm --filter backend build` / `pnpm --filter backend start`.

This repo is a **shared** monorepo: `apps/web` imports `packages/core` and `packages/db`, and `pnpm-lock.yaml` / `pnpm-workspace.yaml` / `turbo.json` live at the root. So **leave the root directory at `/`**. If you set it to `apps/web`, the workspace root and lockfile wouldn't be checked out.

**Uncertain:** the IaC reference's "Larger example" combines `github("acme/monorepo", { rootDirectory: "apps/api" })` with `pnpm --filter api build`. That contradicts the "only pull down files from that directory" wording above. Maybe Railway now checks out the whole repo and only runs commands inside the root directory. The build-configuration page says "all build and deploy commands will operate within the defined root directory" ([builds/build-configuration](https://docs.railway.com/builds/build-configuration)). This hasn't been checked. Root `/` works under either reading, so use it.

**Automatic import:** if you import the repo through railway.com/new, Railway detects pnpm workspaces and stages one service per deployable package. It fills in `pnpm --filter <pkg> build/start` and sets the watch paths to the package directory. It skips config packages (eslint, prettier, tsconfig) and test packages ([deployments/monorepo](https://docs.railway.com/deployments/monorepo)). It would probably also stage `packages/core` and `packages/db` as services; delete those, because only `apps/*` deploy. It sets watch paths to the package folder only, so add the shared paths below by hand.

### Build and start commands

Railpack is the default builder ([config-as-code/reference](https://docs.railway.com/config-as-code/reference), [builds/railpack](https://docs.railway.com/builds/railpack)). It reads `pnpm-workspace.yaml` and picks the package manager from `packageManager` in the root `package.json` first, then the lockfile. It picks the Node version from `RAILPACK_NODE_VERSION`, `engines.node`, `.nvmrc` and so on, defaulting to `lts`. It caches `.next/cache` and `.turbo/cache` ([railpack.com/languages/node](https://railpack.com/languages/node)). So pin `packageManager` and `engines.node` in the root `package.json`.

A build command overrides the detected one and "is run after languages and packages have been installed" ([builds/build-configuration](https://docs.railway.com/builds/build-configuration)). Use Turborepo so the workspace packages build first:

| Service | Build | Start |
|---|---|---|
| `web` | `pnpm turbo run build --filter=web` | `pnpm --filter web start` |
| `worker` | `pnpm turbo run build --filter=worker` | `pnpm --filter worker start` |

Replace `web` / `worker` with the real `name` fields from each `package.json`. In Turborepo, `--filter=web...` explicitly selects `web` plus its dependencies. With `"dependsOn": ["^build"]` in `turbo.json`, a plain `--filter=web` also runs the dependencies' builds first. The `--only` flag is what excludes them ([turborepo.dev/docs/reference/run](https://turborepo.dev/docs/reference/run)).

`turbo prune <app> --docker` is Turborepo's tool for slimmer Docker images: it writes `out/json`, `out/full` and a pruned lockfile ([turborepo.dev/docs/guides/tools/docker](https://turborepo.dev/docs/guides/tools/docker), example pinned to Turborepo 2.11.5). It only matters if we switch to a Dockerfile. It's not needed with Railpack.

### Watch paths

Watch paths are gitignore-style patterns. Changes that match none of them skip the deploy. "If a Root Directory is provided, patterns still operate from `/`" ([builds/build-configuration](https://docs.railway.com/builds/build-configuration)).

`web`:
```gitignore
/apps/web/**
/packages/**
/package.json
/pnpm-lock.yaml
/pnpm-workspace.yaml
/turbo.json
```

`worker`: the same list, with `/apps/worker/**` in place of `/apps/web/**`.

Changes under `/packages/**` (including new migrations in `packages/db`) redeploy both services. That's intended: both import the schema.

## 3. Migrations and seeding on deploy

### Pre-deploy command

From [deployments/pre-deploy-command](https://docs.railway.com/deployments/pre-deploy-command):
- It runs "between building and deploying your application, handling tasks like database migrations or data seeding".
- It "execute[s] within your private network and [has] access to your application's environment variables".
- "If your command fails, it will not be retried and the deployment will not proceed."
- It runs "in a separate container from your application". Filesystem changes are not kept and volumes are not mounted.
- It must exit 0 on success. It "has the dependencies it needs to run installed in the application image".
- There is no time limit by default. A **Pre-deploy Timeout** of 1-3600 s can be set. The field only appears once a command is entered.

Railway's Next.js guide recommends exactly this for Drizzle: Settings > Deploy > Pre-deploy Command = `npx drizzle-kit migrate` ([guides/nextjs](https://docs.railway.com/guides/nextjs)). The IaC reference uses the same example, `preDeploy: "npx drizzle-kit migrate"`.

A note that looks contradictory: the private-networking page says "Database migrations that require internal connectivity should run as part of the start command, not the build" ([how-it-works](https://docs.railway.com/networking/private-networking/how-it-works)). It is contrasting migrations with the *build*. The newer pre-deploy page states that pre-deploy has private-network access, so pre-deploy is fine.

### Drizzle side

Drizzle documents two ways to apply generated migrations ([orm.drizzle.team/docs/migrations](https://orm.drizzle.team/docs/migrations)):
- `drizzle-kit migrate` (CLI). It reads the migration files, fetches the migration history from the database, and applies the ones that haven't run yet.
- `migrate(db)` from `drizzle-orm/node-postgres/migrator`, called from code.

`drizzle-kit push` is for prototyping. Don't use it for deploys of a ledger.

**Recommendation:**
- Generate migrations locally (`drizzle-kit generate`) and commit them in `packages/db`.
- Add a `db:migrate` script to `packages/db` that runs `drizzle-kit migrate`.
- Set the `web` pre-deploy command to `pnpm --filter db db:migrate`.

Two checks:
- `drizzle-kit` is usually a devDependency. It stays in the image unless `RAILPACK_PRUNE_DEPS=true` is set ([railpack.com/languages/node](https://railpack.com/languages/node)), so don't set that variable. Alternatively, write a small `migrate.ts` script that uses `drizzle-orm`'s `migrate()`, so no dev tooling is needed at runtime.
- `drizzle.config.ts` must read `DATABASE_URL` from `process.env`. The migrations folder must be part of the build image, which it is with root `/`.

Only `web` migrates. If both `web` and `worker` ran migrations in pre-deploy, a change to `/packages/**` would redeploy both and race two migrators against one database. Railway doesn't document any locking between services' pre-deploy runs.

### Seeding

Railway names "data seeding" as a pre-deploy use case, but every deploy runs it, so the seed must be **idempotent**: inserts that use `ON CONFLICT DO NOTHING` or check before inserting.

Split it in two:
- **Reference data the app needs** (e.g. system or house accounts): an idempotent `db:seed` script, chained after migrate: `pnpm --filter db db:migrate && pnpm --filter db db:seed`.
- **Demo or fake data:** never on deploy. `drizzle-seed` is deterministic, and its `reset()` runs `TRUNCATE ... CASCADE` ([orm.drizzle.team/docs/seed-overview](https://orm.drizzle.team/docs/seed-overview)). That is destructive against a ledger. Run demo seeding by hand. `DATABASE_URL` is a private hostname that a laptop can't reach. To run from a laptop, either:
  - turn on Public Access temporarily and use `DATABASE_PUBLIC_URL`, or
  - run the command inside a Railway container.

  `railway run` runs a *local* command with Railway's variables ([cli/run](https://docs.railway.com/cli/run)), so on its own it still can't reach the private host. Not verified: whether `railway ssh` would serve.

## 4. Environment variables and private networking

- **Postgres variables.** The Postgres service exposes `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` and `DATABASE_URL`. "Databases are deployed private by default". Adding Public Access creates a TCP proxy and fills in `DATABASE_PUBLIC_URL`, billed as network egress ([databases/postgresql](https://docs.railway.com/databases/postgresql)). So `DATABASE_URL` is the private connection string.
- **Reference variables.** On `web` and `worker`, set `DATABASE_URL=${{Postgres.DATABASE_URL}}`. The syntax is `${{SERVICE_NAME.VAR}}` ([variables](https://docs.railway.com/variables)); use whatever the database service is called on the canvas. A reference "stays in sync if the database credentials change" ([guides/nextjs](https://docs.railway.com/guides/nextjs)). In IaC this is `env: { DATABASE_URL: db.env.DATABASE_URL }`.
- **Shared variables** (`${{shared.NAME}}`) suit values both services need, such as a log level.
- **Private networking.** Services in the same project *and environment* reach each other at `SERVICE_NAME.railway.internal` over WireGuard. Different projects or environments are isolated from each other ([networking/private-networking](https://docs.railway.com/networking/private-networking), [how-it-works](https://docs.railway.com/networking/private-networking/how-it-works)). Environments created after 2025-10-16 resolve to both IPv4 and IPv6; older ones are IPv6-only. Railway's library-configuration page lists dual-stack fixes for `ioredis`, `bullmq` and `hot-shots` only, with nothing needed for `pg` ([library-configuration](https://docs.railway.com/networking/private-networking/library-configuration)).
- **Build vs runtime.** "Private networking is only available at **runtime**, not during the build phase" ([how-it-works](https://docs.railway.com/networking/private-networking/how-it-works)). Pre-deploy counts as runtime here. `next build` can't reach Postgres, so:
  - no static prerendering that queries the database;
  - route handlers and server components that read the ledger must be dynamic;
  - code must not open a database connection at module import time during build.
- **Useful built-in variables** ([variables/reference](https://docs.railway.com/variables/reference)): `RAILWAY_PRIVATE_DOMAIN`, `RAILWAY_PUBLIC_DOMAIN`, `RAILWAY_ENVIRONMENT_NAME`, `RAILWAY_GIT_COMMIT_SHA` (handy as a build or version tag on the ops console), and `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (time between SIGTERM and SIGKILL, default 0).

## 5. Next.js output mode

Railway's Next.js guide tells you to set `output: "standalone"` and change `start` to `node .next/standalone/server.js` ([guides/nextjs](https://docs.railway.com/guides/nextjs)). The Next.js docs (page last updated 2026-09-18) add two caveats ([next.config output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)):
- The standalone `server.js` "does not copy the `public` or `.next/static` folders by default". You must `cp -r public .next/standalone/ && cp -r .next/static .next/standalone/.next/` yourself. Railway's GitHub/CLI path doesn't mention this step; only its Dockerfile example does the copy.
- In a monorepo, tracing is rooted at the app folder by default. To include `packages/*` you set `outputFileTracingRoot: path.join(__dirname, '../../')`. Not verified from the docs page, based on how Next.js lays out the output: with that root, `server.js` lands under `.next/standalone/apps/web/`, not at `.next/standalone/server.js`.

**Recommendation for the MVP:** skip standalone. Railpack builds the image with the full workspace `node_modules`, so `next start` (the default `start` script) works as it is. Revisit standalone, together with `turbo prune --docker`, only if image size or cold start becomes a problem and we move to a Dockerfile. `next start` reads `PORT`, which Railway sets.

**Unverified:** that `next start` binds to the right interface on Railway. Railway's Dockerfile example sets `HOSTNAME="0.0.0.0"` for the standalone server. Check this on the first deploy.

Add a healthcheck route (e.g. `/api/health`) and set it as the service healthcheck, so new deploys only take traffic once healthy ([deployments/healthchecks](https://docs.railway.com/deployments/healthchecks), not read in detail).

## 6. The worker service

The worker fits in the same project as a second service from the same repo. Railway's own IaC "Larger example" shows `api`, `web` and `worker` services from one monorepo, all sharing `DATABASE_URL: db.env.DATABASE_URL`, grouped on the canvas with `group("Backend", [db, api, worker])` ([IaC reference](https://docs.railway.com/infrastructure-as-code/reference)).

For `worker`:
- Root `/`. Build `pnpm turbo run build --filter=worker`, start `pnpm --filter worker start`.
- Watch paths as in section 2.
- `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
- No generated domain: it only talks to Postgres over the private network.
- No pre-deploy: `web` owns migrations. A worker deploy that comes from a `packages/db` change can briefly run before `web`'s pre-deploy has migrated. Keep migrations backward compatible, adding before removing.
- Handle SIGTERM and set `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` so in-flight jobs finish before the old container is killed.

**Long-running or cron.** A Railway cron service "execute[s] the start command for that service on the given schedule" and must "exit as soon as that task is finished, not leaving any resources open, such as database connections". Runs must be "at least 5 minutes apart". Schedules are in UTC. If the previous run is still going, the next is skipped ([cron-jobs](https://docs.railway.com/cron-jobs)). That suits a periodic balance verify or reconcile job. A job loop that polls or listens continuously should be a normal long-running service instead.

## Open questions

1. Can IaC express watch paths and cron schedules, or does `railway config apply` leave values set in the dashboard alone? (Section 1.)
2. Does `rootDirectory` in a shared pnpm monorepo check out the whole repo? (Section 2.) This doesn't matter if we keep `/`.
3. Does `next start` bind correctly without `HOSTNAME=0.0.0.0` on Railway? Check on the first deploy.
4. Do pre-deploy commands of two services ever run at the same time? Avoided by having only `web` migrate.
