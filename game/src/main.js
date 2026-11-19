// CINDER BAY — an original open-world crime game. All code authored fresh in
// this session for make.fun gta6-01. No GTA assets, names, maps or music.
// three.js r160 (vendored UMD) + plain DOM HUD. No network at runtime.
(function () {
'use strict';
var errBox = document.getElementById('err');
window.addEventListener('error', function (e) {
  errBox.textContent += 'ERR: ' + e.message + ' @' + (e.filename || '') + ':' + (e.lineno || '') + '\n';
});
if (!window.THREE) { errBox.textContent = 'ERR: three.js failed to load'; return; }

// ---------- utils ----------
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function lerp(a, b, t) { return a + (b - a) * t; }
function dist2(ax, az, bx, bz) { var dx = ax - bx, dz = az - bz; return dx * dx + dz * dz; }
function angLerp(a, b, t) {
  var d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
function mulberry(seed) {
  var s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    var t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
var rng = mulberry(20261119);
function pick(arr) { return arr[Math.floor(rng() * arr.length)]; }

// ---------- game state ----------
var SAVE_KEY = 'cinderbay-save-v1';
var S = {
  mode: 'menu', // menu | play | pause | busted | wasted
  health: 100, cash: 0, wanted: 0, wantedTimer: 0, mission: 0,
  inCar: null, // car object or null
  time: 0, kills: 0, carsStolen: 0, muted: false,
  missionStage: 0, // sub-step inside a mission
  missionTimer: 0, bustedTimer: 0, shotCooldown: 0,
  camYaw: 0, camPitch: 0.32, camDist: 9,
  objective: null, // {x,z,label}
  hideout: { x: -150, z: 150 },
};
var MISSIONS = [
  { title: 'MISSION 1 — FIRST WHEELS', pay: 200,
    text: 'Vera needs wheels. Steal ANY car (walk up and press E) then drive to the yellow marker at the docks.',
    hint: 'Parked cars are free. Stealing a driven car raises your wanted level!' },
  { title: 'MISSION 2 — COURIER RUN', pay: 350,
    text: 'Pick up the package at the north market, then deliver it to the lighthouse point. Drive fast, drive clean.',
    hint: 'Follow the yellow beacon. Crashing into police cars raises heat.' },
  { title: 'MISSION 3 — ASHFORD AMBUSH', pay: 500,
    text: 'Rival Ashford gunners hold the old warehouse yard. Get out on foot and take down 3 of them (F or Click to shoot).',
    hint: 'Use cover. They shoot back. Wanted stars rise while you fight.' },
  { title: 'MISSION 4 — THE BAY HEIST', pay: 1000,
    text: 'Grab the cash from the Cinder Bank vault point, then lose the cops and reach the hideout. Finish this and Cinder Bay is yours.',
    hint: 'Grabbing the cash sets 3 wanted stars. Break line of sight to cool down.' },
  { title: 'CINDER BAY IS YOURS', pay: 0,
    text: 'All missions complete. Free-roam Cinder Bay: steal cars, dodge the Bay Police, and stack cash.',
    hint: 'Your progress is saved. Reload any time and Continue.' },
];

// ---------- audio: fully synthesized WebAudio, no files ----------
var AC = null, masterGain = null, engineOsc = null, engineGain = null, musicTimer = null;
function audioInit() {
  if (AC) return;
  try {
    AC = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = AC.createGain(); masterGain.gain.value = 0.5; masterGain.connect(AC.destination);
    engineOsc = AC.createOscillator(); engineOsc.type = 'sawtooth'; engineOsc.frequency.value = 55;
    var filt = AC.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 420;
    engineGain = AC.createGain(); engineGain.gain.value = 0.0;
    engineOsc.connect(filt); filt.connect(engineGain); engineGain.connect(masterGain);
    engineOsc.start();
    startMusic();
  } catch (e) { AC = null; }
}
function beep(freq, dur, type, vol, slideTo) {
  if (!AC || S.muted) return;
  try {
    var o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(freq, AC.currentTime);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, AC.currentTime + dur);
    g.gain.setValueAtTime(vol || 0.2, AC.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, AC.currentTime + dur);
    o.connect(g); g.connect(masterGain); o.start(); o.stop(AC.currentTime + dur + 0.02);
  } catch (e) {}
}
function noiseBurst(dur, vol, freq) {
  if (!AC || S.muted) return;
  try {
    var len = Math.floor(AC.sampleRate * dur), buf = AC.createBuffer(1, len, AC.sampleRate);
    var d = buf.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    var src = AC.createBufferSource(); src.buffer = buf;
    var f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq || 1800;
    var g = AC.createGain(); g.gain.value = vol || 0.4;
    src.connect(f); f.connect(g); g.connect(masterGain); src.start();
  } catch (e) {}
}
function sfx(name) {
  if (!AC) return;
  if (name === 'shot') { noiseBurst(0.14, 0.5, 2600); beep(160, 0.08, 'square', 0.25, 60); }
  else if (name === 'hit') { noiseBurst(0.1, 0.3, 900); }
  else if (name === 'cash') { beep(880, 0.12, 'sine', 0.25); setTimeout(function () { beep(1320, 0.2, 'sine', 0.25); }, 110); }
  else if (name === 'steal') { beep(300, 0.15, 'sawtooth', 0.2, 520); }
  else if (name === 'busted') { beep(220, 0.5, 'sawtooth', 0.3, 110); }
  else if (name === 'hurt') { beep(140, 0.18, 'sawtooth', 0.3, 70); }
  else if (name === 'pickup') { beep(660, 0.1, 'sine', 0.22); setTimeout(function () { beep(990, 0.14, 'sine', 0.22); }, 90); }
}
function sirenTick() {
  if (!AC || S.muted || S.wanted === 0) return;
  var t = S.time % 1.2;
  beep(t < 0.6 ? 720 : 540, 0.5, 'sine', 0.05);
}
// Simple noir bass loop: minor-key walking bass, scheduled per bar.
var BASS = [55, 55, 65.41, 49, 55, 55, 82.41, 73.42];
function startMusic() {
  if (musicTimer) return;
  var step = 0;
  musicTimer = setInterval(function () {
    if (!AC || S.muted || S.mode !== 'play') return;
    var f = BASS[step % BASS.length];
    beep(f, 0.42, 'triangle', 0.12);
    if (step % 4 === 0) beep(f * 2, 0.2, 'sine', 0.05);
    step++;
  }, 430);
}

// ---------- three.js scene ----------
var canvas = document.getElementById('c');
var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
var scene = new THREE.Scene();
scene.background = new THREE.Color(0x87a8c8);
scene.fog = new THREE.Fog(0x87a8c8, 180, 520);
var camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 900);
camera.position.set(0, 12, 20);
var hemi = new THREE.HemisphereLight(0xcfe8ff, 0x3a2f26, 0.9); scene.add(hemi);
var sun = new THREE.DirectionalLight(0xffe6b8, 1.6);
sun.position.set(120, 180, 60); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -220; sun.shadow.camera.right = 220;
sun.shadow.camera.top = 220; sun.shadow.camera.bottom = -220;
sun.shadow.camera.far = 500;
scene.add(sun);

var CITY = 400; // city spans -200..200
var buildings = []; // {minX,maxX,minZ,maxZ,h}
var roads = []; // road centre lines for traffic/peds

function box(w, h, d, color, x, y, z, opts) {
  var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color: color, roughness: 0.85, metalness: 0.05 }));
  m.position.set(x, y, z);
  if (opts && opts.shadow !== false) { m.castShadow = true; m.receiveShadow = true; }
  scene.add(m); return m;
}
function cyl(rt, rb, h, color, x, y, z, seg) {
  var m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg || 12),
    new THREE.MeshStandardMaterial({ color: color, roughness: 0.7 }));
  m.position.set(x, y, z); m.castShadow = true; scene.add(m); return m;
}

