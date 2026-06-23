# future-battlefield-ui

A **real-time tactical HUD** that fuses live air, sea, and space tracks onto a single command-console map interface — built in **framework-free vanilla JavaScript** with a thin Node.js proxy server.

## Frontend highlights

- **~2,800 lines of dependency-free JS** — a hand-rolled state machine and render loop, no React/Vue/build step
- **MapLibre GL** base map with a **Canvas 2D** tactical overlay composited on top
- Live tracks for **aircraft, satellites, and vessels**, plus address geocoding and parcel tracking
- Custom **tactical HUD** styling — a CRT / command-console aesthetic driven by CSS variables

## Architecture

A Node.js proxy (`server.js`, port 8080) aggregates and normalizes several open data sources behind one origin, so the browser only ever talks to localhost:

| Endpoint | Source |
|----------|--------|
| `/api/flights` | Flightradar24 — live aircraft |
| `/api/satellites` | CelesTrak SGP4 TLE — satellite positions |
| `/api/vessels` | MarineTraffic / `vessels.json` — ships |
| `/api/aircraft-photo` | Planespotters.net — aircraft imagery |
| `/api/geocode` | Nominatim / OpenStreetMap — address → coordinates |
| `/api/track` | Tracker.delivery — parcel tracking |

See [`ARCHITECTURE.md`](ARCHITECTURE.md) for the full breakdown (Korean).

## Getting started

```bash
node server.js     # serves the UI + API proxy at http://localhost:8080
```

## Files

| File | Role |
|------|------|
| `index.html` | DOM structure, HUD layout, panels |
| `app.js` | All client logic (~2,860 lines) |
| `styles.css` | Tactical HUD styling |
| `server.js` | Node.js HTTP proxy server |
| `vessels.json` | Cached vessel data |
