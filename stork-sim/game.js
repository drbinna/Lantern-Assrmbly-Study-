import { Sim, Terrain, planSurvey, Coverage, swathAt, gsdNadir, eulerFromQ, AC, pointInPoly } from './sim.js';

const $ = id => document.getElementById(id);
const CAMPAIGN = ['L1', 'L2', 'L3'];
const PAR = { L1: 290, L2: 690, L3: 870 };   // seconds, from optimised reference runs (+10%)
const VLOS = 1000, CEIL = 122, DT = 0.005;
const store = { get(k, d) { try { return JSON.parse(localStorage.getItem('stork-sim:' + k)) ?? d; } catch { return d; } },
                set(k, v) { try { localStorage.setItem('stork-sim:' + k, JSON.stringify(v)); } catch {} } };
const fmtT = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const mph = ms => ms * 2.237;
const compass = d => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
function show(id) { document.querySelectorAll('.screen').forEach(s => s.classList.toggle('on', s.id === id)); document.body.classList.toggle('flying', id === 'fly'); }
function loading(on, txt = 'LOADING…') { $('loading').textContent = txt; $('loading').classList.toggle('on', on); }

// ======================= levels =======================
const cache = {};
async function loadLevel(key) {
  if (cache[key]) return cache[key];
  const L = await fetch(`levels/${key}.json`).then(r => r.json());
  L.img = await loadImg(`levels/${L.image}`);
  L.terr = new Terrain(L.terrain.n, L.terrain.size, Float32Array.from(L.terrain.h));
  L.key = key;
  return (cache[key] = L);
}
function loadImg(src) { return new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; }); }

async function buildMenu() {
  const g = $('levelGrid'); g.innerHTML = '';
  for (const [n, key] of CAMPAIGN.entries()) {
    const L = await fetch(`levels/${key}.json`).then(r => r.json()); cache['meta' + key] = L;
    const best = store.get('best:' + key, null);
    const st = best ? best.stars : 0;
    const el = document.createElement('div'); el.className = 'lvl';
    el.innerHTML = `<div class="img" style="background-image:url(levels/${L.image})"><span class="tag mono">LEVEL ${n + 1}</span></div>
      <div class="body"><h3>${L.title}</h3><p>${L.sub}. ${Math.round(L.acres)} acres of ${L.crop.toLowerCase()}, ${L.county} County.</p>
      <div class="meta mono"><span class="stars">${'<b>★</b>'.repeat(st)}${'★'.repeat(3 - st)}</span><span>${best ? 'BEST ' + best.score : 'WIND ' + Math.round(mph(L.wind.speed)) + ' MPH'}</span></div></div>`;
    el.onclick = () => openPlan(key);
    g.appendChild(el);
  }
  const f = document.createElement('div'); f.className = 'lvl free';
  f.innerHTML = `<div class="img mono">ANY FIELD IN THE US</div><div class="body"><h3>Free play</h3><p>Pick any real crop field on the satellite map, set the wind, and fly it.</p><div class="meta mono"><span>USDA FIELD OUTLINES</span><span>ESRI IMAGERY</span></div></div>`;
  f.onclick = openFree; g.appendChild(f);
}

// ======================= planning =======================
let L = null, plan = null;
const pc = $('planCanvas'), pctx = pc.getContext('2d');
let view = { cx: 0, cy: 0, s: 1 };
function defaultPlan(L) {
  // align with the field's long axis by default
  return { alt: 60, hdg: fieldAxis(L.ring), ov: 20, spd: 17, home: [...L.home] };
}
function fieldAxis(ring) {
  let best = 0, bl = 0;
  for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > bl) { bl = l; best = Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI; } }
  return Math.round(((best % 180) + 180) % 180);
}
async function openPlan(key, keepPlan) {
  loading(true);
  L = typeof key === 'string' ? await loadLevel(key) : key;
  loading(false);
  if (!keepPlan || !plan || plan.key !== L.key) plan = { key: L.key, ...defaultPlan(L) };
  const idx = CAMPAIGN.indexOf(L.key);
  $('pKicker').textContent = idx >= 0 ? `LEVEL ${idx + 1} · ${L.county.toUpperCase()} COUNTY, OK` : 'FREE PLAY';
  $('pTitle').textContent = L.title; $('pBrief').textContent = L.brief;
  const par = PAR[L.key];
  $('pGoals').innerHTML = `<i>★</i> Land safely with ≥ ${Math.round(L.goal * 100)}% of the field at ${Math.round(L.gsd * 100)} cm/px or sharper<br>
    <i>★★</i> …and ≥ 25% battery left, no line-of-sight or ceiling breaches<br>
    <i>★★★</i> …and ≥ 97% coverage${par ? ` in under ${fmtT(par)}` : ''}<br><span class="mono" style="font-size:11px;color:var(--ink-3)">WIND ${Math.round(mph(L.wind.speed))} MPH FROM ${compass(L.wind.from)} · GUSTS ±${Math.round(mph(L.wind.gust * 1.5))} MPH · ${L.crop.toUpperCase()} · ${Math.round(L.acres)} AC</span>`;
  $('sAlt').value = plan.alt; $('sHdg').value = plan.hdg; $('sOv').value = plan.ov; $('sSpd').value = plan.spd;
  show('plan');
  fitView(); updatePlan();
}
function fitView() {
  const r = pc.getBoundingClientRect(); pc.width = r.width * devicePixelRatio; pc.height = r.height * devicePixelRatio;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of [...L.ring, [plan.home[1], plan.home[0]]]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  view.cx = (x0 + x1) / 2; view.cy = (y0 + y1) / 2;
  view.s = Math.min(pc.width / (x1 - x0 + 500), pc.height / (y1 - y0 + 500));
}
const w2c = (E, N) => [pc.width / 2 + (E - view.cx) * view.s, pc.height / 2 - (N - view.cy) * view.s];
const c2w = (x, y) => [view.cx + (x - pc.width / 2) / view.s, view.cy - (y - pc.height / 2) / view.s];