// Ground: grass/ash plain + bay water on the west edge.
var ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900),
  new THREE.MeshStandardMaterial({ color: 0x5d7a4a, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);
var water = new THREE.Mesh(new THREE.PlaneGeometry(260, 900),
  new THREE.MeshStandardMaterial({ color: 0x1c5f7a, roughness: 0.25, metalness: 0.4 }));
water.rotation.x = -Math.PI / 2; water.position.set(-330, 0.05, 0); scene.add(water);
// Beach strip
var beach = new THREE.Mesh(new THREE.PlaneGeometry(36, 900),
  new THREE.MeshStandardMaterial({ color: 0xc9b083, roughness: 1 }));
beach.rotation.x = -Math.PI / 2; beach.position.set(-212, 0.06, 0); scene.add(beach);


// ---------- city: roads on a grid, buildings as InstancedMesh per the
// procedural-buildings playbook (merged/instanced per material slot) ----------
var ROAD = 40, HALF = 200;
var roadMat = new THREE.MeshStandardMaterial({ color: 0x2e2e33, roughness: 0.95 });
var paveMat = new THREE.MeshStandardMaterial({ color: 0x8a8a86, roughness: 1 });
for (var gx = -HALF; gx <= HALF; gx += ROAD) {
  var rv = new THREE.Mesh(new THREE.PlaneGeometry(14, CITY + 40), roadMat);
  rv.rotation.x = -Math.PI / 2; rv.position.set(gx, 0.08, 0); rv.receiveShadow = true; scene.add(rv);
  var rh = new THREE.Mesh(new THREE.PlaneGeometry(CITY + 40, 14), roadMat);
  rh.rotation.x = -Math.PI / 2; rh.position.set(0, 0.08, gx); rh.receiveShadow = true; scene.add(rh);
  roads.push({ x: gx, vertical: true }); roads.push({ z: gx, vertical: false });
  // centre dashes
  for (var d = -HALF + 10; d < HALF; d += 20) {
    var dash = new THREE.Mesh(new THREE.PlaneGeometry(0.7, 4),
      new THREE.MeshBasicMaterial({ color: 0xd8c95a }));
    dash.rotation.x = -Math.PI / 2; dash.position.set(gx, 0.1, d); scene.add(dash);
    var dash2 = dash.clone(); dash2.position.set(d, 0.1, gx); dash2.rotation.z = Math.PI / 2; scene.add(dash2);
  }
}
// sidewalks around each block
for (var bx = -HALF + ROAD / 2; bx < HALF; bx += ROAD) {
  for (var bz = -HALF + ROAD / 2; bz < HALF; bz += ROAD) {
    var sw = new THREE.Mesh(new THREE.PlaneGeometry(26, 26), paveMat);
    sw.rotation.x = -Math.PI / 2; sw.position.set(bx, 0.07, bz); sw.receiveShadow = true; scene.add(sw);
  }
}
// Buildings: one InstancedMesh, deterministic seeded layout, heights by district.
var PALETTE = [0x9a7b5f, 0x7d8aa0, 0xa08a6a, 0x6a7a8a, 0xb08a7a, 0x8a6a7a, 0x5f6a7a, 0xc0a080];
var spots = [];
for (var ix = -HALF + ROAD / 2; ix < HALF; ix += ROAD) {
  for (var iz = -HALF + ROAD / 2; iz < HALF; iz += ROAD) {
    if (Math.abs(ix) < 30 && Math.abs(iz) < 30) continue; // central plaza
    if (ix === -150 && iz === 150) continue; // hideout lot
    if (ix === 150 && iz === -150) continue; // warehouse yard (mission 3)
    if (rng() < 0.12) continue; // empty lots / parks
    var distC = Math.sqrt(ix * ix + iz * iz);
    var h = distC < 90 ? 18 + rng() * 34 : 7 + rng() * 14;
    var w = 14 + rng() * 8, d = 14 + rng() * 8;
    spots.push({ x: ix + (rng() - 0.5) * 4, z: iz + (rng() - 0.5) * 4, w: w, d: d, h: h });
    buildings.push({ minX: ix - w / 2 - 1, maxX: ix + w / 2 + 1, minZ: iz - d / 2 - 1, maxZ: iz + d / 2 + 1, h: h });
  }
}
var bGeo = new THREE.BoxGeometry(1, 1, 1);
bGeo.translate(0, 0.5, 0);
var bMat = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0.05 });
var bMesh = new THREE.InstancedMesh(bGeo, bMat, spots.length);
var dummy = new THREE.Object3D(); var tmpColor = new THREE.Color();
spots.forEach(function (s, i) {
  dummy.position.set(s.x, 0, s.z); dummy.scale.set(s.w, s.h, s.d); dummy.updateMatrix();
  bMesh.setMatrixAt(i, dummy.matrix);
  tmpColor.setHex(pick(PALETTE)); bMesh.setColorAt(i, tmpColor);
});
bMesh.castShadow = true; bMesh.receiveShadow = true; bMesh.instanceMatrix.needsUpdate = true;
scene.add(bMesh);
// Window strips: a second InstancedMesh of small glowing planes on facades.
var winGeo = new THREE.PlaneGeometry(1.6, 1.1);
var winMat = new THREE.MeshBasicMaterial({ color: 0xffe9a8 });
var winCount = spots.length * 6;
var wMesh = new THREE.InstancedMesh(winGeo, winMat, winCount);
var wi = 0;
spots.forEach(function (s) {
  for (var k = 0; k < 6; k++) {
    var face = (k % 2 === 0) ? 1 : -1;
    dummy.position.set(s.x + (k % 3 - 1) * s.w * 0.28, 3 + Math.floor(k / 2) * (s.h / 3.2), s.z + face * (s.d / 2 + 0.06));
    dummy.rotation.set(0, face > 0 ? 0 : Math.PI, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    wMesh.setMatrixAt(wi++, dummy.matrix);
  }
});
wMesh.count = wi; scene.add(wMesh);
// Landmarks: Cinder Tower (downtown), lighthouse (north-west shore), bank, warehouse.
var tower = box(16, 90, 16, 0x3a4a5a, 0, 45, 0); box(20, 4, 20, 0xff5a2a, 0, 92, 0);
buildings.push({ minX: -9, maxX: 9, minZ: -9, maxZ: 9, h: 94 });
var light = cyl(2.2, 3, 34, 0xf2f2e8, -185, 17, -170, 10); cyl(3, 3, 3, 0xd23c2a, -185, 35, -170, 10);
var bank = box(22, 12, 16, 0xb8a888, 60, 6, -60); box(24, 1.5, 18, 0x6a5a3a, 60, 12.5, -60);
buildings.push({ minX: 48, maxX: 72, minZ: -69, maxZ: -51, h: 13 });
var ware = box(26, 9, 18, 0x7a5a3a, 150, 4.5, -150);
buildings.push({ minX: 136, maxX: 164, minZ: -160, maxZ: -140, h: 10 });
// Hideout: small garage + neon sign at (-150,150)
box(12, 5, 9, 0x4a5a6a, -150, 2.5, 150);
buildings.push({ minX: -157, maxX: -143, minZ: 145, maxZ: 155, h: 6 });
var sign = box(10, 2, 0.6, 0xff2a7a, -150, 6.5, 150); sign.material = new THREE.MeshBasicMaterial({ color: 0xff2a7a });
// Central plaza fountain + trees (InstancedMesh trunks + canopies)
cyl(8, 9, 1.2, 0x8aa8c8, 0, 0.6, 0, 20); cyl(1, 2, 5, 0x6a8ab8, 0, 3, 0, 10);
var treeSpots = [];
for (var ti = 0; ti < 60; ti++) {
  treeSpots.push({ x: -190 + rng() * 380, z: -190 + rng() * 380 });
}
var trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.4, 2.4, 6),
  new THREE.MeshStandardMaterial({ color: 0x5a4028 }), treeSpots.length);
