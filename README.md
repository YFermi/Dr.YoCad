# Cadline — Browser-Based 2D/3D Design Review Platform

Monorepo foundation and interactive 3D CAD viewer for an eDrawings-style design review and collaboration application.

## Stack

- **Monorepo**: `pnpm` workspaces (`apps/web`, `apps/api`, `packages/shared`)
- **Frontend**: React 18, TypeScript, Vite, Tailwind CSS, minimal shadcn-style UI primitives, React Router, Zustand, TanStack Query, Three.js, `@react-three/fiber`, `@react-three/drei`
- **Backend**: Fastify, TypeScript, Prisma, PostgreSQL 16, Redis 7, Socket.IO, `occt-import-js`, `@gltf-transform/core`
- **Object Storage**: S3-compatible (MinIO in development, AWS S3 in production) via `@aws-sdk/client-s3`
- **Auth**: JWT access + rotating refresh tokens, bcrypt passwords, per-route rate limits, OAuth provider stubs

## Quick Start

1. Copy environment variables:

```bash
cp .env.example .env
```

2. Install all workspace dependencies:

```bash
pnpm install
```

3. Start PostgreSQL 16, Redis 7, and MinIO:

```bash
docker compose up -d
```

4. Configure MinIO CORS so browsers can `PUT` directly to presigned URLs and read `ETag`:

```bash
chmod +x scripts/setup-minio-cors.sh
./scripts/setup-minio-cors.sh
```

5. Run Prisma database migrations:

```bash
pnpm --filter api prisma migrate dev
```

6. Seed the demo organization, users, project, and sample STEP/STL models (uploads to MinIO and queues conversion jobs):

```bash
pnpm --filter api seed
```

7. Start both the Fastify API (`http://localhost:4000`, Swagger at `/docs`) and the React web app (`http://localhost:5173`):

```bash
pnpm dev
```

### Seeded Demo Credentials

| Role | Email | Password |
| :--- | :--- | :--- |
| Admin | `admin@demo.local` | `Password123!` |
| Member | `user@demo.local` | `Password123!` |

## Session 2 — How to Test the Viewer End-to-End

1. Run `docker compose up -d`, `./scripts/setup-minio-cors.sh`, `pnpm --filter api prisma migrate dev`, `pnpm --filter api seed`, and `pnpm dev`.
2. Watch the API terminal for `[conversion-worker] Completed job=...` confirming that both `calibration-cube-50mm.step` (via `occt-import-js`) and `calibration-cube-50mm.stl` converted to `.converted.glb` in MinIO.
3. Open `http://localhost:5173/login`, sign in with `admin@demo.local` / `Password123!`, and click **Planetary Gearbox Assembly**.
4. Click `calibration-cube-50mm.step` to open `/files/:id` — the 3D viewport auto-fits the 50 mm cube, loads the part tree on the left, and displays the floating bottom toolbar.
5. Test the viewer tools:
   - Toggle **Part tree** checkboxes or click isolate on a node.
   - Cycle shading modes (**Shaded → Edges → Wireframe → X-Ray**).
   - Enable **Section** in the bottom toolbar, switch X/Y/Z axis, and drag the offset slider to slice the geometry.
   - Enable **Measure (Distance)** and click two opposite vertices/faces on the 50 mm cube to read the `~50.00 mm` callout.
   - Click **Screenshot** to download a PNG of the viewport.
6. Upload `scripts/seed-models/cube-50mm.stl` (or any `.step` / `.stl` / `.obj` / `.glb`) through the Project Detail dropzone to test direct-to-MinIO presigned `PUT` chunk upload → `PROCESSING` status polling → automatic transition into the 3D viewer.

## Session 4 — 2D Drawing Viewer & Markup

Cadline supports 2D engineering drawings in **DXF** (vector scene graph parsed via `dxf-parser` and rendered on Konva with per-layer visibility, soloing, snapping, and viewport culling) and **PDF** (rasterized server-side at 2× scale via `pdfjs-dist` into per-page PNGs with stacked page viewing and markup).

### DWG Format Policy (Deliberate Scope & Licensing Decision)

**Native `.dwg` parsing is intentionally not implemented.** DWG is a proprietary Autodesk format, and bundling a native DWG decoder introduces licensing constraints (such as GPL/commercial ODA licensing). When a `.dwg` file is uploaded, the conversion worker marks the job `FAILED` with the explicit guidance:

> *DWG is a proprietary format. Convert to DXF with ODA File Converter or LibreDWG before upload. Free online converters also work.*

