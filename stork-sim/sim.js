// Stork VTOL flight simulator core — 6-DOF quadplane model + ArduPilot-style modes.
// Frames: world NED (x north, y east, z down), body FRD (x fwd, y right, z down). SI units.
// Runs in the browser and in Node (for headless tests).

export const AC = {
  mass: 2.6,                       // kg, all-up with 6S battery + Walksnail (assumption)
  I: [0.15, 0.10, 0.24],           // kg m^2 (roll, pitch, yaw) estimated
  S: 0.30, b: 1.613, c: 0.19,      // wing area (measured from model + body strip), span, MAC
  CL0: 0.25, CLa: 5.0, alphaStall: 0.23, CD0: 0.045, e: 0.8,
  CYb: -0.30,
  Clb: -0.06, Clp: -0.45, Clr: 0.10, Clda: 0.16,
  Cm0: 0.02, Cma: -0.80, Cmq: -12.0, Cmde: 0.90,
  Cnb: 0.06, Cnr: -0.10, Cnp: -0.03, Cndr: 0.05,
  dMax: 0.35,                      // control surface limit (rad)
  lift: { pos: [[0.23, -0.256], [0.23, 0.256], [-0.23, -0.256], [-0.23, 0.256]], spin: [-1, 1, 1, -1],
          Tmax: 16, tau: 0.045, kq: 0.018, A: Math.PI * 0.0889 ** 2, eff: 0.50 },
  push: { Tmax: 20, Vpitch: 32, tau: 0.15, A: Math.PI * 0.1143 ** 2, eff: 0.55 },
  battWh: 111, avionicsW: 9,       // 6S 5000 mAh LiPo (assumption), FC + GPS + Walksnail
  cgHeight: 0.11,                  // CG above skid contact
  vCruise: 17, vMin: 13, vTransition: 14, vStall: 10.6, bankMax: 0.61,
};

const G = 9.81, RHO = 1.2;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

// ---------- quaternion helpers (body -> world) ----------
function qmul(a, b) {
  return [a[0]*b[0]-a[1]*b[1]-a[2]*b[2]-a[3]*b[3], a[0]*b[1]+a[1]*b[0]+a[2]*b[3]-a[3]*b[2],
          a[0]*b[2]-a[1]*b[3]+a[2]*b[0]+a[3]*b[1], a[0]*b[3]+a[1]*b[2]-a[2]*b[1]+a[3]*b[0]];
}
function qnorm(q) { const n = Math.hypot(q[0], q[1], q[2], q[3]); return [q[0]/n, q[1]/n, q[2]/n, q[3]/n]; }
function qrot(q, v) { // rotate body vector into world
  const [w, x, y, z] = q;
  const r00 = 1-2*(y*y+z*z), r01 = 2*(x*y-w*z), r02 = 2*(x*z+w*y);
  const r10 = 2*(x*y+w*z), r11 = 1-2*(x*x+z*z), r12 = 2*(y*z-w*x);
  const r20 = 2*(x*z-w*y), r21 = 2*(y*z+w*x), r22 = 1-2*(x*x+y*y);
  return [r00*v[0]+r01*v[1]+r02*v[2], r10*v[0]+r11*v[1]+r12*v[2], r20*v[0]+r21*v[1]+r22*v[2]];
}
function qinv(q, v) { return qrot([q[0], -q[1], -q[2], -q[3]], v); }
export function eulerFromQ(q) {
  const [w, x, y, z] = q;
  return [Math.atan2(2*(w*x+y*z), 1-2*(x*x+y*y)), Math.asin(clamp(2*(w*y-z*x), -1, 1)), Math.atan2(2*(w*z+x*y), 1-2*(y*y+z*z))];
}
export function qFromEuler(r, p, y) {
  const cr = Math.cos(r/2), sr = Math.sin(r/2), cp = Math.cos(p/2), sp = Math.sin(p/2), cy = Math.cos(y/2), sy = Math.sin(y/2);
  return [cr*cp*cy+sr*sp*sy, sr*cp*cy-cr*sp*sy, cr*sp*cy+sr*cp*sy, cr*cp*sy-sr*sp*cy];
}

// ---------- terrain ----------
export class Terrain {
  // heights: Float32Array n*n, row 0 = north edge, col 0 = west edge; size metres; centred on (0,0)
  constructor(n, size, heights) { this.n = n; this.size = size; this.h = heights; }
  at(N, E) {
    const n = this.n, s = this.size, gx = (E / s + 0.5) * (n - 1), gy = (0.5 - N / s) * (n - 1);
    const x = clamp(gx, 0, n - 1.001), y = clamp(gy, 0, n - 1.001), i = x | 0, j = y | 0, fx = x - i, fy = y - j, h = this.h;
    const a = h[j*n+i], b = h[j*n+i+1], c = h[(j+1)*n+i], d = h[(j+1)*n+i+1];
    return a*(1-fx)*(1-fy) + b*fx*(1-fy) + c*(1-fx)*fy + d*fx*fy;
  }
}