var canopy = new THREE.InstancedMesh(new THREE.SphereGeometry(1.6, 8, 6),
  new THREE.MeshStandardMaterial({ color: 0x3f6a2f, roughness: 1 }), treeSpots.length);
treeSpots.forEach(function (t, i) {
  dummy.position.set(t.x, 1.2, t.z); dummy.scale.set(1, 1, 1); dummy.rotation.set(0, 0, 0); dummy.updateMatrix();
  trunk.setMatrixAt(i, dummy.matrix);
  dummy.position.set(t.x, 3.4, t.z); dummy.updateMatrix();
  canopy.setMatrixAt(i, dummy.matrix);
});
trunk.castShadow = true; canopy.castShadow = true; scene.add(trunk); scene.add(canopy);
// Street lamps along roads
var lampGeo = new THREE.CylinderGeometry(0.12, 0.12, 6, 6);
var lampMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
var lamps = new THREE.InstancedMesh(lampGeo, lampMat, 80);
var li = 0;
for (var lx = -180; lx <= 180 && li < 80; lx += 40) {
  for (var lz of [-180, -100, -20, 60, 140]) {
    if (li >= 80) break;
    dummy.position.set(lx + 8, 3, lz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
    lamps.setMatrixAt(li++, dummy.matrix);
  }
}
lamps.count = li; scene.add(lamps);

// ---------- cars ----------
var CAR_COLORS = [0xc23b2a, 0x2a6ac2, 0xd8c832, 0x3aa84a, 0x8a8a8a, 0x222222, 0xe8e8e8, 0x7a3aa8, 0x2aa8a8];
function makeCar(color, isPolice) {
  var g = new THREE.Group();
  var bodyMat = new THREE.MeshStandardMaterial({ color: color, roughness: 0.35, metalness: 0.5 });
  var body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.7, 4.4), bodyMat);
  body.position.y = 0.65; body.castShadow = true; g.add(body);
  var cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.65, 2.2),
    new THREE.MeshStandardMaterial({ color: isPolice ? 0xffffff : 0x18222e, roughness: 0.15, metalness: 0.6 }));
  cabin.position.set(0, 1.3, -0.2); cabin.castShadow = true; g.add(cabin);
  var wheelGeo = new THREE.CylinderGeometry(0.38, 0.38, 0.3, 10);
  var wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
  var wheels = [];
  [[-0.95, 1.45], [0.95, 1.45], [-0.95, -1.45], [0.95, -1.45]].forEach(function (p) {
    var w = new THREE.Mesh(wheelGeo, wheelMat);
    w.rotation.z = Math.PI / 2; w.position.set(p[0], 0.38, p[1]); g.add(w); wheels.push(w);
  });
  var hl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xfff2b0 }));
  hl.position.set(0, 0.7, 2.21); g.add(hl);
  var tl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.1),
    new THREE.MeshBasicMaterial({ color: 0xff2222 }));
  tl.position.set(0, 0.7, -2.21); g.add(tl);
  var lightbar = null;
  if (isPolice) {
    lightbar = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.22, 0.5),
      new THREE.MeshBasicMaterial({ color: 0x2244ff }));
    lightbar.position.set(0, 1.75, -0.2); g.add(lightbar);
  }
  scene.add(g);
  return { group: g, wheels: wheels, lightbar: lightbar, speed: 0, steer: 0, yaw: 0,
    x: 0, z: 0, driven: false, parked: true, color: color, isPolice: !!isPolice, hp: 100 };
}
function placeCar(car, x, z, yaw) {
  car.x = x; car.z = z; car.yaw = yaw || 0;
  car.group.position.set(x, 0, z); car.group.rotation.y = car.yaw;
}
// Traffic cars drive road loops; parked cars wait to be stolen.
var traffic = [], parked = [], police = [];
for (var ci = 0; ci < 10; ci++) {
  var tc = makeCar(pick(CAR_COLORS), false);
  var vertical = rng() < 0.5;
  var lane = (Math.floor(rng() * 10) - 5) * ROAD;
  tc.parked = false; tc.driven = true;
  tc.roadVertical = vertical; tc.roadLine = lane; tc.roadDir = rng() < 0.5 ? 1 : -1;
  tc.roadPos = -180 + rng() * 360; tc.cruise = 7 + rng() * 4;
  traffic.push(tc);
}
for (var pi = 0; pi < 12; pi++) {
  var pc = makeCar(pick(CAR_COLORS), false);
  pc.parked = true;
  var px = (Math.floor(rng() * 9) - 4) * ROAD + (rng() < 0.5 ? 9 : -9);
  var pz = -180 + rng() * 360;
  placeCar(pc, px, pz, (rng() < 0.5 ? 0 : Math.PI / 2) + (rng() - 0.5) * 0.2);
  parked.push(pc);
}
// Player starts on foot near the docks plaza.
var player = (function () {
  var g = new THREE.Group();
  var torso = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4),
    new THREE.MeshStandardMaterial({ color: 0x2a4a6a, roughness: 0.8 }));
  torso.position.y = 1.05; torso.castShadow = true; g.add(torso);
  var head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 10),
    new THREE.MeshStandardMaterial({ color: 0xc89878, roughness: 0.7 }));
  head.position.y = 1.75; head.castShadow = true; g.add(head);
  var legL = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.7, 0.3),
    new THREE.MeshStandardMaterial({ color: 0x222831 }));
  legL.position.set(-0.18, 0.35, 0); g.add(legL);
  var legR = legL.clone(); legR.position.x = 0.18; g.add(legR);
  var gun = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.12, 0.55),
    new THREE.MeshStandardMaterial({ color: 0x111111 }));
  gun.position.set(0.4, 1.2, 0.3); g.add(gun);
  scene.add(g);
  return { group: g, legs: [legL, legR], x: 20, z: 40, yaw: 0, speed: 0, walkPhase: 0 };
})();
player.group.position.set(player.x, 0, player.z);

