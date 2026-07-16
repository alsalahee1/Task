# Product Specification — AeroAssist

An improved, complete version of the original idea:

> "Admin gives a task to staff to take a wheelchair from storage, pick up the
> passenger, and bring them to their destination. The app tracks start/pickup/finish,
> calculates task time and GPS route, gives full results, lets the admin set an
> estimated time, and supports template times (gate-to-gate)."

Everything from the original idea is kept; the spec below fills the gaps that real
airport products (Ozion, AvTech) solve.

## 1. Users and roles

| Role | Device | What they do |
|---|---|---|
| **Admin / Dispatcher** | Web dashboard (+ mobile) | Create/assign tasks, watch live map and SLA timers, manage templates, view reports |
| **Staff / Agent** | Mobile app | Go on/off shift, receive tasks, advance task stages, get navigated |
| **Supervisor** (optional, later) | Web | Reports, staff performance, SLA compliance exports |
| **Passenger** (later phase) | SMS / public page | See "your agent is on the way", rate the service |

## 2. Task lifecycle (the heart of the app)

The original idea had 3 buttons (start, pickup, finish). Real operations need a few
more milestones — each one is a single tap and an automatic timestamp:

```
CREATED ──▶ ASSIGNED ──▶ ACCEPTED ──▶ EN_ROUTE_TO_STORAGE ──▶ WHEELCHAIR_COLLECTED
                                                                      │
        COMPLETED ◀── PASSENGER_DELIVERED ◀── IN_TRANSIT ◀── PASSENGER_PICKED_UP
                                                                      ▲
                                                              (agent arrives at
                                                               pickup point:
                                                               ARRIVED_AT_PICKUP)
```

- Any state can go to `CANCELLED` (with a reason: passenger no-show, flight
  cancelled, duplicate…) or `ESCALATED` (agent needs help).
- If a task needs **no wheelchair from storage** (chair already at gate, passenger
  has own chair), the storage stages are skipped — task types control which stages
  apply.
- **Why the extra stages matter:** "Accepted" proves the agent saw the task
  (response-time metric); "Arrived at pickup" is the timestamp used for the legal
  SLA (passenger waiting time), which is different from total task time.

### Agent app screens (minimum)
1. **My shift**: on-duty toggle, my assigned queue, my stats today.
2. **Task card**: passenger name + photo of SSR type icon, flight, pickup point,
   destination, wheelchair type needed, special notes ("passenger is deaf",
   "2-person lift"), estimated duration, ONE big action button that always shows the
   next stage.
3. **Active task**: live timer, next-stage button, map with route, "report problem"
   button (broken chair, passenger not found, elevator out of service).

### Admin dashboard (minimum)
1. **Live board**: all tasks as cards in columns by state, each with a countdown
   timer that turns **green → amber → red** as the SLA target approaches.
2. **Live map**: agents' positions and active task routes.
3. **Create task** form (30 seconds to fill): passenger, flight number (autofills
   airline/gate/time later via flight feed), pickup, destination, wheelchair type,
   priority, estimated time (auto-filled from template, editable).
4. **Assignment**: manual pick from a list sorted by *nearest available qualified
   agent*, or "auto-assign" button.

## 3. Time estimation & templates (key differentiator in the original idea — kept and expanded)

1. **Route templates**: a matrix of `(from-location, to-location) → typical minutes`,
   e.g. `Gate A3 → Gate B12 = 14 min`. Seeded manually by the admin who knows the
   airport.
2. **Auto-learning**: after every completed task, the system stores the actual
   stage-by-stage durations. The template value is continuously updated to the
   **median of the last N actual tasks** on that route (median resists outliers
   better than average).
3. **Per-stage estimates**, not just total: storage→pickup, wait-at-pickup,
   pickup→destination. This makes delay analysis meaningful ("we lose time waiting
   at arrival gates, not walking").
4. **Modifiers** (later): wheelchair type (electric cart vs. manual push), peak
   hours, terminal train/elevator availability.
5. When the admin creates a task, the estimate is **pre-filled from the template**
   and the admin can override it. Both numbers are stored (template estimate, admin
   estimate, actual) — that's what makes the reports honest.

## 4. Time & GPS tracking

- **Timestamps**: every stage transition is stamped server-side (plus client time,
  to survive offline moments). All durations are derived — never typed by hand.
- **GPS breadcrumbs**: while a task is active, the agent app records a location
  point every ~10 seconds / 15 meters and uploads in batches. Result: a replayable
  polyline of the actual route + computed walked distance.
- **Reality check**: GPS indoors in terminals is often inaccurate. So:
  - Milestone timestamps (button taps) are the **source of truth** for all
    KPIs/SLAs; GPS is supporting evidence and route insight.
  - Phase 2 can add BLE beacons/indoor positioning (like infsoft) if needed.
- **SLA timers**: each task carries a target from configuration (e.g. arriving
  passenger must be met within 20 min of aircraft on-blocks). The dispatcher board
  counts down and pushes an alert at 75% consumed, and escalates at breach.

## 5. Results & reports (the "full results" from the original idea)

**Per task:** timeline of all stages with durations, estimate vs. actual (template
and admin), route map + distance, delays and reported problems, SLA met/breached,
passenger rating (later).

**Aggregate (filter by day/week/terminal/agent/airline/route):**
- SLA compliance % (the number airports/airlines actually care about)
- Average and median task duration per route → feeds back into templates
- Tasks per agent, on-time acceptance rate, distance walked per shift (fairness!)
- Peak-hour heatmap → staffing decisions
- Export to CSV/PDF for the airline/airport monthly report

## 6. Practical operational features (learned from real products)

- **Offline tolerance**: terminals have dead zones. The agent app queues stage taps
  and GPS points locally and syncs when back online.
- **Wheelchair inventory** (simple v1): each storage location has a count; each
  chair can get a QR code the agent scans at collection — this also confirms the
  "wheelchair collected" milestone honestly and tracks where chairs end up.
- **Multi-agent tasks**: some passengers need 2 agents (lifts) — a task can have
  more than one assignee.
- **Priorities & tight connections**: a task linked to a closing flight jumps the
  queue and is visually marked.
- **Handover chains** (later): long journeys can be split into legs
  (aircraft→border control by agent A, border→baggage by agent B), like Ozion does.
- **Push notifications**: new task assigned, gate changed, SLA warning.
- **Accessibility & languages**: big buttons, high contrast, RTL support (Arabic +
  English UI).

## 7. What we deliberately leave OUT of version 1

- Flight data feed integration (AODB/FIDS/SITA) — start with manual flight entry,
  design the Task model so a feed can plug in later.
- Autonomous wheelchairs, indoor beacon positioning, passenger self-booking.
- Payroll/rostering — we only need on/off shift, not full workforce management.
