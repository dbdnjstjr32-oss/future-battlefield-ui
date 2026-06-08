const http = require('http');

console.log("Requesting http://localhost:8080/api/flights...");
http.get('http://localhost:8080/api/flights', (res) => {
    console.log("Status:", res.statusCode);
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
        try {
            const parsed = JSON.parse(data);
            const keys = Object.keys(parsed);
            console.log("Successfully parsed JSON!");
            console.log("Keys count:", keys.length);
            console.log("Keys list preview:", keys.slice(0, 10));
            if (keys.length > 3) {
                const firstFlightKey = keys.find(k => k !== 'version' && k !== 'full_count' && k !== 'stats');
                console.log("Sample flight data:", firstFlightKey, parsed[firstFlightKey]);
            }
        } catch (e) {
            console.log("Error parsing JSON:", e.message);
            console.log("Data preview:", data.slice(0, 200));
        }
    });
}).on('error', (err) => {
    console.error("Request error:", err.message);
});