// ---------- pedestrians & enemies ----------
function makePed(color) {
  var g = new THREE.Group();
  var shirt = new THREE.Mesh(new THREE.BoxGeometry(0.65, 0.85, 0.38),
    new THREE.MeshStandardMaterial({ color: color, roughness: 0.85 }));
  shirt.position.y = 1.0; shirt.castShadow = true; g.add(shirt);
  var head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xd8a888, roughness: 0.7 }));
  head.position.y = 1.68; g.add(head);
  var leg = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.65, 0.28),
    new THREE.MeshStandardMaterial({ color: 0x333333 }));
  leg.position.y = 0.32; g.add(leg);
  scene.add(g);
  return { group: g, x: 0, z: 0, yaw: rng() * Math.PI * 2, speed: 1 + rng() * 0.8,
    dir: rng() < 0.5 ? 1 : -1, roadLine: 0, vertical: rng() < 0.5, alive: true, hp: 30, isEnemy: false };
}
var peds = [];
for (var pd = 0; pd < 16; pd++) {
  var p = makePed(pick([0xd84a4a, 0x4ad8a8, 0xd8c84a, 0x8a6ad8, 0xe8e8e8, 0x4a8ad8]));
  p.x = -180 + rng() * 360; p.z = -180 + rng() * 360;
  p.roadLine = Math.round(p.x / ROAD) * ROAD; peds.push(p);
}
var enemies = [];
function spawnEnemies(x, z, n) {
  enemies.forEach(function (e) { scene.remove(e.group); });
  enemies = [];
  for (var i = 0; i < n; i++) {
    var e = makePed(0x8a1a1a);
    e.isEnemy = true; e.hp = 60; e.alive = true;
    e.x = x + (rng() - 0.5) * 24; e.z = z + (rng() - 0.5) * 24;
    e.group.position.set(e.x, 0, e.z);
    // red bandana marker
    var band = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.12, 0.42),
      new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    band.position.y = 1.85; e.group.add(band);
    enemies.push(e);
  }
}
// Mission beacon: glowing pillar + ring at the objective.
var beacon = cyl(2.2, 2.2, 40, 0xffd23f, 0, 20, 0, 16);
beacon.material = new THREE.MeshBasicMaterial({ color: 0xffd23f, transparent: true, opacity: 0.35 });
var beaconRing = new THREE.Mesh(new THREE.TorusGeometry(3, 0.25, 8, 24),
  new THREE.MeshBasicMaterial({ color: 0xffd23f }));
beaconRing.rotation.x = Math.PI / 2; beaconRing.position.y = 0.3; scene.add(beaconRing);
function setObjective(x, z, label) {
  S.objective = { x: x, z: z, label: label };
  beacon.position.set(x, 20, z); beaconRing.position.set(x, 0.3, z);
  beacon.visible = true; beaconRing.visible = true;
}
function clearObjective() { S.objective = null; beacon.visible = false; beaconRing.visible = false; }
clearObjective();


