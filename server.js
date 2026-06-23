const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 8080;
const FR24_URL = 'https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=39,33,124,131&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=1&estimated=1&maxage=14400&gliders=1&stats=1';

// Satellites frequently visible over Korea (NORAD catalog IDs)
// ISS, NOAA-19, Aqua, Terra, Landsat-8, Landsat-9, Sentinel-1A, Sentinel-2A, KOMPSAT-3, KOMPSAT-5
const TRACKED_SAT_IDS = '25544,33591,27424,25994,39084,49260,39634,40697,39237,40786';
// CelesTrak GP data API — gp.php accepts only a single CATNR per request,
// so we query each tracked satellite individually and combine the results.
// (The old SATCAT/TLE.PHP endpoint was deprecated in 2020 and removed in 2022.)
const CELESTRAK_GP_BASE = 'https://celestrak.org/NORAD/elements/gp.php';
let satCache = null;        // Cached raw JSON string
let satCacheTime = 0;       // Timestamp of last cache fill
const SAT_CACHE_TTL = 3600000; // 1 hour

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

let vesselData = null; // In-memory store for AIS vessel positions

// Try loading persisted vessels if available
try {
    const filePath = path.join(__dirname, 'vessels.json');
    if (fs.existsSync(filePath)) {
        vesselData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        console.log(`[Server] Loaded ${vesselData?.data?.rows?.length || 0} cached vessels.`);
    }
} catch (e) {
    console.warn('[Server Warning] Failed to load cached vessels:', e.message);
}