function computePlan() {
  plan.alt = +$('sAlt').value; plan.hdg = +$('sHdg').value; plan.ov = +$('sOv').value; plan.spd = +$('sSpd').value;
  const sw = swathAt(plan.alt, L.gsd);
  const spacing = Math.max(12, sw * (1 - plan.ov / 100));
  const wps = sw > 0 ? planSurvey(L.ring, plan.hdg, spacing) : [];
  // estimate
  const H = plan.home; let dist = 0, prev = { N: H[0], E: H[1] }, maxD = 0;
  for (const w of wps) { dist += Math.hypot(w.N - prev.N, w.E - prev.E); prev = w; maxD = Math.max(maxD, Math.hypot(w.N - H[0], w.E - H[1])); }
  dist += Math.hypot(prev.N - H[0], prev.E - H[1]);
  const nTurns = Math.max(0, wps.length / 2 - 1), R = plan.spd ** 2 / (9.81 * Math.tan(0.6));
  const tTurn = nTurns * Math.max(0, Math.PI * Math.max(R, spacing / 2) - spacing) / plan.spd;
  const tCruise = dist / plan.spd + tTurn;
  const tHover = (plan.alt * 0.6 + 8) / 2.2 + 25 + Math.max(plan.alt, 15) / 1.7 + 12;
  const V = plan.spd, q = 0.5 * 1.2 * V * V, CL = AC.mass * 9.81 / (q * AC.S);
  const Pc = q * AC.S * (AC.CD0 + CL * CL / (Math.PI * AC.e * AC.b * AC.b / AC.S)) * V / 0.52 + AC.avionicsW;
  const Ph = 4 * (AC.mass * 9.81 / 4) * Math.sqrt(AC.mass * 9.81 / 4 / (2 * 1.2 * AC.lift.A)) / AC.lift.eff + AC.avionicsW;
  const wh = (Pc * tCruise + Ph * tHover) / 3600;
  Object.assign(plan, { sw, spacing, wps, dist, time: tCruise + tHover, wh, battLeft: 1 - wh / AC.battWh, maxD, Pc, Ph });
  return plan;
}
function updatePlan() {
  computePlan();
  $('vAlt').textContent = `${plan.alt} m · ${Math.round(plan.alt * 3.281)} ft`;
  $('vHdg').textContent = `${plan.hdg}° / ${(plan.hdg + 180) % 360}°`;
  $('vOv').textContent = plan.ov + '%'; $('vSpd').textContent = `${plan.spd} m/s · ${Math.round(mph(plan.spd))} mph`;
  const g = gsdNadir(plan.alt);
  $('hAlt').innerHTML = plan.sw > 0 ? `Straight down the Walksnail sees <b>${(g * 100).toFixed(1)} cm/px</b>. Usable swath at the ${Math.round(L.gsd * 100)} cm target: <b>${Math.round(plan.sw)} m</b>.`
    : `<span style="color:var(--rust)">Too high: even straight down is coarser than ${Math.round(L.gsd * 100)} cm/px.</span>`;
  const vl = plan.maxD + 60 > VLOS;
  $('pFacts').innerHTML = [['LINES', Math.ceil(plan.wps.length / 2)], ['LINE SPACING', Math.round(plan.spacing) + ' m'], ['FLIGHT TIME', '≈ ' + fmtT(plan.time)],
    ['DISTANCE', (plan.dist / 1000).toFixed(1) + ' km'], ['BATTERY LEFT', `<span class="${plan.battLeft < 0.25 ? 'warn' : ''}">≈ ${Math.round(plan.battLeft * 100)}%</span>`],
    ['FARTHEST POINT', `<span class="${vl ? 'warn' : ''}">${Math.round(plan.maxD)} m${vl ? ' ⚠' : ''}</span>`]]
    .map(([a, b]) => `<div><span class="mono">${a}</span><b>${b}</b></div>`).join('') +
    (vl ? `<div style="grid-column:1/3;font-size:11.5px;color:var(--rust)">Part of the route leaves the 1 km line-of-sight ring. Move the launch pad or the lines.</div>` : '');
  $('bFlyAuto').disabled = !plan.wps.length;
  drawPlan();
}
function drawPlan() {
  const c = pctx, W = pc.width, H = pc.height;
  c.fillStyle = '#2a2f2b'; c.fillRect(0, 0, W, H);
  const [ix, iy] = w2c(-1000, 1000); c.drawImage(L.img, ix, iy, 2000 * view.s, 2000 * view.s);
  c.fillStyle = 'rgba(10,14,12,.18)'; c.fillRect(0, 0, W, H);
  // VLOS ring
  const [hx, hy] = w2c(plan.home[1], plan.home[0]);
  c.beginPath(); c.arc(hx, hy, VLOS * view.s, 0, Math.PI * 2); c.strokeStyle = '#ff6b5b'; c.lineWidth = 2 * devicePixelRatio; c.setLineDash([10, 8]); c.stroke(); c.setLineDash([]);
  // swath strips
  const wps = plan.wps;
  c.lineCap = 'butt';
  for (let i = 0; i + 1 < wps.length; i += 2) {
    const [a, b] = [w2c(wps[i].E, wps[i].N), w2c(wps[i + 1].E, wps[i + 1].N)];
    c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.strokeStyle = 'rgba(143,224,181,.22)'; c.lineWidth = plan.sw * view.s; c.stroke();
  }
  // field
  c.beginPath(); L.ring.forEach(([x, y], i) => { const p = w2c(x, y); i ? c.lineTo(...p) : c.moveTo(...p); }); c.closePath();
  c.strokeStyle = '#ffb547'; c.lineWidth = 2.5 * devicePixelRatio; c.stroke();
  // route
  c.beginPath(); c.moveTo(hx, hy); wps.forEach(w => c.lineTo(...w2c(w.E, w.N))); c.lineTo(hx, hy);
  c.strokeStyle = 'rgba(255,255,255,.95)'; c.lineWidth = 1.6 * devicePixelRatio; c.stroke();
  wps.forEach((w, i) => { const p = w2c(w.E, w.N); c.beginPath(); c.arc(...p, 3 * devicePixelRatio, 0, 7); c.fillStyle = i === 0 ? '#8fe0b5' : '#fff'; c.fill(); });
  // home pad
  c.beginPath(); c.arc(hx, hy, 13 * devicePixelRatio, 0, 7); c.fillStyle = '#1f6b52'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2 * devicePixelRatio; c.stroke();
  c.fillStyle = '#fff'; c.font = `700 ${13 * devicePixelRatio}px Archivo`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('H', hx, hy + 1);
  // wind arrow
  const wx = W - 70 * devicePixelRatio, wy = 70 * devicePixelRatio, d = (L.wind.from + 180) * Math.PI / 180;
  c.save(); c.translate(wx, wy); c.fillStyle = 'rgba(16,20,18,.7)'; c.beginPath(); c.arc(0, 0, 44 * devicePixelRatio, 0, 7); c.fill();
  c.rotate(d); c.fillStyle = '#8fe0b5'; c.beginPath(); const k = devicePixelRatio; c.moveTo(0, -26 * k); c.lineTo(10 * k, 8 * k); c.lineTo(0, 2 * k); c.lineTo(-10 * k, 8 * k); c.closePath(); c.fill(); c.restore();
  c.fillStyle = '#fff'; c.font = `600 ${11 * k}px JetBrains Mono`; c.fillText(`${Math.round(mph(L.wind.speed))} MPH`, wx, wy + 58 * k);
  // scale bar
  const sb = 200 * view.s; c.fillStyle = '#fff'; c.fillRect(W - 30 * k - sb, H - 30 * k, sb, 3 * k); c.textAlign = 'right'; c.font = `${10 * k}px JetBrains Mono`; c.fillText('200 m', W - 30 * k, H - 40 * k);
}
let drag = null;
pc.addEventListener('pointerdown', e => {
  const r = pc.getBoundingClientRect(), x = (e.clientX - r.left) * devicePixelRatio, y = (e.clientY - r.top) * devicePixelRatio;
  const [hx, hy] = w2c(plan.home[1], plan.home[0]);
  drag = Math.hypot(x - hx, y - hy) < 22 * devicePixelRatio ? { type: 'home' } : { type: 'pan', x, y, cx: view.cx, cy: view.cy };
  pc.setPointerCapture(e.pointerId); pc.style.cursor = 'grabbing';
});
pc.addEventListener('pointermove', e => {
  if (!drag) return; const r = pc.getBoundingClientRect(), x = (e.clientX - r.left) * devicePixelRatio, y = (e.clientY - r.top) * devicePixelRatio;
  if (drag.type === 'home') {
    const [E, N] = c2w(x, y);
    if (Math.abs(E) < 960 && Math.abs(N) < 960 && !pointInPoly([E, N], L.ring)) { plan.home = [N, E]; updatePlan(); }
  } else { view.cx = drag.cx - (x - drag.x) / view.s; view.cy = drag.cy + (y - drag.y) / view.s; drawPlan(); }
});
pc.addEventListener('pointerup', () => { drag = null; pc.style.cursor = 'grab'; });
pc.addEventListener('wheel', e => { e.preventDefault(); view.s *= e.deltaY < 0 ? 1.12 : 1 / 1.12; view.s = Math.max(0.15, Math.min(view.s, 6)); drawPlan(); }, { passive: false });
['sAlt', 'sHdg', 'sOv', 'sSpd'].forEach(id => $(id).oninput = updatePlan);
$('bAlign').onclick = () => { $('sHdg').value = fieldAxis(L.ring); updatePlan(); };
$('bWindAlong').onclick = () => { $('sHdg').value = ((L.wind.from % 180) + 180) % 180; updatePlan(); };
$('bWindAcross').onclick = () => { $('sHdg').value = ((L.wind.from + 90) % 180 + 180) % 180; updatePlan(); };
$('bBack').onclick = () => { show('menu'); buildMenu(); };
addEventListener('resize', () => { if ($('plan').classList.contains('on')) { fitView(); drawPlan(); } });

