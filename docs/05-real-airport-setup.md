# Loading Your Real Airport — Locations, Map, and True Walking Times

Follow these four steps to replace the demo airport with yours. Total effort for one
terminal is typically **half a day**, and walking times tune themselves afterwards.

## Step 1 — List your locations

Write down every place a task can start or end:

- All gates (A1, A2, …)
- Check-in halls / assistance reception desks
- Wheelchair storage rooms
- Baggage claim belts, transfer desks, taxi/pickup ranks, lounges

Give each a short **code** (what agents see on their phone) and a full **name**.

## Step 2 — Get real GPS coordinates (choose the easiest method)

**Method A — Google Maps (recommended, ~2 min per location, no walking):**
1. Open [Google Maps](https://maps.google.com), switch to **satellite view**, zoom
   into your terminal.
2. Right-click exactly on each gate/door — the coordinates appear at the top of the
   menu (e.g. `25.24851, 55.35262`). Click to copy.
3. Paste into your import file (Step 3). First number = `lat`, second = `lng`.

**Method B — walk it with a phone:** stand at the location with any GPS app
(or Google Maps blue-dot → tap it to see coordinates) and record the reading.
Do it once per location.

**Method C — indoor gates with bad GPS:** use the coordinates of the nearest
point on the roof from satellite view. Millimeter accuracy is not needed — the
coordinates drive the map display and distance estimates; the *timing* system runs
on button-tap milestones, not GPS.

## Step 3 — Import

Fill in `setup/airport-import.example.json` with your data, then either:

- **Admin UI**: *Locations* tab → paste the JSON → **Import**, or
- **API**: `POST /api/locations/import` with the JSON (admin token).

What happens automatically:
- Existing codes are **updated in place** (safe to re-import after corrections).
- With `"replace": true` in the JSON, demo/old locations that are not referenced by
  any task, flight, or wheelchair are removed in the same import.
- When every location has `lat`/`lng`, the **map projection is refitted** so your
  whole airport fills the map view, and `meters_per_unit` is computed so
  distance-based fallback estimates remain honest.
- Agents' GPS breadcrumbs are projected onto the same map from then on.

## Step 4 — True walking times

You do **not** need to measure every pair of locations. The system has three layers:

1. **Seed the main routes roughly** (in the import file's `templates`, or the
   *Time templates* tab). Rules of thumb at wheelchair-pushing pace (~55 m/min):
   count ~1 minute per 50–60 m of corridor, add ~1–2 min per elevator, ~2 min per
   security/border crossing. `both_ways: true` (the default) seeds both directions.
2. **Routes you didn't seed** fall back to straight-line distance ÷ walking speed —
   rough but never blocking.
3. **Self-learning takes over**: after 5 completed real tasks on a route, the
   template becomes the **median of actual times** and keeps updating (last 20
   tasks). Within days of live operation your times are measured reality, not
   estimates. The *Time templates* tab shows which values are `manual` vs `learned`
   and how many samples each has.

**Pro tip for day one:** have two or three agents run "practice tasks" along your
busiest routes (create real tasks, walk them properly, complete them). Five walks
per route is enough to flip it to learned — you can have measured times for the top
routes before the first real passenger.

## Optional — your terminal floor plan as the map background

Export your terminal plan as an image (from CAD/PDF, roughly matching the
proportions of your airport's bounding box) and save it as:

```
web/assets/floorplan.png
```

The map automatically shows it (dimmed) behind the location dots, agents, and GPS
routes instead of the generic terminal silhouette. Because locations are placed by
their real GPS through the fitted projection, dots land in the right area of the
plan; nudge any that look off by adjusting that location's lat/lng and re-importing.

## Checklist

- [ ] All locations imported (check the *Locations* tab and the *Map*)
- [ ] Storage rooms present (type `STORAGE`) — auto-storage-selection depends on them
- [ ] Main routes seeded in *Time templates*
- [ ] Wheelchairs registered with QR codes at their real storage rooms
- [ ] Flights of the day entered (or SSR feed pointed at `/api/flights/:id/ssrs`)
- [ ] Optional: `floorplan.png` in place