To review a DWG drawing in Cadline, convert it to ASCII DXF first using the free [ODA File Converter](https://www.opendesign.com/guestfiles/oda_file_converter) or [LibreDWG](https://www.gnu.org/software/libredwg/), then upload the `.dxf` file.

### Running the Session 4 2D Smoke Test

```bash
API_URL=http://localhost:3000/api/v1 bash scripts/test-2d.sh
```

## Session 5 — Real-Time Collaboration

Cadline provides live multi-user collaboration across both **3D models** and **2D drawings (DXF/PDF)** via Socket.IO room sync (`file:<id>`):

- **REST persists, Socket.IO broadcasts**: All annotation, comment, and measurement writes go through authenticated REST endpoints first, then broadcast typed `ServerEvent<T>` deltas to room peers (excluding the originating socket via `x-socket-id`). Clients merge deltas directly into the TanStack Query cache without full-list refetches.
- **Presence & Follow Mode**: Active room participants appear in the top-bar avatar stack with deterministic colors (`hsl(hash % 360, 65%, 55%)`). Clicking an avatar lets you follow that collaborator's 3D camera or 2D pan/zoom/page viewport with smooth `0.15` per-frame lerping. Mutual/cyclic follow loops are rejected server-side.
- **Live Cursors & Rate Limiting**: 3D surface raycast cursors (screen-space-constant `RingGeometry` rings) and 2D Konva cursors broadcast at up to 20 Hz (`camera:sync` and `viewport:sync` at up to 15 Hz). Server-side per-socket sliding-window rate limits drop floods, emit `rate_limit:error`, and disconnect sustained abuse (5× limit for 10s).
- **Reconnect & Fallback**: Clients auto-rejoin their active file room on reconnect, reconcile missed updates, and fall back to `POST /api/v1/files/:id/presence/ping` (30s Redis TTL) if WebSockets are temporarily unavailable.
- **Voice & Video Scope**: Real-time audio/video conferencing is intentionally out of scope (no WebRTC); teams rely on **integration with external tools (Teams/Zoom)** alongside Cadline's shared viewport and follow mode.

### Running the Full Regression & Realtime Test Suites

```bash
API_URL=http://localhost:3000/api/v1 bash scripts/test-annotations.sh
API_URL=http://localhost:3000/api/v1 bash scripts/test-2d.sh
API_URL=http://localhost:3000/api/v1 bash scripts/test-realtime.sh
API_URL=http://localhost:3000/api/v1 bash scripts/test-realtime-reconnect.sh
API_URL=http://localhost:3000/api/v1 bash scripts/test-ai.sh
```

## Session 6 — AI Design Assistant (Optional)

Cadline includes an optional server-side AI Design Assistant powered by Google Gemini (`@google/genai`) with four workflows inside the File Viewer right sidebar:

1. **Contextual Q&A (`POST /api/v1/ai/chat`)** — Answers questions about annotations, discussion threads, recorded measurements, 3D part trees, and 2D drawing layers/notes, returning clickable `#N` annotation references.
2. **Review Summary (`POST /api/v1/ai/summary`)** — Synthesizes open issues, resolution counts, and recommended next steps. Cached in `AIInsight` (`type: SUMMARY`) until new `ActivityLog` events occur or `?force=true` is requested.
3. **BOM Extraction (`POST /api/v1/ai/bom`)** — Generates a structured, CSV/TSV-exportable Bill of Materials from 3D assembly part trees or 2D DXF title-block text & layer names.
4. **DFM Pre-Check (`POST /api/v1/ai/dfm`)** — Runs a transparent, non-geometric manufacturability check grounded strictly in available metadata, recorded measurements, and review annotations.

### Configuration & Data Handling

- **Optional by design**: Set `GEMINI_API_KEY` in the server `.env` file to enable AI endpoints. When omitted, the rest of Cadline continues operating normally and AI endpoints return `503 AI_NOT_CONFIGURED`.
- **Server-side only**: API keys are never exposed to the browser, and raw model bytes (`.step`, `.glb`, `.pdf` PNGs, raw DXF vector geometry) never leave the server. Context sent to Gemini is strictly capped at **50 KB**.
- **Per-user rate limits**: `/api/v1/ai/chat` is limited to **30 requests / 5 min**; `/summary`, `/bom`, and `/dfm` are limited to **5 requests / 10 min** (`429 AI_RATE_LIMIT` with `retryAfterSeconds`).

### Running the AI Test Suite

```bash
# Default CI mode (verifies 503 AI_NOT_CONFIGURED + 429 rate-limit enforcement without an API key)
API_URL=http://localhost:3000/api/v1 bash scripts/test-ai.sh

# Opt-in live Gemini verification
AI_TEST_KEY=your_key_here API_URL=http://localhost:3000/api/v1 bash scripts/test-ai.sh
```



