const https = require('https');

const url = 'https://www.marinetraffic.com/getData/get_data_json_4/z:8/X:109/Y:50/station:0';

console.log("Fetching MarineTraffic tiles:", url);

https.get(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.marinetraffic.com/en/ais/home/centerx:127.4/centery:35.8/zoom:8',
        'Accept': '*/*',
        'X-Requested-With': 'XMLHttpRequest'
    }
}, (res) => {
    console.log("Status:", res.statusCode);
    console.log("Headers:", res.headers);
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        console.log("Data length:", data.length);
        console.log("Data preview:", data.slice(0, 500));
        try {
            const parsed = JSON.parse(data);
            console.log("SUCCESS. Keys:", Object.keys(parsed));
            if (parsed.data && parsed.data.rows) {
                console.log("Rows count:", parsed.data.rows.length);
                console.log("First row:", parsed.data.rows[0]);
            }
        } catch (e) {
            console.log("JSON parse failed:", e.message);
        }
    });
}).on('error', (err) => {
    console.error("Error:", err.message);
});
