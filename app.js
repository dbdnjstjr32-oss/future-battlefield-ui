// MapLibre GL & Canvas Tactical HUD Integration

const canvas = document.getElementById('terrain-canvas');
const ctx = canvas.getContext('2d');

// Engine State
const state = {
    yaw: -10 * (Math.PI / 180),
    pitch: 35 * (Math.PI / 180),
    zoom: 7.0,
    gridInterval: 0.5,
    isAutoRot: false,
    isNoiseWave: true,
    isScanline: true,
    showAircraft: true,
    showVessels: true,
    showDataCenters: true,
    showSatTracks: true,
    scanProgress: 0
};

// Altitude layer scale (pixels per km in vertical dimension, updated each frame)
let altPxPerKm = 2;

// Initialize MapLibre GL Map with Satellite imagery
const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {
            'satellite-tiles': {
                type: 'raster',
                tiles: [
                    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'
                ],
                tileSize: 256,
                attribution: 'Tiles &copy; Esri'
            }
        },
        layers: [
            {
                id: 'satellite-layer',
                type: 'raster',
                source: 'satellite-tiles',
                minzoom: 0,
                maxzoom: 18
            }
        ]
    },
    center: [127.7669, 35.9077], // South Korea Center Coordinates
    zoom: state.zoom,
    pitch: 35, // Lowered from 50 → 35: perspective tilt is the main GPU cost; 35 keeps the 3D feel with far less lag
    bearing: -10,
    attributionControl: false
});

// Canvas Resizing
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Connect DOM controls
const heightSlider = document.getElementById('height-scale');
const heightValEl = document.getElementById('height-val');
const resSlider = document.getElementById('grid-resolution');
const resValEl = document.getElementById('res-val');
const zoomSlider = document.getElementById('camera-zoom');
const zoomValEl = document.getElementById('zoom-val');
const speedSlider = document.getElementById('auto-rot-speed');
const speedValEl = document.getElementById('speed-val');

const toggleAutoRot = document.getElementById('toggle-autorot');
const toggleNoiseWave = document.getElementById('toggle-noise-wave');
const toggleScanline = document.getElementById('toggle-scanline');
const toggleAircraft = document.getElementById('toggle-aircraft');
const toggleVessels = document.getElementById('toggle-vessels');
const toggleDataCenter = document.getElementById('toggle-datacenter');
const toggleSatTrack = document.getElementById('toggle-sattrack');

const pitchValEl = document.getElementById('pitch-val');
const yawValEl = document.getElementById('yaw-val');
const fpsCounter = document.getElementById('fps-counter');
const vertexCounter = document.getElementById('vertex-counter');

// Set slider initial settings
heightSlider.disabled = true; // Height scale disabled as 3D terrain uses actual map projection
heightValEl.textContent = "MAP CONTROLLER";

// Resolution slider controls Grid Line Spacing
resSlider.min = "1";
resSlider.max = "10";
resSlider.value = "5"; // 0.5 degrees
resValEl.textContent = "0.5° Spacing";

resSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    state.gridInterval = val * 0.1;
    resValEl.textContent = `${state.gridInterval.toFixed(1)}° Spacing`;
});

zoomSlider.min = "5";
zoomSlider.max = "12";
zoomSlider.step = "0.1";
zoomSlider.value = state.zoom;
zoomValEl.textContent = state.zoom.toFixed(1) + 'x';

zoomSlider.addEventListener('input', (e) => {
    state.zoom = parseFloat(e.target.value);
    map.setZoom(state.zoom);
    zoomValEl.textContent = state.zoom.toFixed(1) + 'x';
});

toggleAutoRot.checked = state.isAutoRot;
toggleAutoRot.addEventListener('change', (e) => {
    state.isAutoRot = e.target.checked;
});

toggleNoiseWave.addEventListener('change', (e) => {
    state.isNoiseWave = e.target.checked;
});

toggleScanline.addEventListener('change', (e) => {
    state.isScanline = e.target.checked;
});

toggleAircraft.checked = state.showAircraft;
toggleAircraft.addEventListener('change', (e) => {
    state.showAircraft = e.target.checked;
    // Deselect a hidden aircraft target
    if (!state.showAircraft && selectedDrone && !selectedDrone.isVessel) selectedDrone = null;
});

toggleVessels.checked = state.showVessels;
toggleVessels.addEventListener('change', (e) => {
    state.showVessels = e.target.checked;
    // Deselect a hidden vessel target
    if (!state.showVessels && selectedDrone && selectedDrone.isVessel) selectedDrone = null;
});

toggleDataCenter.checked = state.showDataCenters;
toggleDataCenter.addEventListener('change', (e) => {
    state.showDataCenters = e.target.checked;
});

toggleSatTrack.checked = state.showSatTracks;
toggleSatTrack.addEventListener('change', (e) => {
    state.showSatTracks = e.target.checked;
});

// Synchronize Map changes back to UI Telemetry
map.on('move', () => {
    const bearing = map.getBearing();
    const pitch = map.getPitch();
    state.zoom = map.getZoom();

    state.yaw = bearing * (Math.PI / 180);
    state.pitch = pitch * (Math.PI / 180);

    // Update Telemetry Display
    let yawDeg = bearing.toFixed(1);
    if (yawDeg < 0) yawDeg = (parseFloat(yawDeg) + 360).toFixed(1);
    yawValEl.textContent = `${yawDeg}°`;
    pitchValEl.textContent = `${pitch.toFixed(1)}°`;
    zoomValEl.textContent = state.zoom.toFixed(1) + 'x';
    zoomSlider.value = state.zoom;
});


// ─── Satellite Tracking (SGP4 via satellite.js) ─────────────────────────────

let satObjects = [];
let satTrackLastUpdate = 0;
const SAT_TRACK_INTERVAL = 30000;

async function fetchSatelliteTLEs() {
    try {
        const res = await fetch('/api/satellites');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (!Array.isArray(data) || data.length === 0) throw new Error('Empty TLE');
        satObjects = data.map(s => {
            try {
                const satrec = satellite.twoline2satrec(s.tle1, s.tle2);
                return { name: s.name.trim(), satrec, pastTrack: [], futureTrack: [] };
            } catch (e) { return null; }
        }).filter(Boolean);
        satTrackLastUpdate = 0;
        console.log(`[Satellites] Loaded ${satObjects.length} satellites.`);
    } catch (err) { console.warn('[Satellites] TLE fetch failed:', err.message); }
}
fetchSatelliteTLEs();
setInterval(fetchSatelliteTLEs, 3600000);

function getSatPos(satrec, date) {
    try {
        const pv = satellite.propagate(satrec, date);
        if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
        const gmst = satellite.gstime(date);
        const geo  = satellite.eciToGeodetic(pv.position, gmst);
        return { lon: satellite.degreesLong(geo.longitude), lat: satellite.degreesLat(geo.latitude), alt: geo.height };
    } catch (e) { return null; }
}

function recomputeSatTracks() {
    const now = new Date();
    satObjects.forEach(sat => {
        const past = [], future = [];
        for (let m = -24; m <= 0; m += 2) { const p = getSatPos(sat.satrec, new Date(now.getTime() + m * 60000)); if (p) past.push(p); }
        for (let m = 0; m <= 80; m += 2)  { const p = getSatPos(sat.satrec, new Date(now.getTime() + m * 60000)); if (p) future.push(p); }
        sat.pastTrack = past; sat.futureTrack = future;
    });
}

