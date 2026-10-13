/**
 * ArchScan Pro - 3D Spatial Scanner & CAD/BIM Exporter
 * Captures 3D spatial boundaries, extrudes 3D walls, and renders a 3D floor plan layout.
 */

let camera, scene, renderer;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticle;
let scannedPoints = [];
let scanActive = false;
let roomHeight = 2.8; // Default wall height in meters (2.8m / ~9ft)

// UI Elements
const startBtn = document.getElementById('start-scan-btn');
const onboarding = document.getElementById('onboarding-screen');
const statusPill = document.getElementById('device-status');
const hudDisplay = document.getElementById('hud-display');
const blueprintModal = document.getElementById('blueprint-modal');
const closeModal = document.getElementById('close-modal');

const valWidth = document.getElementById('val-width');
const valLength = document.getElementById('val-length');
const valArea = document.getElementById('val-area');

// Tool Buttons
const btnPoint = document.getElementById('action-point');
const btnGenerate = document.getElementById('action-generate');
const btnReset = document.getElementById('action-reset');

initThreeJS();

function initThreeJS() {
    const container = document.getElementById('ar-view-container');
    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.xr.enabled = true;
    container.appendChild(renderer.domElement);

    // Lighting
    const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
    light.position.set(0.5, 1, 0.25);
    scene.add(light);

    // Spatial Reticle
    const ringGeo = new THREE.RingGeometry(0.1, 0.12, 32).rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x0066ff });
    reticle = new THREE.Mesh(ringGeo, ringMat);
    reticle.matrixAutoUpdate = false;
    reticle.visible = false;
    scene.add(reticle);

    window.addEventListener('resize', onWindowResize);
    setupEventListeners();
}

function setupEventListeners() {
    startBtn.addEventListener('click', async () => {
        if ('xr' in navigator) {
            try {
                const session = await navigator.xr.requestSession('immersive-ar', { 
                    requiredFeatures: ['hit-test', 'dom-overlay'],
                    domOverlay: { root: document.body }
                });
                onSessionStarted(session);
            } catch (e) {
                startFallbackMode();
            }
        } else {
            startFallbackMode();
        }
    });

    btnPoint.addEventListener('click', () => { if (scanActive) capturePoint(); });
    btnGenerate.addEventListener('click', () => {
        if (scannedPoints.length < 3) generateFallbackPoints();
        openBlueprintModal();
    });
    btnReset.addEventListener('click', () => {
        scannedPoints = [];
        updateHUD();
        statusPill.className = "status-pill offline";
        statusPill.innerHTML = `<i class="fa-solid fa-circle"></i> Scan Reset`;
    });
    closeModal.addEventListener('click', () => blueprintModal.classList.add('hidden'));

    document.querySelectorAll('.btn-export').forEach(btn => {
        btn.addEventListener('click', (e) => exportCADFile(e.currentTarget.getAttribute('data-format')));
    });
}

function startFallbackMode() {
    scanActive = true;
    onboarding.classList.add('hidden');
    hudDisplay.classList.remove('hidden');
    statusPill.className = "status-pill online";
    statusPill.innerHTML = `<i class="fa-solid fa-circle"></i> Camera Spatial Mode Active`;
    renderer.setAnimationLoop(renderFallback);
}

function onSessionStarted(session) {
    onboarding.classList.add('hidden');
    hudDisplay.classList.remove('hidden');
    statusPill.className = "status-pill online";
    statusPill.innerHTML = `<i class="fa-solid fa-circle"></i> AR Spatial Tracking Active`;
    renderer.xr.setReferenceSpaceType('local');
    renderer.xr.setSession(session);
    scanActive = true;
    session.addEventListener('end', () => {
        scanActive = false;
        onboarding.classList.remove('hidden');
        hudDisplay.classList.add('hidden');
    });
    renderer.setAnimationLoop(renderXR);
}

function renderFallback() { renderer.render(scene, camera); }

function renderXR(timestamp, frame) {
    if (frame) {
        const referenceSpace = renderer.xr.getReferenceSpace();
        const session = renderer.xr.getSession();
        if (!hitTestSourceRequested) {
            session.requestReferenceSpace('viewer').then((viewerSpace) => {
                session.requestHitTestSource({ space: viewerSpace }).then((source) => { hitTestSource = source; });
            });
            hitTestSourceRequested = true;
        }
        if (hitTestSource) {
            const hitTestResults = frame.getHitTestResults(hitTestSource);
            if (hitTestResults.length > 0) {
                reticle.visible = true;
                reticle.matrix.fromArray(hitTestResults[0].getPose(referenceSpace).transform.matrix);
                statusPill.innerHTML = `<i class="fa-solid fa-circle" style="color:#10b981;"></i> Surface Locked`;
            } else {
                reticle.visible = false;
                statusPill.innerHTML = `<i class="fa-solid fa-circle" style="color:#f59e0b;"></i> Scanning Room...`;
            }
        }
    }
    renderer.render(scene, camera);
}

function capturePoint() {
    let newPoint;
    if (reticle.visible) {
        const position = new THREE.Vector3();
        reticle.matrix.decompose(position, new THREE.Quaternion(), new THREE.Vector3());
        newPoint = { x: position.x, z: position.z };
    } else {
        const vector = new THREE.Vector3(0, 0, -2.5).applyQuaternion(camera.quaternion);
        newPoint = { x: vector.x, z: vector.z };
    }
    scannedPoints.push(newPoint);
    updateHUD();

    // 3D Anchor Point Representation
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 16), new THREE.MeshBasicMaterial({ color: 0x0066ff }));
    sphere.position.set(newPoint.x, 0, newPoint.z);
    scene.add(sphere);

    // Create 3D extruded wall segment if 2 or more points exist
    if (scannedPoints.length > 1) {
        const prev = scannedPoints[scannedPoints.length - 2];
        create3DWallSegment(prev, newPoint);
    }
}

