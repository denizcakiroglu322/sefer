# Sefer

**A departure-time–optimizing, multi-stop route planner for Istanbul.** Sefer decides *when to leave* and *in what order to visit your stops* using a time-dependent traffic model — then picks the right Bosphorus crossing while accounting for **directional bridge tolls**.

**Live demo:** https://sefer-h98a.onrender.com — hit `/health`, then try the `/day` example below.
*(Free tier: the first request after a few idle minutes can take ~30s to wake, then it's instant.)*

Zero runtime dependencies — pure Node.js built-ins.

---

## Why this isn't just "sort the stops"

Map apps optimize stop order for a **fixed** start time. The parts that actually bite in Istanbul are the ones Sefer focuses on:

- **Departure-time optimization.** It scans a time window and recommends *when to leave*. A Kadıköy→Maslak hop is ~24 min at midday but ~53 min in the 18:00 peak — timing matters as much as ordering.
- **Istanbul bridge & toll rules.** 15 Temmuz and FSM are tolled **one-way only** (Asia→Europe); the return is free. YSS is tolled **both directions**. A there-and-back trip is **₺59, not ₺118** — and the planner gets this right per leg.
- **Time + toll crossing selection.** Each crossing is scored by `drive_time × value-of-time + toll`, so it won't pay ₺285 for the Avrasya Tunnel to save a minute, nor send you far out of the way to a "cheap" bridge whose detour costs an hour.
- **Deadline mode.** "Be at the last stop by 17:30" → it returns the *latest* departure that still makes it.

---

## Live example — `POST /day`

```bash
curl -s https://sefer-h98a.onrender.com/day \
  -H 'content-type: application/json' \
  -d '{
    "stops": ["Kadikoy", "Besiktas", "Levent", "Maslak", "Kadikoy"],
    "dwell": { "Besiktas": 45, "Levent": 30, "Maslak": 60 },
    "window": { "start": "12:00", "end": "18:00" }
  }'
```

**Example response** (trimmed — real output from the live endpoint):

```json
{
  "order": ["Kadikoy", "Maslak", "Levent", "Besiktas", "Kadikoy"],
  "recommendedDeparture": "12:00",
  "arrival": "15:06",
  "savedByOrdering": 1.5,
  "legs": [
    { "from": "Kadikoy",  "to": "Maslak",  "durationMin": 23.9, "crossing": { "id": "15temmuz", "direction": "A2E" }, "tollTRY": 59 },
    "… 2 intra-Europe legs: crossing null, tollTRY 0 …",
    { "from": "Besiktas", "to": "Kadikoy", "durationMin": 12.6, "crossing": { "id": "15temmuz", "direction": "E2A" }, "tollTRY": 0 }
  ],
  "totals": { "drivingMin": 50.6, "dwellMin": 135, "doorToDoorMin": 185.6, "fuelTRY": 181, "tollTRY": 59, "totalTRY": 240 }
}
```

> The return leg (`Beşiktaş→Kadıköy`, `E2A`) is **₺0** — 15 Temmuz is tolled one-way only, so the round trip costs ₺59, not ₺118. *(Free tier: the first request can take ~30 s to wake the instance.)*

The response contains:

- `order` — optimized stop sequence (first and last fixed, the middle re-ordered)
- `recommendedDeparture` / `arrival`, plus `savedByOrdering` (minutes saved vs. your input order)
- `legs[]` — per leg: drive time, distance, `crossing` (`id`, `direction`) and `tollTRY`
- `totals` — `drivingMin`, `dwellMin`, `doorToDoorMin`, `fuelTRY`, `tollTRY`, `totalTRY`
- `weather` — live conditions (rain nudges the traffic estimate)

For the trip above: order `Kadıköy → Maslak → Levent → Beşiktaş → Kadıköy`, leave `12:00`, **total ₺240** — outbound 15 Temmuz at ₺59, **return at ₺0** (one-way rule). Add `"mode": "deadline", "arriveBy": "17:30"` to get the latest departure that still arrives in time.

---

## Endpoints

| Method & path | Purpose |
|---|---|
| `GET /health` | liveness check |
| `POST /scan` | shortest-duration departure within a window (single trip) |
| `POST /deadline` | latest departure to arrive by a given time |
| `POST /optimize` | optimal stop order at a reference time |
| `POST /plan` | one trip: route + crossing + cost + live weather |
| `POST /day` | **the full flow** — order + departure + per-leg ETA/toll + totals |
| `GET` / `POST /tours` | list / save named tours |

Locations are either a name (`"Kadikoy"`, resolved via a built-in gazetteer with Nominatim fallback) or `{lat, lng}`.

---

## Architecture

- **No runtime dependencies** — `node:http` + built-ins (`fetch`, `fs`, `url`). Nothing to install.
- **Traffic model** (`engine.mjs`) — deterministic and parametric: a base level plus Gaussian **morning (08:30)** and **evening (18:00)** peaks defined in `CONFIG`. Same input → same output; the evening peak runs ~2.2× midday. Distance is haversine × a city detour factor.
- **Geocoding** (`geo.mjs`) — offline gazetteer of Istanbul districts; Nominatim fallback (3 s timeout). Each point carries its Bosphorus side (Europe / Asia).
- **Crossing selection** (`bridges.mjs`) — four crossings scored by `time × VALUE_OF_TIME_TRY_PER_MIN + directional toll`; value-of-time is a single tunable knob (default 5 ₺/min).
- **Cost** (`cost.mjs`) — configurable bridge tolls and fuel; directional one-way toll logic.
- **Weather** (`weather.mjs`) — live Open-Meteo (3 s timeout, graceful offline fallback); rain raises the congestion multiplier.

---

## Run locally

```bash
git clone https://github.com/denizcakiroglu322/sefer.git
cd sefer
node server.mjs        # -> "sefer api :3000"   (no install needed: zero dependencies)
```

Node 18+ (developed on 22). The server reads `PORT` from the environment, defaulting to 3000. `node demo.mjs` exercises the core engine without the HTTP layer.

---

## Current limitations & roadmap

Where it honestly stands:

- **Traffic is modeled, not measured — yet.** The curve is synthetic but realistic (midday ≈ baseline, evening ≈ 2.2× midday). Because `CONFIG` is parametric, wiring in **real İBB hourly traffic data** is the planned next step — a data/calibration change, not a rewrite.
- **The crossing affects toll, not yet drive time.** A leg's duration is straight-line × detour and doesn't yet route *through* the chosen bridge (approach/egress time). Crossing *selection* is correct; folding bridge geometry into the duration is the next modeling step.
- **No persistence on the live demo.** Saved tours live in `tours.json`, which is ephemeral on the free tier (resets on restart). A real datastore is future work.

---

Built from scratch as a focused prototype: a real Istanbul problem (timing + cross-Bosphorus multi-stop trips), a deterministic engine, and no framework.
