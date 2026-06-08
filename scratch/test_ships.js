const https = require('https');

const url = 'https://services.myshiptracking.com/requests/vesselsonmaptempw.php?type=json&minlat=33.0&maxlat=39.0&minlon=124.0&maxlon=131.0&zoom=8&selid=null&seltype=null&timecode=-1&slmp=&_=' + Date.now();

console.log("Fetching vessels from MyShipTracking:", url);

https.get(url, {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.myshiptracking.com/',
        'Accept': '*/*'
    }
}, (res) => {
    console.log("Status:", res.statusCode);
    console.log("Headers:", res.headers);
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        console.log("Data length:", data.length);
        console.log("Data preview (first 500 chars):", data.slice(0, 500));
        try {
            const parsed = JSON.parse(data);
            console.log("Parsed keys:", Object.keys(parsed));
        } catch (e) {
            console.log("JSON parsing failed:", e.message);
        }
    });
}).on('error', (err) => {
    console.error("Error:", err.message);
});