// ---------- survey planning ----------
function pointInPoly(pt, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
export { pointInPoly };

// Walksnail Avatar HD Pro: 1920 px across 160 deg (equidistant fisheye), 1080 px across ~90 deg.
export const CAM = { fovX: 160 * Math.PI / 180, fovY: 90 * Math.PI / 180, px: 1920, py: 1080 };
CAM.dth = CAM.fovX / CAM.px;
// usable swath (m) at altitude h for a nadir camera and a ground-resolution target (m/px)
export function swathAt(h, gsdTarget) {
  const nad = h * CAM.dth;
  if (nad >= gsdTarget) return 0;
  const th = Math.min(Math.acos(Math.sqrt(nad / gsdTarget)), CAM.fovX / 2);
  return 2 * h * Math.tan(th);
}
export function gsdNadir(h) { return h * CAM.dth; }

// ring: [[E,N],...] ; returns waypoints [{N,E}] for a boustrophedon survey
export function planSurvey(ring, headingDeg, spacing, overshoot = 45) {
  const ps = headingDeg * Math.PI / 180, ux = Math.sin(ps), uy = Math.cos(ps); // along-line unit (E,N)
  const vx = uy, vy = -ux;                                                     // cross-line unit
  let cmin = 1e9, cmax = -1e9;
  for (const [x, y] of ring) { const c = x*vx + y*vy; cmin = Math.min(cmin, c); cmax = Math.max(cmax, c); }
  const lines = [];
  const width = cmax - cmin, nL = Math.max(1, Math.ceil(width / spacing));
  const off = (width - (nL - 1) * spacing) / 2;
  for (let k = 0; k < nL; k++) {
    const c = cmin + off + k * spacing;
    // intersect line {p : p.v = c} with polygon edges, get along-track extent
    const ts = [];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j], [x2, y2] = ring[i];
      const c1 = x1*vx + y1*vy, c2 = x2*vx + y2*vy;
      if ((c1 - c) * (c2 - c) <= 0 && c1 !== c2) {
        const t = (c - c1) / (c2 - c1), x = x1 + t*(x2-x1), y = y1 + t*(y2-y1); ts.push(x*ux + y*uy);
      }
    }
    if (ts.length < 2) continue;
    const a = Math.min(...ts) - overshoot, b = Math.max(...ts) + overshoot;
    const P = t => ({ E: c*vx + t*ux, N: c*vy + t*uy });
    lines.push(k % 2 === 0 ? [P(a), P(b)] : [P(b), P(a)]);
  }
  return lines.flat();
}

// ---------- coverage grid ----------
export class Coverage {
  constructor(ring, cell = 4) {
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    this.cell = cell; this.x0 = x0; this.y0 = y0;
    this.nx = Math.ceil((x1 - x0) / cell); this.ny = Math.ceil((y1 - y0) / cell);
    this.inside = new Uint8Array(this.nx * this.ny);
    this.best = new Float32Array(this.nx * this.ny).fill(99);
    let cnt = 0;
    for (let j = 0; j < this.ny; j++) for (let i = 0; i < this.nx; i++) {
      if (pointInPoly([x0 + (i + .5) * cell, y0 + (j + .5) * cell], ring)) { this.inside[j*this.nx+i] = 1; cnt++; }
    }
    this.total = cnt; this.version = 0;
  }
  // camera at world NED position p, camera axes in world: f (optical axis), r (image right), d (image down)
  sample(p, f, r, d, terrain, gsdTarget) {
    const { cell, x0, y0, nx, ny } = this;
    const h = -p[2] - terrain.at(p[0], p[1]);
    if (h < 3 || f[2] <= 0.05) return 0;
    // conservative ground bbox: rays up to 80 deg off-axis can reach far; cap at range where GSD > target
    const Rmax = gsdTarget / CAM.dth;                 // range beyond which even an on-axis pixel is too coarse
    const reach = Math.sqrt(Math.max(0, Rmax * Rmax - h * h));
    const ce = p[1], cn = p[0];
    const i0 = Math.max(0, Math.floor((ce - reach - x0) / cell)), i1 = Math.min(nx - 1, Math.ceil((ce + reach - x0) / cell));
    const j0 = Math.max(0, Math.floor((cn - reach - y0) / cell)), j1 = Math.min(ny - 1, Math.ceil((cn + reach - y0) / cell));
    const hx = CAM.fovX / 2, hy = CAM.fovY / 2; let hits = 0;
    const gz = terrain.at(cn, ce);
    for (let j = j0; j <= j1; j++) {
      const N = y0 + (j + .5) * cell;
      for (let i = i0; i <= i1; i++) {
        const k = j * nx + i; if (!this.inside[k]) continue;
        const E = x0 + (i + .5) * cell;
        const dx = N - p[0], dy = E - p[1], dz = -gz - p[2];
        const R = Math.hypot(dx, dy, dz);
        const cf = (dx*f[0] + dy*f[1] + dz*f[2]) / R; if (cf <= 0.02) continue;
        const cr = (dx*r[0] + dy*r[1] + dz*r[2]) / R, cd = (dx*d[0] + dy*d[1] + dz*d[2]) / R;
        const th = Math.acos(clamp(cf, -1, 1)), phi = Math.atan2(cd, cr);
        const ax = th * Math.cos(phi), ay = th * Math.sin(phi);         // equidistant fisheye image angles
        if (Math.abs(ax) > hx || Math.abs(ay) > hy) continue;
        const inc = dz / R;                                              // cos of incidence on flat ground
        const gsd = R * CAM.dth / Math.max(inc, 0.05);
        if (gsd < this.best[k]) { this.best[k] = gsd; hits++; }
      }
    }
    if (hits) this.version++;
    return hits;
  }
  fraction(gsdTarget) { let c = 0; for (let k = 0; k < this.best.length; k++) if (this.inside[k] && this.best[k] <= gsdTarget) c++; return c / this.total; }
}