// ---------- input ----------
var keys = {};
window.addEventListener('keydown', function (e) {
  keys[e.code] = true;
  if (e.code === 'KeyM') { S.muted = !S.muted; if (masterGain) masterGain.gain.value = S.muted ? 0 : 0.5; toast(S.muted ? 'Sound muted' : 'Sound on'); }
  if (e.code === 'KeyP' || e.code === 'Escape') {
    if (S.mode === 'play') pauseGame(); else if (S.mode === 'pause') resumeGame();
  }
  if (e.code === 'KeyE' && S.mode === 'play') tryEnterExitCar();
  if (e.code === 'KeyF' && S.mode === 'play') shoot();
  if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.code) >= 0) e.preventDefault();
});
window.addEventListener('keyup', function (e) { keys[e.code] = false; });
canvas.addEventListener('mousedown', function () { if (S.mode === 'play') shoot(); });
var dragX = null;
canvas.addEventListener('mousedown', function (e) { dragX = e.clientX; });
window.addEventListener('mousemove', function (e) {
  if (dragX !== null) { S.camYaw -= (e.clientX - dragX) * 0.005; dragX = e.clientX; }
});
window.addEventListener('mouseup', function () { dragX = null; });
window.addEventListener('resize', function () {
  camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- collision: circle vs building AABBs ----------
function collideCircle(x, z, r) {
  for (var i = 0; i < buildings.length; i++) {
    var b = buildings[i];
    if (x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r) {
      var dxl = x - (b.minX - r), dxr = (b.maxX + r) - x;
      var dzl = z - (b.minZ - r), dzr = (b.maxZ + r) - z;
      var m = Math.min(dxl, dxr, dzl, dzr);
      if (m === dxl) x = b.minX - r; else if (m === dxr) x = b.maxX + r;
      else if (m === dzl) z = b.minZ - r; else z = b.maxZ + r;
    }
  }
  x = clamp(x, -198, 198); z = clamp(z, -198, 198);
  return { x: x, z: z };
}
function nearestCar(maxD) {
  var best = null, bd = maxD * maxD;
  var all = parked.concat(traffic);
  for (var i = 0; i < all.length; i++) {
    var c = all[i];
    var d = dist2(player.x, player.z, c.x, c.z);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}
function tryEnterExitCar() {
  if (S.inCar) {
    var car = S.inCar; S.inCar = null;
    player.x = car.x + Math.sin(car.yaw + Math.PI / 2) * 2.5;
    player.z = car.z + Math.cos(car.yaw + Math.PI / 2) * 2.5;
    player.group.visible = true; car.driven = false;
    toast('You left the car'); return;
  }
  var c = nearestCar(4.5);
  if (!c) { toast('No car nearby — find a parked car'); return; }
  S.inCar = c; c.driven = true; c.parked = false;
  player.group.visible = false;
  var idx = parked.indexOf(c); if (idx >= 0) parked.splice(idx, 1);
  if (c.roadVertical !== undefined && traffic.indexOf(c) < 0) { /* driven traffic car stays in traffic list */ }
  S.carsStolen++;
  sfx('steal');
  if (traffic.indexOf(c) >= 0) { addWanted(1); toast('CAR STOLEN! The Bay Police are onto you'); }
  else toast('Car taken — drive to the marker');
  saveGame();
}
function addWanted(n) {
  S.wanted = clamp(S.wanted + n, 0, 5);
  S.wantedTimer = 0;
  if (S.wanted > 0 && police.length < S.wanted * 2) spawnPolice();
}
function spawnPolice() {
  while (police.length < S.wanted * 2 + 1) {
    var pc = makeCar(0xffffff, true);
    var a = rng() * Math.PI * 2;
    placeCar(pc, player.x + Math.sin(a) * 45, player.z + Math.cos(a) * 45, a);
    pc.parked = false; pc.driven = true; police.push(pc);
  }
}
function removePolice() {
  police.forEach(function (p) { scene.remove(p.group); });
  police = [];
}

// ---------- combat ----------
var tracers = [];
function shoot() {
  if (S.shotCooldown > 0 || S.mode !== 'play') return;
  S.shotCooldown = 0.28;
  sfx('shot');
  var ox, oz, yaw;
  if (S.inCar) { ox = S.inCar.x; oz = S.inCar.z; yaw = S.inCar.yaw; }
  else { ox = player.x; oz = player.z; yaw = player.yaw; }
  var fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  // tracer
  var geo = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(ox, 1.4, oz), new THREE.Vector3(ox + fx * 26, 1.4, oz + fz * 26)]);
  var line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe27a }));
  scene.add(line); tracers.push({ line: line, t: 0.09 });
  // targets: enemies first, then police on foot range, then peds (crime!)
  var targets = enemies.concat(peds.filter(function (p) { return p.alive; }));
  var best = null, bd = 1e9;
  targets.forEach(function (t) {
    var dx = t.x - ox, dz = t.z - oz, d = Math.sqrt(dx * dx + dz * dz);
    if (d > 34) return;
    var dot = (dx * fx + dz * fz) / (d || 1);
    if (dot < 0.55) return;
    if (d < bd) { bd = d; best = t; }
  });
  if (best) {
    best.hp -= 34; sfx('hit');
    if (best.hp <= 0 && best.alive) {
      best.alive = false; best.group.visible = false;
      if (best.isEnemy) { S.kills++; toast('Rival down — ' + S.kills + ' / 3'); }
      else { addWanted(1); toast('You hit a civilian! Wanted level up'); }
    }
  } else if (!S.inCar) {
    // firing a gun in public draws heat slowly
    if (rng() < 0.25) addWanted(1);
  }
  // shooting from a car at police cars damages nearest police car
  if (S.inCar) {
    police.forEach(function (p) {
      var d = Math.sqrt(dist2(ox, oz, p.x, p.z));
      if (d < 30) { p.hp -= 20; if (p.hp <= 0) { scene.remove(p.group); police.splice(police.indexOf(p), 1); } }
    });
  }
}

// ---------- missions ----------
var missionState = { pickedUp: false, grabbed: false };
function missionText() {
  var m = MISSIONS[Math.min(S.mission, MISSIONS.length - 1)];
  document.getElementById('mtitle').textContent = m.title;
  document.getElementById('mtext').textContent = m.text;
  document.getElementById('hint').textContent = m.hint + '  ·  Payout $' + m.pay;
}
function startMission(i) {
  S.mission = i; S.missionStage = 0; missionState = { pickedUp: false, grabbed: false };
  if (i === 0) setObjective(160, 160, 'Docks');
  else if (i === 1) setObjective(-160, -160, 'Market pickup');
  else if (i === 2) { setObjective(150, -150, 'Warehouse yard'); spawnEnemies(150, -150, 3); S.kills = 0; }
  else if (i === 3) setObjective(60, -60, 'Cinder Bank');
  else { clearObjective(); }
  missionText(); saveGame();
}
function completeMission() {
  var m = MISSIONS[S.mission];
  S.cash += m.pay; sfx('cash');
  toast('MISSION COMPLETE — +$' + m.pay);
  S.mission++;
  if (S.mission >= 4) { S.wanted = 0; removePolice(); }
  setTimeout(function () { if (S.mode === 'play') startMission(S.mission); }, 1200);
  saveGame();
}
function updateMissions(dt) {
  if (!S.objective || S.mission >= 4) return;
  var px = S.inCar ? S.inCar.x : player.x, pz = S.inCar ? S.inCar.z : player.z;
  var d = Math.sqrt(dist2(px, pz, S.objective.x, S.objective.z));
  document.getElementById('objdist').textContent = S.objective.label + ' — ' + Math.round(d) + 'm away';
  if (d > 7) return;
  if (S.mission === 0) { if (S.inCar) completeMission(); else toast('You need a car for this job!'); }
  else if (S.mission === 1) {
    if (!missionState.pickedUp) { missionState.pickedUp = true; sfx('pickup'); setObjective(120, 140, 'Lighthouse drop'); toast('Package collected — deliver it south'); }
    else completeMission();
  } else if (S.mission === 2) {
    if (S.kills >= 3) completeMission(); else toast('Take down ' + (3 - S.kills) + ' more Ashford gunners');
  } else if (S.mission === 3) {
    if (!missionState.grabbed) { missionState.grabbed = true; S.cash += 0; sfx('pickup'); addWanted(3); setObjective(S.hideout.x, S.hideout.z, 'Hideout — lose the cops'); toast('CASH GRABBED! 3 stars — get to the hideout!'); }
    else if (S.wanted <= 1) completeMission();
    else toast('Lose the heat first — wanted ' + S.wanted + '★');
  }
}

