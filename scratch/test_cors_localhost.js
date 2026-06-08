const https = require('https');

const url = 'https://corsproxy.io/?url=' + encodeURIComponent('https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=39,33,124,131&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=1&estimated=1&maxage=14400&gliders=1&stats=1');

console.log("Fetching via CORS proxy with Localhost Origin:", url);
https.get(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Origin': 'http://localhost:8080',
        'Referer': 'http://localhost:8080/'
    }
}, (res) => {
    console.log("Status:", res.statusCode);
    let data = '';
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const flightKeys = Object.keys(parsed).filter(k => k !== 'version' && k !== 'full_count' && k !== 'stats');
            console.log("SUCCESS. Number of flights:", flightKeys.length);
            if (flightKeys.length > 0) {
                console.log("First flight details:", parsed[flightKeys[0]]);
            }
        } catch (e) {
            console.log("Error parsing JSON. Preview:", data.slice(0, 500));
        }
    });
}).on('error', (err) => {
    console.error("Error:", err);
});