// ---------- the simulator ----------
export class Sim {
  constructor({ terrain, home = [0, 0], homeYaw = 0, wind = { speed: 0, from: 0, gust: 0 }, seed = 1 } = {}) {
    this.ac = AC; this.terrain = terrain; this.home = home;
    this.wind = wind; this.seed = seed; this.gust = [0, 0, 0];
    const gz = terrain.at(home[0], home[1]);
    this.p = [home[0], home[1], -(gz + AC.cgHeight)];
    this.v = [0, 0, 0]; this.q = qFromEuler(0, 0, homeYaw); this.w = [0, 0, 0];
    this.lift = [0, 0, 0, 0]; this.push = 0; this.surf = [0, 0, 0];
    this.whUsed = 0; this.t = 0; this.mode = 'DISARMED'; this.msgs = []; this.events = [];
    this.onGround = true; this.crashed = null; this.landed = false;
    this.i = { z: 0, roll: 0, pitch: 0, yaw: 0, spd: 0, climb: 0, rr: 0, pr: 0 };
    this.target = { alt: 30, yaw: homeYaw, spd: AC.vCruise, pos: [...home] };
    this.trans = 0;      // 0 = hover, 1 = fixed wing (blend)
    this.mission = null; this.wpIdx = 0; this.maxAGL = 0; this.maxDist = 0;
    this.power = 0; this.airspeed = 0; this.aoa = 0;
  }
  msg(s) { this.msgs.push({ t: this.t, s }); if (this.msgs.length > 40) this.msgs.shift(); }
  rand() { this.seed = (this.seed * 16807) % 2147483647; return this.seed / 2147483647 - 0.5; }
  agl() { return -this.p[2] - this.terrain.at(this.p[0], this.p[1]) - AC.cgHeight; }
  battPct() { return Math.max(0, 1 - this.whUsed / AC.battWh); }

  windVec(dt) {
    const W = this.wind, d = W.from * Math.PI / 180;          // "from" direction, degrees true
    const tau = 3, k = dt / tau, sg = W.gust || 0;
    for (let i = 0; i < 3; i++) this.gust[i] += (-this.gust[i] * k + sg * Math.sqrt(2 * k) * this.rand() * 3.4) ;
    return [-Math.cos(d) * W.speed + this.gust[0], -Math.sin(d) * W.speed + this.gust[1], this.gust[2] * 0.3];
  }

  // ---------- modes ----------
  arm() { if (this.mode === 'DISARMED' && !this.crashed) { this.mode = 'QLOITER'; this.target.alt = this.agl(); this.target.pos = [this.p[0], this.p[1]]; this.target.yaw = eulerFromQ(this.q)[2]; this.msg('Armed'); } }
  setMode(m) {
    if (this.crashed || this.mode === 'DISARMED' && m !== 'AUTO') return;
    if (this.mode === 'DISARMED' && m === 'AUTO') { this.arm(); }
    const e = eulerFromQ(this.q);
    if (m === 'QLOITER') { this.target.pos = [this.p[0], this.p[1]]; this.target.yaw = e[2]; this.target.alt = Math.max(this.agl(), 0); if (this.trans > 0) this.msg('Back-transition'); }
    if (m === 'FBWA') { this.target.yaw = e[2]; this.target.alt = Math.max(this.agl(), 15); this.i.spd = 0; if (this.trans < 1) this.msg('Transition started'); }
    if (m === 'QRTL') { this.msg('Returning home'); }
    if (m === 'AUTO') { this.wpIdx = 0; this.autoStage = 'TAKEOFF'; this.target.pos = [this.p[0], this.p[1]]; this.target.yaw = e[2]; this.msg('Mission start'); }
    this.mode = m;
  }

  weathervane(dt, e, pilotYaw) {
    // ArduPilot Q_WVANE-style: point the nose into the wind while hovering so the wing isn't broadside
    if (pilotYaw || this.onGround) return;
    const w = this._windNow || [0, 0, 0], ws = Math.hypot(w[0], w[1]);
    if (ws < 1.5) return;
    const upwind = Math.atan2(-w[1], -w[0]);
    this.target.yaw = e[2] + clamp(wrap(upwind - e[2]), -1, 1) * Math.min(1, dt * 0.6 * 60) * 0.02;
  }