// ======================= 3D world =======================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.outputEncoding = THREE.sRGBEncoding;
renderer.autoClear = false;
$('flyCanvas').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xb9cbd8); scene.fog = new THREE.Fog(0xb9cbd8, 900, 2600);
const cam = new THREE.PerspectiveCamera(55, 1, 0.3, 6000);
const pipCam = new THREE.PerspectiveCamera(90, 16 / 9, 0.5, 3000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a5e, 0.75));
const sun = new THREE.DirectionalLight(0xfff4e0, 0.75); sun.position.set(-400, 900, 300); scene.add(sun);
const world = { group: null };
const n2t = (N, E, D) => new THREE.Vector3(E, -D, -N);

let model = null;
async function loadModel() {
  if (model) return model;
  const [meta, buf] = await Promise.all([fetch('stork_lo.json').then(r => r.json()), fetch('stork_lo.bin').then(r => r.arrayBuffer())]);
  const g = new THREE.Group();
  const mk = (k, color) => {
    const m = meta[k], geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(buf, m.pos[0], m.pos[1]), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Int8Array(buf, m.nrm[0], m.nrm[1]), 3, true));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, m.idx[0], m.idx[1]), 1));
    g.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.6, side: THREE.DoubleSide })));
  };
  mk('base', 0xeeece6); mk('vtol', 0x8fb8a5);
  const carbon = new THREE.MeshStandardMaterial({ color: 0x1d1f1e, roughness: 0.45 });
  for (const b of meta.booms) {
    const a = new THREE.Vector3(...b.a), c = new THREE.Vector3(...b.b), len = a.distanceTo(c);
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, len), carbon); m.position.copy(a).add(c).multiplyScalar(0.5); g.add(m);
  }
  const props = [];
  const discMat = new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
  const bladeMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.5 });
  const bell = new THREE.MeshStandardMaterial({ color: 0x9a2f2a, roughness: 0.4, metalness: 0.4 });
  for (const mo of meta.motors) {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.017, 0.024, 16), bell); m.position.set(mo.p[0], mo.p[1] + 0.012, mo.p[2]); g.add(m);
    const blade = new THREE.Mesh(new THREE.BoxGeometry(mo.d, 0.002, 0.014), bladeMat); blade.position.set(mo.p[0], mo.p[1] + 0.03, mo.p[2]);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(mo.d / 2, 32), discMat); disc.rotation.x = -Math.PI / 2; disc.position.copy(blade.position);
    g.add(blade, disc); props.push({ blade, disc, axis: 'y' });
  }
  { const pu = meta.pusher; const blade = new THREE.Mesh(new THREE.BoxGeometry(pu.d, 0.016, 0.003), bladeMat); blade.position.set(pu.p[0], pu.p[1], pu.p[2] + 0.04);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(pu.d / 2, 32), discMat); disc.position.copy(blade.position); g.add(blade, disc); props.push({ blade, disc, axis: 'z', pusher: true }); }
  g.userData.props = props;
  return (model = g);
}

