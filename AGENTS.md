# AGENTS.md — FormZoomAudiencias

## Migration in progress
The project is migrating from a **static setup** (GitHub Pages, Google Sheets backend) to a **Docker + PostgreSQL** application. Until migration is complete, these three form files must maintain the same functionality:

| File | Backend | What it does |
|---|---|---|
| `public/index.html` | PostgreSQL (`/api/meetings`, `/api/access-logs`) | Docker version of the Zoom form |
| `trt12-acesso-zoom-google-sheet.html` | Google Sheets | Legacy form (no IP capture) |
| `trt12-acesso-zoom-google-sheet-ip.html` | Google Sheets | Legacy form (with IP capture via ipify/ipapi) |

All three are functionally equivalent: user selects unidade/audiência → Zoom redirect. Any change to the form's behavior must be replicated across all three.

## Quick start
- `npm start` — run server.js on port 3000
- `npm run dev` — nodemon (auto-restart on changes)
- `docker compose up` — full stack (postgres + web) on port 3000

## Architecture
- **Monolithic Node.js/Express** app (`server.js`). No frameworks beyond Express.
- **PostgreSQL** with auto-migration on startup (`initDb()`): creates `meetings`, `access_logs`, `admins` tables and seeds initial data.
- **Static files** in `public/` served by `express.static`. Catch-all `*` route falls back to `public/index.html`.
- **No tests, no lint/typecheck, no CI**.

## Key files & endpoints
| File | Purpose |
|---|---|
| `public/index.html` | Docker form — `GET /api/meetings` to load, `POST /api/access-logs` to log |
| `public/admin.html` | CRUD for meetings. Protected by `requireAdmin`. Routes: `/api/admin/meetings` |
| `public/estatisticas.html` | Stats dashboard — **must log in first**. Calls `GET /api/access-logs` (protected) |
| `estatisticas.html` (root) | Same layout but backed by **Google Sheets** (used on GitHub Pages, no auth). Always edit both to keep them in sync. |
| `trt12-acesso-zoom-google-sheet.html` | Legacy form — Google Sheets backend, no IP |
| `trt12-acesso-zoom-google-sheet-ip.html` | Legacy form — Google Sheets backend, captures IP via ipify/ipapi |
| `server.js` | All backend logic |

Google Sheets files use `DATA_SOURCE = atob(_src)` (base64) to fetch meeting data from a published spreadsheet CSV export, and `STATS_SCRIPT_URL` to log access events.

## API routes
**Public:**
- `GET /api/meetings` — list meeting rooms
- `POST /api/access-logs` — log an access event
- `GET/POST /api/auth/config`, `/login`, `/logout`, `/me`

**Protected (`requireAdmin`):**
- `GET /api/access-logs` — fetch all access logs (stats page)
- `GET/POST/PUT/DELETE /api/admin/meetings` — CRUD meetings
- `GET/POST/DELETE /api/admin/users` — manage admins
- `GET /admin.html` — admin panel HTML

## Auth details
- Google Sign-In via ID token or dev fallback when `GOOGLE_CLIENT_ID` is empty.
- JWT stored in httpOnly cookie, 2h expiry.
- Domain locked to `@trt12.jus.br`. Must be in `admins` table.
- `csi@trt12.jus.br` is the primary admin (seeded on first run, cannot be deleted).
- Dev fallback: `POST /api/auth/login` with `{ devEmail: "..." }` — only works if `GOOGLE_CLIENT_ID` is not set.

## Docker
- `docker compose up` starts `db` (postgres:15-alpine, healthcheck) and `web` (node:18-alpine).
- `.env` has `DATABASE_URL=postgresql://postgres:postgres@db:5432/zoom_db` and `JWT_SECRET`.
- `GOOGLE_CLIENT_ID` is set in docker-compose.yml (prod), commented in `.env` for local dev.

## Important gotchas
- **Two `estatisticas.html` files**: root = Google Sheets (GitHub Pages), `public/` = PostgreSQL API (Docker). Always edit both to keep them in sync.
- **Three form files must stay functionally equivalent** during migration: `public/index.html`, `trt12-acesso-zoom-google-sheet.html`, `trt12-acesso-zoom-google-sheet-ip.html`.
- `GET /api/access-logs` requires admin login — stats page breaks without auth in Docker.
- No `README.md` in the repo.
- Files in `bkp/` and `old/` are historical/archived — not served.
- No formatter, linter, or type checker configured.