  // ---------- controllers ----------
  hoverControl(dt, cmd, e, vel, wantTrans) {
    // cmd: {vN, vE (desired ground velocity), vz (desired climb, +up), yawRate | yaw}
    const [ph, th, ps] = e;
    const kv = 1.2, aMax = 3.5;
    let aN = clamp(kv * (cmd.vN - vel[0]), -aMax, aMax), aE = clamp(kv * (cmd.vE - vel[1]), -aMax, aMax);
    const c = Math.cos(ps), s = Math.sin(ps);
    const aF = aN * c + aE * s, aR = -aN * s + aE * c;
    const lean = 0.45;
    let thd = clamp(-Math.atan(aF / G), -lean, lean), phd = clamp(Math.atan(aR / G), -lean, lean);
    if (wantTrans) { thd = clamp(thd, -0.05, 0.05); phd = clamp(phd, -0.15, 0.15); }
    const landing = cmd.vz < 0 && this.agl() < 1.5;
    if (landing) { const lim = this.onGround ? 0 : 0.08; thd = clamp(thd, -lim, lim); phd = clamp(phd, -lim, lim); }
    // vertical
    const climb = -vel[2], ez = cmd.vz - climb;
    this.i.z = clamp(this.i.z + ez * dt * 1.2, -4, 4);
    const az = G + 2.8 * ez + this.i.z;
    const tilt = Math.max(0.6, Math.cos(ph) * Math.cos(th));
    let Ttot = AC.mass * az / tilt;
    if (this.onGround && cmd.vz < 0) { this._gnd = Math.min(1, (this._gnd || 0) + dt * 1.5); Ttot *= (1 - 0.8 * this._gnd); this.i.z = Math.min(this.i.z, 0); this.i.rr = 0; this.i.pr = 0; }
    else this._gnd = 0;
    // yaw
    let yawRate = cmd.yawRate ?? clamp(1.5 * wrap(cmd.yaw - ps), -1.0, 1.0);
    // attitude -> rates -> moments
    const pd = 6 * (phd - ph), qd = 6 * (thd - th), rd = yawRate;
    const ep = pd - this.w[0], eq = qd - this.w[1], er = rd - this.w[2];
    this.i.rr = clamp(this.i.rr + ep * dt, -0.5, 0.5); this.i.pr = clamp(this.i.pr + eq * dt, -0.5, 0.5);
    const Mr = AC.I[0] * (14 * ep + 4 * this.i.rr), Mp = AC.I[1] * (14 * eq + 4 * this.i.pr), My = AC.I[2] * 4 * er;
    return { Ttot, Mr, Mp, My, phd, thd };
  }
  mixLift(Ttot, Mr, Mp, My, scale = 1) {
    const L = AC.lift; const out = [];
    for (let i = 0; i < 4; i++) {
      const [rx, ry] = L.pos[i];
      let T = Ttot / 4 - Math.sign(ry) * Mr / (4 * 0.256) + Math.sign(rx) * Mp / (4 * 0.23) + L.spin[i] * My / (4 * L.kq);
      out.push(clamp(T * scale, 0, L.Tmax));
    }
    return out;
  }
  fwControl(dt, e, cmd, Va, climb) {
    // cmd: {bank, climb (m/s), spd}
    const [ph, th] = e;
    const qbar = Math.max(0.5 * RHO * Va * Va, 30), sc = clamp(170 / qbar, 0.35, 3);
    const pd = clamp(3.0 * (cmd.bank - ph), -1.6, 1.6);
    const ep = pd - this.w[0]; this.i.roll = clamp(this.i.roll + ep * dt, -0.6, 0.6);
    const da = clamp(sc * (0.14 * ep + 0.06 * this.i.roll), -AC.dMax, AC.dMax);
    const ec = cmd.climb - climb; this.i.climb = clamp(this.i.climb + ec * dt * 0.05, -0.2, 0.2);
    const thd = clamp(0.03 + Math.asin(clamp(cmd.climb / Math.max(Va, 8), -0.5, 0.5)) + 0.04 * ec + this.i.climb, -0.35, 0.35);
    const qff = G / Math.max(Va, 8) * Math.sin(ph) * Math.tan(ph);
    const qd = clamp(2.5 * (thd - th), -0.8, 0.8) + qff;
    const eq = qd - this.w[1]; this.i.pitch = clamp(this.i.pitch + eq * dt, -0.5, 0.5);
    const de = clamp(sc * (0.25 * eq + 0.25 * this.i.pitch) + 0.02, -AC.dMax, AC.dMax);
    const rff = G / Math.max(Va, 8) * Math.sin(ph);
    const dr = clamp(sc * (0.4 * (rff - this.w[2]) - 1.2 * this.beta), -AC.dMax, AC.dMax);
    // airspeed via pusher
    const es = cmd.spd - Va; this.i.spd = clamp(this.i.spd + es * dt, -15, 15);
    const Dest = 0.5 * RHO * Va * Va * AC.S * (AC.CD0 + 0.02);
    const Tcmd = clamp(Dest + AC.mass * G * clamp(cmd.climb / Math.max(Va, 8), -0.3, 0.3) + 2.0 * es + 0.6 * this.i.spd, 0, AC.push.Tmax);
    return { da, de, dr, Tcmd };
  }