const server = http.createServer((req, res) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        res.end();
        return;
    }

    // Handle Geocoding API proxy (via Nominatim)
    if (req.url.startsWith('/api/geocode')) {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const query = parsedUrl.searchParams.get('q');
        
        if (!query) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing query parameter' }));
            return;
        }
        
        const targetUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
        console.log(`[Proxy] Fetching geocode for: "${query}"`);
        
        const geoRequest = https.get(targetUrl, {
            headers: {
                'User-Agent': 'TacticalHUDApp/1.0 (dbdnj@daum.net)',
                'Accept': 'application/json'
            }
        }, (geoResponse) => {
            res.writeHead(geoResponse.statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            geoResponse.pipe(res);
        });
        
        geoRequest.on('error', (err) => {
            console.error('[Proxy Error] Geocode fetch failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Failed to geocode address', details: err.message }));
        });
        return;
    }

    // Handle Real Delivery Tracking API proxy
    if (req.url.startsWith('/api/track')) {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const carrier = parsedUrl.searchParams.get('carrier');
        const invoice = parsedUrl.searchParams.get('invoice');
        
        if (!carrier || !invoice) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing carrier or invoice parameter' }));
            return;
        }
        
        const targetUrl = `https://apis.tracker.delivery/carriers/${carrier}/tracks/${invoice}`;
        console.log(`[Proxy] Fetching package tracking from: ${targetUrl}`);
        
        const trackRequest = https.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            }
        }, (trackResponse) => {
            res.writeHead(trackResponse.statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            trackResponse.pipe(res);
        });
        
        trackRequest.on('error', (err) => {
            console.error('[Proxy Error] Tracking fetch failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Failed to fetch tracking data', details: err.message }));
        });
        return;
    }

    // Handle Aircraft Photo API proxy (to Planespotters.net)
    if (req.url.startsWith('/api/aircraft-photo')) {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const reg = parsedUrl.searchParams.get('reg');
        
        if (!reg) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Missing reg parameter' }));
            return;
        }
        
        const targetUrl = `https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(reg)}`;
        console.log(`[Proxy] Fetching aircraft photo for registration: "${reg}"`);
        
        const photoRequest = https.get(targetUrl, {
            headers: {
                'User-Agent': 'MyFlightTracker/1.2 (+https://example.com/contact)',
                'Accept': 'application/json'
            }
        }, (photoResponse) => {
            res.writeHead(photoResponse.statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            photoResponse.pipe(res);
        });
        
        photoRequest.on('error', (err) => {
            console.error('[Proxy Error] Aircraft photo fetch failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ error: 'Failed to fetch aircraft photo', details: err.message }));
        });
        return;
    }

    // Handle Flightradar24 API proxy
    if (req.url === '/api/flights') {
        console.log(`[Proxy] Fetching live flight data from Flightradar24...`);
        
        const frRequest = https.get(FR24_URL, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json',
                'Referer': 'https://www.flightradar24.com/'
            }
        }, (frResponse) => {
            res.writeHead(frResponse.statusCode, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*'
            });
            frResponse.pipe(res);
        });

        frRequest.on('error', (err) => {
            console.error('[Proxy Error]', err);
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ error: 'Failed to fetch flight data', details: err.message }));
        });
        return;
    }

    // Handle Satellite TLE API (proxy to CelesTrak)
    if (req.url === '/api/satellites') {
        const now = Date.now();
        if (satCache && (now - satCacheTime) < SAT_CACHE_TTL) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
            res.end(satCache);
            return;
        }

        function parseTLE(body) {
            const lines = body.trim().split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
            const sats = [];
            for (let i = 0; i + 2 < lines.length; i += 3) {
                if (lines[i + 1].startsWith('1 ') && lines[i + 2].startsWith('2 ')) {
                    sats.push({ name: lines[i], tle1: lines[i + 1], tle2: lines[i + 2] });
                }
            }
            return sats;
        }

        function fetchURL(url) {
            return new Promise((resolve, reject) => {
                const proto = url.startsWith('https') ? https : require('http');
                const req2 = proto.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Tactical HUD)' } }, (r) => {
                    // Follow one redirect
                    if ((r.statusCode === 301 || r.statusCode === 302) && r.headers.location) {
                        return resolve(fetchURL(r.headers.location));
                    }
                    let body = '';
                    r.on('data', c => { body += c; });
                    r.on('end', () => resolve(body));
                });
                req2.on('error', reject);
            });
        }

        const ids = TRACKED_SAT_IDS.split(',');
        console.log(`[Satellites] Fetching ${ids.length} TLEs from CelesTrak (gp.php per-CATNR)...`);
        Promise.all(ids.map(id =>
            fetchURL(`${CELESTRAK_GP_BASE}?CATNR=${id}&FORMAT=TLE`)
                .then(body => parseTLE(body))
                .catch(err => { console.warn(`[Satellites] CATNR ${id} failed:`, err.message); return []; })
        )).then(results => {
            const sats = results.flat();
            if (sats.length > 0) {
                satCache = JSON.stringify(sats);
                satCacheTime = now;
                console.log(`[Satellites] Cached ${sats.length} TLEs.`);
            } else {
                console.warn('[Satellites] All CATNR queries returned 0 TLEs.');
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(sats));
        }).catch(err => {
            console.error('[Satellites] Fetch error:', err.message);
            if (satCache) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }); res.end(satCache); }
            else { res.writeHead(500); res.end(JSON.stringify([])); }
        });
        return;
    }


    // Handle Vessels API Endpoint
    if (req.url === '/api/vessels') {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                try {
                    vesselData = JSON.parse(body);
                    console.log(`[Vessels] Received ${vesselData?.data?.rows?.length || 0} vessels from scraper.`);
                    
                    // Persist to file
                    fs.writeFile(path.join(__dirname, 'vessels.json'), body, 'utf8', (err) => {
                        if (err) console.error('[Vessels Error] Failed to write vessels.json:', err.message);
                    });

                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Access-Control-Allow-Origin': '*'
                    });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    console.error('[Vessels Error] Failed to parse POST body:', e.message);
                    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
                }
            });
            return;
        } else {
            // GET request
            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-store'
            });
            res.end(JSON.stringify(vesselData || {}));
            return;
        }
    }

    // Serve static files
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
    
    // Normalize path to prevent directory traversal
    filePath = path.normalize(filePath);
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('403 Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 
            'Content-Type': contentType,
            'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0'
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`Tactical HUD Server is running at http://localhost:${PORT}`);
});