// ---------- HUD / minimap ----------
var mm = document.getElementById('minimap').getContext('2d');
function updateHUD() {
  document.getElementById('stars').textContent = '★'.repeat(S.wanted) + '☆'.repeat(5 - S.wanted);
  document.getElementById('cash').textContent = '$' + S.cash.toLocaleString();
  document.getElementById('healthbar').style.width = clamp(S.health, 0, 100) + '%';
  document.getElementById('speed').textContent = S.inCar ? Math.round(Math.abs(S.inCar.speed) * 3.6) + ' km/h' : 'ON FOOT';
  // minimap
  mm.clearRect(0, 0, 170, 170);
  mm.save(); mm.beginPath(); mm.arc(85, 85, 83, 0, Math.PI * 2); mm.clip();
  mm.fillStyle = '#12202e'; mm.fillRect(0, 0, 170, 170);
  var sc = 170 / 420;
  mm.strokeStyle = '#3a4a5a'; mm.lineWidth = 5;
  for (var i = -200; i <= 200; i += 40) {
    mm.beginPath(); mm.moveTo((i + 210) * sc, 0); mm.lineTo((i + 210) * sc, 170); mm.stroke();
    mm.beginPath(); mm.moveTo(0, (i + 210) * sc); mm.lineTo(170, (i + 210) * sc); mm.stroke();
  }
  mm.fillStyle = '#2a6a8a'; mm.fillRect(0, 0, 14, 170); // bay water west
  if (S.objective) {
    mm.fillStyle = '#ffd23f'; mm.beginPath();
    mm.arc((S.objective.x + 210) * sc, (S.objective.z + 210) * sc, 6, 0, Math.PI * 2); mm.fill();
  }
  police.forEach(function (p) { mm.fillStyle = '#4488ff'; mm.fillRect((p.x + 210) * sc - 3, (p.z + 210) * sc - 3, 6, 6); });
  var px = S.inCar ? S.inCar.x : player.x, pz = S.inCar ? S.inCar.z : player.z;
  mm.fillStyle = '#fff'; mm.beginPath(); mm.arc((px + 210) * sc, (pz + 210) * sc, 5, 0, Math.PI * 2); mm.fill();
  mm.strokeStyle = '#ff5a2a'; mm.lineWidth = 2; mm.stroke();
  mm.restore();
}
var toastTimer = null;
function toast(msg) {
  var t = document.getElementById('toast'); t.textContent = msg;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.textContent = ''; }, 2600);
}