  l1(Va, a, b) {
    // L1 guidance along segment a->b (NE). returns lateral accel demand and progress
    const vel = this.vg, gs = Math.max(Math.hypot(vel[0], vel[1]), 5);
    const L1 = Math.max(0.24 * (this.mission?.l1p ?? 16) * gs, this.mission?.l1p ? 22 : 30);
    const AB = [b[0] - a[0], b[1] - a[1]], ABl = Math.hypot(AB[0], AB[1]) || 1, u = [AB[0] / ABl, AB[1] / ABl];
    const AP = [this.p[0] - a[0], this.p[1] - a[1]];
    const along = AP[0] * u[0] + AP[1] * u[1], xt = AP[0] * u[1] - AP[1] * u[0];   // xt >0 : right of track? (N,E): cross = AP x u
    // look-ahead point on line
    const la = Math.sqrt(Math.max(L1 * L1 - xt * xt, 1));
    const tgt = [a[0] + u[0] * (along + la), a[1] + u[1] * (along + la)];
    const toT = [tgt[0] - this.p[0], tgt[1] - this.p[1]];
    const eta = wrap(Math.atan2(toT[1], toT[0]) - Math.atan2(vel[1], vel[0]));
    const acc = 2 * gs * gs / L1 * Math.sin(clamp(eta, -Math.PI / 2, Math.PI / 2));
    return { acc, along, len: ABl, xt };
  }

  autopilot(dt, input, e, Va) {
    const vel = this.vg, climb = -vel[2], agl = this.agl();
    const M = this.mission;
    let hov = null, fw = null, wantFW = false;
    const posHold = (tp, vmax = 5) => {
      const dN = tp[0] - this.p[0], dE = tp[1] - this.p[1], d = Math.hypot(dN, dE);
      const sp = Math.min(vmax, 0.6 * d); return { vN: d > 0.1 ? dN / d * sp : 0, vE: d > 0.1 ? dE / d * sp : 0, d };
    };
    const altHold = (alt, vmax = 2.5) => clamp(0.8 * (alt - agl), -vmax, vmax);
    if (this.mode === 'QLOITER') {
      const ps = e[2], c = Math.cos(ps), s = Math.sin(ps);
      const f = input.pitch * 6, r = input.roll * 6;
      let vN = f * c - r * s, vE = f * s + r * c;
      if (Math.abs(input.pitch) < 0.05 && Math.abs(input.roll) < 0.05) { const ph = posHold(this.target.pos, 3); vN = ph.vN; vE = ph.vE; }
      else this.target.pos = [this.p[0] + vN * 0.5, this.p[1] + vE * 0.5];
      let vz = input.throttle * 3;
      if (vz < 0) vz = Math.max(vz, agl > 10 ? -2.5 : agl > 3 ? -1.2 : -0.5);
      if (this.onGround && input.throttle <= 0) vz = -1;
      if (Math.abs(input.yaw) > 0.05) this.target.yaw = ps + input.yaw * 0.3;
      this.weathervane(dt, e, Math.abs(input.yaw) > 0.05);
      hov = { vN, vE, vz, yawRate: Math.abs(input.yaw) > 0.05 ? input.yaw * 1.2 : undefined, yaw: this.target.yaw };
      if (this.trans > 0 && Va > 9) { hov.vN = vel[0] * 0.9; hov.vE = vel[1] * 0.9; this.target.pos = [this.p[0], this.p[1]]; }
    } else if (this.mode === 'FBWA') {
      wantFW = true;
      if (Math.abs(input.roll) > 0.05) { fw = { bank: input.roll * AC.bankMax }; this.target.yaw = e[2]; }
      else { const herr = wrap(this.target.yaw - Math.atan2(vel[1], vel[0])); fw = { bank: clamp(1.2 * herr, -0.35, 0.35) }; }
      if (Math.abs(input.pitch) > 0.05) { fw.climb = input.pitch * 4; this.target.alt = agl; } else fw.climb = altHold(this.target.alt, 3);
      this.target.spd = clamp(this.target.spd + input.throttle * dt * 4, AC.vMin, 24);
      fw.spd = this.target.spd;
    } else if (this.mode === 'AUTO' || this.mode === 'QRTL') {
      const alt = M ? M.alt : 40;
      if (this.mode === 'AUTO' && this.autoStage === 'TAKEOFF') {
        hov = { ...posHold(this.target.pos, 2), vz: altHold(alt * 0.6 + 8, 2.5), yaw: this.target.yaw };
        if (M && M.wps.length) this.target.yaw = Math.atan2(M.wps[0].E - this.p[1], M.wps[0].N - this.p[0]);
        if (agl > Math.min(alt * 0.6 + 4, alt - 2) && Math.abs(wrap(this.target.yaw - e[2])) < 0.15) { this.autoStage = 'WP'; this.msg('Transition to forward flight'); this.i.spd = 0; }
      } else if (this.mode === 'AUTO' && this.autoStage === 'WP') {
        wantFW = true;
        const wps = M.wps; const i = this.wpIdx;
        const a = i === 0 ? [this.home[0], this.home[1]] : [wps[i - 1].N, wps[i - 1].E], b = [wps[i].N, wps[i].E];
        const g = this.l1(Va, a, b);
        const bank = clamp(Math.atan(g.acc / G), -AC.bankMax, AC.bankMax);
        fw = { bank, climb: altHold(wps[i].alt ?? alt, 3), spd: M.spd || AC.vCruise };
        if (g.along >= g.len - 2) { this.wpIdx++; if (this.wpIdx >= wps.length) { this.mode = 'QRTL'; this.msg(M.course ? 'Course done — returning to the pad' : 'Survey complete — returning home'); } else if (!M.course && this.wpIdx % 2 === 0) this.msg(`Line ${this.wpIdx / 2 + 1} of ${Math.ceil(wps.length / 2)}`); }
      }
      if (this.mode === 'QRTL') {
        const dN = this.home[0] - this.p[0], dE = this.home[1] - this.p[1], d = Math.hypot(dN, dE);
        const stopDist = Va * Va / (2 * 0.9) + 25;
        if (this._qrtlDecel === undefined || this.mode !== this._qrtlMode) { this._qrtlDecel = this.trans < 0.5; this._qrtlMode = this.mode; }
        if (!this._qrtlDecel && d <= stopDist) { this._qrtlDecel = true; this.msg('Back-transition — slowing to hover'); }
        if (!this._qrtlDecel) {
          wantFW = true;
          const g = this.l1(Va, [this.p[0] - Math.cos(Math.atan2(dE, dN)) * 5, this.p[1] - Math.sin(Math.atan2(dE, dN)) * 5], this.home);
          fw = { bank: clamp(Math.atan(g.acc / G), -AC.bankMax, AC.bankMax), climb: altHold(Math.max(alt, 30), 3), spd: AC.vCruise };
        } else {
          const ph = posHold(this.home, 6);
          const gs = Math.hypot(vel[0], vel[1]);
          if (ph.d < 2.5 && gs < 0.8) this._overHome = true; else if (ph.d > 6) this._overHome = false;
          const descend = this._overHome ? (agl > 8 ? -1.8 : agl > 2 ? -0.7 : -0.4) : altHold(Math.max(15, Math.min(agl, alt)), 2);
          if (Va > 7 && this.trans > 0) { ph.vN = vel[0] * 0.9; ph.vE = vel[1] * 0.9; }
          if (ph.d > 8 && Va < 8) this.target.yaw = Math.atan2(dE, dN); else this.weathervane(dt, e, false);
          hov = { vN: ph.vN, vE: ph.vE, vz: descend, yaw: this.target.yaw };
        }
      }
    }
    return { hov, fw, wantFW };
  }

