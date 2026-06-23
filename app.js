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
    isScanline: false,
    showAircraft: true,
    showVessels: true,
    showDataCenters: false,
    showSatTracks: false,
    scanProgress: 0,
    isFollowing: true
};

// Tactical Delivery (Cargo Tracking) State
const LOGISTICS_HUBS = {
    gonjiam: { name: "CJ Gonjiam Mega Hub", coords: [127.2947, 37.3828], desc: "경기도 광주 초월읍 메가허브" },
    okcheon: { name: "CJ Okcheon Hub", coords: [127.5901, 36.3155], desc: "충북 옥천군 옥천허브 (Black Hole)" },
    daejeon: { name: "CJ Daejeon Hub", coords: [127.4208, 36.3882], desc: "대전광역시 대덕구 대전허브" },
    jincheon: { name: "Lotte Jincheon Mega Hub", coords: [127.4398, 36.8831], desc: "충청북도 진천군 메가허브" },
    chilgok: { name: "Hanjin Chilgok Hub", coords: [128.4069, 35.9863], desc: "경상북도 칠곡군 영남복합물류" },
    jangseong: { name: "CJ Jangseong Hub", coords: [126.8372, 35.2678], desc: "전라남도 장성군 호남물류" },
    
    seoul_hq: { name: "Seoul HQ Terminal", coords: [127.05, 37.45], desc: "서울특별시 강남구 지사" },
    busan_base: { name: "Busan Terminal", coords: [129.09, 35.10], desc: "부산광역시 영도구 지사" },
    daegu_center: { name: "Daegu Terminal", coords: [128.60, 35.87], desc: "대구광역시 동구 지사" },
    gwangju_center: { name: "Gwangju Terminal", coords: [126.85, 35.16], desc: "광주광역시 광산구 지사" },
    jeju_airfield: { name: "Jeju Terminal", coords: [126.46, 33.24], desc: "제주특별자치도 제주시 지사" },
    incheon_airport: { name: "Incheon Cargo Terminal", coords: [126.45, 37.45], desc: "인천국제공항 화물지사" },
    gangneung_center: { name: "Gangneung Terminal", coords: [128.90, 37.75], desc: "강원특별자치도 강릉시 지사" }
};

const trackingState = {
    active: false,
    courier: '',
    invoice: '',
    routeStages: [],    // Stages: { name, coords, statusText, desc, time }
    activeStageIndex: 0,
    osrmCoords: [],     // Coordinates of the current OSRM road path
    currentPos: null,   // [lng, lat]
    pathProgress: 0.0,
    speed: 0.10,
    status: 'idle',     // 'idle', 'loading', 'hub_stationed', 'in_transit', 'delivered'
    statusTimer: 0.0
};

const plotterState = {
    active: false,
    name: '',
    coords: null // [lon, lat]
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

// ─── Cargo Tracking (Tactical Parcel Follower) & Geocoding Logic ───
const carrierMap = {
    cj: 'kr.cjlogistics',
    coupang: 'kr.coupangls',
    hanjin: 'kr.hanjin',
    lotte: 'kr.lotte',
    post: 'kr.epost'
};

function getCoordsForName(name, invoice, index, totalEvents) {
    const lower = name.toLowerCase();
    
    if (lower.includes("곤지암") || lower.includes("gonjiam")) return LOGISTICS_HUBS.gonjiam.coords;
    if (lower.includes("옥천") || lower.includes("okcheon")) return LOGISTICS_HUBS.okcheon.coords;
    if (lower.includes("대전") || lower.includes("daejeon") || lower.includes("대덕")) return LOGISTICS_HUBS.daejeon.coords;
    if (lower.includes("진천") || lower.includes("jincheon")) return LOGISTICS_HUBS.jincheon.coords;
    if (lower.includes("칠곡") || lower.includes("chilgok")) return LOGISTICS_HUBS.chilgok.coords;
    if (lower.includes("장성") || lower.includes("jangseong")) return LOGISTICS_HUBS.jangseong.coords;
    if (lower.includes("부산") || lower.includes("busan")) return LOGISTICS_HUBS.busan_base.coords;
    if (lower.includes("대구") || lower.includes("daegu")) return LOGISTICS_HUBS.daegu_center.coords;
    if (lower.includes("광주") || lower.includes("gwangju")) return LOGISTICS_HUBS.gwangju_center.coords;
    if (lower.includes("인천") || lower.includes("incheon")) return LOGISTICS_HUBS.incheon_airport.coords;
    if (lower.includes("강릉") || lower.includes("gangneung")) return LOGISTICS_HUBS.gangneung_center.coords;
    if (lower.includes("서울") || lower.includes("seoul")) return LOGISTICS_HUBS.seoul_hq.coords;
    
    // Fallback region matches
    if (lower.includes("경기") || lower.includes("수원") || lower.includes("성남") || lower.includes("고양") || lower.includes("용인") || lower.includes("의정부") || lower.includes("남양주")) {
        return [127.1 + (index * 0.03), 37.3 + (index * 0.02)];
    }
    if (lower.includes("경북") || lower.includes("포항") || lower.includes("경주") || lower.includes("구미") || lower.includes("안동")) {
        return [128.6 + (index * 0.03), 36.2 + (index * 0.02)];
    }
    if (lower.includes("경남") || lower.includes("창원") || lower.includes("김해") || lower.includes("진주") || lower.includes("양산")) {
        return [128.7 + (index * 0.03), 35.2 + (index * 0.02)];
    }
    if (lower.includes("충북") || lower.includes("청주") || lower.includes("충주")) {
        return [127.6 + (index * 0.03), 36.8 + (index * 0.02)];
    }
    if (lower.includes("충남") || lower.includes("천안") || lower.includes("아산") || lower.includes("서산")) {
        return [127.0 + (index * 0.03), 36.6 + (index * 0.02)];
    }
    if (lower.includes("전북") || lower.includes("전주") || lower.includes("익산")) {
        return [127.1 + (index * 0.03), 35.8 + (index * 0.02)];
    }
    if (lower.includes("전남") || lower.includes("여수") || lower.includes("순천") || lower.includes("목포")) {
        return [126.9 + (index * 0.03), 34.8 + (index * 0.02)];
    }
    if (lower.includes("강원") || lower.includes("춘천") || lower.includes("원주") || lower.includes("속초")) {
        return [128.2 + (index * 0.03), 37.8 + (index * 0.02)];
    }
    if (lower.includes("제주")) {
        return [126.5 + (index * 0.02), 33.3 + (index * 0.02)];
    }
    
    // Hash-based deterministic coordinates inside South Korea
    let hash = 0;
    const str = name + invoice;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) % 10000;
    }
    
    const lng = 126.6 + ((hash + index * 57) % 220) * 0.01;
    const lat = 35.3 + (((hash / 10) + index * 63) % 180) * 0.01;
    return [lng, lat];
}

function parseLocationNameAndCoords(progress, index, totalEvents, invoice) {
    let name = "";
    if (progress.location && typeof progress.location === 'object') {
        name = progress.location.name || "";
    } else if (progress.location && typeof progress.location === 'string') {
        name = progress.location;
    }
    
    if (!name && progress.description) {
        const match = progress.description.match(/([가-힣\w]+(?:HUB|허브|센터|지점|대리점|지사|터미널|포트))/i);
        if (match) {
            name = match[1];
        } else {
            const cityMatch = progress.description.match(/(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주|곤지암|옥천|칠곡|장성|진천)/);
            if (cityMatch) {
                name = cityMatch[1] + " 센터";
            }
        }
    }
    
    if (!name) {
        name = `지점 ${index + 1}`;
    }
    
    const coords = getCoordsForName(name, invoice, index, totalEvents);
    return { name, coords };
}

