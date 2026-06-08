const https = require('https');

function fetchUrl(url) {
    console.log("Fetching:", url);
    https.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'application/json',
            'Referer': 'https://www.flightradar24.com/'
        }
    }, (res) => {
        console.log("Status:", res.statusCode);
        console.log("Headers:", res.headers);
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchUrl(res.headers.location);
            } else {
                console.log("Data preview:", data.slice(0, 500));
            }
        });
    }).on('error', (err) => {
        console.error("Error:", err);
    });
}

fetchUrl('https://data-cloud.flightradar24.com/zones/fcgi/feed.js?bounds=39,33,124,131&faa=1&satellite=1&mlat=1&flarm=1&adsb=1&gnd=1&air=1&vehicles=1&estimated=1&maxage=14400&gliders=1&stats=1');