let overlay = null;
function buildWorld(L) {
  if (world.group) { world.group.remove(model); scene.remove(world.group); world.group.traverse(o => { o.geometry?.dispose?.(); o.material?.map?.dispose?.(); }); }
  const g = new THREE.Group(); world.group = g; scene.add(g);
  const n = L.terrain.n, size = L.terrain.size;
  const geo = new THREE.PlaneGeometry(size, size, n - 1, n - 1); geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) pos.setY(i, L.terrain.h[i]);
  geo.computeVertexNormals();
  const tex = new THREE.Texture(L.img); tex.needsUpdate = true; tex.encoding = THREE.sRGBEncoding; tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ map: tex })));
  // big surround so the horizon isn't a hard edge
  const sur = new THREE.Mesh(new THREE.PlaneGeometry(12000, 12000), new THREE.MeshLambertMaterial({ color: 0x7d8a5f }));
  sur.rotation.x = -Math.PI / 2; sur.position.y = Math.min(...L.terrain.h.slice(0, 2000)) - 3; g.add(sur);
  // coverage overlay
  const oc = document.createElement('canvas'); oc.width = oc.height = 1024;
  const otex = new THREE.CanvasTexture(oc);
  const om = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: otex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  g.add(om); overlay = { canvas: oc, ctx: oc.getContext('2d'), tex: otex, small: document.createElement('canvas') };
  // draped lines
  const drape = (pts, color, lift = 0.6, closed = false) => {
    const arr = []; const P = closed ? [...pts, pts[0]] : pts;
    for (let i = 0; i + 1 < P.length; i++) { const [a, b] = [P[i], P[i + 1]]; const k = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 8);
      for (let j = 0; j < k; j++) { const t = j / k, E = a[0] + (b[0] - a[0]) * t, N = a[1] + (b[1] - a[1]) * t; arr.push(new THREE.Vector3(E, L.terr.at(N, E) + lift, -N)); } }
    const last = P[P.length - 1]; arr.push(new THREE.Vector3(last[0], L.terr.at(last[1], last[0]) + lift, -last[1]));
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(arr), new THREE.LineBasicMaterial({ color }));
  };
  g.add(drape(L.ring, 0xffb547, 0.8, true));
  const ring = []; for (let i = 0; i < 128; i++) { const a = i / 128 * Math.PI * 2; ring.push([plan.home[1] + Math.sin(a) * VLOS, plan.home[0] + Math.cos(a) * VLOS]); }
  g.add(drape(ring, 0xff6b5b, 1.5, true));
  // flight lines at mission altitude
  const wps = plan.wps;
  for (let i = 0; i + 1 < wps.length; i += 2) {
    const a = wps[i], b = wps[i + 1];
    const pts = [a, b].map(w => new THREE.Vector3(w.E, L.terr.at(w.N, w.E) + plan.alt, -w.N));
    const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0xffffff, dashSize: 12, gapSize: 9, transparent: true, opacity: 0.7 }));
    ln.computeLineDistances(); g.add(ln);
  }
  // home pad
  const hy = L.terr.at(plan.home[0], plan.home[1]);
  const pad = new THREE.Mesh(new THREE.CircleGeometry(2.2, 40), new THREE.MeshBasicMaterial({ color: 0x1f6b52 })); pad.rotation.x = -Math.PI / 2; pad.position.set(plan.home[1], hy + 0.05, -plan.home[0]); g.add(pad);
  const hc = document.createElement('canvas'); hc.width = hc.height = 128; const hx = hc.getContext('2d'); hx.fillStyle = '#fff'; hx.font = '700 90px Archivo'; hx.textAlign = 'center'; hx.textBaseline = 'middle'; hx.fillText('H', 64, 70);
  const hm = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 2.6), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(hc), transparent: true })); hm.rotation.x = -Math.PI / 2; hm.position.set(plan.home[1], hy + 0.07, -plan.home[0]); g.add(hm);
  // pilot figure
  const pilot = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, 1.75, 10), new THREE.MeshLambertMaterial({ color: 0x2a3a6b })); pilot.position.set(plan.home[1] + 6, hy + 0.9, -plan.home[0] + 4); g.add(pilot);
  // aircraft + blob shadow
  g.add(model);
  const sh = new THREE.Mesh(new THREE.CircleGeometry(0.75, 32), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25, depthWrite: false }));
  sh.rotation.x = -Math.PI / 2; sh.scale.set(1, 0.45, 1); g.add(sh); world.shadow = sh;
  // track
  world.trackGeo = new THREE.BufferGeometry(); world.trackPts = new Float32Array(3 * 4000); world.trackN = 0;
  world.trackGeo.setAttribute('position', new THREE.BufferAttribute(world.trackPts, 3)); world.trackGeo.setDrawRange(0, 0);
  g.add(new THREE.Line(world.trackGeo, new THREE.LineBasicMaterial({ color: 0x8fe0b5 })));
}
function drawOverlay(cov, gsd, final = false) {
  const { small, ctx, canvas, tex } = overlay;
  if (small.width !== cov.nx) { small.width = cov.nx; small.height = cov.ny; }
  const sc = small.getContext('2d'), img = sc.createImageData(cov.nx, cov.ny), d = img.data;
  for (let j = 0; j < cov.ny; j++) for (let i = 0; i < cov.nx; i++) {
    const k = j * cov.nx + i; if (!cov.inside[k]) continue;
    const o = ((cov.ny - 1 - j) * cov.nx + i) * 4, b = cov.best[k];
    if (b <= gsd) { d[o] = 70; d[o + 1] = 225; d[o + 2] = 150; d[o + 3] = 135; }
    else if (b < 50) { d[o] = 255; d[o + 1] = 185; d[o + 2] = 60; d[o + 3] = 110; }
    else if (final) { d[o] = 230; d[o + 1] = 70; d[o + 2] = 55; d[o + 3] = 120; }
  }
  sc.putImageData(img, 0, 0);
  ctx.clearRect(0, 0, 1024, 1024); ctx.imageSmoothingEnabled = false;
  const s = 1024 / 2000;
  ctx.drawImage(small, (cov.x0 + 1000) * s, (1000 - (cov.y0 + cov.ny * cov.cell)) * s, cov.nx * cov.cell * s, cov.ny * cov.cell * s);
  tex.needsUpdate = true;
}

// ======================= flight =======================
let F = null;   // current flight
const keys = {};
addEventListener('keydown', e => {
  if (!$('fly').classList.contains('on')) return;
  const k = e.key.toLowerCase(); keys[k] = true;
  if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) e.preventDefault();
  if (!F || F.over) return;
  if (k === ' ') toggleArm();
  if (k === 't') modeReq('FBWA'); if (k === 'h') modeReq('QLOITER'); if (k === 'm') modeReq('AUTO'); if (k === 'b') modeReq('QRTL');
  if (k === 'c') cycleCam(); if (k === 'p') F.paused = !F.paused;
  if (k === '+' || k === '=') setWarp(F.warp * 2); if (k === '-' || k === '_') setWarp(F.warp / 2);
  if (k === 'escape') endFlight('Flight ended');
});
addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
function toggleArm() {
  const s = F.sim;
  if (s.mode === 'DISARMED' && !s.landed) { s.arm(); F.started = true; hideStart(); }
  else if (s.onGround && s.mode !== 'DISARMED' && s.mode !== 'CRASHED') { s.mode = 'DISARMED'; s.landed = true; s.msg('Disarmed'); }
}
function modeReq(m) {
  const s = F.sim; if (s.crashed || s.landed) return;
  if (m === 'FBWA' && (s.mode === 'DISARMED' || s.agl() < 10)) { toast('Climb above 10 m before switching to wing flight', true); return; }
  if (m === 'QRTL' && s.mode === 'DISARMED') return;
  if (m === 'AUTO') { const wi = s.wpIdx; s.setMode('AUTO'); F.usedAuto = true; F.started = true; hideStart();
    if (s.agl() > 8) { s.autoStage = s.trans >= 1 || s.airspeed > 12 ? 'WP' : 'TAKEOFF'; s.wpIdx = Math.min(wi, s.mission.wps.length - 1); } return; }
  s.setMode(m);
}
function setWarp(w) { F.warp = Math.max(1, Math.min(16, w)); $('bWarp').textContent = F.warp + '×'; $('hWarp').textContent = F.warp + '×'; }
const CAMS = ['CHASE', 'ORBIT', 'MAP', 'WALKSNAIL'];
function cycleCam() { F.cam = (F.cam + 1) % CAMS.length; $('bCam').textContent = 'CAM: ' + CAMS[F.cam]; }
$('bCam').onclick = () => cycleCam(); $('bWarp').onclick = () => setWarp(F.warp >= 16 ? 1 : F.warp * 2); $('bEnd').onclick = () => endFlight('Flight ended');
document.querySelectorAll('#ctrlBar [data-m]').forEach(b => b.onclick = () => { if (b.dataset.m !== 'QRTL' && F.sim.mode === 'DISARMED' && b.dataset.m !== 'AUTO') toggleArm(); modeReq(b.dataset.m); });
$('helpX').onclick = () => $('hudBL').style.display = 'none';
// orbit drag
let orb = { az: 0, el: 0.35, dist: 9, drag: null };
renderer.domElement.addEventListener('pointerdown', e => { orb.drag = [e.clientX, e.clientY, orb.az, orb.el]; if (F && F.cam === 0) { F.cam = 1; $('bCam').textContent = 'CAM: ORBIT'; } });
addEventListener('pointermove', e => { if (!orb.drag) return; orb.az = orb.drag[2] - (e.clientX - orb.drag[0]) * 0.006; orb.el = Math.max(-0.2, Math.min(1.45, orb.drag[3] + (e.clientY - orb.drag[1]) * 0.005)); });
addEventListener('pointerup', () => orb.drag = null);
renderer.domElement.addEventListener('wheel', e => { e.preventDefault(); orb.dist = Math.max(4, Math.min(400, orb.dist * (e.deltaY > 0 ? 1.12 : 0.89))); }, { passive: false });