function getRelativeTimeString(offsetHours) {
    const d = new Date();
    d.setHours(d.getHours() + offsetHours);
    return `${(d.getMonth() + 1).toString().padStart(2, '0')}-${d.getDate().toString().padStart(2, '0')} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function generateSimulationRouteStages(courier, invoice) {
    let hash = 0;
    for (let i = 0; i < invoice.length; i++) {
        hash = (hash * 31 + invoice.charCodeAt(i)) % 1000;
    }
    
    const sellerBases = [
        { name: "Busan Terminal", coords: LOGISTICS_HUBS.busan_base.coords, text: "부산 수영지사 집하 처리" },
        { name: "Daegu Terminal", coords: LOGISTICS_HUBS.daegu_center.coords, text: "대구 북구지사 집하 처리" },
        { name: "Gwangju Terminal", coords: LOGISTICS_HUBS.gwangju_center.coords, text: "광주 광산지사 집하 처리" },
        { name: "Gangneung Terminal", coords: LOGISTICS_HUBS.gangneung_center.coords, text: "강원 강릉지사 집하 처리" },
        { name: "Incheon Terminal", coords: LOGISTICS_HUBS.incheon_airport.coords, text: "인천 중구지사 집하 처리" }
    ];
    
    const destinations = [
        { name: "Seoul HQ", coords: LOGISTICS_HUBS.seoul_hq.coords, text: "서울 강남구 배송지" },
        { name: "Gyeryongdae HQ", coords: [127.24, 36.29], text: "충남 계룡대 본부 배송지" },
        { name: "Busan Naval Base", coords: [129.09, 35.10], text: "부산 남구 해군기지 배송지" },
        { name: "Jeju Terminal", coords: LOGISTICS_HUBS.jeju_airfield.coords, text: "제주 제주시 배송지" }
    ];
    
    const start = sellerBases[hash % sellerBases.length];
    let dest = destinations[(hash + 1) % destinations.length];
    if (start.name.startsWith("Busan") && dest.name.startsWith("Busan")) {
        dest = destinations[0];
    }
    
    const hubs = [];
    if (start.name.includes("Busan") || start.name.includes("Daegu")) {
        hubs.push({ name: "Chilgok Hub", coords: LOGISTICS_HUBS.chilgok.coords, text: "한진 칠곡허브 입고" });
        hubs.push({ name: "Okcheon Hub", coords: LOGISTICS_HUBS.okcheon.coords, text: "CJ 옥천허브 간선하차" });
        hubs.push({ name: "Gonjiam Hub", coords: LOGISTICS_HUBS.gonjiam.coords, text: "CJ 곤지암메가허브 간선상차" });
    } else if (start.name.includes("Gwangju")) {
        hubs.push({ name: "Jangseong Hub", coords: LOGISTICS_HUBS.jangseong.coords, text: "CJ 장성허브 입고" });
        hubs.push({ name: "Daejeon Hub", coords: LOGISTICS_HUBS.daejeon.coords, text: "CJ 대전허브 간선하차" });
        hubs.push({ name: "Gonjiam Hub", coords: LOGISTICS_HUBS.gonjiam.coords, text: "CJ 곤지암메가허브 간선상차" });
    } else if (start.name.includes("Gangneung")) {
        hubs.push({ name: "Jincheon Hub", coords: LOGISTICS_HUBS.jincheon.coords, text: "롯데 진천메가허브 입고" });
        hubs.push({ name: "Gonjiam Hub", coords: LOGISTICS_HUBS.gonjiam.coords, text: "CJ 곤지암메가허브 간선상차" });
    } else {
        hubs.push({ name: "Gonjiam Hub", coords: LOGISTICS_HUBS.gonjiam.coords, text: "CJ 곤지암메가허브 입고" });
        hubs.push({ name: "Daejeon Hub", coords: LOGISTICS_HUBS.daejeon.coords, text: "CJ 대전허브 간선상차" });
    }
    
    if (dest.name.includes("Jeju")) {
        hubs.push({ name: "Busan Terminal", coords: LOGISTICS_HUBS.busan_base.coords, text: "부산항선박화물 선적 대기" });
    }
    
    const stages = [];
    stages.push({
        name: start.name,
        coords: start.coords,
        statusText: "SHIPPED",
        desc: start.text,
        time: getRelativeTimeString(-12)
    });
    
    hubs.forEach((hub, idx) => {
        stages.push({
            name: hub.name,
            coords: hub.coords,
            statusText: "IN_TRANSIT",
            desc: hub.text,
            time: getRelativeTimeString(-8 + idx * 2)
        });
    });
    
    stages.push({
        name: dest.name,
        coords: dest.coords,
        statusText: "DELIVERED",
        desc: dest.text,
        time: "PENDING"
    });
    
    return stages;
}

async function fetchOSRMRoute(startCoords, endCoords) {
    try {
        const url = `https://router.project-osrm.org/route/v1/driving/${startCoords[0]},${startCoords[1]};${endCoords[0]},${endCoords[1]}?geometries=geojson&overview=full`;
        const res = await fetch(url);
        if (!res.ok) throw new Error('OSRM status ' + res.status);
        const data = await res.json();
        if (data.routes && data.routes.length > 0 && data.routes[0].geometry) {
            return data.routes[0].geometry.coordinates;
        }
        throw new Error('No routes returned');
    } catch (e) {
        console.warn('[OSRM] Routing failed, falling back to geodesic line:', e.message);
        const pts = [];
        const steps = 30;
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            pts.push([
                startCoords[0] + (endCoords[0] - startCoords[0]) * t,
                startCoords[1] + (endCoords[1] - startCoords[1]) * t
            ]);
        }
        return pts;
    }
}

