# Cadline — Browser-Based 2D/3D Design Review Platform

Design review for CAD files in the browser: 3D models (STEP/IGES/BREP via OpenCASCADE, STL, OBJ, GLB/glTF), 2D drawings (DXF, PDF), annotations, threaded comments, measurements, real-time collaboration, and an optional AI assistant.

## Stack

- **Monorepo**: pnpm workspaces — `apps/api`, `apps/web`, `packages/shared`, `scripts`
- **API** (`apps/api`, port 4000): Fastify 5, Prisma 5 + PostgreSQL 16, Redis 7, Socket.IO, `occt-import-js`, `@gltf-transform/core`, optional Gemini (`@google/genai`)
- **Web** (`apps/web`, port 5173): React 19, Vite, Tailwind CSS 4, Three.js (`@react-three/fiber`, `three-mesh-bvh`), Konva, TanStack Query, Zustand
- **Shared** (`packages/shared`): zod 3 schemas and TypeScript types used by both apps
- **Object storage**: any S3-compatible service. Local dev and CI use [SeaweedFS](https://github.com/seaweedfs/seaweedfs)'s S3 gateway (MinIO's community images are no longer distributed).

There is one backend: `apps/api`. The web dev server proxies `/api` and `/socket.io` to it.

## Quick start

Requires Node 22+, pnpm (via `corepack enable`), and Docker.

```bash
docker compose up -d                      # postgres :5432, redis :6379, S3 :9000
pnpm install
pnpm --filter api prisma migrate deploy   # create the schema
pnpm --filter api seed                    # demo org, users, project, sample files
pnpm dev                                  # API on :4000 + web on :5173
```

Open <http://localhost:5173> and sign in:

| Role | Email | Password |
| :--- | :--- | :--- |
| Admin | `admin@demo.local` | `Password123!` |
| Member | `user@demo.local` | `Password123!` |

The seed uploads `scripts/seed-models/*` (STEP cube, STL cube, DXF plate, PDF sheet) and queues their conversion. The API's conversion worker processes them once `pnpm dev` is running; they show **READY** within a few seconds.

### Configuration

API scripts load configuration in this order (first wins): the real environment, `apps/api/.env`, `./.env`, then `./.env.example` as development defaults. No `.env` file is needed for local development.

- `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET`: if unset in development the API generates random per-process secrets (sessions reset on restart) and logs a warning. **With `NODE_ENV=production` the API refuses to start without them.** They are never taken from `.env.example`.
- `GEMINI_API_KEY`: optional. Without it, AI endpoints return `503 AI_NOT_CONFIGURED` and everything else works.
- `RATE_LIMIT_MAX`: global per-IP request limit per minute (default 300).

To persist sessions across restarts: `cp .env.example .env` and set real secrets.

## Tests

With the stack running (`docker compose up -d`, migrate, seed, and the API on :4000):

```bash
bash scripts/test-all.sh
```

`test-all.sh` waits for `/api/v1/health` and for the seeded files to finish converting, then runs all 7 suites against the Fastify API and exits non-zero if any fail:

| Suite | Covers |
| :--- | :--- |
| geometry unit tests (`pnpm --filter web test:geometry`) | planar regions, edge loops, cylinders, measurement math |
| `test-annotations.sh` | auth, files, annotations, comments, measurements, share-token scoping, JWT fail-closed |
| `test-2d.sh` | DXF scene, PDF pages, 2D markup and measurements, `NOT_2D` errors |
| `test-realtime.sh` | Socket.IO presence, deltas, follow mode, rate limits, room authorization |
| `test-realtime-reconnect.sh` | reconnect and room rejoin |
| `test-ai.sh` | AI endpoints: `503` without a key, `429` rate limits (live Gemini checks with `AI_TEST_KEY`) |
| `test-measurements.sh` | upload → OCCT/STL conversion → GLB geometry checks, feature cache, smart measurements |

Each suite also runs on its own, e.g. `API_URL=http://localhost:4000/api/v1 bash scripts/test-2d.sh` (`API_URL` defaults to that value). CI (`.github/workflows/ci.yml`) runs typecheck, build, and all suites on every push and pull request.

## Behavior notes

- **Uploads**: `POST /files/init` returns presigned S3 part URLs. The browser PUTs chunks directly to storage (the API sets bucket CORS on startup), then calls `POST /files/:id/complete`. `PUT /files/:id/chunk` is an authenticated server-side alternative.
- **Model and page delivery**: `GET /files/:id/glb` and `GET /files/:id/2d/page/:n` return short-lived signed same-origin URLs (`/files/:id/glb-binary`, `/files/:id/2d/page-image/:n`). The API streams those from storage, so `<img>` and the glTF loader need no auth headers and no bucket CORS.
- **Share links** grant access only to the file or project they were created for; other resources return 404. Socket rooms require org membership or a share token covering the file (`auth.shareToken` in the Socket.IO handshake).
- **DWG** is intentionally unsupported (proprietary format). Convert to DXF with the [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter) or [LibreDWG](https://www.gnu.org/software/libredwg/) first.
- **AI assistant** (Gemini, server-side only): chat, review summary, BOM extraction and DFM pre-check, grounded in file metadata, annotations, comments and measurements. Context is capped at 50 KB and scoped to the caller's organization; raw model bytes never leave the server. Rate limits: chat 30 / 5 min, summary/BOM/DFM 5 / 10 min per user.
- **Realtime**: REST persists, Socket.IO broadcasts deltas to the other sockets in the file room. Cursors are limited to 20 Hz and camera/viewport sync to 15 Hz per socket; `POST /files/:id/presence/ping` is the HTTP fallback (30 s Redis TTL). Voice and video are out of scope.

API docs (Swagger UI): <http://localhost:4000/docs>