function toast(s, bad) {
  const d = document.createElement('div'); d.textContent = s; if (bad) d.className = 'bad';
  const w = document.createElement('div'); w.appendChild(d); $('msgs').appendChild(w);
  setTimeout(() => d.style.opacity = 0, 3800); setTimeout(() => w.remove(), 4500);
  while ($('msgs').children.length > 4) $('msgs').firstChild.remove();
}
function hideStart() { $('startOverlay').style.display = 'none'; }

async function startFlight(auto) {
  computePlan();
  loading(true, 'PREPARING THE FIELD…');
  await loadModel();
  show('fly'); resizeFly();
  buildWorld(L);
  const yaw0 = Math.atan2(plan.wps[0] ? plan.wps[0].E - plan.home[1] : 0, plan.wps[0] ? plan.wps[0].N - plan.home[0] : 1);
  const sim = new Sim({ terrain: L.terr, home: plan.home, homeYaw: yaw0, wind: L.wind, seed: 7 });
  sim.mission = { alt: plan.alt, wps: plan.wps, spd: plan.spd };
  const cov = new Coverage(L.ring, L.acres > 400 ? 6 : 4);
  F = { sim, cov, auto, warp: 1, cam: 0, paused: false, acc: 0, nextCam: 0, vlosT: 0, ceilT: 0, msgSeen: 0, usedAuto: false, started: false, over: false, track: [], lastOv: 0, gsdNow: null };
  drawOverlay(cov, L.gsd);
  setWarp(auto ? 4 : 1);
  orb = { az: 0, el: 0.35, dist: 9, drag: null };
  $('startOverlay').style.display = '';
  $('soTitle').textContent = auto ? 'Mission loaded' : 'Ready on the pad';
  $('soText').innerHTML = auto ? `The autopilot will take off, fly ${Math.ceil(plan.wps.length / 2)} lines at ${plan.alt} m and land back on the pad. You can take over any time with <b>H</b> (hover) or <b>T</b> (wing). Running at 4× speed; use + and − to change it.`
    : `Press <b>SPACE</b> to arm, hold <b>R</b> to climb. Above 10 m press <b>T</b> to transition to wing flight. Fly the dashed lines, then <b>H</b> to hover and <b>F</b> to land on the pad. Fly the whole thing without AUTO for a 25% bonus.`;
  $('soGo').textContent = auto ? 'Start mission' : 'Got it';
  $('soGo').onclick = () => { hideStart(); if (auto) modeReq('AUTO'); };
  loading(false);
}
$('bFlyAuto').onclick = () => startFlight(true);
$('bFlyManual').onclick = () => startFlight(false);

function readInput() {
  const k = keys, ax = (p, n) => (k[p] ? 1 : 0) - (k[n] ? 1 : 0);
  let fwd = ax('w', 's') || ax('arrowup', 'arrowdown'), roll = ax('d', 'a') || ax('arrowright', 'arrowleft'), yaw = ax('e', 'q'), thr = ax('r', 'f');
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const p of pads) { if (!p) continue; const dz = v => Math.abs(v) < 0.08 ? 0 : v;
    yaw ||= dz(p.axes[0]); thr ||= -dz(p.axes[1]); roll ||= dz(p.axes[2] ?? 0); fwd ||= -dz(p.axes[3] ?? 0);
    const b = i => p.buttons[i]?.pressed, edge = F.padPrev || [];
    [[0, 'FBWA'], [1, 'QLOITER'], [2, 'AUTO'], [3, 'QRTL']].forEach(([i, m]) => { if (b(i) && !edge[i]) { if (m !== 'QRTL' && F.sim.mode === 'DISARMED' && m !== 'AUTO') toggleArm(); modeReq(m); } });
    if (b(9) && !edge[9]) toggleArm();
    F.padPrev = p.buttons.map(x => x.pressed); break; }
  const s = F.sim, wing = s.mode === 'FBWA';
  return { roll, pitch: wing ? -fwd : fwd, yaw, throttle: thr };
}

const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
function placeModel(s) {
  // body FRD -> model (X right, Y up, Z aft): v_b = B v_m ; world three = A v_ned
  const q = s.q, [w, x, y, z] = q;
  const R = [[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]];
  const B = [[0, 0, -1], [1, 0, 0], [0, -1, 0]], A = [[0, 1, 0], [0, 0, -1], [-1, 0, 0]];
  const mul = (P, Q) => P.map(r => [0, 1, 2].map(j => r[0] * Q[0][j] + r[1] * Q[1][j] + r[2] * Q[2][j]));
  const M = mul(mul(A, R), B), p = n2t(s.p[0], s.p[1], s.p[2]);
  _m4.set(M[0][0], M[0][1], M[0][2], p.x, M[1][0], M[1][1], M[1][2], p.y, M[2][0], M[2][1], M[2][2], p.z, 0, 0, 0, 1);
  model.matrixAutoUpdate = false; model.matrix.copy(_m4); model.matrixWorldNeedsUpdate = true;
  const props = model.userData.props;
  for (let i = 0; i < props.length; i++) {
    const pr = props[i], T = pr.pusher ? s.push : s.lift[i];
    const sp = T > 0.3 ? 1 : 0; pr.blade.visible = !sp; pr.disc.visible = !!sp;
    if (!sp) { pr.blade.rotation[pr.axis] += 0; }
  }
  return M;
}

function resizeFly() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); }
addEventListener('resize', () => { if ($('fly').classList.contains('on')) resizeFly(); });

