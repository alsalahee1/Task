# Data Model & API Outline

## Entities

```
User
  id, name, phone, email, role (ADMIN | AGENT | SUPERVISOR)
  skills [AISLE_CHAIR, TWO_PERSON_LIFT, ELECTRIC_CART, ...]
  on_duty (bool), last_known_location (lat, lng, updated_at)

Location            -- every named point in the airport
  id, code ("A3"), name ("Gate A3"), type (GATE | CHECKIN | STORAGE |
  BAGGAGE | TAXI | LOUNGE | TRANSFER_DESK | AIRCRAFT_STAND | OTHER)
  terminal, floor, lat, lng

RouteTemplate       -- the "usual time" matrix from the original idea
  id, from_location_id, to_location_id
  est_minutes            -- current template value (median-updated)
  sample_count           -- how many actual tasks contributed
  manually_set (bool)    -- admin-seeded values are kept until enough samples exist

WheelchairType
  id, name (MANUAL | ELECTRIC | AISLE | OWN_CHAIR | CART), notes

Wheelchair (optional v1)
  id, qr_code, type_id, home_storage_location_id, status, current_location_id

Task
  id, created_by (admin), created_at
  passenger_name, passenger_notes, ssr_code (WCHR | WCHS | WCHC | DPNA ...)
  flight_number, flight_direction (ARRIVAL | DEPARTURE | TRANSFER)
  flight_time, priority (NORMAL | HIGH | URGENT)
  storage_location_id (nullable), pickup_location_id, destination_location_id
  wheelchair_type_id, wheelchair_id (nullable, set by QR scan)
  template_est_minutes    -- what the template predicted
  admin_est_minutes       -- what the admin set (defaults to template)
  sla_target_minutes, sla_deadline_at, sla_breached (bool)
  status (see state machine), cancel_reason (nullable)

TaskAssignment      -- supports multi-agent tasks
  task_id, agent_id, assigned_at, accepted_at, role (PRIMARY | ASSIST)

TaskEvent           -- the audit trail; every stage tap is one row
  id, task_id, agent_id, type (ASSIGNED | ACCEPTED | EN_ROUTE_TO_STORAGE |
  WHEELCHAIR_COLLECTED | ARRIVED_AT_PICKUP | PASSENGER_PICKED_UP |
  IN_TRANSIT | PASSENGER_DELIVERED | COMPLETED | CANCELLED | ESCALATED |
  PROBLEM_REPORTED)
  server_time, client_time, lat, lng, note

TrackPoint          -- GPS breadcrumbs, batched
  task_id, agent_id, lat, lng, accuracy_m, recorded_at

ShiftSession
  agent_id, started_at, ended_at
```

**Derived, never stored by hand:** all durations (per stage and total) are computed
from `TaskEvent` timestamps; walked distance from `TrackPoint`s; SLA compliance from
`ARRIVED_AT_PICKUP` (or config-defined milestone) vs. `sla_deadline_at`.

## Task state machine

```
CREATED → ASSIGNED → ACCEPTED → EN_ROUTE_TO_STORAGE → WHEELCHAIR_COLLECTED
        → ARRIVED_AT_PICKUP → PASSENGER_PICKED_UP → IN_TRANSIT
        → PASSENGER_DELIVERED → COMPLETED

Rules:
- Storage stages are skipped when task.storage_location_id is null.
- Any non-terminal state → CANCELLED (reason required) or ESCALATED.
- Transitions are validated server-side; out-of-order taps are rejected.
- Each transition writes a TaskEvent and updates Task.status.
```

## Template learning rule

```
On task COMPLETED:
  actual = minutes(ARRIVED_AT_PICKUP → PASSENGER_DELIVERED)   # per leg, similarly
  t = RouteTemplate(pickup → destination)
  t.sample_count += 1
  if t.sample_count >= 5:            # enough data to trust reality
      t.est_minutes = median(last 20 actuals on this route)
      t.manually_set = false
```

## API outline (REST + WebSocket)

```
POST   /auth/login
GET    /me/tasks?status=active                  (agent queue)
POST   /tasks                                   (admin create; returns template estimate)
POST   /tasks/{id}/assign      {agent_ids[]}
POST   /tasks/{id}/events      {type, client_time, lat, lng}   (stage taps; idempotent)
POST   /tasks/{id}/trackpoints [ {lat,lng,recorded_at}, ... ]  (batched breadcrumbs)
POST   /tasks/{id}/cancel      {reason}
GET    /tasks/{id}/report                       (full per-task result)
GET    /locations, /route-templates (CRUD, admin)
GET    /reports/summary?from=&to=&group_by=agent|route|terminal
WS     /live                                    (dispatcher board: task + agent updates)
```

Idempotency note: stage taps carry a client-generated UUID so offline retries never
create duplicate events.
