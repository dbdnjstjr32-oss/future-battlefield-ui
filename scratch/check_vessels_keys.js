const fs = require('fs');
const path = require('path');

try {
    const filePath = path.join(__dirname, '..', 'vessels.json');
    if (fs.existsSync(filePath)) {
        const fileContent = fs.readFileSync(filePath, 'utf8');
        const parsed = JSON.parse(fileContent);
        if (parsed.data && parsed.data.rows && parsed.data.rows.length > 0) {
            const rows = parsed.data.rows;
            const nonSat = rows.filter(r => r.SHIPNAME && r.SHIPNAME !== '[SAT-AIS]');
            console.log("Total rows:", rows.length);
            console.log("Non SAT-AIS rows:", nonSat.length);
            
            // Look at a few sample non-SAT rows
            console.log("Sample non-SAT rows:", nonSat.slice(0, 5));
        }
    }
} catch (e) {
    console.error(e);
}
