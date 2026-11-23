# STANDALONE mode

`npm run dev:standalone` runs the whole app as two local processes (API on :4000, Vite on :5173) with no Docker, no Postgres, no Redis, no S3, no `.env` file and no login. It is the default way to develop Cadline. The full stack (README, "Full stack (advanced)") is unchanged and remains what you deploy.

## How it is switched on

One environment variable: **`STANDALONE=true`** on the API process, plus **`VITE_STANDALONE=true`** in the web build. `npm run dev:standalone` sets both: the API through `apps/api/scripts/standalone/dev.mjs`, the web app through `vite --mode standalone`, which loads `apps/web/.env.standalone`. There is no marker file and no CLI flag. When the variables are unset, every STANDALONE branch is skipped.

The API refuses to start with `STANDALONE=true` and `NODE_ENV=production` together (`apps/api/src/lib/standalone.ts`).

## What it changes

| Concern | Full mode (default) | STANDALONE |
| :--- | :--- | :--- |
| Database | PostgreSQL via `prisma/schema.prisma` | SQLite at `./data/cadline.db`. The client is generated from `prisma/schema.standalone.prisma` into `apps/api/node_modules/.prisma-standalone/client` |
| Object storage | S3 (`lib/s3.ts`, via `S3Adapter`) | `LocalStorageAdapter`: files under `./data/files/`. Presigned upload and download URLs point at signed `/api/v1/local-storage/*` routes |
| Redis | ioredis (presence-ping keys, health) | in-memory TTL map (`lib/memoryRedis.ts`) |
| Socket.IO fan-out | in-process | in-process (unchanged: it never used Redis) |
| Conversion queue | in-process worker polling the database | the same worker, unchanged |
| Auth (API) | JWT; `authenticate` and `requirePermission` enforce it | every request is `LOCAL_USER` (`local-user`, `local@cadline.dev`, "Local Dev", OWNER of `local-org`); every permission check passes |
| Auth (web) | `hydrate()` calls `GET /auth/me` when tokens are stored | no auth request at all: the store starts as `LOCAL_USER`; `/login` and `/register` redirect to `/projects`; "Sign out" is hidden |
| Seed | `pnpm --filter api seed` | automatic on first boot: `local-org`, `LOCAL_USER`, the 2 demo users, the gearbox project, and the STEP/STL/DXF/PDF fixtures (converted in the background) |

`schema.standalone.prisma` is generated from `schema.prisma` at every start; only the generator and datasource blocks differ. Change `schema.prisma` only; the next `npm run dev:standalone` regenerates the SQLite schema and client and updates `./data/cadline.db` with `prisma db push`.

## What it does NOT do

- **No security.** Anything that can reach port 4000 can read, change and delete everything, with no token. `dev:standalone` binds the API to `localhost` only (`API_HOST`, overridable). Do not expose it with `API_HOST=0.0.0.0` on a network you do not trust.
- **Single user.** Every browser tab and every API caller is the same "Local Dev" user. Presence shows that one user, and per-user permissions and roles are not exercised. Share links open, but the guest view grants nothing the local user does not already have.
- **Not for production.** It is blocked with `NODE_ENV=production` by design. SQLite and local disk storage are not a deployment target.
- **Not a substitute for the full-stack tests.** The 7 suites in `scripts/test-all.sh` check auth failures (401/403/404 scoping), which STANDALONE turns off on purpose. Run them against the full stack. `scripts/test-standalone.sh` is STANDALONE's own smoke test.
- **No data migration** between SQLite and Postgres. The two modes keep separate data.

All STANDALONE data is in **`./data/`**: `cadline.db` (SQLite) and `files/` (uploads and converted GLB, scene and page assets). It is git-ignored.

## Reset all data

Stop `npm run dev:standalone`, then delete the `data/` folder:

```bash
rm -rf data        # PowerShell: Remove-Item -Recurse -Force data
```

The next `npm run dev:standalone` recreates the database and reseeds the demo data.

## Switch back to full mode

1. Stop `npm run dev:standalone` and make sure `STANDALONE` is not set in your shell or in `.env` (it is not set unless you set it).
2. Start the services and the normal dev script, as in README, "Full stack (advanced)": `docker compose up -d`, `pnpm install`, `pnpm --filter api prisma migrate deploy`, `pnpm --filter api seed`, `pnpm dev`.
3. Sign in with `admin@demo.local` / `Password123!`.

The full-mode `pnpm dev` runs plain `vite` without `--mode standalone`, so the web app does real JWT login again. Nothing needs to be deleted or reverted: `./data/` is simply unused in full mode.

To remove STANDALONE mode entirely, revert the `fast-dev` commits (`git revert <first>^..<last>`). Each one only adds STANDALONE branches or files, except the Prisma 5 → 6 upgrade, which both modes use.