// ---------- save / load ----------
function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      cash: S.cash, health: S.health, mission: S.mission, wanted: S.wanted,
      x: S.inCar ? S.inCar.x : player.x, z: S.inCar ? S.inCar.z : player.z,
      kills: S.kills, carsStolen: S.carsStolen, time: Date.now()
    }));
  } catch (e) {}
}
function loadSave() {
  try {
    var raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}

// ---------- screens ----------
function show(id) { document.getElementById(id).classList.remove('hidden'); }
function hide(id) { document.getElementById(id).classList.add('hidden'); }
function startGame(fresh) {
  audioInit();
  if (AC && AC.state === 'suspended') AC.resume();
  var save = fresh ? null : loadSave();
  if (save) {
    S.cash = save.cash || 0; S.health = save.health || 100; S.wanted = 0;
    player.x = save.x || 20; player.z = save.z || 40;
    player.group.position.set(player.x, 0, player.z);
    startMission(Math.min(save.mission || 0, 4));
  } else {
    S.cash = 0; S.health = 100; S.wanted = 0; S.kills = 0; S.carsStolen = 0;
    player.x = 20; player.z = 40; player.group.position.set(20, 0, 40);
    startMission(0);
  }
  S.mode = 'play'; hide('start'); hide('end'); hide('pause'); show('hud');
  missionText(); toast('Welcome to Cinder Bay, Dax');
}
function pauseGame() { S.mode = 'pause'; show('pause'); }
function resumeGame() { S.mode = 'play'; hide('pause'); }
function endGame(kind) {
  S.mode = kind; hide('hud');
  document.getElementById('endTitle').textContent = kind === 'busted' ? 'BUSTED' : 'WASTED';
  document.getElementById('endTitle').id = 'endTitle';
  document.getElementById('endText').textContent = kind === 'busted'
    ? 'The Bay Police caught Dax Mercer. You lost $' + Math.min(150, S.cash) + ' in fines — but the story continues.'
    : 'Dax Mercer went down in Cinder Bay. The crew will patch you up — try again.';
  if (kind === 'busted') { S.cash = Math.max(0, S.cash - 150); }
  show('end'); sfx('busted');
  if (S.inCar) { S.inCar.driven = false; S.inCar = null; player.group.visible = true; }
  removePolice();
}
document.getElementById('btnStart').addEventListener('click', function () { startGame(true); });
document.getElementById('btnContinue').addEventListener('click', function () { startGame(false); });
document.getElementById('btnResume').addEventListener('click', resumeGame);
document.getElementById('btnRestart').addEventListener('click', function () { hide('pause'); startGame(true); });
document.getElementById('btnRetry').addEventListener('click', function () {
  S.health = 100; S.wanted = 0; player.x = 20; player.z = 40;
  player.group.position.set(20, 0, 40); hide('end'); show('hud'); S.mode = 'play';
  startMission(S.mission); saveGame();
});
document.getElementById('btnMenu').addEventListener('click', function () {
  hide('end'); hide('hud'); S.mode = 'menu'; show('start'); refreshContinue();
});
function refreshContinue() {
  var sv = loadSave();
  if (sv) document.getElementById('btnContinue').classList.remove('hidden');
}
refreshContinue();


// ---------- per-frame updates ----------
function updatePlayer(dt) {
  var sprint = keys['ShiftLeft'] || keys['ShiftRight'];
  var sp = sprint ? 7.5 : 4.2;
  var f = (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0) - (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
  var r = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
  if (f !== 0 || r !== 0) {
    var mx = -Math.sin(S.camYaw) * f + Math.cos(S.camYaw) * r;
    var mz = -Math.cos(S.camYaw) * f - Math.sin(S.camYaw) * r;
    var len = Math.sqrt(mx * mx + mz * mz); mx /= len; mz /= len;
    player.yaw = Math.atan2(mx, mz);
    var nx = player.x + mx * sp * dt, nz = player.z + mz * sp * dt;
    var res = collideCircle(nx, nz, 0.5);
    player.x = res.x; player.z = res.z;
    player.walkPhase += dt * sp * 1.6;
    player.legs[0].rotation.x = Math.sin(player.walkPhase) * 0.7;
    player.legs[1].rotation.x = -Math.sin(player.walkPhase) * 0.7;
  } else { player.legs[0].rotation.x = 0; player.legs[1].rotation.x = 0; }
  player.group.position.set(player.x, 0, player.z);
  player.group.rotation.y = player.yaw;
}
// Arcade car: steering tapers with speed (Jolt playbook idea, kinematic form),
// brake reverses once stopped, handbrake cuts rear grip for slides.
function updateCar(car, dt) {
  var fwd = (keys['KeyW'] || keys['ArrowUp'] ? 1 : 0);
  var back = (keys['KeyS'] || keys['ArrowDown'] ? 1 : 0);
  var steerIn = (keys['KeyD'] || keys['ArrowRight'] ? 1 : 0) - (keys['KeyA'] || keys['ArrowLeft'] ? 1 : 0);
  var hand = !!keys['Space'];
  var maxSpeed = 34, accel = 16, brake = 26;
  if (fwd) car.speed += accel * dt;
  else if (back) {
    if (car.speed > 0.5) car.speed -= brake * dt;
    else car.speed -= 7 * dt; // reverse
  } else car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 8 * dt);
  car.speed = clamp(car.speed, -10, maxSpeed);
  // steering taper: full lock at walking pace, ~30% at top speed
  var spdF = clamp(Math.abs(car.speed) / maxSpeed, 0, 1);
  var maxSteer = lerp(0.55, 0.16, spdF);
  var targetSteer = steerIn * maxSteer;
  car.steer = lerp(car.steer, targetSteer, clamp(dt * 8, 0, 1));
  var turn = car.steer * (car.speed / 3.2) * dt * (hand ? 1.7 : 1);
  car.yaw -= turn;
  if (hand) car.speed *= (1 - 0.9 * dt);
  var nx = car.x - Math.sin(car.yaw) * car.speed * dt;
  var nz = car.z - Math.cos(car.yaw) * car.speed * dt;
  var before = { x: car.x, z: car.z };
  var res = collideCircle(nx, nz, 2.0);
  if ((res.x !== nx || res.z !== nz) && Math.abs(car.speed) > 3) {
    car.speed *= 0.4; sfx('hit');
    if (S.inCar === car && rng() < 0.3) addWanted(0); // crash alone is not a crime
  }
  car.x = res.x; car.z = res.z;
  car.group.position.set(car.x, 0, car.z);
  car.group.rotation.y = car.yaw;
  car.group.rotation.z = lerp(car.group.rotation.z, -car.steer * 0.06 * Math.sign(car.speed || 1), 0.2);
  car.wheels.forEach(function (w, i) {
    w.rotation.x += car.speed * dt * 2.4;
    if (i < 2) w.rotation.y = -car.steer * 0.9;
  });
  if (engineOsc && S.inCar === car) {
    engineOsc.frequency.value = 55 + Math.abs(car.speed) * 5.5;
    engineGain.gain.value = S.muted ? 0 : 0.05 + Math.abs(car.speed) / maxSpeed * 0.06;
  }
}
function updateTraffic(dt) {
  traffic.forEach(function (c) {
    if (c === S.inCar) return;
    c.roadPos += c.cruise * c.roadDir * dt;
    if (c.roadPos > 195) { c.roadPos = 195; c.roadDir = -1; }
    if (c.roadPos < -195) { c.roadPos = -195; c.roadDir = 1; }
    if (c.roadVertical) { c.x = c.roadLine + 3.5; c.z = c.roadPos; c.yaw = c.roadDir > 0 ? Math.PI : 0; }
    else { c.z = c.roadLine + 3.5; c.x = c.roadPos; c.yaw = c.roadDir > 0 ? -Math.PI / 2 : Math.PI / 2; }
    c.group.position.set(c.x, 0, c.z); c.group.rotation.y = c.yaw;
    c.wheels.forEach(function (w) { w.rotation.x += c.cruise * dt * 2.4; });
  });
}
function updatePeds(dt) {
  peds.forEach(function (p) {
    if (!p.alive) return;
    if (p.vertical) p.z += p.speed * p.dir * dt; else p.x += p.speed * p.dir * dt;
    if (p.z > 195 || p.z < -195 || p.x > 195 || p.x < -195) p.dir *= -1;
    p.group.position.set(p.x, 0, p.z);
    p.group.rotation.y = p.vertical ? (p.dir > 0 ? 0 : Math.PI) : (p.dir > 0 ? Math.PI / 2 : -Math.PI / 2);
  });
  enemies.forEach(function (e) {
    if (!e.alive) return;
    var px = S.inCar ? S.inCar.x : player.x, pz = S.inCar ? S.inCar.z : player.z;
    var d = Math.sqrt(dist2(e.x, e.z, px, pz));
    if (d < 45 && S.mode === 'play') {
      e.yaw = Math.atan2(px - e.x, pz - e.z);
      e.group.rotation.y = e.yaw;
      // enemies strafe toward the player slowly and shoot
      if (d > 12) { e.x += Math.sin(e.yaw) * 2.2 * dt; e.z += Math.cos(e.yaw) * 2.2 * dt; }
      e.group.position.set(e.x, 0, e.z);
      if (rng() < dt * 0.35) {
        noiseBurst(0.1, 0.25, 2000);
        if (rng() < 0.4) {
          S.health -= 4; sfx('hurt'); toast('You are taking fire!');
          if (S.health <= 0) endGame('wasted');
        }
      }
    }
  });
}
function updatePolice(dt) {
  var px = S.inCar ? S.inCar.x : player.x, pz = S.inCar ? S.inCar.z : player.z;
  police.forEach(function (p) {
    var d = Math.sqrt(dist2(p.x, p.z, px, pz));
    var targetYaw = Math.atan2(px - p.x, pz - p.z);
    // police cars drive toward the player (heading -z is forward in our car model)
    var wantYaw = Math.atan2(-(px - p.x), -(pz - p.z));
    p.yaw = angLerp(p.yaw, wantYaw, clamp(dt * 2.2, 0, 1));
    var spd = d > 60 ? 26 : (d > 8 ? 20 : 8);
    p.speed = lerp(p.speed, spd, clamp(dt * 2, 0, 1));
    var nx = p.x - Math.sin(p.yaw) * p.speed * dt;
    var nz = p.z - Math.cos(p.yaw) * p.speed * dt;
    var res = collideCircle(nx, nz, 2.0);
    if (res.x !== nx || res.z !== nz) p.speed *= 0.3;
    p.x = res.x; p.z = res.z;
    p.group.position.set(p.x, 0, p.z); p.group.rotation.y = p.yaw;
    p.wheels.forEach(function (w) { w.rotation.x += p.speed * dt * 2.4; });
    if (p.lightbar) p.lightbar.material.color.setHex(Math.floor(S.time * 3) % 2 ? 0xff2222 : 0x2244ff);
    if (d < 4.5) {
      if (S.inCar) {
        S.inCar.speed *= (1 - 2 * dt);
        S.health -= 6 * dt;
        if (S.health <= 0) endGame('wasted');
      } else {
        S.bustedTimer += dt;
        if (S.bustedTimer > 1.6) endGame('busted');
      }
    }
  });
  if (S.wanted === 0 && police.length) { /* keep patrolling briefly, then leave */ }
}
function updateWanted(dt) {
  if (S.wanted === 0) return;
  S.wantedTimer += dt;
  // heat cools when the player is far from police and committing no crime
  var px = S.inCar ? S.inCar.x : player.x, pz = S.inCar ? S.inCar.z : player.z;
  var nearest = 1e9;
  police.forEach(function (p) { nearest = Math.min(nearest, Math.sqrt(dist2(p.x, p.z, px, pz))); });
  if (nearest > 55 && S.wantedTimer > 14) {
    S.wanted--; S.wantedTimer = 0;
    toast(S.wanted > 0 ? 'Heat cooling — ' + S.wanted + '★ left' : 'You lost the cops!');
    if (S.wanted === 0) removePolice();
  }
  if (Math.floor(S.time * 1.4) !== Math.floor((S.time - dt) * 1.4)) sirenTick();
}
function updateCamera(dt) {
  var px, pz, yaw, height = 7;
  if (S.inCar) { px = S.inCar.x; pz = S.inCar.z; yaw = S.inCar.yaw; height = 8; S.camDist = 12; }
  else { px = player.x; pz = player.z; yaw = player.yaw; S.camDist = 9; }
  // chase camera: behind the heading, blended smoothly
  var desiredYaw = S.inCar ? yaw : S.camYaw;
  if (!S.inCar && (keys['KeyW'] || keys['KeyA'] || keys['KeyS'] || keys['KeyD'])) {
    S.camYaw = angLerp(S.camYaw, player.yaw + Math.PI, clamp(dt * 3, 0, 1));
    desiredYaw = S.camYaw;
  }
  var cx = px + Math.sin(desiredYaw) * S.camDist;
  var cz = pz + Math.cos(desiredYaw) * S.camDist;
  camera.position.x = lerp(camera.position.x, cx, clamp(dt * 6, 0, 1));
  camera.position.y = lerp(camera.position.y, height, clamp(dt * 6, 0, 1));
  camera.position.z = lerp(camera.position.z, cz, clamp(dt * 6, 0, 1));
  camera.lookAt(px, 1.6, pz);
  // health regen slowly out of combat
  if (S.wanted === 0 && S.health < 100) S.health = Math.min(100, S.health + 1.2 * dt);
}

// ---------- main loop ----------
var last = performance.now(), saveTimer = 0;
function loop(now) {
  requestAnimationFrame(loop);
  var dt = Math.min((now - last) / 1000, 0.05); last = now;
  if (S.mode === 'play') {
    S.time += dt; S.shotCooldown = Math.max(0, S.shotCooldown - dt);
    S.bustedTimer = Math.max(0, S.bustedTimer - dt * 0.4);
    if (S.inCar) updateCar(S.inCar, dt); else updatePlayer(dt);
    updateTraffic(dt); updatePeds(dt); updatePolice(dt); updateWanted(dt);
    updateMissions(dt); updateCamera(dt); updateHUD();
    tracers.forEach(function (t) { t.t -= dt; if (t.t <= 0) { scene.remove(t.line); } });
    tracers = tracers.filter(function (t) { return t.t > 0; });
    beacon.rotation.y += dt; beaconRing.scale.setScalar(1 + Math.sin(S.time * 3) * 0.08);
    saveTimer += dt;
    if (saveTimer > 5) { saveTimer = 0; saveGame(); }
  }
  renderer.render(scene, camera);
}
requestAnimationFrame(loop);

// ---------- test / screenshot hooks (used by the CDP playtest) ----------
window.__GAME__ = {
  state: S, missions: MISSIONS,
  start: function (fresh) { startGame(fresh); },
  save: saveGame, load: loadSave,
  teleport: function (x, z) {
    if (S.inCar) { S.inCar.x = x; S.inCar.z = z; } else { player.x = x; player.z = z; }
  },
  enterNearestCar: function () { tryEnterExitCar(); },
  setWanted: function (n) { S.wanted = n; if (n > 0) spawnPolice(); },
  playerPos: function () { return { x: player.x, z: player.z, inCar: !!S.inCar }; },
  carPos: function () { return S.inCar ? { x: S.inCar.x, z: S.inCar.z, speed: S.inCar.speed } : null; },
  shoot: shoot, completeMission: completeMission,
  keys: keys, version: 'cinder-bay-1.0'
};
// Screenshot modes: ?shot=foot|drive|chase|mission — deterministic staged scenes.
(function () {
  var q = new URLSearchParams(location.search);
  var shot = q.get('shot');
  if (!shot) return;
  startGame(true);
  if (shot === 'foot') { /* on foot in the plaza, mission 1 shown */ }
  else if (shot === 'drive' || shot === 'chase' || shot === 'mission') {
    var c = parked[0];
    if (c) { player.x = c.x; player.z = c.z; tryEnterExitCar(); }
    if (shot === 'drive') { S.inCar.speed = 16; S.inCar.x = 0; S.inCar.z = 60; }
    if (shot === 'chase') { S.wanted = 3; spawnPolice(); S.inCar.x = -40; S.inCar.z = 20; S.inCar.speed = 18; }
    if (shot === 'mission') { startMission(1); S.inCar.x = -120; S.inCar.z = -120; S.inCar.speed = 12; }
  }
  // freeze the camera nicely for the shot
  S.camYaw = S.inCar ? S.inCar.yaw : 0.6;
})();
})();