let last = performance.now(), ovT = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const rdt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!F || !$('fly').classList.contains('on')) return;
  const s = F.sim;
  if (!F.paused && !F.over) {
    const inp = readInput();
    F.acc += rdt * F.warp; let n = 0;
    while (F.acc >= DT && n < 4000) {
      s.step(DT, inp); F.acc -= DT; n++;
      if (s.t >= F.nextCam) {
        F.nextCam += 0.1;
        if (s.mode !== 'DISARMED' && !s.crashed) {
          const c = s.cameraAxes(90); F.cov.sample(s.p, c.f, c.r, c.d, L.terr, L.gsd);
          const agl = s.agl(), dist = Math.hypot(s.p[0] - plan.home[0], s.p[1] - plan.home[1]);
          if (dist > VLOS) F.vlosT += 0.1; if (agl > CEIL) F.ceilT += 0.1;
          F.gsdNow = agl > 3 ? (agl * 0.001454 / Math.max(0.2, Math.cos(eulerFromQ(s.q)[0]) * Math.cos(eulerFromQ(s.q)[1]))) : null;
        }
        if (Math.round(s.t * 10) % 10 === 0) { F.track.push([s.p[0], s.p[1]]); const i = world.trackN; if (i < 4000) { const p = n2t(s.p[0], s.p[1], s.p[2]); world.trackPts.set([p.x, p.y, p.z], i * 3); world.trackN++; world.trackGeo.setDrawRange(0, world.trackN); world.trackGeo.attributes.position.needsUpdate = true; } }
      }
      if (s.crashed || s.landed) break;
    }
    ovT += rdt; if (ovT > 0.4 && F.cov.version !== F.lastOv) { ovT = 0; F.lastOv = F.cov.version; drawOverlay(F.cov, L.gsd); }
    if ((s.crashed || s.landed) && !F.endTimer) F.endTimer = setTimeout(() => endFlight(s.crashed ? 'crash' : 'landed'), s.crashed ? 2200 : 1500);
  }
  // messages
  while (F.msgSeen < s.msgs.length) { const m = s.msgs[F.msgSeen++]; toast(m.s, /CRASH|low|Stall/i.test(m.s)); }
  // scene
  const M = placeModel(s);
  const p = n2t(s.p[0], s.p[1], s.p[2]);
  const gy = L.terr.at(s.p[0], s.p[1]); world.shadow.position.set(p.x, gy + 0.08, p.z);
  const agl = s.agl(); world.shadow.material.opacity = Math.max(0, 0.28 - agl / 160); world.shadow.scale.set(1 + agl / 40, 0.45 + agl / 60, 1);
  const e = eulerFromQ(s.q); const hdg = s.trans > 0.5 && Math.hypot(s.v[0], s.v[1]) > 5 ? Math.atan2(s.v[1], s.v[0]) : e[2];
  if (F.cam === 0) { // chase
    const back = new THREE.Vector3(-Math.sin(hdg), 0, Math.cos(hdg));    // three: north = -z, so behind = +z rotated
    const want = p.clone().add(back.multiplyScalar(orb.dist)).add(new THREE.Vector3(0, orb.dist * 0.32 + 1.5, 0));
    want.y = Math.max(want.y, L.terr.at(-want.z, want.x) + 2);
    cam.position.lerp(want, Math.min(1, 1 - Math.exp(-rdt * 4 * F.warp))); cam.fov = 55; cam.lookAt(p);
  } else if (F.cam === 1) {
    const d = orb.dist, want = new THREE.Vector3(p.x + Math.sin(orb.az) * Math.cos(orb.el) * d, p.y + Math.sin(orb.el) * d, p.z + Math.cos(orb.az) * Math.cos(orb.el) * d);
    want.y = Math.max(want.y, L.terr.at(-want.z, want.x) + 2); cam.position.copy(want); cam.fov = 55; cam.lookAt(p);
  } else if (F.cam === 2) {
    const want = new THREE.Vector3(p.x, Math.max(p.y + 380, 420), p.z + 0.01); cam.position.lerp(want, Math.min(1, 1 - Math.exp(-rdt * 3 * F.warp))); cam.fov = 55; cam.lookAt(p.x, gy, p.z);
  }
  cam.updateProjectionMatrix();
  // Walksnail camera (looking straight down from the belly, image top = nose)
  const c = s.cameraAxes(90), f = n2t(c.f[0], c.f[1], c.f[2]), up = n2t(-c.d[0], -c.d[1], -c.d[2]);
  pipCam.position.copy(p).add(f.clone().multiplyScalar(0.15)); pipCam.up.copy(up); pipCam.lookAt(pipCam.position.clone().add(f));
  pipCam.aspect = 16 / 9; pipCam.updateProjectionMatrix();
  const W = innerWidth, H = innerHeight;
  renderer.setViewport(0, 0, W, H); renderer.setScissorTest(false); renderer.clear();
  model.visible = F.cam !== 3;
  renderer.render(scene, F.cam === 3 ? pipCam : cam);
  if (F.cam !== 3 && W > 900) {
    const pw = 320, ph = 180; model.visible = false;
    renderer.setScissorTest(true); renderer.setScissor(W - pw - 16, 16, pw, ph); renderer.setViewport(W - pw - 16, 16, pw, ph); renderer.clearDepth();
    renderer.render(scene, pipCam); renderer.setScissorTest(false); model.visible = true;
  }
  $('pip').style.display = F.cam !== 3 && W > 900 ? '' : 'none'; $('pipLbl').style.display = $('pip').style.display;
  hud(s, e);
}
requestAnimationFrame(frame);

const MODE_TXT = { DISARMED: ['DISARMED', 'PRESS SPACE TO ARM'], QLOITER: ['HOVER', 'QLOITER · LIFT MOTORS'], FBWA: ['WING', 'FBWA · WING-BORNE'], AUTO: ['AUTO', 'MISSION'], QRTL: ['RETURN', 'QRTL · HEADING HOME'], CRASHED: ['CRASHED', ''] };
function hud(s, e) {
  const [m, sub] = MODE_TXT[s.mode] || [s.mode, ''];
  $('hMode').textContent = m;
  let subt = sub;
  if (s.mode === 'AUTO') subt = s.autoStage === 'TAKEOFF' ? 'VTOL TAKEOFF' : s.trans < 1 ? 'TRANSITION' : 'SURVEY';
  if ((s.mode === 'FBWA' || s.mode === 'AUTO') && s.trans > 0 && s.trans < 1) subt = 'TRANSITIONING · ' + Math.round(s.trans * 100) + '%';
  if (s.landed) subt = 'LANDED';
  $('hModeSub').textContent = subt;
  const gs = Math.hypot(s.v[0], s.v[1]);
  $('hVa').textContent = s.airspeed.toFixed(1); $('hGs').textContent = gs.toFixed(1); $('hAgl').textContent = Math.max(0, s.agl()).toFixed(0);
  $('hVs').textContent = (-s.v[2]).toFixed(1); $('hPw').textContent = Math.round(s.mode === 'DISARMED' ? 0 : s.power) + 'W'; $('hT').textContent = fmtT(s.t);
  const b = s.battPct(); $('hBatt').style.width = b * 100 + '%'; $('hBatt').style.background = b < 0.25 ? '#ff6b5b' : b < 0.45 ? '#ffc861' : '#8fe0b5';
  $('hBattTxt').textContent = Math.round(b * 100) + '% · ' + (AC.battWh - s.whUsed).toFixed(0) + ' Wh';
  const cv = F.cov.fraction(L.gsd); $('hCov').textContent = (cv * 100).toFixed(1) + '%'; $('hCovBar').style.width = cv * 100 + '%';
  $('hCovSub').textContent = `AT ${Math.round(L.gsd * 100)} CM/PX · GOAL ${Math.round(L.goal * 100)}%`;
  const dist = Math.hypot(s.p[0] - plan.home[0], s.p[1] - plan.home[1]); $('hDist').textContent = Math.round(dist) + ' m'; $('hDist').style.color = dist > VLOS ? '#ff8b7b' : '';
  $('hLine').textContent = s.mission && s.wpIdx < s.mission.wps.length ? `${Math.floor(s.wpIdx / 2) + 1} / ${Math.ceil(s.mission.wps.length / 2)}` : '—';
  $('hGsd').textContent = F.gsdNow ? (F.gsdNow * 100).toFixed(1) + ' cm/px' : '—';
  const wd = (L.wind.from + 180); $('windArrow').setAttribute('transform', `rotate(${wd - (F.cam === 0 ? (Math.atan2(s.v[1], s.v[0]) * 0) : 0)})`);
  $('windTxt').textContent = `${Math.round(mph(L.wind.speed))} mph from ${compass(L.wind.from)}`;
  const warn = dist > VLOS ? 'OUTSIDE LINE OF SIGHT — TURN BACK' : s.agl() > CEIL ? 'ABOVE 400 FT — DESCEND' : s.battPct() < 0.2 && !s.landed ? 'LOW BATTERY' : (F.paused ? 'PAUSED' : '');
  $('warn').style.display = warn ? 'block' : 'none'; $('warn').textContent = warn;
  document.querySelectorAll('#ctrlBar [data-m]').forEach(bt => bt.classList.toggle('on', bt.dataset.m === s.mode));
}

