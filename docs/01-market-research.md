# Market Research — What Big Airports Already Use

Your idea is not just good — it is exactly what a whole industry category does. It is
called **PRM management software** (PRM = Passenger with Reduced Mobility, the official
aviation term for passengers needing wheelchair or mobility assistance). Studying these
products tells us which features matter and which mistakes to avoid.

## 1. The main products used by big companies

### Ozion PRM Manager (the market leader in Europe)
- Used at **London Heathrow** and 18+ airports across Europe and North America;
  handles up to **10,000 assistance requests per day**.
- Converts every assistance request into **jobs and tasks**, and builds each
  passenger journey automatically based on rules about resources, airport layout,
  and staffing.
- Dispatchers see **agent availability in real time** and can assign one agent to
  many passengers or many agents to one passenger (e.g. lifting help).
- Agents carry PDAs/phones — the operation always knows **each passenger's location
  and each task's status**.
- A **Passenger Delay Monitor** shows delays in real time so dispatchers react
  *before* a passenger waits too long.
- Deep analytics: query performance by airline, flight, route, terminal, date,
  wheelchair type, SSR code, etc.

Source: [ozion-airport.com PRM software](https://www.ozion-airport.com/prm-software-solution-for-airports/),
[Heathrow case](https://www.ozion-airport.com/2025/09/16/as-proven-in-heathrow-the-airport-software-system-too-important-to-fail/)

### AvTech SSR/PRM (common in the USA)
- Used by US wheelchair-assistance vendors to **staff, dispatch, and track** passengers.
- Dispatchers can **scan a passenger's boarding pass** to create/assign the task.
- Integrates flight data feeds, text messaging, and even **autonomous wheelchairs
  (WHILL)** as an assignable resource.

Source: [avtechcorp.com](https://www.avtechcorp.com/products-passengers-assistance-a/),
[Runway Girl Network on WHILL + AvTech](https://runwaygirlnetwork.com/2024/12/whill-autonomous-wheelchairs-see-growing-adoption-at-airports/)

### Avtura AV PAX
- Manages and records all passenger-services operations: check-in, boarding gates,
  lounges, and **PRM activities**, tied into aircraft turnaround management.

Source: [avtura.com](https://www.avtura.com/)

### Other relevant tech
- **Samsic ORESTE** — PRM operations software used by the ground handler Samsic Aero
  ([samsic.aero](https://www.samsic.aero/prm-reduced-mobility)).
- **infsoft wheelchair tracking** — indoor positioning (BLE/UWB beacons) to track
  where wheelchairs physically are inside the terminal, because **GPS is weak
  indoors** ([infsoft use case](https://www.infsoft.com/use-cases/cart-and-wheelchair-tracking-at-an-airport/)).
- **WHILL autonomous wheelchairs** — self-driving chairs that can be dispatched like
  staff ([whill.inc](https://whill.inc/us/autonomous-service/)).

## 2. Industry rules that shape the app (very important)

Wheelchair assistance at airports is regulated, and the software is built around the
legal waiting-time targets:

- **EU Regulation EC 1107/2006** (and ECAC Doc 30 quality standards): commonly applied
  targets are that **departing** pre-booked passengers wait no more than ~**10 min**
  (pre-notified) to ~**30 min** after presenting themselves, and **arriving**
  passengers get assistance at the aircraft within ~**20 min** of the aircraft
  arriving on stand. Airports publish these as SLAs
  (example: [Vienna Airport PRM quality standards](https://viennaairport.com/en/passengers/airport/accessible_travel/prm_quality_standards)).
- **USA**: the Air Carrier Access Act (ACAA) requires "prompt" assistance, and the
  DOT fines airlines for wheelchair delays, so US carriers demand timing evidence
  from vendors.

**Consequence for our app:** timing is not just a "nice statistic" — it is the legal
proof the airport/handler needs. Every task must record timestamps of each milestone
automatically, and the dispatcher must be warned **before** an SLA is breached.

## 3. Lessons to copy into our design

1. **Model the work as jobs with milestones**, not just "start/finish". Real products
   track: notified → agent assigned → agent en route → wheelchair collected →
   passenger contact → in transit → handover/complete.
2. **Countdown timers against SLA targets** with color escalation (green → amber →
   red) on the dispatcher screen.
3. **Auto-assignment suggestions**: nearest available agent with the right skills
   (e.g. trained for aisle-chair transfers, two-person lifts).
4. **Estimated times from templates that learn**: seed a gate-to-gate time matrix
   manually, then continuously update it with the median of actual completed tasks.
5. **Flight data awareness**: tasks should link to a flight so gate changes and
   delays update the task automatically (later phase: AODB/FIDS feed).
6. **Indoor positioning caveat**: GPS works poorly inside terminals. Plan for GPS
   outdoors + (later) BLE beacons or Wi-Fi positioning indoors, and always fall back
   to milestone timestamps as the source of truth.
7. **Passenger dignity**: notifications to the passenger ("your agent Ahmed is 3 min
   away") is a differentiator big vendors advertise.

## Sources
- [Ozion PRM software solution for airports](https://www.ozion-airport.com/prm-software-solution-for-airports/)
- [Ozion — proven at Heathrow](https://www.ozion-airport.com/2025/09/16/as-proven-in-heathrow-the-airport-software-system-too-important-to-fail/)
- [Ozion PRM Manager for service providers](https://www.ozion-airport.com/prm-manager-for-service-providers/)
- [Ozion — smart milestones](https://www.ozion-airport.com/2025/06/20/prm-precision-how-smart-milestones-drive-success/)
- [AvTech passenger assistance products](https://www.avtechcorp.com/products-passengers-assistance-a/)
- [Runway Girl Network — WHILL + AvTech integration](https://runwaygirlnetwork.com/2024/12/whill-autonomous-wheelchairs-see-growing-adoption-at-airports/)
- [Avtura Ltd](https://www.avtura.com/)
- [Samsic Aero PRM](https://www.samsic.aero/prm-reduced-mobility)
- [infsoft — wheelchair tracking at an airport](https://www.infsoft.com/use-cases/cart-and-wheelchair-tracking-at-an-airport/)
- [WHILL autonomous service](https://whill.inc/us/autonomous-service/)
- [Vienna Airport PRM quality standards](https://viennaairport.com/en/passengers/airport/accessible_travel/prm_quality_standards)
- [Latest technologies in wheelchair dispatch](https://an.aero/the-latest-technologies-in-wheelchair-dispatch/)