  // ---------- one physics step ----------
  step(dt, input = { roll: 0, pitch: 0, yaw: 0, throttle: 0 }) {
    if (this.crashed) return;
    const W = this.windVec(dt); this._windNow = W;
    if (this.mode === 'DISARMED' && this.onGround) {      // resting on the skids: hold still
      this.v = [0, 0, 0]; this.w = [0, 0, 0]; this.lift = [0, 0, 0, 0]; this.push = 0; this.t += dt; this.vg = this.v; this.airspeed = Math.hypot(W[0], W[1]); return;
    }
    const e = eulerFromQ(this.q);
    this.vg = this.v;
    const vair = [this.v[0] - W[0], this.v[1] - W[1], this.v[2] - W[2]];
    const vb = qinv(this.q, vair);
    const Va = Math.hypot(vb[0], vb[1], vb[2]); this.airspeed = Va;
    const alpha = Math.atan2(vb[2], Math.max(vb[0], 0.1)), beta = Va > 1 ? Math.asin(clamp(vb[1] / Va, -1, 1)) : 0;
    this.aoa = alpha; this.beta = beta;

    // ---- autopilot ----
    let liftCmd = [0, 0, 0, 0], pushCmd = 0, surf = [0, 0, 0];
    if (this.mode !== 'DISARMED') {
      const ap = this.autopilot(dt, input, e, Va);
      // transition state machine
      if (ap.wantFW) {
        if (this.trans < 1) { if (Va > AC.vTransition) this.trans = Math.min(1, this.trans + dt / 1.5); }
      } else if (this.trans > 0 && Va < 9) this.trans = Math.max(0, this.trans - dt / 1.0);
      this._wantFW = ap.wantFW;
      if (this.trans >= 1 && !this._fwMsg) { this.msg('Transition done — wing-borne'); this._fwMsg = true; }
      if (this.trans <= 0 && this._fwMsg) { this._fwMsg = false; this.msg('Hovering on lift motors'); }
      const fwCmd = ap.fw || { bank: 0, climb: 0, spd: AC.vCruise };
      const fwOut = this.fwControl(dt, e, fwCmd, Va, -this.v[2]);
      if (ap.wantFW) {
        surf = [fwOut.da, fwOut.de, fwOut.dr];
        pushCmd = this.trans < 1 ? AC.push.Tmax : fwOut.Tcmd;
        // quad assist while transitioning or if airspeed low
        const assist = this.trans < 1 ? 1 : (Va < AC.vMin - 1 ? 0.6 : 0);
        if (assist > 0) {
          const hv = this.hoverControl(dt, { vN: this.v[0], vE: this.v[1], vz: fwCmd.climb ?? 0, yaw: e[2] }, e, this.v, true);
          const liftShare = clamp(1 - (0.5 * RHO * Va * Va * AC.S * 0.7) / (AC.mass * G), 0, 1);
          liftCmd = this.mixLift(hv.Ttot * liftShare, hv.Mr, hv.Mp, hv.My * 0.3, assist);
        }
      } else if (ap.hov) {
        const hv = this.hoverControl(dt, ap.hov, e, this.v, false);
        const wingShare = Va > 6 ? clamp(1 - (0.5 * RHO * Va * Va * AC.S * 0.6) / (AC.mass * G), 0.15, 1) : 1;
        liftCmd = this.mixLift(hv.Ttot * wingShare, hv.Mr, hv.Mp, hv.My);
        pushCmd = 0;
        surf = Va > 8 ? [fwOut.da * 0.6, fwOut.de, fwOut.dr] : [0, 0, 0];
        if (this.onGround && ap.hov.vz < 0 && (this.mode === 'QRTL' || this.mode === 'QLOITER') && Math.hypot(this.v[0], this.v[1], this.v[2]) < 0.4 && this.t > 3) {
          this._landT = (this._landT || 0) + dt;
          if (this._landT > 1.0) { this.mode = 'DISARMED'; this.landed = true; this.msg('Landed — disarmed'); this.events.push({ t: this.t, type: 'landed' }); }
        } else this._landT = 0;
      }
    }
    // ---- actuators ----
    const L = AC.lift;
    for (let i = 0; i < 4; i++) this.lift[i] += (liftCmd[i] - this.lift[i]) * Math.min(1, dt / L.tau);
    this.push += (pushCmd - this.push) * Math.min(1, dt / AC.push.tau);
    for (let i = 0; i < 3; i++) this.surf[i] += (surf[i] - this.surf[i]) * Math.min(1, dt / 0.04);

    // ---- forces & moments (body) ----
    let F = [0, 0, 0], Mo = [0, 0, 0];
    const qbar = 0.5 * RHO * Va * Va;
    if (Va > 0.5) {
      const sig = 1 / (1 + Math.exp(-40 * (Math.abs(alpha) - AC.alphaStall)));
      const CLlin = AC.CL0 + AC.CLa * alpha;
      const CL = (1 - sig) * CLlin + sig * 1.1 * Math.sin(2 * alpha);
      const CD = AC.CD0 + (CLlin * CLlin) / (Math.PI * AC.e * (AC.b * AC.b / AC.S)) * (1 - sig) + sig * 1.2 * Math.sin(alpha) ** 2;
      const Lf = qbar * AC.S * CL, Df = qbar * AC.S * CD, Yf = qbar * AC.S * AC.CYb * beta;
      const ca = Math.cos(alpha), sa = Math.sin(alpha);
      // drag along -airflow direction, lift perpendicular
      const ux = vb[0] / Va, uy = vb[1] / Va, uz = vb[2] / Va;
      F[0] += -Df * ux + Lf * sa; F[1] += -Df * uy + Yf; F[2] += -Df * uz - Lf * ca;
      const Vr = Math.max(Va, 4), [p, q, r] = this.w;
      const Cl = AC.Clb * beta + AC.Clp * p * AC.b / (2 * Vr) + AC.Clr * r * AC.b / (2 * Vr) + AC.Clda * this.surf[0];
      const Cm = AC.Cm0 + AC.Cma * alpha * (1 - sig) - 0.3 * sig * Math.sign(alpha) + AC.Cmq * q * AC.c / (2 * Vr) + AC.Cmde * this.surf[1];
      const Cn = AC.Cnb * beta + AC.Cnr * r * AC.b / (2 * Vr) + AC.Cnp * p * AC.b / (2 * Vr) + AC.Cndr * this.surf[2];
      Mo[0] += qbar * AC.S * AC.b * Cl; Mo[1] += qbar * AC.S * AC.c * Cm; Mo[2] += qbar * AC.S * AC.b * Cn;
    }
    // airframe rotational damping at low speed (props, body)
    Mo[0] -= 0.02 * this.w[0]; Mo[1] -= 0.02 * this.w[1]; Mo[2] -= 0.03 * this.w[2];
    let Ptot = AC.avionicsW;
    for (let i = 0; i < 4; i++) {
      const T = this.lift[i], [rx, ry] = L.pos[i];
      F[2] -= T; Mo[0] += -ry * T; Mo[1] += rx * T; Mo[2] += L.spin[i] * L.kq * T;
      // power: momentum theory, reduced with edgewise airflow
      const vi = Math.sqrt(T / (2 * RHO * L.A) + (Va * Va / 4) ** 2 / (2 * RHO * L.A + 1) ) ;
      const vind = Math.sqrt(Math.max(0, -Va * Va / 2 + Math.sqrt(Va ** 4 / 4 + (T / (2 * RHO * L.A)) ** 2)));
      Ptot += T * (vind + 0.0 * vi) / L.eff;
    }
    {
      const Vax = Math.max(vb[0], 0), Tav = this.push * clamp(1 - Vax / AC.push.Vpitch, 0, 1);
      F[0] += Tav;
      const vi = -Vax / 2 + Math.sqrt(Vax * Vax / 4 + Tav / (2 * RHO * AC.push.A));
      Ptot += Tav * (Vax + vi) / AC.push.eff;
      this.pushThrust = Tav;
    }
    this.power = Ptot;
    if (this.mode !== 'DISARMED') this.whUsed += Ptot * dt / 3600;

    // world forces
    let Fw = qrot(this.q, F); Fw[2] += AC.mass * G;
    // ---- ground contact ----
    const pts = [[0.10, -0.12, AC.cgHeight], [0.10, 0.12, AC.cgHeight], [-0.55, 0, AC.cgHeight], [0.3, 0, 0.07]];
    let contact = false;
    for (const cp of pts) {
      const rw = qrot(this.q, cp), P = [this.p[0] + rw[0], this.p[1] + rw[1], this.p[2] + rw[2]];
      const gz = -this.terrain.at(P[0], P[1]), pen = P[2] - gz;
      if (pen > 0) {
        contact = true;
        // velocity of contact point
        const wv = qrot(this.q, [this.w[1] * cp[2] - this.w[2] * cp[1], this.w[2] * cp[0] - this.w[0] * cp[2], this.w[0] * cp[1] - this.w[1] * cp[0]]);
        const vc = [this.v[0] + wv[0], this.v[1] + wv[1], this.v[2] + wv[2]];
        if (vc[2] > 3.0 && !this.crashed) this.crash(`Hard landing (${vc[2].toFixed(1)} m/s vertical)`);
        const Fn = Math.max(0, 4000 * pen + 180 * vc[2]);
        const Fc = [-0.9 * Fn * Math.tanh(vc[0] * 3), -0.9 * Fn * Math.tanh(vc[1] * 3), -Fn];
        Fw = [Fw[0] + Fc[0], Fw[1] + Fc[1], Fw[2] + Fc[2]];
        const Fb = qinv(this.q, Fc);
        Mo[0] += cp[1] * Fb[2] - cp[2] * Fb[1]; Mo[1] += cp[2] * Fb[0] - cp[0] * Fb[2]; Mo[2] += cp[0] * Fb[1] - cp[1] * Fb[0];
      }
    }
    if (contact && Math.hypot(this.v[0], this.v[1]) > 6 && !this.crashed) this.crash('Hit the ground at speed');
    if (contact && Math.abs(e[0]) > 0.9 && !this.crashed) this.crash('Rolled over on the ground');
    this.onGround = contact;
    // ---- integrate ----
    for (let i = 0; i < 3; i++) { this.v[i] += Fw[i] / AC.mass * dt; this.p[i] += this.v[i] * dt; }
    const I = AC.I, w = this.w;
    const Iw = [I[0] * w[0], I[1] * w[1], I[2] * w[2]];
    const cr = [w[1] * Iw[2] - w[2] * Iw[1], w[2] * Iw[0] - w[0] * Iw[2], w[0] * Iw[1] - w[1] * Iw[0]];
    for (let i = 0; i < 3; i++) w[i] += (Mo[i] - cr[i]) / I[i] * dt;
    const dq = qmul(this.q, [0, w[0], w[1], w[2]]);
    this.q = qnorm([this.q[0] + 0.5 * dq[0] * dt, this.q[1] + 0.5 * dq[1] * dt, this.q[2] + 0.5 * dq[2] * dt, this.q[3] + 0.5 * dq[3] * dt]);
    this.t += dt;
    // ---- bookkeeping / failsafes ----
    const agl = this.agl();
    if (this.mode !== 'DISARMED') {
      if (agl > this.maxAGL) { this.maxAGL = agl; this.maxAGLt = this.t; this.maxAGLmode = this.mode + (this.trans).toFixed(2); }
      this.maxDist = Math.max(this.maxDist, Math.hypot(this.p[0] - this.home[0], this.p[1] - this.home[1]));
      if (this.battPct() < 0.2 && !this._lowBatt) { this._lowBatt = true; this.msg('Battery low — RTL'); this.events.push({ t: this.t, type: 'lowbatt' }); if (this.mode !== 'QRTL') this.mode = 'QRTL'; }
      if (this.battPct() <= 0.0) { this.crash('Battery depleted'); }
      if (Va < AC.vStall * 0.9 && this.trans >= 1 && this._wantFW && agl > 3 && !this._stallMsg) { this._stallMsg = true; this.msg('Stall warning — Q-assist'); }
      if (Va > AC.vStall) this._stallMsg = false;
    }
  }
  crash(why) { this.crashed = why; this.mode = 'CRASHED'; this.msg('CRASH: ' + why); this.events.push({ t: this.t, type: 'crash', why }); }

  // camera axes in world (Walksnail, tilt deg below the nose: 90 = straight down)
  cameraAxes(tiltDeg = 90) {
    const t = tiltDeg * Math.PI / 180;
    const fB = [Math.cos(t), 0, Math.sin(t)], rB = [0, 1, 0], dB = [-Math.sin(t), 0, Math.cos(t)];
    return { f: qrot(this.q, fB), r: qrot(this.q, rB), d: qrot(this.q, dB) };
  }
}