function drawSatTrack(track) {
    if (track.length < 2) return;
    ctx.beginPath();
    let first = true, prevLon = null;
    const step = 2; // Project every 2nd point to cut projection operations in half
    for (let i = 0; i < track.length; i += step) {
        const pt = track[i];
        if (prevLon !== null && Math.abs(pt.lon - prevLon) > 180) { ctx.stroke(); ctx.beginPath(); first = true; }
        const sp = map.project([pt.lon, pt.lat]);
        if (first) { ctx.moveTo(sp.x, sp.y); first = false; } else { ctx.lineTo(sp.x, sp.y); }
        prevLon = pt.lon;
    }
    // Always connect the final point for continuity
    const lastIdx = track.length - 1;
    if (lastIdx % step !== 0) {
        const pt = track[lastIdx];
        if (prevLon !== null && Math.abs(pt.lon - prevLon) > 180) { ctx.stroke(); ctx.beginPath(); }
        const sp = map.project([pt.lon, pt.lat]);
        ctx.lineTo(sp.x, sp.y);
    }
    ctx.stroke();
}

function drawSatellites(time) {
    if (satObjects.length === 0) return;
    if (time - satTrackLastUpdate > SAT_TRACK_INTERVAL) { recomputeSatTracks(); satTrackLastUpdate = time; }
    const now = new Date();
    satObjects.forEach(sat => {
        // Current position
        const cur = getSatPos(sat.satrec, now);
        if (!cur) return;
        const sp = map.project([cur.lon, cur.lat]);

        // Cull tracks and icon if satellite is extremely far offscreen (> 1500px)
        const isFarOffscreen = sp.x < -1500 || sp.x > canvas.width + 1500 || sp.y < -1500 || sp.y > canvas.height + 1500;
        if (isFarOffscreen) return;

        if (state.showSatTracks) {
            // Past track
            ctx.save(); ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.setLineDash([]);
            drawSatTrack(sat.pastTrack); ctx.restore();
            // Future track (dashed)
            ctx.save(); ctx.lineWidth = 0.8; ctx.strokeStyle = 'rgba(255,255,255,0.32)'; ctx.setLineDash([5, 7]);
            drawSatTrack(sat.futureTrack); ctx.setLineDash([]); ctx.restore();
        }
        
        if (sp.x < -60 || sp.x > canvas.width + 60 || sp.y < -60 || sp.y > canvas.height + 60) return;
        // Satellite icon (central body + solar-panel wings + dish antenna)
        ctx.save();
        ctx.translate(sp.x, sp.y);
        ctx.strokeStyle = 'rgba(255,255,255,0.92)';
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1.0;

        // Struts linking body to panels
        ctx.beginPath();
        ctx.moveTo(-4, 0); ctx.lineTo(-7, 0);
        ctx.moveTo( 4, 0); ctx.lineTo( 7, 0);
        ctx.stroke();

        // Left solar panel (with cell dividers)
        ctx.beginPath(); ctx.rect(-15, -3.5, 8, 7); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-12.3, -3.5); ctx.lineTo(-12.3, 3.5);
        ctx.moveTo(-9.6, -3.5);  ctx.lineTo(-9.6, 3.5);
        ctx.stroke();

        // Right solar panel (with cell dividers)
        ctx.beginPath(); ctx.rect(7, -3.5, 8, 7); ctx.fill(); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(9.7, -3.5);  ctx.lineTo(9.7, 3.5);
        ctx.moveTo(12.4, -3.5); ctx.lineTo(12.4, 3.5);
        ctx.stroke();

        // Central body
        ctx.beginPath(); ctx.rect(-4, -4, 8, 8); ctx.fill(); ctx.stroke();

        // Antenna mast + dish
        ctx.beginPath(); ctx.moveTo(0, -4); ctx.lineTo(0, -8); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, -9, 1.6, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
        // Label
        ctx.save();
        ctx.font = '8px "Share Tech Mono", monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.fillText(sat.name, sp.x + 14, sp.y - 2);
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fillText(`${Math.round(cur.alt)} km`, sp.x + 14, sp.y + 9);
        ctx.restore();
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// ─── Global Data Center Network ──────────────────────────────────────────────

const dataCenters = [
    // North America
    { id:'ASH', coords:[-77.488, 38.970], tier:1 }, { id:'SJC', coords:[-121.886, 37.338], tier:1 },
    { id:'DFW', coords:[-96.872,  32.777], tier:1 }, { id:'ORD', coords:[-87.630,  41.878], tier:1 },
    { id:'JFK', coords:[-74.006,  40.713], tier:1 }, { id:'SEA', coords:[-122.332, 47.606], tier:1 },
    { id:'LAX', coords:[-118.244, 34.052], tier:1 }, { id:'MIA', coords:[-80.192,  25.762], tier:2 },
    { id:'ATL', coords:[-84.388,  33.749], tier:2 }, { id:'PHX', coords:[-112.074, 33.448], tier:2 },
    { id:'YYZ', coords:[-79.383,  43.653], tier:2 }, { id:'YVR', coords:[-123.121, 49.283], tier:2 },
    { id:'DEN', coords:[-104.990, 39.739], tier:2 }, { id:'YUL', coords:[-73.567,  45.502], tier:2 },
    // Europe
    { id:'AMS', coords:[  4.904,  52.368], tier:1 }, { id:'FRA', coords:[  8.682,  50.111], tier:1 },
    { id:'LHR', coords:[ -0.128,  51.507], tier:1 }, { id:'CDG', coords:[  2.352,  48.857], tier:1 },
    { id:'ARN', coords:[ 18.069,  59.329], tier:2 }, { id:'ZRH', coords:[  8.542,  47.377], tier:2 },
    { id:'DUB', coords:[ -6.260,  53.350], tier:2 }, { id:'MAD', coords:[ -3.704,  40.417], tier:2 },
    { id:'MXP', coords:[  9.190,  45.465], tier:2 }, { id:'WAW', coords:[ 21.012,  52.230], tier:2 },
    { id:'HEL', coords:[ 24.941,  60.170], tier:2 }, { id:'OSL', coords:[ 10.753,  59.913], tier:2 },
    // Asia-Pacific
    { id:'NRT', coords:[139.692,  35.690], tier:1 }, { id:'SIN', coords:[103.820,   1.352], tier:1 },
    { id:'HKG', coords:[114.169,  22.319], tier:1 }, { id:'SYD', coords:[151.209, -33.869], tier:1 },
    { id:'ICN', coords:[126.978,  37.567], tier:1 }, { id:'BOM', coords:[ 72.878,  19.076], tier:1 },
    { id:'KIX', coords:[135.502,  34.694], tier:2 }, { id:'TPE', coords:[121.565,  25.033], tier:2 },
    { id:'PVG', coords:[121.474,  31.230], tier:1 }, { id:'PEK', coords:[116.407,  39.904], tier:2 },
    { id:'CGK', coords:[106.846,  -6.209], tier:2 }, { id:'MEL', coords:[144.963, -37.814], tier:2 },
    { id:'DEL', coords:[ 77.103,  28.704], tier:2 }, { id:'KUL', coords:[101.687,   3.139], tier:2 },
    { id:'MNL', coords:[120.984,  14.599], tier:2 }, { id:'BKK', coords:[100.523,  13.736], tier:2 },
    // Middle East
    { id:'DXB', coords:[ 55.271,  25.205], tier:1 }, { id:'BAH', coords:[ 50.586,  26.067], tier:2 },
    { id:'TLV', coords:[ 34.782,  32.085], tier:2 },
    // South America
    { id:'GRU', coords:[-46.633, -23.551], tier:1 }, { id:'BOG', coords:[-74.072,   4.711], tier:2 },
    { id:'SCL', coords:[-70.669, -33.449], tier:2 }, { id:'LIM', coords:[-77.043, -12.046], tier:2 },
    // Africa
    { id:'JNB', coords:[ 28.047, -26.204], tier:1 }, { id:'CPT', coords:[ 18.424, -33.925], tier:2 },
    { id:'NBO', coords:[ 36.822,  -1.292], tier:2 }, { id:'LOS', coords:[  3.379,   6.524], tier:2 },
];

// Haversine great-circle distance in km
function dcHaversine(c1, c2) {
    const R = 6371, toR = d => d * Math.PI / 180;
    const dLat = toR(c2[1] - c1[1]), dLon = toR(c2[0] - c1[0]);
    const a = Math.sin(dLat/2)**2 + Math.cos(toR(c1[1]))*Math.cos(toR(c2[1]))*Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Spherical SLERP great-circle interpolation
function gcPoints(c1, c2, n = 28) {
    const toR = d => d * Math.PI/180, toD = r => r * 180/Math.PI;
    const [φ1, λ1] = [toR(c1[1]), toR(c1[0])], [φ2, λ2] = [toR(c2[1]), toR(c2[0])];
    const d = 2 * Math.asin(Math.sqrt(Math.sin((φ2-φ1)/2)**2 + Math.cos(φ1)*Math.cos(φ2)*Math.sin((λ2-λ1)/2)**2));
    if (d < 1e-6) return [c1, c2];
    const pts = [];
    for (let i = 0; i <= n; i++) {
        const f = i / n, A = Math.sin((1-f)*d)/Math.sin(d), B = Math.sin(f*d)/Math.sin(d);
        const x = A*Math.cos(φ1)*Math.cos(λ1) + B*Math.cos(φ2)*Math.cos(λ2);
        const y = A*Math.cos(φ1)*Math.sin(λ1) + B*Math.cos(φ2)*Math.sin(λ2);
        const z = A*Math.sin(φ1) + B*Math.sin(φ2);
        pts.push([toD(Math.atan2(y, x)), toD(Math.atan2(z, Math.sqrt(x*x + y*y)))]);
    }
    return pts;
}

// Pre-computed K=4 nearest-neighbor connections (great-circle arcs)
let dcConnections = null;
function ensureDCConnections() {
    if (dcConnections) return;
    const K = 4, pairs = new Set();
    dataCenters.forEach((a, i) => {
        dataCenters
            .map((b, j) => ({ j, d: dcHaversine(a.coords, b.coords) }))
            .filter(n => n.j !== i)
            .sort((x, y) => x.d - y.d)
            .slice(0, K)
            .forEach(n => {
                const key = i < n.j ? `${i}-${n.j}` : `${n.j}-${i}`;
                pairs.add(key);
            });
    });
    dcConnections = [...pairs].map(key => {
        const [i, j] = key.split('-').map(Number);
        return { a: dataCenters[i], b: dataCenters[j], pts: gcPoints(dataCenters[i].coords, dataCenters[j].coords) };
    });
    console.log(`[DataCenters] ${dataCenters.length} sites · ${dcConnections.length} links`);
}

// Draw global data center network
function drawDataCenters(time) {
    ensureDCConnections();
    const pulse = 0.60 + 0.40 * Math.abs(Math.sin(time * 0.0007));

    // ── Connection arcs ──────────────────────────────────────────────────────
    ctx.save();
    // Soft white glow so the network links read clearly against the dark map
    ctx.shadowColor = 'rgba(255, 255, 255, 0.9)';
    ctx.shadowBlur = 6;
    ctx.lineCap = 'round';
    dcConnections.forEach(conn => {
        // Project the two endpoints first to perform bounding box culling
        const spA = map.project(conn.a.coords);
        const spB = map.project(conn.b.coords);

        const minX = Math.min(spA.x, spB.x);
        const maxX = Math.max(spA.x, spB.x);
        const minY = Math.min(spA.y, spB.y);
        const maxY = Math.max(spA.y, spB.y);
        const margin = 150;

        // Skip calculations for links completely offscreen
        if (maxX < -margin || minX > canvas.width + margin || maxY < -margin || minY > canvas.height + margin) {
            return;
        }

        const isTrans = Math.abs(conn.a.coords[0] - conn.b.coords[0]) > 60; // intercontinental
        ctx.lineWidth = isTrans ? 1.4 : 1.0;
        ctx.strokeStyle = isTrans
            ? `rgba(255,255,255,${(0.85 * pulse).toFixed(3)})`
            : `rgba(255,255,255,${(0.55 * pulse).toFixed(3)})`;
        ctx.beginPath();
        let first = true, prevLon = null;
        const step = 2; // Project every 2nd point for 50% fewer projections
        for (let i = 0; i < conn.pts.length; i += step) {
            const pt = conn.pts[i];
            if (prevLon !== null && Math.abs(pt[0] - prevLon) > 180) {
                ctx.stroke(); ctx.beginPath(); first = true;
            }
            const sp = map.project(pt);
            if (first) { ctx.moveTo(sp.x, sp.y); first = false; }
            else         { ctx.lineTo(sp.x, sp.y); }
            prevLon = pt[0];
        }
        const lastIdx = conn.pts.length - 1;
        if (lastIdx % step !== 0) {
            const pt = conn.pts[lastIdx];
            if (prevLon !== null && Math.abs(pt[0] - prevLon) > 180) {
                ctx.stroke(); ctx.beginPath();
            }
            const sp = map.project(pt);
            ctx.lineTo(sp.x, sp.y);
        }
        ctx.stroke();
    });
    ctx.restore();

    // ── Site markers ─────────────────────────────────────────────────────────
    dataCenters.forEach(dc => {
        const sp = map.project(dc.coords);
        if (sp.x < -30 || sp.x > canvas.width + 30 || sp.y < -30 || sp.y > canvas.height + 30) return;

        const isSeoul  = dc.id === 'ICN';
        const s        = dc.tier === 1 ? 5 : 3;

        // Diamond marker (rotated 45°)
        ctx.save();
        ctx.translate(sp.x, sp.y);
        ctx.rotate(Math.PI / 4);
        ctx.strokeStyle = isSeoul ? 'rgba(255,255,255,1.0)'
            : dc.tier === 1 ? 'rgba(255,255,255,0.78)' : 'rgba(255,255,255,0.38)';
        ctx.lineWidth   = isSeoul ? 1.8 : dc.tier === 1 ? 1.1 : 0.7;
        ctx.strokeRect(-s, -s, s * 2, s * 2);
        ctx.restore();

        // Center fill dot for tier-1
        if (dc.tier === 1) {
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.beginPath();
            ctx.arc(sp.x, sp.y, 1.5, 0, Math.PI * 2);
            ctx.fill();
        }

        // Label
        ctx.save();
        ctx.font        = `${dc.tier === 1 ? 8 : 7}px "Share Tech Mono", monospace`;
        ctx.fillStyle   = dc.tier === 1 ? 'rgba(255,255,255,0.70)' : 'rgba(255,255,255,0.35)';
        ctx.fillText(dc.id, sp.x + s + 5, sp.y + 3);
        ctx.restore();
    });
}

// ─────────────────────────────────────────────────────────────────────────────

// Tactical locations (Bases)
const militaryBases = [
    { name: "SEOUL HQ", coords: [127.05, 37.45] },
    { name: "GYERYONGDAE", coords: [127.24, 36.29] },
    { name: "BUSAN NAVAL BASE", coords: [129.09, 35.10] },
    { name: "JEJU AIRFIELD", coords: [126.46, 33.24] }
];

// Drones/Aircraft (patrolling targets and real flight feeds)
let drones = [];

// Fallback mock aircraft in case the API is rate-limited or fails
// altitude in feet, speedKnots for display, velocity (m/s) for physics
const mockFlights = [
    { id: "KAL082", currentCoords: [127.12, 37.40], speedKnots: 430, heading: 45, altitude: 32000, acType: "B789", registration: "HL8084", origin: "LIS", dest: "ICN" },
    { id: "AAR361", currentCoords: [128.40, 36.20], speedKnots: 410, heading: 180, altitude: 28000, acType: "A359", registration: "HL8361", origin: "LHR", dest: "ICN" },
    { id: "JJA512", currentCoords: [126.80, 35.10], speedKnots: 370, heading: 270, altitude: 24000, acType: "B738", registration: "HL8051", origin: "CJU", dest: "GMP" }
];

function initializeMockFlights() {
    drones = mockFlights.map(f => ({
        id: f.id,
        currentCoords: [...f.currentCoords],
        velocity: f.speedKnots * 0.514444, // m/s for physics
        speedKnots: f.speedKnots,
        heading: f.heading,
        altitude: f.altitude,   // stored in feet
        acType: f.acType,
        registration: f.registration,
        origin: f.origin,
        dest: f.dest,
        path: [],
        isMock: true,
        isGrounded: false
    }));
}
initializeMockFlights();

async function fetchRealFlights() {
    try {
        const res = await fetch('/api/flights');
        if (!res.ok) throw new Error('API Response Error');
        const data = await res.json();
        
        if (data) {
            const flightKeys = Object.keys(data).filter(k => k !== 'version' && k !== 'full_count' && k !== 'stats');
            
            if (flightKeys.length > 0) {
                const prevPaths = {};
                drones.forEach(d => {
                    prevPaths[d.id] = d.path;
                });

                drones = flightKeys.map(key => {
                    const flight = data[key];
                    const callsign = (flight[13] || flight[16] || key).trim();
                    const lon = flight[2];
                    const lat = flight[1];
                    
                    // FR24 altitude is in feet — keep as feet for display
                    const altFeet = flight[4] || 0;
                    
                    // FR24 speed is in knots — keep knots for display, convert to m/s for physics
                    const speedKnots = flight[5] || 0;
                    const speedMs = speedKnots * 0.514444;
                    
                    const heading = Math.round(flight[3] || 0);
                    const acType = flight[8] || 'N/A';
                    const registration = flight[9] || 'N/A';
                    const origin = flight[11] || 'N/A';
                    const dest = flight[12] || 'N/A';
                    
                    // Ground detection: altitude < 200ft AND speed < 30kt
                    const isGrounded = altFeet < 200 && speedKnots < 30;

                    const path = prevPaths[callsign] || [];
                    // Grounded aircraft don't move — skip path to avoid drift
                    if (!isGrounded) {
                        path.push([lon, lat]);
                        if (path.length > 20) path.shift();
                    }

                    return {
                        id: callsign,
                        currentCoords: [lon, lat],
                        velocity: isGrounded ? 0 : speedMs, // freeze grounded aircraft
                        speedKnots: speedKnots,
                        heading: heading,
                        altitude: altFeet,   // stored in feet
                        acType: acType,
                        registration: registration,
                        origin: origin,
                        dest: dest,
                        path: path,
                        isMock: false,
                        isGrounded: isGrounded
                    };
                });
                
                // Re-bind selected drone if it's still present in the updated feed
                if (selectedDrone) {
                    const updatedSelected = drones.find(d => d.id === selectedDrone.id);
                    if (updatedSelected) {
                        selectedDrone = updatedSelected;
                    }
                }
                console.log(`Loaded ${drones.length} real flights over Korea from Flightradar24.`);
            }
        }
    } catch (err) {
        console.warn('Error fetching live flights (proxy/rate limits), keeping simulation:', err);
    }
}

// Fetch live flight coordinates every 20 seconds
setInterval(fetchRealFlights, 20000);
fetchRealFlights();

// Vessels collection (MarineTraffic AIS data)
let vessels = [];

async function fetchRealVessels() {
    try {
        const res = await fetch('/api/vessels');
        if (!res.ok) throw new Error('API Response Error');
        const data = await res.json();
        
        if (data && data.data && data.data.rows) {
            const prevPaths = {};
            vessels.forEach(v => {
                prevPaths[v.id] = v.path;
            });

            // Filter for high-importance vessels (Cargo, Tanker, Passenger, and real names)
            const filteredRows = data.data.rows.filter(r => {
                const name = (r.SHIPNAME || '').trim();
                if (!name || name === '[SAT-AIS]') return false;
                
                const type = (r.TYPE_NAME || '').toLowerCase();
                const shipType = r.SHIPTYPE || '';
                const length = parseInt(r.LENGTH || 0);
                const dwt = parseInt(r.DWT || 0);
                
                // SHIPTYPE codes: '7' = Cargo, '8' = Tanker, '6' = Passenger, '4' = Special/Military, '3' = Special Craft
                const isCargo = shipType === '7' || type.includes('cargo');
                const isTanker = shipType === '8' || type.includes('tanker');
                const isPassenger = shipType === '6' || type.includes('passenger');
                const isSpecial = shipType === '4' || shipType === '3' || type.includes('military') || type.includes('rescue') || type.includes('special');
                
                const isImportantType = isCargo || isTanker || isPassenger || isSpecial;
                
                // Keep if it is an important type and meets minimum size criteria (or is cargo/tanker which are inherently large)
                return isImportantType && (length >= 100 || dwt >= 10000 || isCargo || isTanker);
            });

            vessels = filteredRows.map(r => {
                const name = r.SHIPNAME.trim();
                const lat = parseFloat(r.LAT);
                const lon = parseFloat(r.LON);

                // Speed is stored in tenths of a knot in the API
                const speedKnots = parseFloat(r.SPEED || 0) / 10;
                const speedMs = speedKnots * 0.514444; // knots to m/s
                const heading = parseInt(r.HEADING || r.COURSE || 0);

                // Docking Detection Algorithm:
                // A vessel is considered docked/moored if:
                //   (a) Speed < 0.5 knots (stationary or near-stationary)
                //   (b) OR STATUS_NAME indicates 'Moored' or 'At Anchor'
                const statusName = (r.STATUS_NAME || '').toLowerCase();
                const isDocked = speedKnots < 0.5 ||
                    statusName === 'moored' ||
                    statusName === 'at anchor';
                
                let type = r.TYPE_NAME;
                if (!type) {
                    if (r.SHIPTYPE === '7') type = 'Cargo Vessel';
                    else if (r.SHIPTYPE === '8') type = 'Tanker';
                    else if (r.SHIPTYPE === '6') type = 'Passenger Vessel';
                    else if (r.SHIPTYPE === '3') type = 'Special Craft';
                    else if (r.SHIPTYPE === '4') type = 'High Speed Craft';
                    else type = 'Vessel';
                }
                const destination = r.DESTINATION || 'N/A';
                const flag = r.FLAG || 'N/A';
                const length = r.LENGTH || 'N/A';
                const width = r.WIDTH || 'N/A';
                const dwt = r.DWT || 'N/A';
                
                const path = prevPaths[name] || [];
                // Docked vessels don't move — skip path updates to avoid drift
                if (!isDocked) {
                    path.push([lon, lat]);
                    if (path.length > 20) path.shift();
                }

                return {
                    id: name,
                    currentCoords: [lon, lat],
                    velocity: isDocked ? 0 : speedMs, // Freeze docked vessels
                    heading: heading,
                    altitude: 0,
                    acType: type,
                    registration: `${flag} | L:${length}m W:${width}m`,
                    origin: 'AIS',
                    dest: destination,
                    dwt: dwt,
                    path: path,
                    isVessel: true,
                    isDocked: isDocked  // Docking status flag
                };
            });
            
            // Re-bind selected vessel if it's still present in the updated feed
            if (selectedDrone && selectedDrone.isVessel) {
                const updatedSelected = vessels.find(v => v.id === selectedDrone.id);
                if (updatedSelected) {
                    selectedDrone = updatedSelected;
                }
            }
            console.log(`Loaded ${vessels.length} high-importance vessels.`);
        }
    } catch (err) {
        console.warn('Error fetching live vessels:', err);
    }
}

// Fetch live vessels every 30 seconds
setInterval(fetchRealVessels, 30000);
fetchRealVessels();

let selectedDrone = null;

// Determine if a vessel should be visible at the current zoom level (Level of Detail - LOD)
function isVesselVisibleAtZoom(v, zoom) {
    if (selectedDrone && selectedDrone.id === v.id) {
        return true; // Keep selected vessel always visible
    }

    // RULE: Docked/moored vessels are only rendered at zoom >= 10
    // (user needs to be zoomed in close to a port to see them)
    if (v.isDocked) {
        return zoom >= 10.0;
    }

    const dwtVal = parseInt(v.dwt) || 0;

    // Stable deterministic hash [0, 99] based on vessel ID/name to prevent flickering
    let hash = 0;
    for (let i = 0; i < v.id.length; i++) {
        hash = (hash * 31 + v.id.charCodeAt(i)) % 100;
    }

    // Zoom-based Level of Detail thresholds (underway vessels only):
    // Larger ships (higher DWT) stay visible longer at lower zooms.
    if (zoom >= 9.0) {
        return true; // Show 100% of underway vessels when zoomed in
    } else if (zoom >= 8.0) {
        return hash < 70 || dwtVal >= 30000; // Show 70% + large vessels
    } else if (zoom >= 7.0) {
        return hash < 40 || dwtVal >= 50000; // Show 40% + very large vessels
    } else if (zoom >= 6.0) {
        return hash < 20 || dwtVal >= 80000; // Show 20% + ultra large vessels
    } else {
        return hash < 8 || dwtVal >= 120000; // Zoom < 6.0: Show only 8% or mega vessels
    }
}

// FPS Tracker
let lastFrameTime = performance.now();
let frameCount = 0;
let fps = 60;

function updateFPS(now) {
    frameCount++;
    if (now > lastFrameTime + 1000) {
        fps = Math.round((frameCount * 1000) / (now - lastFrameTime));
        fpsCounter.textContent = `FPS: ${fps}`;
        lastFrameTime = now;
        frameCount = 0;
    }
}

// Check mouse clicks on drones & vessels (handled via projected coordinates)
window.addEventListener('click', (e) => {
    let clickedObject = null;
    
    // Check drones/aircraft
    const clickZoom = map.getZoom();
    if (state.showAircraft) drones.forEach(d => {
        if (!isAircraftVisibleAtZoom(d, clickZoom)) return; // Skip LOD-hidden aircraft
        const screenPos = map.project(d.currentCoords);
        
        // Use the actual floating screen position (lifting by altitude if airborne)
        const altKm = (d.altitude || 0) * 0.0003048;
        const altPx = d.isGrounded ? 0 : altKm * altPxPerKm;
        const actualY = screenPos.y - altPx;
        
        const dist = Math.hypot(e.clientX - screenPos.x, e.clientY - actualY);
        if (dist < 15) {
            clickedObject = d;
        }
    });

    // Check vessels
    if (!clickedObject && state.showVessels) {
        const currentZoom = clickZoom;
        vessels.forEach(v => {
            if (!isVesselVisibleAtZoom(v, currentZoom)) return; // Skip hidden vessels
            
            const screenPos = map.project(v.currentCoords);
            const dist = Math.hypot(e.clientX - screenPos.x, e.clientY - screenPos.y);
            if (dist < 15) {
                clickedObject = v;
            }
        });
    }

    if (clickedObject) {
        selectedDrone = clickedObject;
    } else {
        // Only deselect if not clicking control panel
        if (!e.target.closest('.control-panel') && !e.target.closest('input')) {
            selectedDrone = null;
        }
    }
});

let lastTime = 0;

// Aircraft LOD: same logic as vessels but for airborne/ground state
function isAircraftVisibleAtZoom(d, zoom) {
    if (selectedDrone && selectedDrone.id === d.id) return true;

    // Grounded aircraft only visible when zoomed in to airport level
    if (d.isGrounded) return zoom >= 10.0;

    // Airborne aircraft LOD — always show all airborne targets
    // (they are far fewer in number than vessels, so no sub-sampling needed)
    return true;
}

// Main Render Loop
function render(time) {
    updateFPS(time);

    // Compute delta time in seconds
    const dt = lastTime ? (time - lastTime) / 1000 : 0;
    lastTime = time;

    // Auto Rotation simulation
    if (state.isAutoRot) {
        let currentBearing = map.getBearing();
        const speed = parseFloat(speedSlider.value);
        map.setBearing(currentBearing + speed * 0.05);
    }

    // Clear overlay canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Update Drones/Aircraft position
    drones.forEach(d => {
        const headingRad = d.heading * (Math.PI / 180);
        
        // Extrapolate position using physical speeds: velocity (m/s) converted to degrees.
        // 1 degree of latitude is approx 111,000 meters.
        // 1 degree of longitude at latitude L is approx 111,000 * cos(L).
        const latSpeed = (d.velocity / 111000) * dt;
        const lonSpeed = (d.velocity / (111000 * Math.cos(d.currentCoords[1] * Math.PI / 180))) * dt;

        d.currentCoords[0] += Math.sin(headingRad) * lonSpeed;
        d.currentCoords[1] += Math.cos(headingRad) * latSpeed;

        // Reset mock flights if they leave bounds
        if (d.isMock) {
            if (d.currentCoords[0] < 124.0 || d.currentCoords[0] > 131.0 || d.currentCoords[1] < 33.0 || d.currentCoords[1] > 39.0) {
                const mock = mockFlights[Math.floor(Math.random() * mockFlights.length)];
                d.currentCoords = [...mock.currentCoords];
                d.heading = mock.heading;
                d.path = [];
            }
        }
        
        // Save path trails only for airborne aircraft
        if (!d.isGrounded) {
            d.path.push([...d.currentCoords]);
            if (d.path.length > 20) d.path.shift();
        }
    });

    // Update Vessels position
    vessels.forEach(v => {
        const headingRad = v.heading * (Math.PI / 180);
        const latSpeed = (v.velocity / 111000) * dt;
        const lonSpeed = (v.velocity / (111000 * Math.cos(v.currentCoords[1] * Math.PI / 180))) * dt;

        v.currentCoords[0] += Math.sin(headingRad) * lonSpeed;
        v.currentCoords[1] += Math.cos(headingRad) * latSpeed;

        v.path.push([...v.currentCoords]);
        if (v.path.length > 20) v.path.shift();
    });

    // Update scanline sweep progress
    if (state.isScanline) {
        state.scanProgress = (time * 0.0006) % 1.0;
    }

    // (Lat/Lon grid lines over South Korea removed per design request)

    // Recompute altitude pixel scale based on zoom level to prevent perspective jumping during pans
    {
        const currentZoom = map.getZoom();
        // Web Mercator scale at Korea's average latitude (36°N) with 3.0x vertical exaggeration
        altPxPerKm = (3.0 * Math.pow(2, currentZoom)) / 126.59;
    }

    // 2. Draw Global Data Center Network (background layer)
    if (state.showDataCenters) drawDataCenters(time);

    // 3. Draw Aircraft Mesh Network (organic lines between nearby aircraft)
    if (state.showAircraft) drawAircraftMesh(time);

    // (3D atmosphere altitude-layer horizontal lines removed per design request)

    // 4. Draw Satellite Ground Tracks
    drawSatellites(time);

    // 5. Draw Military Bases
    drawBases();

    // 4. Draw Drones and Paths
    if (state.showAircraft) drawDrones(time);
    if (state.showVessels) drawVessels(time);

    // 5. Draw Selected Target details
    const targetPanel = document.getElementById('target-details-panel');
    if (selectedDrone) {
        drawTargetDetails(selectedDrone);
        if (targetPanel) {
            targetPanel.style.display = 'flex';
            document.getElementById('target-callsign').textContent = selectedDrone.id;
            document.getElementById('target-type').textContent = selectedDrone.acType || 'N/A';
            document.getElementById('target-reg').textContent = selectedDrone.registration || 'N/A';
            document.getElementById('target-route').textContent = selectedDrone.isVessel 
                ? (selectedDrone.dest || 'N/A')
                : `${selectedDrone.origin || 'N/A'} > ${selectedDrone.dest || 'N/A'}`;
            // Speed: vessels use knots (nautical), aircraft use knots
            if (selectedDrone.isVessel) {
                const knots = (selectedDrone.velocity / 0.514444);
                document.getElementById('target-speed').textContent = `${knots.toFixed(1)} kt`;
            } else {
                const knots = selectedDrone.speedKnots !== undefined
                    ? selectedDrone.speedKnots
                    : (selectedDrone.velocity / 0.514444);
                document.getElementById('target-speed').textContent = `${Math.round(knots)} kt  (${Math.round(knots * 1.15078)} mph)`;
            }
            document.getElementById('target-lat').textContent = `${selectedDrone.currentCoords[1].toFixed(4)}°N`;
            document.getElementById('target-lon').textContent = `${selectedDrone.currentCoords[0].toFixed(4)}°E`;

            // Dynamic Sidebar Labels customization for Vessels vs Aircraft
            const typeLabel = document.querySelector('#target-type').previousElementSibling;
            const regLabel = document.querySelector('#target-reg').previousElementSibling;
            const routeLabel = document.querySelector('#target-route').previousElementSibling;
            const altLabel = document.querySelector('#target-alt').previousElementSibling;

            if (selectedDrone.isVessel) {
                if (typeLabel) typeLabel.textContent = 'TYPE';
                if (regLabel) regLabel.textContent = 'FLAG / DIM';
                if (routeLabel) routeLabel.textContent = 'DESTINATION';
                if (altLabel) altLabel.textContent = 'DWT';
                document.getElementById('target-alt').textContent = selectedDrone.dwt ? `${parseInt(selectedDrone.dwt).toLocaleString()} tons` : 'N/A';
            } else {
                if (typeLabel) typeLabel.textContent = 'AIRCRAFT';
                if (regLabel) regLabel.textContent = 'REGISTRATION';
                if (routeLabel) routeLabel.textContent = 'ROUTE';
                if (altLabel) altLabel.textContent = 'ALTITUDE';
                document.getElementById('target-alt').textContent = selectedDrone.isGrounded
                    ? `ON GROUND`
                    : `${selectedDrone.altitude.toLocaleString()} ft  (${Math.round(selectedDrone.altitude * 0.3048)} m)`;
            }
        }
    } else {
        if (targetPanel) {
            targetPanel.style.display = 'none';
        }
    }

    // 6. Draw scan sweep overlay
    if (state.isScanline) {
        drawScanSweep();
    }

    requestAnimationFrame(render);
}

// Draw Latitude and Longitude Grid Lines projected in 3D
function drawLatLonGrid() {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.font = '9px "Share Tech Mono", monospace';

    const latMin = 33.0;
    const latMax = 39.0;
    const lonMin = 124.0;
    const lonMax = 131.0;
    const interval = state.gridInterval;

    let totalGridLines = 0;

    // Draw Longitude Lines (Vertical grid lines)
    for (let lon = lonMin; lon <= lonMax; lon += interval) {
        ctx.beginPath();
        let first = true;
        for (let lat = latMin; lat <= latMax; lat += 0.1) {
            const screenPos = map.project([lon, lat]);
            if (first) {
                ctx.moveTo(screenPos.x, screenPos.y);
                first = false;
            } else {
                ctx.lineTo(screenPos.x, screenPos.y);
            }
        }
        ctx.stroke();
        totalGridLines++;

        // Add Label at top boundary
        const labelPos = map.project([lon, latMax]);
        if (labelPos.y > 0 && labelPos.y < canvas.height && labelPos.x > 0 && labelPos.x < canvas.width) {
            ctx.fillText(`${lon.toFixed(1)}°E`, labelPos.x + 3, labelPos.y - 5);
        }
    }

    // Draw Latitude Lines (Horizontal grid lines)
    for (let lat = latMin; lat <= latMax; lat += interval) {
        ctx.beginPath();
        let first = true;
        for (let lon = lonMin; lon <= lonMax; lon += 0.1) {
            const screenPos = map.project([lon, lat]);
            if (first) {
                ctx.moveTo(screenPos.x, screenPos.y);
                first = false;
            } else {
                ctx.lineTo(screenPos.x, screenPos.y);
            }
        }
        ctx.stroke();
        totalGridLines++;

        // Add Label at left boundary
        const labelPos = map.project([lonMin, lat]);
        if (labelPos.y > 0 && labelPos.y < canvas.height && labelPos.x > 0 && labelPos.x < canvas.width) {
            ctx.fillText(`${lat.toFixed(1)}°N`, labelPos.x - 35, labelPos.y + 3);
        }
    }

    vertexCounter.textContent = `LINES: ${totalGridLines}`;
}

// Draw organic mesh network connecting each airborne aircraft to its 3 nearest neighbors
function drawAircraftMesh(time) {
    const K = 3; // Max connections per aircraft

    // Collect only airborne aircraft
    const airborne = drones.filter(d => !d.isGrounded);
    if (airborne.length < 2) return;

    // Subtle time-based global pulse [0.65 .. 1.0]
    const pulse = 0.65 + 0.35 * Math.abs(Math.sin(time * 0.0004));

    // Step 1: For each aircraft, find its K nearest neighbors
    // Store unique pairs as "indexA-indexB" (always A < B) to avoid drawing the same line twice
    const pairsToDraw = new Set();

    for (let i = 0; i < airborne.length; i++) {
        const a = airborne[i];

        // Compute distances to all other aircraft
        const neighbors = [];
        for (let j = 0; j < airborne.length; j++) {
            if (i === j) continue;
            const b = airborne[j];
            const dLon = a.currentCoords[0] - b.currentCoords[0];
            const dLat = a.currentCoords[1] - b.currentCoords[1];
            const dist = Math.sqrt(dLon * dLon + dLat * dLat);
            neighbors.push({ index: j, dist });
        }

        // Sort by distance ascending, take closest K
        neighbors.sort((x, y) => x.dist - y.dist);
        const closest = neighbors.slice(0, K);

        // Register unique pairs (smaller index first)
        for (const nb of closest) {
            const key = i < nb.index ? `${i}-${nb.index}` : `${nb.index}-${i}`;
            pairsToDraw.add(key + `|${nb.dist}`);
        }
    }

    // Lifted screen position: same 3D altitude offset used when drawing the
    // aircraft icons, so the mesh links the floating aircraft rather than their
    // ground shadows.
    const liftedPos = (d) => {
        const sp = map.project(d.currentCoords);
        const altPx = (d.altitude || 0) * 0.0003048 * altPxPerKm; // feet → km → px
        return { x: sp.x, y: sp.y - altPx };
    };

    // Step 2: Draw all unique collected pairs
    ctx.save();
    ctx.lineWidth = 1.2;

    for (const entry of pairsToDraw) {
        const [pairKey, distStr] = entry.split('|');
        const [ai, bi] = pairKey.split('-').map(Number);
        const a = airborne[ai];
        const b = airborne[bi];
        const dist = parseFloat(distStr);

        const posA = liftedPos(a);
        const posB = liftedPos(b);

        // Off-screen cull
        const offA = posA.x < -80 || posA.x > canvas.width + 80 || posA.y < -80 || posA.y > canvas.height + 80;
        const offB = posB.x < -80 || posB.x > canvas.width + 80 || posB.y < -80 || posB.y > canvas.height + 80;
        if (offA && offB) continue;

        // Opacity: closer = brighter, falls off with distance²
        const normDist = Math.min(dist / 4.0, 1.0);
        const proximityFactor = 1 - normDist * normDist;

        // Altitude similarity boost
        const altDiff = Math.abs((a.altitude || 0) - (b.altitude || 0));
        const altFactor = altDiff < 3000 ? 1.0 : altDiff < 8000 ? 0.75 : 0.5;

        const alpha = proximityFactor * altFactor * pulse * 0.75;

        ctx.strokeStyle = `rgba(255, 255, 255, ${Math.max(0.12, alpha).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(posA.x, posA.y);
        ctx.lineTo(posB.x, posB.y);
        ctx.stroke();
    }

    ctx.restore();
}


// Draw tactical base locations
// Draw 3D altitude atmosphere zones (0–100 km) above the map plane
function drawAltitudeLayers() {
    // Zone definitions: altitude in km, label, opacity
    const zones = [
        { alt: 100, label: '100 KM ─ KÁRMÁN LINE', opacity: 0.60 },
        { alt:  80, label: ' 80 KM ─ MESOSPHERE',  opacity: 0.42 },
        { alt:  50, label: ' 50 KM ─ STRATOSPHERE',opacity: 0.36 },
        { alt:  12, label: ' 12 KM ─ TROPOSPHERE', opacity: 0.28 },
    ];

    // We draw lines along a fixed reference latitude, spanning Korea's longitude range
    const LAT   = 36.0;
    const LON_W = 122.0;
    const LON_E = 133.0;
    const LON_STEP = 0.5;

    ctx.save();

    // --- Filled gradient bands between zone levels ---
    const groundY_W = map.project([LON_W, LAT]).y;
    const groundY_E = map.project([LON_E, LAT]).y;

    // Fill from 100km ceiling down to ground with very faint gradient
    const top100_W = map.project([LON_W, LAT]);
    const top100_E = map.project([LON_E, LAT]);
    const topY_W = top100_W.y - zones[0].alt * altPxPerKm;
    const topY_E = top100_E.y - zones[0].alt * altPxPerKm;

    // Draw each zone boundary line (horizontal plane at that altitude)
    zones.forEach(zone => {
        const altPx = zone.alt * altPxPerKm;

        ctx.strokeStyle = `rgba(255,255,255,${(zone.opacity * 0.35).toFixed(2)})`;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        let first = true;
        for (let lon = LON_W; lon <= LON_E + 0.01; lon += LON_STEP) {
            const sp = map.project([lon, LAT]);
            if (first) { ctx.moveTo(sp.x, sp.y - altPx); first = false; }
            else        { ctx.lineTo(sp.x, sp.y - altPx); }
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Right-side label
        const spLabel = map.project([LON_E, LAT]);
        ctx.font = '8px "Share Tech Mono", monospace';
        ctx.fillStyle = `rgba(255,255,255,${zone.opacity.toFixed(2)})`;
        ctx.fillText(zone.label, spLabel.x + 8, spLabel.y - altPx + 4);
    });

    // --- Vertical wall lines at west and east edges of Korea ---
    const maxAltPx = zones[0].alt * altPxPerKm;
    [LON_W, LON_E].forEach(lon => {
        const sp = map.project([lon, LAT]);
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 0.6;
        ctx.setLineDash([2, 7]);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y);
        ctx.lineTo(sp.x, sp.y - maxAltPx);
        ctx.stroke();
        ctx.setLineDash([]);
    });

    // --- Ground line (base of the 3D space) ---
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    let gFirst = true;
    for (let lon = LON_W; lon <= LON_E + 0.01; lon += LON_STEP) {
        const sp = map.project([lon, LAT]);
        if (gFirst) { ctx.moveTo(sp.x, sp.y); gFirst = false; }
        else         { ctx.lineTo(sp.x, sp.y); }
    }
    ctx.stroke();

    // --- Top ceiling line ---
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    let tFirst = true;
    for (let lon = LON_W; lon <= LON_E + 0.01; lon += LON_STEP) {
        const sp = map.project([lon, LAT]);
        if (tFirst) { ctx.moveTo(sp.x, sp.y - maxAltPx); tFirst = false; }
        else         { ctx.lineTo(sp.x, sp.y - maxAltPx); }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.restore();
}


// Draw tactical base locations
function drawBases() {
    ctx.font = '9px "Orbitron", sans-serif';
    ctx.fillStyle = '#ffffff';

    militaryBases.forEach(base => {
        const screenPos = map.project(base.coords);
        if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;

        // Draw crosshair symbol
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(screenPos.x, screenPos.y, 4, 0, Math.PI * 2);
        ctx.moveTo(screenPos.x - 7, screenPos.y);
        ctx.lineTo(screenPos.x + 7, screenPos.y);
        ctx.moveTo(screenPos.x, screenPos.y - 7);
        ctx.lineTo(screenPos.x, screenPos.y + 7);
        ctx.stroke();

        // Label
        ctx.fillText(base.name, screenPos.x + 10, screenPos.y + 3);
    });
}

// Draw Drones, flight trails, and targets
function drawDrones(time) {
    const currentZoom = map.getZoom();
    drones.forEach(d => {
        if (!isAircraftVisibleAtZoom(d, currentZoom)) return; // LOD: hide grounded aircraft when zoomed out

        const screenPos = map.project(d.currentCoords);
        if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;

        const isSelected = selectedDrone && selectedDrone.id === d.id;

        if (d.isGrounded) {
            // --- Grounded Aircraft Style: dim X mark ---
            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(170, 170, 170, 0.4)';
            ctx.lineWidth = isSelected ? 1.5 : 0.8;
            const gs = 4;
            ctx.beginPath();
            ctx.moveTo(screenPos.x - gs, screenPos.y - gs);
            ctx.lineTo(screenPos.x + gs, screenPos.y + gs);
            ctx.moveTo(screenPos.x + gs, screenPos.y - gs);
            ctx.lineTo(screenPos.x - gs, screenPos.y + gs);
            ctx.stroke();

            ctx.font = '7px "Share Tech Mono", monospace';
            ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(160, 160, 160, 0.5)';
            ctx.fillText(`[G] ${d.id}`, screenPos.x + 8, screenPos.y + 3);
        } else {
            // --- Airborne Aircraft Style: dot + square box at 3D altitude position ---
            const altKm  = (d.altitude || 0) * 0.0003048; // feet → km
            const altPx  = altKm * altPxPerKm;
            // Lifted screen position (straight up from map ground position)
            const liftX  = screenPos.x;
            const liftY  = screenPos.y - altPx;

            // Altitude drop line: ground → aircraft
            if (altPx > 3) {
                ctx.save();
                ctx.strokeStyle = 'rgba(255,255,255,0.14)';
                ctx.lineWidth = 0.6;
                ctx.setLineDash([2, 5]);
                ctx.beginPath();
                ctx.moveTo(screenPos.x, screenPos.y);
                ctx.lineTo(liftX, liftY);
                ctx.stroke();
                ctx.setLineDash([]);
                // Ground shadow dot
                ctx.fillStyle = 'rgba(255,255,255,0.20)';
                ctx.beginPath();
                ctx.arc(screenPos.x, screenPos.y, 1.5, 0, Math.PI * 2);
                ctx.fill();
                ctx.restore();
            }

            // Draw path trail at ground level (projecting every 2nd point for optimization)
            if (d.path.length > 1) {
                ctx.beginPath();
                ctx.lineWidth = 0.7;
                ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
                const startPos = map.project(d.path[0]);
                ctx.moveTo(startPos.x, startPos.y);
                const step = 2;
                for (let i = 1; i < d.path.length; i += step) {
                    const pos = map.project(d.path[i]);
                    ctx.lineTo(pos.x, pos.y);
                }
                const lastIdx = d.path.length - 1;
                if (lastIdx % step !== 0) {
                    const pos = map.project(d.path[lastIdx]);
                    ctx.lineTo(pos.x, pos.y);
                }
                ctx.stroke();
            }

            // Aircraft icon at 3D altitude position
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(liftX, liftY, 3, 0, Math.PI * 2);
            ctx.fill();

            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
            ctx.lineWidth = isSelected ? 1.5 : 1;
            ctx.strokeRect(liftX - 8, liftY - 8, 16, 16);

            ctx.font = '9px "Share Tech Mono", monospace';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.fillText(d.id, liftX + 12, liftY - 3);
        }
    });
}

// Draw Vessels, trails, and shapes
function drawVessels(time) {
    const currentZoom = map.getZoom();
    vessels.forEach(v => {
        if (!isVesselVisibleAtZoom(v, currentZoom)) return; // Level of detail zoom-filtering

        const screenPos = map.project(v.currentCoords);
        if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;

        // Draw path trail (projecting every 2nd point for optimization)
        if (v.path.length > 1) {
            ctx.beginPath();
            ctx.lineWidth = 1;
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            const startPos = map.project(v.path[0]);
            ctx.moveTo(startPos.x, startPos.y);
            const step = 2;
            for (let i = 1; i < v.path.length; i += step) {
                const pos = map.project(v.path[i]);
                ctx.lineTo(pos.x, pos.y);
            }
            const lastIdx = v.path.length - 1;
            if (lastIdx % step !== 0) {
                const pos = map.project(v.path[lastIdx]);
                ctx.lineTo(pos.x, pos.y);
            }
            ctx.stroke();
        }

        const isSelected = selectedDrone && selectedDrone.id === v.id;

        if (v.isDocked) {
            // --- Docked / Moored Vessel Style ---
            // Smaller, dimmer, square icon to distinguish from underway diamond
            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(180, 180, 180, 0.4)';
            ctx.lineWidth = isSelected ? 1.5 : 0.8;
            const ds = 4;
            ctx.strokeRect(screenPos.x - ds, screenPos.y - ds, ds * 2, ds * 2);

            // Small dot
            ctx.fillStyle = isSelected ? '#ffffff' : 'rgba(180, 180, 180, 0.5)';
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 1.5, 0, Math.PI * 2);
            ctx.fill();

            // Label (dimmer, smaller)
            ctx.font = '7px "Share Tech Mono", monospace';
            ctx.fillStyle = isSelected ? 'rgba(255,255,255,0.9)' : 'rgba(160, 160, 160, 0.6)';
            ctx.fillText(`[P] ${v.id}`, screenPos.x + 8, screenPos.y + 3);
        } else {
            // --- Underway Vessel Style: Diamond shape ---
            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = isSelected ? 1.5 : 1;

            ctx.beginPath();
            const size = 6;
            ctx.moveTo(screenPos.x, screenPos.y - size);
            ctx.lineTo(screenPos.x + size, screenPos.y);
            ctx.lineTo(screenPos.x, screenPos.y + size);
            ctx.lineTo(screenPos.x - size, screenPos.y);
            ctx.closePath();
            ctx.stroke();

            // Solid center point
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 2, 0, Math.PI * 2);
            ctx.fill();

            // Label
            ctx.font = '8px "Share Tech Mono", monospace';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
            ctx.fillText(v.id, screenPos.x + 10, screenPos.y + 3);
        }
    });
}

// Draw detailed HUD locks around selected targets
function drawTargetDetails(d) {
    const screenPos = map.project(d.currentCoords);
    if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;

    // Draw Lock bracket rings
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    
    // Corners
    const size = 20;
    ctx.beginPath();
    // Top-Left
    ctx.moveTo(screenPos.x - size, screenPos.y - size + 6);
    ctx.lineTo(screenPos.x - size, screenPos.y - size);
    ctx.lineTo(screenPos.x - size + 6, screenPos.y - size);
    // Top-Right
    ctx.moveTo(screenPos.x + size, screenPos.y - size + 6);
    ctx.lineTo(screenPos.x + size, screenPos.y - size);
    ctx.lineTo(screenPos.x + size - 6, screenPos.y - size);
    // Bottom-Left
    ctx.moveTo(screenPos.x - size, screenPos.y + size - 6);
    ctx.lineTo(screenPos.x - size, screenPos.y + size);
    ctx.lineTo(screenPos.x - size + 6, screenPos.y + size);
    // Bottom-Right
    ctx.moveTo(screenPos.x + size, screenPos.y + size - 6);
    ctx.lineTo(screenPos.x + size, screenPos.y + size);
    ctx.lineTo(screenPos.x + size - 6, screenPos.y + size);
    ctx.stroke();

    // Line connect to telemetry
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(screenPos.x + size, screenPos.y);
    ctx.lineTo(screenPos.x + size + 35, screenPos.y - 35);
    ctx.lineTo(screenPos.x + size + 130, screenPos.y - 35);
    ctx.stroke();

    // Mini details
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillStyle = '#ffffff';
    
    if (d.isVessel) {
        ctx.fillText(`LOCK: ACTIVE [NAVAL]`, screenPos.x + size + 40, screenPos.y - 40);
        ctx.fillText(`VESSEL: ${d.id}`, screenPos.x + size + 40, screenPos.y - 30);
        ctx.fillText(`TYPE: ${d.acType || 'N/A'}`, screenPos.x + size + 40, screenPos.y - 20);
        ctx.fillText(`DIM: ${d.registration || 'N/A'}`, screenPos.x + size + 40, screenPos.y - 10);
        ctx.fillText(`DWT: ${d.dwt ? parseInt(d.dwt).toLocaleString() + ' tons' : 'N/A'}`, screenPos.x + size + 40, screenPos.y);
        const vesselKt = (d.velocity / 0.514444).toFixed(1);
        ctx.fillText(`SPEED: ${vesselKt} kt`, screenPos.x + size + 40, screenPos.y + 10);
        ctx.fillText(`LAT: ${d.currentCoords[1].toFixed(4)}°N`, screenPos.x + size + 40, screenPos.y + 20);
        ctx.fillText(`LON: ${d.currentCoords[0].toFixed(4)}°E`, screenPos.x + size + 40, screenPos.y + 30);
    } else {
        ctx.fillText(`LOCK: ACTIVE [AIR]`, screenPos.x + size + 40, screenPos.y - 40);
        ctx.fillText(`FLIGHT: ${d.id}`, screenPos.x + size + 40, screenPos.y - 30);
        ctx.fillText(`TYPE: ${d.acType || 'N/A'} [${d.registration || 'N/A'}]`, screenPos.x + size + 40, screenPos.y - 20);
        ctx.fillText(`ROUTE: ${d.origin || 'N/A'} > ${d.dest || 'N/A'}`, screenPos.x + size + 40, screenPos.y - 10);
        ctx.fillText(`ALTITUDE: ${d.isGrounded ? 'ON GROUND' : d.altitude.toLocaleString() + ' ft'}`, screenPos.x + size + 40, screenPos.y);
        const displayKt = d.speedKnots !== undefined ? Math.round(d.speedKnots) : Math.round(d.velocity / 0.514444);
        ctx.fillText(`SPEED: ${displayKt} kt / ${Math.round(displayKt * 1.15078)} mph`, screenPos.x + size + 40, screenPos.y + 10);
        ctx.fillText(`LAT: ${d.currentCoords[1].toFixed(4)}°N`, screenPos.x + size + 40, screenPos.y + 20);
        ctx.fillText(`LON: ${d.currentCoords[0].toFixed(4)}°E`, screenPos.x + size + 40, screenPos.y + 30);
    }
}

// Draw linear scan sweep effect
function drawScanSweep() {
    const sweepY = canvas.height * state.scanProgress;
    
    // Draw scanline gradient
    const grad = ctx.createLinearGradient(0, sweepY - 100, 0, sweepY + 5);
    grad.addColorStop(0, 'rgba(255, 255, 255, 0)');
    grad.addColorStop(0.95, 'rgba(255, 255, 255, 0.05)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0.4)'); // Scan wave front

    ctx.fillStyle = grad;
    ctx.fillRect(0, sweepY - 100, canvas.width, 105);

    // Glowing core scan line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, sweepY);
    ctx.lineTo(canvas.width, sweepY);
    ctx.stroke();
}

// Hide the basemap's text/symbol (label) layers — city/road/place names.
// Symbol layout (label collision detection) is MapLibre's most expensive
// per-frame work during camera movement, so removing it reduces frame drops.
function hideBasemapLabels() {
    try {
        const layers = map.getStyle().layers || [];
        layers.forEach(l => {
            if (l.type === 'symbol') {
                map.setLayoutProperty(l.id, 'visibility', 'none');
            }
        });
        console.log('[Perf] Basemap label/symbol layers hidden.');
    } catch (e) {
        console.warn('[Perf] Could not hide label layers:', e.message);
    }
}

// Start Render Loop
map.on('load', () => {
    hideBasemapLabels();
    requestAnimationFrame(render);
});