// ======================= debrief =======================
function endFlight(why) {
  if (!F || F.over) return; F.over = true; clearTimeout(F.endTimer);
  const s = F.sim; drawOverlay(F.cov, L.gsd, true);
  const cov = F.cov.fraction(L.gsd), batt = s.battPct(), t = s.t;
  const crashed = !!s.crashed, landed = s.landed && !crashed;
  const offPad = Math.hypot(s.p[0] - plan.home[0], s.p[1] - plan.home[1]);
  const vlos = F.vlosT > 2, ceil = F.ceilT > 2, par = PAR[L.key];
  let stars = 0; const reasons = [];
  if (crashed) reasons.push('Crashed: ' + s.crashed + '.');
  else if (!landed) reasons.push('The flight ended before the Stork landed.');
  else if (cov < L.goal) reasons.push(`Coverage ${(cov * 100).toFixed(1)}% is under the ${Math.round(L.goal * 100)}% goal.`);
  else {
    stars = 1;
    if (batt >= 0.25 && !vlos && !ceil) stars = 2; else reasons.push(batt < 0.25 ? 'Under 25% battery at landing.' : vlos ? 'Left the 1 km line-of-sight ring.' : 'Went above 400 ft.');
    if (stars === 2) { if (cov >= 0.97 && (!par || t <= par)) stars = 3; else reasons.push(cov < 0.97 ? `Third star needs 97% coverage (you got ${(cov * 100).toFixed(1)}%).` : `Third star needs a flight under ${fmtT(par)} (you took ${fmtT(t)}).`); }
  }
  const manual = !F.usedAuto && landed;
  const timePts = par ? Math.round(300 * Math.min(1.3, par / Math.max(t, 1))) : 200;
  const pen = (vlos ? 150 : 0) + (ceil ? 150 : 0) + (landed && offPad > 15 ? 100 : 0);
  const base = Math.round(cov * 600 + batt * 300 + timePts);
  const score = crashed || !landed ? Math.round(cov * 300) : Math.max(0, Math.round(base * (manual ? 1.25 : 1)) - pen);
  if (CAMPAIGN.includes(L.key)) { const best = store.get('best:' + L.key, null); if (!best || score > best.score || stars > best.stars) store.set('best:' + L.key, { score: Math.max(score, best?.score || 0), stars: Math.max(stars, best?.stars || 0) }); }
  $('dbKicker').textContent = crashed ? 'CRASHED' : landed ? 'MISSION COMPLETE' : 'FLIGHT ENDED';
  $('dbTitle').textContent = L.title;
  $('dbStars').innerHTML = '<b>★</b>'.repeat(stars) + '★'.repeat(3 - stars);
  $('dbScore').textContent = `SCORE ${score}${manual ? ' · MANUAL ×1.25' : ''}`;
  const rows = [['Field covered at ' + Math.round(L.gsd * 100) + ' cm/px', (cov * 100).toFixed(1) + '%'], ['Acres mapped', (cov * L.acres).toFixed(1) + ' of ' + Math.round(L.acres)],
    ['Flight time', fmtT(t) + (par ? ` (par ${fmtT(par)})` : '')], ['Battery left', Math.round(batt * 100) + '%'], ['Energy used', s.whUsed.toFixed(1) + ' Wh'],
    ['Max distance from pilot', Math.round(s.maxDist) + ' m' + (vlos ? ' ⚠' : '')], ['Max altitude', Math.round(s.maxAGL) + ' m' + (ceil ? ' ⚠' : '')]];
  if (landed) rows.push(['Landed from pad', offPad.toFixed(1) + ' m' + (offPad > 15 ? ' (−100)' : '')]);
  $('dbTable').innerHTML = rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('');
  $('dbReasons').textContent = reasons.join(' ') || 'Clean flight. Try flying it without AUTO for the manual bonus.';
  const idx = CAMPAIGN.indexOf(L.key);
  $('dbNext').style.display = idx >= 0 && idx < CAMPAIGN.length - 1 && stars > 0 ? '' : 'none';
  $('dbNext').onclick = () => openPlan(CAMPAIGN[idx + 1]);
  $('dbRetry').onclick = () => openPlan(L, true);
  $('dbMenu').onclick = () => { show('menu'); buildMenu(); };
  drawDebriefMap(s);
  $('debrief').classList.add('on');
}
function drawDebriefMap(s) {
  const cv = $('dbCanvas'), c = cv.getContext('2d'), W = cv.width, H = cv.height;
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9; for (const [x, y] of L.ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const sc = Math.min(W / (x1 - x0 + 120), H / (y1 - y0 + 120)), cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const w2 = (E, N) => [W / 2 + (E - cx) * sc, H / 2 - (N - cy) * sc];
  c.fillStyle = '#2a2f2b'; c.fillRect(0, 0, W, H);
  const [ix, iy] = w2(-1000, 1000); c.drawImage(L.img, ix, iy, 2000 * sc, 2000 * sc);
  const [ox, oy] = w2(-1000, 1000); c.drawImage(overlay.canvas, ox, oy, 2000 * sc, 2000 * sc);
  c.beginPath(); L.ring.forEach(([x, y], i) => { const p = w2(x, y); i ? c.lineTo(...p) : c.moveTo(...p); }); c.closePath(); c.strokeStyle = '#ffb547'; c.lineWidth = 3; c.stroke();
  c.beginPath(); F.track.forEach(([N, E], i) => { const p = w2(E, N); i ? c.lineTo(...p) : c.moveTo(...p); }); c.strokeStyle = 'rgba(255,255,255,.9)'; c.lineWidth = 2; c.stroke();
  c.fillStyle = 'rgba(16,20,18,.75)'; c.fillRect(0, H - 54, W, 54); c.font = '600 15px JetBrains Mono'; c.textBaseline = 'middle';
  [['#46e196', 'SHARP'], ['#ffb93c', 'TOO COARSE'], ['#e64637', 'MISSED']].forEach(([col, t], i) => { c.fillStyle = col; c.fillRect(20 + i * 190, H - 33, 14, 14); c.fillStyle = '#fff'; c.fillText(t, 42 + i * 190, H - 26); });
}
$('debrief').addEventListener('click', e => { if (e.target.id === 'debrief') {} });
function hideDebrief() { $('debrief').classList.remove('on'); }
['dbNext', 'dbRetry', 'dbMenu'].forEach(id => $(id).addEventListener('click', hideDebrief, true));

// ======================= free play =======================
let fmap = null, freeSel = null;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = rej; document.head.appendChild(s); }); }
async function openFree() {
  show('free');
  if (fmap) { fmap.resize(); return; }
  loading(true, 'LOADING MAP…');
  await loadScript('https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js');
  await loadScript('https://unpkg.com/pmtiles@3.2.0/dist/pmtiles.js');
  const protocol = new pmtiles.Protocol(); maplibregl.addProtocol('pmtiles', protocol.tile);
  const PM = 'pmtiles://https://data.source.coop/ftw/harmonized-field-data/us_usda_cropland/year=2024/us_usda_cropland-2024.pmtiles';
  fmap = new maplibregl.Map({ container: 'freeMap', center: [-95.72, 35.92], zoom: 12.5, maxZoom: 17.5,
    style: { version: 8, sources: {
      esri: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' },
      fields: { type: 'vector', url: PM, attribution: 'Fields: USDA NASS CSB via Fields of the World' } },
      layers: [{ id: 'esri', type: 'raster', source: 'esri' },
        { id: 'f-fill', type: 'fill', source: 'fields', 'source-layer': 'us_usda_cropland', minzoom: 11, paint: { 'fill-color': '#8fe0b5', 'fill-opacity': ['case', ['boolean', ['feature-state', 'hover'], false], 0.35, 0.08] } },
        { id: 'f-line', type: 'line', source: 'fields', 'source-layer': 'us_usda_cropland', minzoom: 11, paint: { 'line-color': '#ffb547', 'line-width': 1.1, 'line-opacity': 0.8 } },
        { id: 'f-sel', type: 'line', source: 'fields', 'source-layer': 'us_usda_cropland', minzoom: 11, paint: { 'line-color': '#ffffff', 'line-width': 3 }, filter: ['==', ['id'], -1] }] } });
  fmap.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-left');
  fmap.on('load', () => loading(false));
  setTimeout(() => loading(false), 6000);
  fmap.on('click', 'f-fill', e => {
    const f = e.features[0]; if (!f) return;
    const props = f.properties || {};
    const geom = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates.sort((a, b) => b[0].length - a[0].length)[0] : f.geometry.coordinates;
    const ring = geom[0]; const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length, lon0 = ring.reduce((a, p) => a + p[0], 0) / ring.length;
    const kx = 111320 * Math.cos(lat0 * Math.PI / 180), ky = 110540;
    const loc = ring.map(([lo, la]) => [(lo - lon0) * kx, (la - lat0) * ky]);
    let area = 0; for (let i = 0; i < loc.length - 1; i++) area += loc[i][0] * loc[i + 1][1] - loc[i + 1][0] * loc[i][1]; area = Math.abs(area / 2);
    let maxR = 0; loc.forEach(([x, y]) => maxR = Math.max(maxR, Math.hypot(x, y)));
    freeSel = { lon0, lat0, ring: loc.slice(0, -1), acres: area / 4046.86, crop: props['crop:name'] || props['hcat:name_en'] || props['hcat:name'] || 'crop field', maxR };
    fmap.setFilter('f-sel', ['==', ['id'], f.id ?? -1]);
    const tooBig = maxR > 900;
    $('freeSel').innerHTML = `<b>${freeSel.acres.toFixed(0)} acres</b> · ${freeSel.crop}<br><span class="mono" style="font-size:11px">${lat0.toFixed(4)}, ${lon0.toFixed(4)}</span>${tooBig ? '<br><span style="color:var(--rust)">Too big for one 2 km flight area. Pick a smaller field.</span>' : ''}`;
    $('bFreeGo').disabled = tooBig || freeSel.acres < 3;
  });
  fmap.on('mouseenter', 'f-fill', () => fmap.getCanvas().style.cursor = 'pointer'); fmap.on('mouseleave', 'f-fill', () => fmap.getCanvas().style.cursor = '');
  const jumps = [['Tulsa, OK', -95.72, 35.92, 12.5], ['Garden City, KS', -100.85, 37.97, 12], ['Central Iowa', -93.6, 42.0, 12], ['Central Valley, CA', -119.8, 36.6, 12], ['Red River, ND', -97.0, 47.3, 12]];
  $('freeJump').innerHTML = ''; jumps.forEach(([n, lo, la, z]) => { const b = document.createElement('button'); b.className = 'chip'; b.textContent = n; b.onclick = () => fmap.flyTo({ center: [lo, la], zoom: z }); $('freeJump').appendChild(b); });
}
['sFW', 'sFWD', 'sFG'].forEach(id => $(id).oninput = () => { $('vFW').textContent = $('sFW').value + ' mph'; $('vFWD').textContent = compass(+$('sFWD').value) + ' · ' + $('sFWD').value + '°'; $('vFG').textContent = $('sFG').value + ' cm/px'; });
$('bFreeGo').onclick = async () => {
  if (!freeSel) return;
  loading(true, 'FETCHING IMAGERY AND ELEVATION…');
  try {
    const { lon0, lat0 } = freeSel;
    const R = 6378137, mx = lon0 * Math.PI / 180 * R, my = Math.log(Math.tan(Math.PI / 4 + lat0 * Math.PI / 360)) * R, k = 1 / Math.cos(lat0 * Math.PI / 180), h = 1000 * k;
    const bbox = [mx - h, my - h, mx + h, my + h].join(',');
    const img = await loadImg(`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/export?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=2048,2048&format=jpg&f=image`);
    let heights = new Array(129 * 129).fill(0), n = 129;
    try {
      if (!window.GeoTIFF) await loadScript('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js');
      const buf = await fetch(`https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage?bbox=${bbox}&bboxSR=3857&imageSR=3857&size=129,129&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&f=image`).then(r => r.arrayBuffer());
      const tif = await GeoTIFF.fromArrayBuffer(buf); const im = await tif.getImage(); const [r] = await im.readRasters();
      heights = Array.from(r);
    } catch (e) { console.warn('elevation unavailable, using flat ground', e); }
    const ring = freeSel.ring;
    const sv = ring.reduce((a, p) => p[1] < a[1] ? p : a, ring[0]); const home = [sv[1] - 40, sv[0]];
    const terr = new Terrain(n, 2000, Float32Array.from(heights));
    const h0 = terr.at(home[0], home[1]); const rel = heights.map(v => v - h0);
    const lvl = { key: 'FREE', title: `${Math.round(freeSel.acres)}-acre ${freeSel.crop.toLowerCase()}`, sub: 'Free play', county: '', crop: freeSel.crop, acres: freeSel.acres,
      brief: 'A real field from the USDA outlines. Imagery from Esri World Imagery, elevation from USGS 3DEP.', ring, home,
      wind: { speed: +$('sFW').value / 2.237, from: +$('sFWD').value, gust: +$('sFW').value / 2.237 * 0.25 }, gsd: +$('sFG').value / 100, goal: 0.9,
      terrain: { n, size: 2000, h: rel }, img };
    lvl.terr = new Terrain(n, 2000, Float32Array.from(rel));
    loading(false); openPlan(lvl);
  } catch (e) { loading(false); $('freeSel').innerHTML += '<br><span style="color:var(--rust)">Could not load imagery for this spot. Try again.</span>'; console.error(e); }
};
$('navMenu').onclick = e => { e.preventDefault(); if (F) F.over = true; $('debrief').classList.remove('on'); show('menu'); buildMenu(); };
$('navFree').onclick = e => { e.preventDefault(); if (F) F.over = true; $('debrief').classList.remove('on'); openFree(); };
buildMenu();
window.__stork = { endFlight: w => endFlight(w), get F() { return F; } };
