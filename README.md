# AeroAssist — Airport Wheelchair Assistance Task Manager

**Built for dnata (Emirates Group)** — themed in dnata's brand identity (dnata blue
with the green tick as secondary accent, on cool dark neutrals). The official dnata
logo (`web/assets/dnata-logo.png`, shown on a white chip via
`web/assets/brand-logo.svg`) appears on the login page, dispatch dashboard, and
agent app; the gold Emirates mark (`web/assets/emirates-logo.png`) sits on the
login page as the group affiliation. To swap logo artwork later, replace those
image files — no code changes.

A working mobile + web application for managing wheelchair assistance tasks at an airport:
an **admin (dispatcher)** creates and assigns tasks, a **staff member (agent)** executes
them step by step (get wheelchair → pick up passenger → deliver to destination), and the
system records **timing, GPS route, and full task results** automatically.

This is the same category of software that major airports and ground handlers use,
known in the industry as **PRM management software** (PRM = Passenger with Reduced
Mobility). Examples used by big companies: Ozion PRM Manager (London Heathrow and 18+
airports), AvTech SSR/PRM (used by US wheelchair-assistance vendors), and Avtura AV PAX.

## Quick start

Requires only **Node.js 22+** — no npm dependencies, no database server (uses Node's
built-in SQLite).

```bash
npm start          # runs on http://localhost:3000
npm test           # backend integration tests (full lifecycle, SLA, GPS, learning)
```

| App | URL | Demo login |
|---|---|---|
| Admin / dispatcher dashboard | `http://localhost:3000/admin` | `admin` / `admin123` |
| Agent mobile app (installable PWA) | `http://localhost:3000/agent` | `ahmed` / `agent123` (also `fatima`, `john`, `sara`) |

To use the agent app on a real phone, open the server's address in the phone's
browser and "Add to Home Screen". GPS breadcrumbs need HTTPS (or localhost) —
put the server behind any TLS reverse proxy for field use.

## What's implemented

- **Admin dashboard**: live task board with color-coded SLA countdowns (green → amber
  → red, updated every second via Server-Sent Events), task creation with
  auto-filled template estimates, agent assignment (multi-agent supported), live
  terminal map, template editor, reports with CSV export, team view.
- **Agent app** (mobile-first): shift on/off, prioritized task queue, one-tap stage
  progression (`Accept → Chair collected → Arrived at pickup → Passenger picked up →
  In transit → Delivered → Complete`), progress stepper, live elapsed timer, problem
  reporting, GPS breadcrumb recording, **offline queue** — actions taken in terminal
  dead zones sync automatically (idempotent event UUIDs prevent duplicates).
- **Backend**: full task state machine with server-side validation, SLA targets
  (EU-regulation defaults: 20 min arrivals / 30 min departures, editable per task),
  per-task results (stage timeline, estimate vs. actual, walked distance from GPS),
  aggregate reports, and **self-learning route templates** — after 5 completed tasks
  on a route, the "usual time" becomes the median of real actuals.
- **Flight feed**: a flights schedule (stand-in for an AODB/FIDS feed with the same
  update shape). Typing a flight number when creating a task auto-fills direction and
  gate. A **gate change automatically retargets every active task** on that flight
  (arrivals: pickup point; departures: destination), re-estimates it, logs a
  `GATE_CHANGED` event on the task timeline, and texts the passenger — tasks already
  past the affected point are left for the dispatcher to judge.
- **Auto-assignment**: one click (or the "auto" option at creation) picks the best
  agent — on duty, holding the required skills (electric-cart task → `ELECTRIC_CART`,
  WCHC passenger → `TWO_PERSON_LIFT`), ranked by current workload then by GPS
  distance to the task's start point.
- **Passenger SMS notifications**: assigned / on-the-way / arrived / delivered /
  gate-change messages per task. Stored as an auditable log the dispatcher sees on
  the task; set `SMS_WEBHOOK_URL` to POST `{to, body}` to any SMS-gateway bridge
  (Twilio/Vonage/etc.) — without it, messages are logged only (demo mode).
- **Arabic interface (RTL)**: full agent app, login, and admin chrome are bilingual —
  one-tap toggle (English/العربية), persisted per device, with proper right-to-left
  layout.
- **Wheelchair QR inventory**: every chair carries a QR label. The agent scans it
  (phone camera via the BarcodeDetector API, with manual typing as fallback) at the
  "wheelchair collected" step — proof of collection, and the chair is linked to the
  task. On completion the chair is freed at the destination, so the fleet tab always
  shows where every chair is, what's available per storage room, what's in use, and
  what's in maintenance. Unknown codes never block a task (offline queues must
  drain); they're flagged to the dispatcher instead.
- **Auto task creation from airline SSR lists**: paste a flight's assistance
  manifest (`Name, SSR code, phone` per line) on the Flights tab and one task per
  passenger is created with the right routing (arrivals: gate → baggage; departures:
  check-in → gate), nearest storage with available chairs, WCHC passengers
  prioritized with aisle chairs, duplicate passengers skipped, and optional
  auto-assignment. A real SSR feed can post the same JSON to
  `POST /api/flights/:id/ssrs`.

## Project layout

```
server/   zero-dependency Node.js API (http + node:sqlite + SSE)
web/      admin dashboard + agent PWA (vanilla ES modules, no build step)
tests/    end-to-end API tests (node --test)
docs/     research, product spec, data model, roadmap
```

## Documentation

| Document | What it covers |
|---|---|
| [docs/01-market-research.md](docs/01-market-research.md) | Similar apps big airports use, what features they have, and industry SLA rules |
| [docs/02-product-spec.md](docs/02-product-spec.md) | The improved app concept: roles, full task lifecycle, timers, GPS tracking, time templates, reports |
| [docs/03-data-model.md](docs/03-data-model.md) | Database entities, task state machine, and API outline |
| [docs/04-mvp-roadmap.md](docs/04-mvp-roadmap.md) | Recommended tech stack and a phased build plan (MVP first) |
| [docs/05-real-airport-setup.md](docs/05-real-airport-setup.md) | **How to load your real airport**: locations with GPS, map refit, floor plans, true walking times — incl. a DXB T1/T2/T3 quickstart (`node setup/load-dxb.mjs`) |

## The core idea (improved)

1. **Admin creates a task** from a flight/passenger request: passenger name, flight,
   pickup point (gate/check-in/arrival), destination (gate/baggage/taxi), wheelchair
   type, and priority.
2. **Estimated time is filled automatically** from a *route time template* (e.g.
   "Gate A3 → Gate B12 usually takes 14 min"). Admin can override it. Templates
   improve over time from real completed-task data.
3. **Staff receives the task on their phone**, and moves it through clear stages with
   one tap each: `Accept → Wheelchair picked up → Passenger picked up → In transit →
   Completed`. Every tap is timestamped.
4. **GPS breadcrumbs** are recorded during the task, so the actual route walked is
   stored and can be replayed on a map.
5. **SLA timers** alert the dispatcher *before* a task breaches the waiting-time
   standard (EU regulation targets: ~30 min for departing, ~20 min for arriving
   passengers), not after.
6. **Full task report** at completion: total time vs. estimate, time per stage,
   distance walked, route map, delays, and staff performance statistics.