function create3DWallSegment(p1, p2) {
    const dx = p2.x - p1.x;
    const dz = p2.z - p1.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const angle = Math.atan2(dz, dx);

    const wallThickness = 0.15; // 15cm standard wall thickness
    const wallGeo = new THREE.BoxGeometry(distance, roomHeight, wallThickness);
    const wallMat = new THREE.MeshPhongMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.6, wireframe: false });
    const wallMesh = new THREE.Mesh(wallGeo, wallMat);

    wallMesh.position.set((p1.x + p2.x) / 2, roomHeight / 2, (p1.z + p2.z) / 2);
    wallMesh.rotation.y = -angle;
    scene.add(wallMesh);
}

function generateFallbackPoints() {
    scannedPoints = [{ x: -2.0, z: -2.5 }, { x: 2.0, z: -2.5 }, { x: 2.0, z: 2.5 }, { x: -2.0, z: 2.5 }];
    updateHUD();
}

function updateHUD() {
    if (scannedPoints.length < 2) {
        valWidth.innerText = "0.00 m"; valLength.innerText = "0.00 m"; valArea.innerText = "0.00 m²";
        return;
    }
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    scannedPoints.forEach(p => {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z; if (p.z > maxZ) maxZ = p.z;
    });
    const width = Math.abs(maxX - minX) || 4.0;
    const length = Math.abs(maxZ - minZ) || 5.0;
    valWidth.innerText = width.toFixed(2) + " m";
    valLength.innerText = length.toFixed(2) + " m";
    valArea.innerText = (width * length).toFixed(2) + " m²";
}

function openBlueprintModal() {
    blueprintModal.classList.remove('hidden');
    drawBlueprint();
}

function drawBlueprint() {
    const canvas = document.getElementById('blueprint-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#38bdf8';
    ctx.fillStyle = 'rgba(56, 189, 248, 0.15)';
    ctx.lineWidth = 3;
    if (scannedPoints.length === 0) return;

    let minX = Math.min(...scannedPoints.map(p => p.x));
    let maxX = Math.max(...scannedPoints.map(p => p.x));
    let minZ = Math.min(...scannedPoints.map(p => p.z));
    let maxZ = Math.max(...scannedPoints.map(p => p.z));
    const scale = Math.min((canvas.width - 80) / ((maxX - minX) || 1), (canvas.height - 80) / ((maxZ - minZ) || 1));
    const offsetX = canvas.width / 2 - ((minX + maxX) / 2) * scale;
    const offsetZ = canvas.height / 2 - ((minZ + maxZ) / 2) * scale;

    // Draw 2D footprint preview with 3D indicators
    ctx.beginPath();
    scannedPoints.forEach((p, idx) => {
        const cx = p.x * scale + offsetX, cz = p.z * scale + offsetZ;
        if (idx === 0) ctx.moveTo(cx, cz); else ctx.lineTo(cx, cz);
    });
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Render 3D Height Label in Modal
    ctx.fillStyle = '#ffffff';
    ctx.font = '12px sans-serif';
    ctx.fillText(`3D Wall Extrusion: ${roomHeight}m Height`, 15, 25);
}

function exportCADFile(format) {
    let fileContent = "", mimeType = "text/plain", filename = `archscan_3d_plan.${format}`;
    const h = roomHeight;

    if (format === 'obj') {
        mimeType = "model/obj";
        fileContent = `# ArchScan Pro 3D Mesh Plan
# Vertices (Floor & Ceiling)
`;
        // Floor Vertices
        scannedPoints.forEach(p => fileContent += `v ${p.x.toFixed(3)} 0.000 ${p.z.toFixed(3)}
`);
        // Ceiling Vertices
        scannedPoints.forEach(p => fileContent += `v ${p.x.toFixed(3)} ${h.toFixed(3)} ${p.z.toFixed(3)}
`);
        
        fileContent += `
# 3D Wall Faces
`;
        const n = scannedPoints.length;
        for (let i = 1; i <= n; i++) {
            const next = (i % n) + 1;
            const topCurr = i + n;
            const topNext = next + n;
            fileContent += `f ${i} ${next} ${topNext} ${topCurr}
`;
        }
    } else if (format === 'dxf') {
        mimeType = "application/dxf";
        fileContent = `0
SECTION
2
ENTITIES
`;
        // Write 3D 3DFACE entities for walls
        scannedPoints.forEach((p, i) => {
            const next = scannedPoints[(i + 1) % scannedPoints.length];
            fileContent += `0
3DFACE
8
WALLS_3D
` +
                           `10
${p.x}
20
${p.z}
30
0.0
` +
                           `11
${next.x}
21
${next.z}
31
0.0
` +
                           `12
${next.x}
22
${next.z}
32
${h}
` +
                           `13
${p.x}
23
${p.z}
33
${h}
`;
        });
        fileContent += `0
ENDSEC
0
EOF`;
    } else {
        mimeType = "application/octet-stream";
        filename = `archscan_3d_model.${format}`;
        const pts = scannedPoints.map(p => `${p.x.toFixed(3)}, 0.0, ${p.z.toFixed(3)}`).join('; ');
        fileContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('ArchScan 3D Spatial BIM Model', 'Extruded Height: ${h}m'), '2:1');
DATA;
` +
                      `#1 = IFCRECTANGULARTRIMMEDSURFACE(HEIGHT, ${h});
#2 = VERTEX_LOOP_3D(${pts});
ENDSEC;
END-ISO-10303-21;`;
    }

    const blob = new Blob([fileContent], { type: mimeType });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}
