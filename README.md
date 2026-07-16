# AeroAssist — Airport Wheelchair Assistance Task Manager

A mobile + web application for managing wheelchair assistance tasks at an airport:
an **admin (dispatcher)** creates and assigns tasks, a **staff member (agent)** executes
them step by step (get wheelchair → pick up passenger → deliver to destination), and the
system records **timing, GPS route, and full task results** automatically.

This is the same category of software that major airports and ground handlers use,
known in the industry as **PRM management software** (PRM = Passenger with Reduced
Mobility). Examples used by big companies: Ozion PRM Manager (London Heathrow and 18+
airports), AvTech SSR/PRM (used by US wheelchair-assistance vendors), and Avtura AV PAX.

## Documentation

| Document | What it covers |
|---|---|
| [docs/01-market-research.md](docs/01-market-research.md) | Similar apps big airports use, what features they have, and industry SLA rules |
| [docs/02-product-spec.md](docs/02-product-spec.md) | The improved app concept: roles, full task lifecycle, timers, GPS tracking, time templates, reports |
| [docs/03-data-model.md](docs/03-data-model.md) | Database entities, task state machine, and API outline |
| [docs/04-mvp-roadmap.md](docs/04-mvp-roadmap.md) | Recommended tech stack and a phased build plan (MVP first) |

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