function updateTrackingLogUI() {
    const container = document.getElementById('tracking-log');
    if (!container) return;
    
    container.innerHTML = '';
    trackingState.routeStages.forEach((stage, idx) => {
        const item = document.createElement('div');
        item.className = 'log-item';
        if (idx === trackingState.activeStageIndex) {
            item.classList.add('active');
        }
        
        let statusMarker = '';
        if (idx < trackingState.activeStageIndex) {
            statusMarker = '✓ ';
        } else if (idx === trackingState.activeStageIndex) {
            statusMarker = (trackingState.status === 'delivered') ? '● ' : '▶ ';
        } else {
            statusMarker = '○ ';
        }
        
        const timeText = stage.time === 'PENDING' ? '' : stage.time;
        
        item.innerHTML = `
            <div class="log-item-meta">
                <span>${statusMarker}${stage.name}</span>
                <span>${timeText}</span>
            </div>
            <div class="log-item-desc">${stage.desc}</div>
        `;
        container.appendChild(item);
    });
    
    const activeItem = container.querySelector('.log-item.active');
    if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

async function transitionToNextStage() {
    const i = trackingState.activeStageIndex;
    if (i >= trackingState.routeStages.length - 1) {
        trackingState.status = 'delivered';
        document.getElementById('track-status-summary').textContent = "DELIVERED";
        return;
    }
    
    trackingState.status = 'loading';
    document.getElementById('track-status-summary').textContent = "ROUTE PLAN...";
    
    const start = trackingState.routeStages[i].coords;
    const end = trackingState.routeStages[i+1].coords;
    
    const coords = await fetchOSRMRoute(start, end);
    trackingState.osrmCoords = coords;
    trackingState.pathProgress = 0.0;
    trackingState.status = 'in_transit';
    trackingState.speed = 0.08;
    
    document.getElementById('track-status-summary').textContent = "IN TRANSIT";
    updateTrackingLogUI();
}

async function startTracking() {
    const courierSelect = document.getElementById('courier-select');
    const trackingInput = document.getElementById('tracking-input');
    const trackingStatusPanel = document.getElementById('tracking-status-panel');
    const trackBtn = document.getElementById('track-btn');
    
    if (!courierSelect || !trackingInput || !trackingStatusPanel || !trackBtn) return;
    
    const courier = courierSelect.value;
    const invoice = trackingInput.value.trim();
    
    if (!invoice) {
        alert("운송장 번호를 입력해주세요.");
        return;
    }
    
    trackBtn.disabled = true;
    trackBtn.textContent = "조회 중...";
    
    const carrierId = carrierMap[courier] || courier;
    
    try {
        console.log(`[Tracking] Fetching real shipment info for ${carrierId} - ${invoice}`);
        const res = await fetch(`/api/track?carrier=${carrierId}&invoice=${invoice}`);
        
        if (!res.ok) {
            if (res.status === 404) {
                throw new Error("해당 운송장 번호의 배송 내역을 찾을 수 없습니다. (택배사 시스템에 미등록된 상태일 수 있습니다.)");
            } else {
                throw new Error(`서버 오류 (Status ${res.status})`);
            }
        }
        
        const data = await res.json();
        
        if (!data.progresses || data.progresses.length === 0) {
            throw new Error("조회된 배송 진행 내역이 없습니다.");
        }
        
        const stages = [];
        const total = data.progresses.length;
        
        data.progresses.forEach((prog, idx) => {
            const { name, coords } = parseLocationNameAndCoords(prog, idx, total, invoice);
            
            let cleanTime = "";
            if (prog.time) {
                try {
                    const date = new Date(prog.time);
                    cleanTime = `${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
                } catch (err) {
                    cleanTime = prog.time.substring(5, 16).replace('T', ' ');
                }
            }
            
            stages.push({
                name: name,
                coords: coords,
                statusText: prog.status ? prog.status.id : "IN_TRANSIT",
                desc: prog.description || "배송 물류 이동 중",
                time: cleanTime || "시간 정보 없음"
            });
        });
        
        const lastState = data.state ? data.state.id : "";
        if (lastState !== 'delivered' && stages.length > 0) {
            const lastStage = stages[stages.length - 1];
            let destCoords = LOGISTICS_HUBS.seoul_hq.coords;
            if (lastStage.coords[0] === destCoords[0] && lastStage.coords[1] === destCoords[1]) {
                destCoords = [127.24, 36.29];
            }
            
            stages.push({
                name: "배송 목적지",
                coords: destCoords,
                statusText: "PENDING",
                desc: "최종 배송지로 배송 예정",
                time: "PENDING"
            });
        }
        
        state.isFollowing = true;
        trackingState.active = true;
        trackingState.courier = courier;
        trackingState.invoice = invoice;
        trackingState.routeStages = stages;
        trackingState.activeStageIndex = 0;
        trackingState.status = 'hub_stationed';
        trackingState.statusTimer = 3.0;
        trackingState.currentPos = [...trackingState.routeStages[0].coords];
        trackingState.pathProgress = 0.0;
        trackingState.osrmCoords = [];
        
        document.getElementById('track-status-summary').textContent = "REAL TRACK";
        trackingStatusPanel.style.display = 'flex';
        updateTrackingLogUI();
        
        map.flyTo({
            center: trackingState.currentPos,
            zoom: 15.5,
            pitch: 40,
            bearing: -10
        });
        
        state.isAutoRot = true;
        const toggleAutoRotEl = document.getElementById('toggle-autorot');
        if (toggleAutoRotEl) {
            toggleAutoRotEl.checked = true;
        }
        
    } catch (e) {
        console.warn('[Tracking API] Real-time fetch failed:', e.message);
        
        const useMock = confirm(`실제 운송장 정보 조회 실패: ${e.message}\n\n시뮬레이션 모드로 가상의 경로 추적을 시동하겠습니까?`);
        if (useMock) {
            runSimulationTracking(courier, invoice);
        } else {
            abortTracking();
        }
    } finally {
        trackBtn.disabled = false;
        trackBtn.textContent = "TRACK";
    }
}

function runSimulationTracking(courier, invoice) {
    const trackingStatusPanel = document.getElementById('tracking-status-panel');
    
    state.isFollowing = true;
    trackingState.active = true;
    trackingState.courier = courier;
    trackingState.invoice = invoice;
    trackingState.routeStages = generateSimulationRouteStages(courier, invoice);
    trackingState.activeStageIndex = 0;
    trackingState.status = 'hub_stationed';
    trackingState.statusTimer = 3.0;
    trackingState.currentPos = [...trackingState.routeStages[0].coords];
    trackingState.pathProgress = 0.0;
    trackingState.osrmCoords = [];
    
    document.getElementById('track-status-summary').textContent = "SIMULATION";
    if (trackingStatusPanel) trackingStatusPanel.style.display = 'flex';
    updateTrackingLogUI();
    
    map.flyTo({
        center: trackingState.currentPos,
        zoom: 15.5,
        pitch: 40,
        bearing: -10
    });
    
    state.isAutoRot = true;
    const toggleAutoRotEl = document.getElementById('toggle-autorot');
    if (toggleAutoRotEl) {
        toggleAutoRotEl.checked = true;
    }
}

function abortTracking() {
    trackingState.active = false;
    trackingState.status = 'idle';
    trackingState.currentPos = null;
    trackingState.osrmCoords = [];
    trackingState.routeStages = [];
    
    const trackingStatusPanel = document.getElementById('tracking-status-panel');
    if (trackingStatusPanel) {
        trackingStatusPanel.style.display = 'none';
    }
}

async function searchAndPlotLocation() {
    const geocodeInput = document.getElementById('geocode-input');
    const geocodeBtn = document.getElementById('geocode-btn');
    
    if (!geocodeInput || !geocodeBtn) return;
    
    const query = geocodeInput.value.trim();
    if (!query) {
        alert("검색할 주소 또는 위치명을 입력하세요.");
        return;
    }
    
    geocodeBtn.disabled = true;
    geocodeBtn.textContent = "조회 중...";
    
    try {
        console.log(`[Geocoding] Querying Nominatim for: "${query}"`);
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        
        const data = await res.json();
        
        if (!data || data.length === 0) {
            throw new Error("위치를 찾을 수 없습니다.");
        }
        
        const place = data[0];
        const lon = parseFloat(place.lon);
        const lat = parseFloat(place.lat);
        
        console.log(`[Geocoding] Location found: ${place.display_name} -> [${lon}, ${lat}]`);
        
        state.isFollowing = true;
        plotterState.active = true;
        plotterState.name = place.display_name.split(',')[0].trim().toUpperCase() || query.toUpperCase();
        plotterState.coords = [lon, lat];
        
        // Show plotter status panel
        const plotterStatusPanel = document.getElementById('plotter-status-panel');
        const plotterTargetName = document.getElementById('plotter-target-name');
        const plotterCoords = document.getElementById('plotter-coords');
        if (plotterStatusPanel) plotterStatusPanel.style.display = 'flex';
        if (plotterTargetName) plotterTargetName.textContent = plotterState.name;
        if (plotterCoords) plotterCoords.textContent = `${lat.toFixed(5)}°N, ${lon.toFixed(5)}°E`;
        
        // Deep zoom and oblique camera angle
        map.flyTo({
            center: [lon, lat],
            zoom: 15.0,
            pitch: 40,
            bearing: -10,
            duration: 2500
        });
        
        // Trigger auto rotation
        state.isAutoRot = true;
        const toggleAutoRotEl = document.getElementById('toggle-autorot');
        if (toggleAutoRotEl) {
            toggleAutoRotEl.checked = true;
        }
        
        geocodeBtn.textContent = "LOCKED!";
        setTimeout(() => {
            geocodeBtn.textContent = "PLOT TARGET";
            geocodeBtn.disabled = false;
        }, 1500);
        
    } catch (e) {
        alert(`위치 조회 실패: ${e.message}`);
        geocodeBtn.textContent = "PLOT TARGET";
        geocodeBtn.disabled = false;
    }
}

function releasePlotterTarget() {
    plotterState.active = false;
    plotterState.name = '';
    plotterState.coords = null;
    
    const plotterStatusPanel = document.getElementById('plotter-status-panel');
    if (plotterStatusPanel) {
        plotterStatusPanel.style.display = 'none';
    }
}

// Canvas Resizing
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// Connect DOM controls
const zoomSlider = document.getElementById('camera-zoom');
const zoomValEl = document.getElementById('zoom-val');
const speedSlider = document.getElementById('auto-rot-speed');
const speedValEl = document.getElementById('speed-val');

const toggleAutoRot = document.getElementById('toggle-autorot');
const toggleNoiseWave = document.getElementById('toggle-noise-wave');
const toggleAircraft = document.getElementById('toggle-aircraft');
const toggleVessels = document.getElementById('toggle-vessels');
const toggleDataCenter = document.getElementById('toggle-datacenter');
const toggleSatTrack = document.getElementById('toggle-sattrack');

// Sidebar Panel Collapsing Toggle
const panelToggle = document.getElementById('panel-toggle');
const controlPanel = document.querySelector('.control-panel');

panelToggle.addEventListener('click', () => {
    controlPanel.classList.toggle('collapsed');
    panelToggle.classList.toggle('collapsed');
    if (controlPanel.classList.contains('collapsed')) {
        panelToggle.textContent = '▶';
    } else {
        panelToggle.textContent = '◀';
    }
});

const pitchValEl = document.getElementById('pitch-val');
const yawValEl = document.getElementById('yaw-val');
const fpsCounter = document.getElementById('fps-counter');
const vertexCounter = document.getElementById('vertex-counter');

// Bind Cargo Tracking & Geocoding Button Events
const trackBtn = document.getElementById('track-btn');
const cancelBtn = document.getElementById('track-cancel-btn');
const geocodeBtn = document.getElementById('geocode-btn');
const plotterClearBtn = document.getElementById('plotter-clear-btn');
if (trackBtn) trackBtn.addEventListener('click', startTracking);
if (cancelBtn) cancelBtn.addEventListener('click', abortTracking);
if (geocodeBtn) geocodeBtn.addEventListener('click', searchAndPlotLocation);
if (plotterClearBtn) plotterClearBtn.addEventListener('click', releasePlotterTarget);

const tacticalCloseBtn = document.getElementById('tactical-close-btn');
if (tacticalCloseBtn) {
    tacticalCloseBtn.addEventListener('click', () => {
        selectDrone(null);
    });
}



zoomSlider.min = "2";
zoomSlider.max = "18";
zoomSlider.step = "0.1";
zoomSlider.value = state.zoom;
zoomValEl.textContent = state.zoom.toFixed(1) + 'x';

zoomSlider.addEventListener('input', (e) => {
    state.zoom = parseFloat(e.target.value);
    map.setZoom(state.zoom);
    zoomValEl.textContent = state.zoom.toFixed(1) + 'x';
});

document.querySelectorAll('.zoom-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const targetZoom = parseFloat(e.target.getAttribute('data-zoom'));
        state.zoom = targetZoom;
        map.setZoom(targetZoom);
        zoomSlider.value = targetZoom;
        zoomValEl.textContent = targetZoom.toFixed(1) + 'x';
        state.isFollowing = true;
    });
});

// Map Color Filter Preset Buttons
const MAP_FILTERS = {
    gray: 'grayscale(100%) brightness(0.75) contrast(1.1)',
    cyan: 'grayscale(100%) sepia(100%) hue-rotate(150deg) saturate(180%) brightness(0.7) contrast(1.1)',
    green: 'grayscale(100%) sepia(100%) hue-rotate(85deg) saturate(300%) brightness(0.75) contrast(1.2)',
    real: 'none'
};

// Set initial default theme attribute — grayscale (흑백) as default
document.documentElement.setAttribute('data-theme', 'gray');

// Apply default grayscale filter to map on load
const _initMapEl = document.getElementById('map');
if (_initMapEl) _initMapEl.style.filter = MAP_FILTERS.gray;

// Mark the gray button as active on load
const _initGrayBtn = document.querySelector('.filter-preset-btn[data-filter="gray"]');
if (_initGrayBtn) {
    document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active-filter'));
    _initGrayBtn.classList.add('active-filter');
}

document.querySelectorAll('.filter-preset-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const filterKey = e.target.getAttribute('data-filter');
        const filterVal = MAP_FILTERS[filterKey] || 'none';
        const mapEl = document.getElementById('map');
        if (mapEl) {
            mapEl.style.filter = filterVal;
        }
        document.querySelectorAll('.filter-preset-btn').forEach(b => b.classList.remove('active-filter'));
        e.target.classList.add('active-filter');
        
        // Update document theme attribute to change side panel style dynamically
        document.documentElement.setAttribute('data-theme', filterKey);
    });
});

speedSlider.addEventListener('input', (e) => {
    speedValEl.textContent = parseFloat(e.target.value).toFixed(1);
});

toggleAutoRot.checked = state.isAutoRot;
toggleAutoRot.addEventListener('change', (e) => {
    state.isAutoRot = e.target.checked;
});

toggleNoiseWave.addEventListener('change', (e) => {
    state.isNoiseWave = e.target.checked;
});



toggleAircraft.checked = state.showAircraft;
toggleAircraft.addEventListener('change', (e) => {
    state.showAircraft = e.target.checked;
    // Deselect a hidden aircraft target
    if (!state.showAircraft && selectedDrone && !selectedDrone.isVessel) selectDrone(null);
});

toggleVessels.checked = state.showVessels;
toggleVessels.addEventListener('change', (e) => {
    state.showVessels = e.target.checked;
    // Deselect a hidden vessel target
    if (!state.showVessels && selectedDrone && selectedDrone.isVessel) selectDrone(null);
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
});

// ─── User Interaction Priority ─────────────────────────────────────────────
// When user touches/drags/zooms the map, immediately pause all auto behaviors.
// Auto-resume 2 seconds after the user stops interacting.
let userInteracting = false;
let userInteractResumeTimer = null;

const USER_RESUME_DELAY = 2000; // ms before auto-resume

function onUserInteractStart(hasOriginalEvent) {
    if (hasOriginalEvent === false) return; // programmatic event — skip
    userInteracting = true;
    state.isFollowing = false;
    // Cancel any pending resume
    if (userInteractResumeTimer) {
        clearTimeout(userInteractResumeTimer);
        userInteractResumeTimer = null;
    }
}

function onUserInteractEnd() {
    // Schedule auto-resume
    if (userInteractResumeTimer) clearTimeout(userInteractResumeTimer);
    userInteractResumeTimer = setTimeout(() => {
        userInteracting = false;
        // Re-enable follow if a target is selected
        if (selectedDrone) {
            state.isFollowing = true;
        }
    }, USER_RESUME_DELAY);
}

// Pause camera follow when the user manually interacts with the map
map.on('dragstart',   (e) => onUserInteractStart(!e.originalEvent ? false : true));
map.on('dragend',     ()  => onUserInteractEnd());
map.on('zoomstart',   (e) => onUserInteractStart(!!e.originalEvent));
map.on('zoomend',     ()  => onUserInteractEnd());
map.on('pitchstart',  (e) => onUserInteractStart(!!e.originalEvent));
map.on('pitchend',    ()  => onUserInteractEnd());
map.on('rotatestart', (e) => onUserInteractStart(!!e.originalEvent));
map.on('rotateend',   ()  => onUserInteractEnd());

// Also capture native touch events on the map canvas for maximum priority
map.getCanvas().addEventListener('touchstart', () => {
    onUserInteractStart(true);
}, { passive: true });
map.getCanvas().addEventListener('touchend', () => {
    onUserInteractEnd();
}, { passive: true });
map.getCanvas().addEventListener('mousedown', () => {
    onUserInteractStart(true);
}, { passive: true });
map.getCanvas().addEventListener('mouseup', () => {
    onUserInteractEnd();
}, { passive: true });


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
    { name: "CHEONGJU UNIV HQ", coords: [127.4957, 36.6506], isHQ: true },
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

let currentLoadedPhotoReg = null;

function loadAircraftPhoto(drone) {
    const reg = drone.registration;
    const model = drone.acType || 'AIRCRAFT';
    const photoContainer = document.getElementById('tac-photo-container');
    const photoImg = document.getElementById('tac-photo');
    const photoModel = document.getElementById('tac-photo-model');
    const photoPhotographer = document.getElementById('tac-photo-photographer');
    
    if (!reg || reg === 'N/A') {
        if (photoContainer) photoContainer.style.display = 'none';
        return;
    }
    
    if (currentLoadedPhotoReg === reg) {
        if (photoContainer) photoContainer.style.display = 'block';
        return;
    }
    
    currentLoadedPhotoReg = reg;
    
    if (photoImg) photoImg.src = '';
    if (photoModel) photoModel.textContent = model;
    if (photoPhotographer) photoPhotographer.textContent = 'LOADING...';
    if (photoContainer) photoContainer.style.display = 'block';
    
    fetch(`/api/aircraft-photo?reg=${encodeURIComponent(reg)}`)
        .then(res => res.json())
        .then(data => {
            if (!selectedDrone || selectedDrone.registration !== reg) return;
            
            if (data.photos && data.photos.length > 0) {
                const photo = data.photos[0];
                const imgSrc = photo.thumbnail_large ? photo.thumbnail_large.src : (photo.thumbnail ? photo.thumbnail.src : '');
                
                if (photoImg && imgSrc) {
                    photoImg.src = imgSrc;
                }
                if (photoPhotographer) {
                    photoPhotographer.textContent = `© ${photo.photographer || 'Planespotters'}`;
                }
            } else {
                if (photoPhotographer) photoPhotographer.textContent = 'NO IMAGE';
                if (photoContainer) photoContainer.style.display = 'none';
            }
        })
        .catch(err => {
            console.error('Error fetching aircraft photo:', err);
            if (photoContainer) photoContainer.style.display = 'none';
        });
}

function loadAirlineLogo(drone) {
    const logoContainer = document.getElementById('tac-airline-container');
    const logoImg = document.getElementById('tac-airline-logo');
    
    if (!drone.id) {
        if (logoContainer) logoContainer.style.display = 'none';
        return;
    }
    
    const match = drone.id.match(/^([A-Z]{3})/);
    const operator = match ? match[1].toUpperCase() : null;
    
    if (!operator) {
        if (logoContainer) logoContainer.style.display = 'none';
        return;
    }
    
    if (logoImg) {
        logoImg.src = `https://www.flightaware.com/images/airline_logos/90p/${operator}.png`;
        logoImg.onerror = () => {
            if (logoContainer) logoContainer.style.display = 'none';
        };
        logoImg.onload = () => {
            if (selectedDrone && selectedDrone.id === drone.id) {
                if (logoContainer) logoContainer.style.display = 'flex';
            }
        };
    }
}

function selectDrone(drone) {
    selectedDrone = drone;
    if (drone) {
        state.isFollowing = true;
        
        if (!drone.isVessel) {
            loadAircraftPhoto(drone);
            loadAirlineLogo(drone);
        } else {
            const photoContainer = document.getElementById('tac-photo-container');
            if (photoContainer) photoContainer.style.display = 'none';
            const logoContainer = document.getElementById('tac-airline-container');
            if (logoContainer) logoContainer.style.display = 'none';
        }
    } else {
        const photoContainer = document.getElementById('tac-photo-container');
        if (photoContainer) photoContainer.style.display = 'none';
        const logoContainer = document.getElementById('tac-airline-container');
        if (logoContainer) logoContainer.style.display = 'none';
        currentLoadedPhotoReg = null;
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
        selectDrone(clickedObject);
    } else {
        // Only deselect if not clicking control panel, input fields, or the tactical side panel overlay
        if (!e.target.closest('.control-panel') && !e.target.closest('input') && !e.target.closest('.tactical-panel-overlay')) {
            selectDrone(null);
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

    // Auto Rotation simulation — suspended while user is interacting
    if (state.isAutoRot && !userInteracting) {
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



    // Auto camera follow — suspended while user is interacting
    if (state.isFollowing && !userInteracting) {
        if (selectedDrone) {
            map.setCenter(selectedDrone.currentCoords);
        } else if (trackingState.active && trackingState.currentPos) {
            map.setCenter(trackingState.currentPos);
        } else if (plotterState.active && plotterState.coords) {
            map.setCenter(plotterState.coords);
        }
    }

    // Update Cargo Tracking Simulation
    if (trackingState.active) {
        if (trackingState.status === 'in_transit' && trackingState.osrmCoords.length > 0) {
            trackingState.pathProgress += trackingState.speed * dt;
            if (trackingState.pathProgress >= 1.0) {
                trackingState.pathProgress = 1.0;
                
                // Arrived at next node!
                const nextIdx = trackingState.activeStageIndex + 1;
                trackingState.activeStageIndex = nextIdx;
                trackingState.currentPos = [...trackingState.routeStages[nextIdx].coords];
                
                // Add timestamp to arrival log
                const now = new Date();
                trackingState.routeStages[nextIdx].time = `${(now.getMonth()+1).toString().padStart(2, '0')}-${now.getDate().toString().padStart(2, '0')} ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
                
                if (nextIdx === trackingState.routeStages.length - 1) {
                    // Reached destination!
                    trackingState.status = 'delivered';
                    document.getElementById('track-status-summary').textContent = "DELIVERED";
                    updateTrackingLogUI();
                } else {
                    // Stationed at hub
                    trackingState.status = 'hub_stationed';
                    trackingState.statusTimer = 4.0; // Wait 4 seconds pulsing
                    document.getElementById('track-status-summary').textContent = "HUB ARRIVED";
                    updateTrackingLogUI();
                }
            } else if (trackingState.osrmCoords.length > 0) {
                // Interpolate position along OSRM road route coordinates
                const len = trackingState.osrmCoords.length;
                const progressFloat = trackingState.pathProgress * (len - 1);
                const idx = Math.floor(progressFloat);
                const nextIdx = Math.min(idx + 1, len - 1);
                const t = progressFloat - idx;
                
                const p1 = trackingState.osrmCoords[idx];
                const p2 = trackingState.osrmCoords[nextIdx];
                
                trackingState.currentPos = [
                    p1[0] + (p2[0] - p1[0]) * t,
                    p1[1] + (p2[1] - p1[1]) * t
                ];
            }
        } else if (trackingState.status === 'hub_stationed') {
            trackingState.statusTimer -= dt;
            if (trackingState.statusTimer <= 0) {
                // Start moving to next stage
                transitionToNextStage();
            }
        }
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

    // (Aircraft Mesh Network removed per design request)

    // (3D atmosphere altitude-layer horizontal lines removed per design request)

    // 4. Draw Satellite Ground Tracks
    drawSatellites(time);

    // 5. Draw Military Bases
    drawBases(time);

    // 5b. Draw Tactical Geo-Plotter Target
    if (plotterState.active) drawPlotterTarget(time);

    // 4. Draw Drones and Paths
    if (state.showAircraft) drawDrones(time);
    if (state.showVessels) drawVessels(time);

    // 8. Draw Cargo Tracking overlay
    if (trackingState.active) drawCargoTracking(time);

    // 5. Draw Selected Target details
    const targetPanel = document.getElementById('target-details-panel');
    const tacPanel = document.getElementById('tactical-right-panel');
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

        // Bind and animate the custom sliding side panel
        if (tacPanel) {
            tacPanel.classList.add('active');

            // ID
            const tacIdEl = document.getElementById('tac-id');
            if (tacIdEl) tacIdEl.textContent = selectedDrone.id;

            // Classify (Type)
            const tacTypeEl = document.getElementById('tac-type');
            if (tacTypeEl) tacTypeEl.textContent = selectedDrone.acType || (selectedDrone.isVessel ? 'VESSEL' : 'AIRCRAFT');

            // Registration / Flag
            const tacRegEl = document.getElementById('tac-reg');
            if (tacRegEl) {
                if (selectedDrone.isVessel) {
                    tacRegEl.textContent = selectedDrone.flag || selectedDrone.registration || 'N/A';
                } else {
                    tacRegEl.textContent = selectedDrone.registration || 'N/A';
                }
            }

            // Altitude
            const tacAltEl = document.getElementById('tac-alt');
            if (tacAltEl) {
                if (selectedDrone.isVessel) {
                    tacAltEl.textContent = selectedDrone.dwt ? `${parseInt(selectedDrone.dwt).toLocaleString()} dwt` : 'N/A';
                } else {
                    tacAltEl.textContent = selectedDrone.isGrounded ? 'ON GROUND' : `${selectedDrone.altitude.toLocaleString()} FT`;
                }
            }

            // Velocity (Knots)
            const tacSpeedEl = document.getElementById('tac-speed');
            if (tacSpeedEl) {
                let knotsVal = 0;
                if (selectedDrone.isVessel) {
                    knotsVal = (selectedDrone.velocity / 0.514444);
                    tacSpeedEl.textContent = `${knotsVal.toFixed(1)} KT`;
                } else {
                    knotsVal = selectedDrone.speedKnots !== undefined ? selectedDrone.speedKnots : (selectedDrone.velocity / 0.514444);
                    tacSpeedEl.textContent = `${Math.round(knotsVal)} KT`;
                }
            }

            // Spec Graphic Icon (Vessel vs Aircraft)
            const tacIconEl = document.getElementById('tac-icon');
            if (tacIconEl) {
                tacIconEl.textContent = selectedDrone.isVessel ? '🚢' : '✈';
            }

            // Callsign
            const tacCallsignEl = document.getElementById('tac-callsign');
            if (tacCallsignEl) tacCallsignEl.textContent = selectedDrone.id;

            // Origin Country or Place
            const tacOriginEl = document.getElementById('tac-origin');
            if (tacOriginEl) {
                if (selectedDrone.isVessel) {
                    tacOriginEl.textContent = selectedDrone.country || selectedDrone.flag || 'MARITIME';
                } else {
                    tacOriginEl.textContent = selectedDrone.origin || 'FLIGHT';
                }
            }

            // Route details
            const tacRouteEl = document.getElementById('tac-route');
            if (tacRouteEl) {
                tacRouteEl.textContent = selectedDrone.isVessel 
                    ? (selectedDrone.dest || 'N/A')
                    : `${selectedDrone.origin || 'N/A'} > ${selectedDrone.dest || 'N/A'}`;
            }

            // Coordinates
            const tacLatEl = document.getElementById('tac-lat');
            if (tacLatEl) tacLatEl.textContent = `${selectedDrone.currentCoords[1].toFixed(5)}°N`;
            const tacLonEl = document.getElementById('tac-lon');
            if (tacLonEl) tacLonEl.textContent = `${selectedDrone.currentCoords[0].toFixed(5)}°E`;

            // Dynamic distance / range from map center
            const mapCenter = map.getCenter();
            const dLon = mapCenter.lng;
            const dLat = mapCenter.lat;

            // Haversine formula to compute distance in km
            const R = 6371; // earth radius in km
            const lat1 = selectedDrone.currentCoords[1] * Math.PI / 180;
            const lat2 = dLat * Math.PI / 180;
            const deltaLat = (dLat - selectedDrone.currentCoords[1]) * Math.PI / 180;
            const deltaLon = (dLon - selectedDrone.currentCoords[0]) * Math.PI / 180;
            const a = Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
                      Math.cos(lat1) * Math.cos(lat2) *
                      Math.sin(deltaLon / 2) * Math.sin(deltaLon / 2);
            const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
            const rangeDist = R * c;

            const tacDistEl = document.getElementById('tac-dist');
            if (tacDistEl) tacDistEl.textContent = `RNG: ${rangeDist.toFixed(1)} KM`;
        }
    } else {
        if (targetPanel) {
            targetPanel.style.display = 'none';
        }
        if (tacPanel) {
            tacPanel.classList.remove('active');
        }
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
    if (selectedDrone) return; // Hide mesh connections when a target is locked
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
function drawBases(time) {
    ctx.font = '9px "Orbitron", sans-serif';
    ctx.fillStyle = '#ffffff';

    // HQ color follows current map filter theme
    const theme = document.documentElement.getAttribute('data-theme') || 'gray';
    const themeColor = {
        gray:  'rgba(220, 220, 220, 0.95)',
        cyan:  'rgba(80, 230, 210, 0.95)',
        green: 'rgba(80, 220, 100, 0.95)',
        real:  'rgba(220, 220, 220, 0.95)'
    }[theme] || 'rgba(220, 220, 220, 0.95)';

    const themeColorFaint = {
        gray:  'rgba(220, 220, 220, 0.5)',
        cyan:  'rgba(80, 230, 210, 0.5)',
        green: 'rgba(80, 220, 100, 0.5)',
        real:  'rgba(220, 220, 220, 0.5)'
    }[theme] || 'rgba(220, 220, 220, 0.5)';

    militaryBases.forEach(base => {
        const screenPos = map.project(base.coords);
        if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;

        ctx.save();

        if (base.isHQ) {
            // ── HQ Marker: static star + solid ring (no pulse) ────────────

            // Outer dashed ring (static)
            ctx.strokeStyle = themeColorFaint;
            ctx.lineWidth = 1.2;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 16, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);

            // Inner solid ring
            ctx.strokeStyle = themeColor;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 7, 0, Math.PI * 2);
            ctx.stroke();

            // 5-point star
            ctx.fillStyle = themeColor;
            ctx.shadowColor = themeColor;
            ctx.shadowBlur = 6;
            ctx.beginPath();
            for (let i = 0; i < 5; i++) {
                const a  = (i * 4 * Math.PI / 5) - Math.PI / 2;
                const ai = a + 2 * Math.PI / 5;
                const ox = screenPos.x + 5 * Math.cos(a);
                const oy = screenPos.y + 5 * Math.sin(a);
                const ix = screenPos.x + 2.2 * Math.cos(ai);
                const iy = screenPos.y + 2.2 * Math.sin(ai);
                i === 0 ? ctx.moveTo(ox, oy) : ctx.lineTo(ox, oy);
                ctx.lineTo(ix, iy);
            }
            ctx.closePath();
            ctx.fill();
            ctx.shadowBlur = 0;

            // HQ label
            ctx.font = 'bold 11px "Courier New", monospace';
            ctx.fillStyle = themeColor;
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;
            ctx.fillText('◈ ' + base.name, screenPos.x + 17, screenPos.y - 4);
            ctx.font = '9px "Courier New", monospace';
            ctx.fillStyle = themeColorFaint;
            ctx.fillText('청주대학교', screenPos.x + 17, screenPos.y + 8);
            ctx.shadowBlur = 0;

        } else {
            // Standard Base Marker: simple crosshair
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 4, 0, Math.PI * 2);
            ctx.moveTo(screenPos.x - 7, screenPos.y);
            ctx.lineTo(screenPos.x + 7, screenPos.y);
            ctx.moveTo(screenPos.x, screenPos.y - 7);
            ctx.lineTo(screenPos.x, screenPos.y + 7);
            ctx.stroke();
            ctx.fillText(base.name, screenPos.x + 10, screenPos.y + 3);
        }

        ctx.restore();
    });
}

// Draw Drones, flight trails, and targets
function drawDrones(time) {
    const currentZoom = map.getZoom();
    drones.forEach(d => {
        if (selectedDrone && selectedDrone.id !== d.id) return; // Hide other aircraft if one is selected
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

            // Aircraft icon at 3D altitude position (rotated vector airplane icon)
            // Adjust heading by map bearing so the nose always points in the correct direction on the map
            const bearing = map.getBearing();
            const headingRad = (d.heading - bearing) * (Math.PI / 180);
            ctx.save();
            ctx.translate(liftX, liftY);
            ctx.rotate(headingRad);
            
            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.65)';
            ctx.fillStyle = isSelected ? 'rgba(255, 255, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)';
            ctx.lineWidth = 1.0;
            
            ctx.beginPath();
            ctx.moveTo(0, -7);
            ctx.lineTo(-1, -4);
            ctx.lineTo(-1, 0);
            ctx.lineTo(-8, 2);
            ctx.lineTo(-8, 3.5);
            ctx.lineTo(-1, 2);
            ctx.lineTo(-1, 5);
            ctx.lineTo(-3.5, 6.5);
            ctx.lineTo(-3.5, 7.5);
            ctx.lineTo(0, 6.5);
            ctx.lineTo(3.5, 7.5);
            ctx.lineTo(3.5, 6.5);
            ctx.lineTo(1, 5);
            ctx.lineTo(1, 2);
            ctx.lineTo(8, 3.5);
            ctx.lineTo(8, 2);
            ctx.lineTo(1, 0);
            ctx.lineTo(1, -4);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();

            // Draw a short heading line extending from the nose
            ctx.strokeStyle = isSelected ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(0, -7);
            ctx.lineTo(0, -17); // 10px heading vector line
            ctx.stroke();

            ctx.restore();

            // Draw a target lock ring indicator if selected
            if (isSelected) {
                ctx.save();
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 1.2;
                ctx.beginPath();
                ctx.arc(liftX, liftY, 11, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }

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
        if (selectedDrone && selectedDrone.id !== v.id) return; // Hide other vessels if one is selected
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
    
    // Calculate the actual center position (lifting by altitude if it is a flying aircraft)
    const altKm = (d.altitude || 0) * 0.0003048;
    const altPx = (d.isVessel || d.isGrounded) ? 0 : altKm * altPxPerKm;
    const targetX = screenPos.x;
    const targetY = screenPos.y - altPx;

    if (targetX < 0 || targetX > canvas.width || targetY < -200 || targetY > canvas.height + 200) return;

    // Draw Lock bracket rings
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    
    // Corners
    const size = 20;
    ctx.beginPath();
    // Top-Left
    ctx.moveTo(targetX - size, targetY - size + 6);
    ctx.lineTo(targetX - size, targetY - size);
    ctx.lineTo(targetX - size + 6, targetY - size);
    // Top-Right
    ctx.moveTo(targetX + size, targetY - size + 6);
    ctx.lineTo(targetX + size, targetY - size);
    ctx.lineTo(targetX + size - 6, targetY - size);
    // Bottom-Left
    ctx.moveTo(targetX - size, targetY + size - 6);
    ctx.lineTo(targetX - size, targetY + size);
    ctx.lineTo(targetX - size + 6, targetY + size);
    // Bottom-Right
    ctx.moveTo(targetX + size, targetY + size - 6);
    ctx.lineTo(targetX + size, targetY + size);
    ctx.lineTo(targetX + size - 6, targetY + size);
    ctx.stroke();

    // Line connect to telemetry
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(targetX + size, targetY);
    ctx.lineTo(targetX + size + 35, targetY - 35);
    ctx.lineTo(targetX + size + 130, targetY - 35);
    ctx.stroke();

    // Mini details
    ctx.font = '9px "Share Tech Mono", monospace';
    ctx.fillStyle = '#ffffff';
    
    if (d.isVessel) {
        ctx.fillText(`LOCK: ACTIVE [NAVAL]`, targetX + size + 40, targetY - 40);
        ctx.fillText(`VESSEL: ${d.id}`, targetX + size + 40, targetY - 30);
        ctx.fillText(`TYPE: ${d.acType || 'N/A'}`, targetX + size + 40, targetY - 20);
        ctx.fillText(`DIM: ${d.registration || 'N/A'}`, targetX + size + 40, targetY - 10);
        ctx.fillText(`DWT: ${d.dwt ? parseInt(d.dwt).toLocaleString() + ' tons' : 'N/A'}`, targetX + size + 40, targetY);
        const vesselKt = (d.velocity / 0.514444).toFixed(1);
        ctx.fillText(`SPEED: ${vesselKt} kt`, targetX + size + 40, targetY + 10);
        ctx.fillText(`LAT: ${d.currentCoords[1].toFixed(4)}°N`, targetX + size + 40, targetY + 20);
        ctx.fillText(`LON: ${d.currentCoords[0].toFixed(4)}°E`, targetX + size + 40, targetY + 30);
    } else {
        ctx.fillText(`LOCK: ACTIVE [AIR]`, targetX + size + 40, targetY - 40);
        ctx.fillText(`FLIGHT: ${d.id}`, targetX + size + 40, targetY - 30);
        ctx.fillText(`TYPE: ${d.acType || 'N/A'} [${d.registration || 'N/A'}]`, targetX + size + 40, targetY - 20);
        ctx.fillText(`ROUTE: ${d.origin || 'N/A'} > ${d.dest || 'N/A'}`, targetX + size + 40, targetY - 10);
        ctx.fillText(`ALTITUDE: ${d.isGrounded ? 'ON GROUND' : d.altitude.toLocaleString() + ' ft'}`, targetX + size + 40, targetY);
        const displayKt = d.speedKnots !== undefined ? Math.round(d.speedKnots) : Math.round(d.velocity / 0.514444);
        ctx.fillText(`SPEED: ${displayKt} kt / ${Math.round(displayKt * 1.15078)} mph`, targetX + size + 40, targetY + 10);
        ctx.fillText(`LAT: ${d.currentCoords[1].toFixed(4)}°N`, targetX + size + 40, targetY + 20);
        ctx.fillText(`LON: ${d.currentCoords[0].toFixed(4)}°E`, targetX + size + 40, targetY + 30);
    }
}



// Draw manual geocode plotter targeting reticle
function drawPlotterTarget(time) {
    if (!plotterState.active || !plotterState.coords) return;
    
    const screenPos = map.project(plotterState.coords);
    if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;

    ctx.save();
    
    // Pulse factor
    const pulse = 0.5 + 0.5 * Math.abs(Math.sin(time * 0.0035));
    
    // Pulsing outer ring (glowing)
    ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
    ctx.shadowBlur = 6;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(screenPos.x, screenPos.y, 5 + pulse * 5, 0, Math.PI * 2);
    ctx.stroke();

    // Solid inner dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(screenPos.x, screenPos.y, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Text label backed by a clean readable box
    ctx.save();
    ctx.font = 'bold 9px "Share Tech Mono", monospace';
    const labelText = `[TARGET] ${plotterState.name}`;
    const textW = ctx.measureText(labelText).width;
    
    const px = screenPos.x + 12;
    const py = screenPos.y - 6;
    
    // Backing box
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.lineWidth = 1;
    ctx.fillRect(px - 4, py - 8, textW + 8, 12);
    ctx.strokeRect(px - 4, py - 8, textW + 8, 12);
    
    // Text
    ctx.fillStyle = '#ffffff';
    ctx.fillText(labelText, px, py + 1);
    ctx.restore();
}

// Draw cargo shipment tracking route, checkpoints, and vehicle
function drawCargoTracking(time) {
    if (!trackingState.active) return;
    
    ctx.save();
    
    const pulse = 0.6 + 0.4 * Math.abs(Math.sin(time * 0.003));
    const rotCW = (time * 0.0008) % (Math.PI * 2);
    
    // 1. Draw highway route if loaded
    if (trackingState.osrmCoords && trackingState.osrmCoords.length > 1) {
        // Find index of current position in road coords to split colors
        const len = trackingState.osrmCoords.length;
        const currentIdx = Math.floor(trackingState.pathProgress * (len - 1));
        
        // Solid white glowing line for traversed route
        ctx.beginPath();
        ctx.lineWidth = 3.0;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
        ctx.shadowColor = 'rgba(255, 255, 255, 0.6)';
        ctx.shadowBlur = 6;
        
        let first = true;
        for (let k = 0; k <= currentIdx; k++) {
            const sp = map.project(trackingState.osrmCoords[k]);
            if (first) { ctx.moveTo(sp.x, sp.y); first = false; }
            else { ctx.lineTo(sp.x, sp.y); }
        }
        if (trackingState.currentPos) {
            const spCurr = map.project(trackingState.currentPos);
            ctx.lineTo(spCurr.x, spCurr.y);
        }
        ctx.stroke();
        
        // Dashed semi-transparent line for remaining route
        ctx.beginPath();
        ctx.lineWidth = 2.0;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.setLineDash([4, 6]);
        ctx.shadowBlur = 0;
        
        if (trackingState.currentPos) {
            const spCurr = map.project(trackingState.currentPos);
            ctx.moveTo(spCurr.x, spCurr.y);
        }
        for (let k = currentIdx + 1; k < len; k++) {
            const sp = map.project(trackingState.osrmCoords[k]);
            ctx.lineTo(sp.x, sp.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
    }
    
    // 2. Draw static route segments between checkpoints (for context)
    ctx.shadowBlur = 0;
    for (let idx = 0; idx < trackingState.routeStages.length - 1; idx++) {
        const startSp = map.project(trackingState.routeStages[idx].coords);
        const endSp = map.project(trackingState.routeStages[idx + 1].coords);
        
        ctx.beginPath();
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = idx < trackingState.activeStageIndex ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.1)';
        ctx.moveTo(startSp.x, startSp.y);
        ctx.lineTo(endSp.x, endSp.y);
        ctx.stroke();
    }
    
    // 3. Draw hub nodes/checkpoints
    trackingState.routeStages.forEach((stage, idx) => {
        const screenPos = map.project(stage.coords);
        if (screenPos.x < 0 || screenPos.x > canvas.width || screenPos.y < 0 || screenPos.y > canvas.height) return;
        
        const isCurrent = idx === trackingState.activeStageIndex;
        const isPast = idx < trackingState.activeStageIndex;
        
        ctx.save();
        if (isCurrent) {
            // Pulsing target hub ring
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 6 + pulse * 6, 0, Math.PI * 2);
            ctx.stroke();
            
            // Solid center
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 4, 0, Math.PI * 2);
            ctx.fill();
        } else if (isPast) {
            // Completed hub: small solid dot
            ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 3, 0, Math.PI * 2);
            ctx.fill();
        } else {
            // Future hub: empty ring
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.arc(screenPos.x, screenPos.y, 4, 0, Math.PI * 2);
            ctx.stroke();
        }
        
        // Hub labels
        ctx.font = '8px "Share Tech Mono", monospace';
        ctx.fillStyle = isCurrent ? '#ffffff' : 'rgba(255, 255, 255, 0.4)';
        
        const label = stage.name.toUpperCase();
        const lblW = ctx.measureText(label).width;
        
        // Draw small label backing
        ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
        ctx.fillRect(screenPos.x - lblW / 2 - 4, screenPos.y - 18, lblW + 8, 10);
        ctx.strokeStyle = isCurrent ? 'rgba(255, 255, 255, 0.4)' : 'rgba(255, 255, 255, 0.15)';
        ctx.strokeRect(screenPos.x - lblW / 2 - 4, screenPos.y - 18, lblW + 8, 10);
        
        ctx.fillStyle = isCurrent ? '#ffffff' : 'rgba(255, 255, 255, 0.55)';
        ctx.fillText(label, screenPos.x - lblW / 2, screenPos.y - 10);
        ctx.restore();
    });
    
    // 4. Draw carrier/vehicle at currentPos
    if (trackingState.currentPos) {
        const vehiclePos = map.project(trackingState.currentPos);
        if (vehiclePos.x >= 0 && vehiclePos.x <= canvas.width && vehiclePos.y >= 0 && vehiclePos.y <= canvas.height) {
            ctx.save();
            ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
            ctx.shadowBlur = 8;
            
            // Rotating brackets around vehicle
            ctx.save();
            ctx.translate(vehiclePos.x, vehiclePos.y);
            ctx.rotate(rotCW);
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.5;
            const vs = 8 + pulse * 2;
            ctx.beginPath();
            // Left Bracket
            ctx.moveTo(-vs + 3, -vs); ctx.lineTo(-vs, -vs); ctx.lineTo(-vs, vs); ctx.lineTo(-vs + 3, vs);
            // Right Bracket
            ctx.moveTo(vs - 3, -vs); ctx.lineTo(vs, -vs); ctx.lineTo(vs, vs); ctx.lineTo(vs - 3, vs);
            ctx.stroke();
            ctx.restore();
            
            // Pulsing dot
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(vehiclePos.x, vehiclePos.y, 3.5, 0, Math.PI * 2);
            ctx.fill();
            
            ctx.restore(); // restore shadow
            
            // 5. Draw vehicle HUD panel
            ctx.save();
            ctx.font = 'bold 9px "Share Tech Mono", monospace';
            
            const vLine1 = `CARRIER: ${trackingState.courier.toUpperCase()}`;
            const vLine2 = `INVOICE: ${trackingState.invoice}`;
            const vLine3 = `STATUS: ${trackingState.status.toUpperCase().replace('_', ' ')}`;
            const vLine4 = `POS: ${trackingState.currentPos[1].toFixed(4)}°N, ${trackingState.currentPos[0].toFixed(4)}°E`;
            
            const w1 = ctx.measureText(vLine1).width;
            const w2 = ctx.measureText(vLine2).width;
            const w3 = ctx.measureText(vLine3).width;
            const w4 = ctx.measureText(vLine4).width;
            
            const panelW = Math.max(w1, w2, w3, w4) + 16;
            const panelH = 50;
            
            const px = vehiclePos.x + 18;
            const py = vehiclePos.y - 25;
            
            // Leader line
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 0.8;
            ctx.beginPath();
            ctx.moveTo(vehiclePos.x + 5, vehiclePos.y);
            ctx.lineTo(px, py + 8);
            ctx.lineTo(px + 5, py + 8);
            ctx.stroke();
            
            // Panel background & outline
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.6)';
            ctx.lineWidth = 1.0;
            ctx.beginPath();
            ctx.rect(px, py, panelW, panelH);
            ctx.fill();
            ctx.stroke();
            
            // Corners ticks
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1.2;
            const ts = 3;
            // Top-left
            ctx.beginPath(); ctx.moveTo(px, py + ts); ctx.lineTo(px, py); ctx.lineTo(px + ts, py); ctx.stroke();
            // Top-right
            ctx.beginPath(); ctx.moveTo(px + panelW, py + ts); ctx.lineTo(px + panelW, py); ctx.lineTo(px + panelW - ts, py); ctx.stroke();
            // Bottom-left
            ctx.beginPath(); ctx.moveTo(px, py + panelH - ts); ctx.lineTo(px, py + panelH); ctx.lineTo(px + ts, py + panelH); ctx.stroke();
            // Bottom-right
            ctx.beginPath(); ctx.moveTo(px + panelW, py + panelH - ts); ctx.lineTo(px + panelW, py + panelH); ctx.lineTo(px + panelW - ts, py + panelH); ctx.stroke();
            
            // Draw texts
            ctx.fillStyle = '#ffffff';
            ctx.fillText(vLine1, px + 8, py + 12);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.8)';
            ctx.fillText(vLine2, px + 8, py + 22);
            ctx.fillText(vLine3, px + 8, py + 32);
            ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
            ctx.fillText(vLine4, px + 8, py + 42);
            
            ctx.restore();
        }
    }
    
    ctx.restore();
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
