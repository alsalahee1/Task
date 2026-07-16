# Tech Stack & Roadmap

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Mobile app (agents) | **Flutter** (or React Native) | One codebase for Android + iOS; airports usually issue Android devices — Flutter is strong there; good offline + background-GPS plugins |
| Admin dashboard | **Web app (React)** | Dispatchers work on big screens; live board + map fits web best |
| Backend | **Node.js (NestJS)** or **Python (FastAPI/Django)** | Fast to build, easy WebSocket support, huge hiring pool |
| Database | **PostgreSQL + PostGIS** | Relational fits tasks/events perfectly; PostGIS handles GPS points, distances, and route lines natively |
| Realtime | WebSockets (or Firebase Cloud Messaging for push) | Live dispatcher board + task push to agents |
| Maps | Google Maps / Mapbox; airport floor-plan image overlay | Outdoor map first; indoor floor plan overlay is enough for v1 |
| Hosting | Any cloud (single region) + daily backups | This is operational + legally relevant data |

Simplest possible alternative for a quick pilot: **Firebase** (Auth + Firestore +
FCM) with a Flutter app — no custom backend at all. Fine to validate the workflow
with 5–10 agents; migrate to PostgreSQL when reports get serious.

## Phased plan

### Phase 1 — MVP (validate the workflow, ~4–6 weeks of work)
- Login, roles (admin / agent), on/off shift
- Locations + manual route-template matrix (admin CRUD)
- Create task (estimate auto-filled from template, admin can override)
- Assign to agent → push notification
- Agent stage buttons with full lifecycle + server timestamps
- GPS breadcrumbs during active task, batched upload, offline queue
- Live dispatcher board with SLA countdown colors
- Per-task report: stage timeline, estimate vs. actual, route on map

### Phase 2 — Operations quality
- Template auto-learning (median of actuals), per-stage estimates
- Aggregate reports + CSV export, SLA compliance dashboard
- Wheelchair QR codes + storage inventory
- Multi-agent tasks, problem reporting, escalation flow
- Arabic/RTL UI, passenger SMS notifications

### Phase 3 — Big-airport features
- Flight data feed (AODB/FIDS) → auto gate changes, auto task creation from SSR codes
- Auto-assignment engine (nearest qualified available agent)
- Handover chains (multi-leg journeys), transfer desks
- Indoor positioning (BLE beacons) if GPS-indoors proves too weak
- Supervisor mobile app, staff fairness metrics (distance walked balance)

## KPIs the product must be able to answer from day one

1. What % of passengers were met within the SLA target (20/30 min)?
2. Average/median time per route — and is it getting better?
3. Estimate vs. actual accuracy — are templates trustworthy?
4. Tasks per agent per shift, and is workload fair?
5. Where do we lose time (waiting at gate? elevator? storage far away?)
