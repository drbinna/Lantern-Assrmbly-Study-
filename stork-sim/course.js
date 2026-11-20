// Ring courses: fly through every ring in order, then land back on the pad.
// Ring positions are N/E metres in the level frame, alt is metres above the ground under the ring.
// Runs in the browser and in Node (headless par runs).

export const COURSES = {
  C1: {
    key: 'C1', level: 'L1', title: 'Training Loop', sub: 'Ring course · easy',
    brief: 'A wide loop around the First Flight wheat field. Eight big rings, gentle turns and a light breeze. Fly it on the wing, or hover through if you want to take it slow.',
    radius: 8, par: [135, 180], demoSeed: 7,
    rings: [
      [-150, 40, 28], [-110, -150, 32], [20, -235, 38], [175, -160, 44],
      [230, 20, 44], [170, 200, 38], [20, 260, 32], [-120, 200, 28],
    ],
  },
  C2: {
    key: 'C2', level: 'L3', title: 'Crosswind Slalom', sub: 'Ring course · hard',
    brief: 'Slalom north through the corn with a 15 mph crosswind from the west, climb through the high gates, then race back south. Smaller rings, bigger height changes.',
    radius: 8, par: [200, 270], demoSeed: 3,
    rings: [
      [-400, 18, 25], [-290, -18, 30], [-170, 18, 36], [-40, -18, 42],
      [90, 18, 48], [220, -25, 55], [290, -170, 60], [210, -310, 55],
      [80, -340, 46], [-50, -300, 38], [-180, -340, 32], [-310, -290, 28],
      [-430, -190, 24],
    ],
  },
};

export class Course {
  constructor(def, terrain, home) {
    this.def = def; this.home = home; this.r = def.radius;
    const H = { N: home[0], E: home[1], alt: def.rings[0][2] };
    const pts = def.rings.map(([N, E, alt]) => ({ N, E, alt }));
    // smooth racing line: centripetal Catmull-Rom through pad -> rings -> pad
    const P = [H, ...pts, H];
    const path = [], ringIdx = [];
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
      const len = Math.hypot(p2.N - p1.N, p2.E - p1.E), n = Math.max(2, Math.ceil(len / 10));
      for (let j = (i ? 1 : 0); j <= n; j++) {
        const t = j / n, q = cr(p0, p1, p2, p3, t);
        path.push({ N: q[0], E: q[1], alt: p1.alt + (p2.alt - p1.alt) * (i === 0 ? 1 : t) });
        if (j === n && i < P.length - 2) ringIdx.push(path.length - 1);
      }
    }
    this.path = path; this.ringIdx = ringIdx;
    this.rings = pts.map((p, k) => {
      const a = path[ringIdx[k] - 1], b = path[ringIdx[k] + 1], n = norm2([b.N - a.N, b.E - a.E]);
      return { ...p, D: -(terrain.at(p.N, p.E) + p.alt), n: [n[0], n[1], 0], get c() { return [this.N, this.E, this.D]; }, state: 'todo' };
    });
    for (const q of path) q.D = -(terrain.at(q.N, q.E) + q.alt);
    this.next = 0; this.clips = 0; this.penalty = 0; this.splits = [];
  }
  get done() { return this.next >= this.rings.length; }
  // returns an event or null for the segment p0 -> p1 (NED)
  check(p0, p1, t) {
    for (let k = this.next; k < Math.min(this.rings.length, this.next + 3); k++) {
      const R = this.rings[k], C = R.c, s0 = dot3(sub3(p0, C), R.n), s1 = dot3(sub3(p1, C), R.n);
      if (!(s0 < 0 && s1 >= 0)) continue;
      const f = s0 / (s0 - s1), x = [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f, p0[2] + (p1[2] - p0[2]) * f];
      const d = sub3(x, C), along = dot3(d, R.n), rad = Math.hypot(d[0] - along * R.n[0], d[1] - along * R.n[1], d[2]);
      if (rad > this.r + 1.3) continue;                       // went past it, not through it
      if (k !== this.next) return { type: 'order', ring: k, want: this.next };
      const clip = rad > this.r - 0.6;                        // wingtip (0.8 m) touched the ring
      R.state = 'done'; this.next++; this.splits.push(t);
      if (clip) { this.clips++; this.penalty += 3; }
      return { type: clip ? 'clip' : 'pass', ring: k, rad, last: this.done };
    }
    return null;
  }
  // autopilot follows the racing line; returns the waypoint index to resume from
  mission(spd = 17) {
    return { course: true, l1p: 6, alt: this.rings[0].alt, spd, wps: this.path.slice(1, this.ringIdx[this.ringIdx.length - 1] + 1).map(q => ({ N: q.N, E: q.E, alt: q.alt })) };
  }
  resumeIdx(p) {
    const lo = this.next ? this.ringIdx[this.next - 1] : 0, hi = this.ringIdx[Math.min(this.next, this.ringIdx.length - 1)];
    let best = hi, bd = 1e9;
    for (let i = lo; i <= hi; i++) { const d = Math.hypot(this.path[i].N - p[0], this.path[i].E - p[1]); if (d < bd) { bd = d; best = i; } }
    return Math.max(0, Math.min(hi, best + 3) - 1);   // mission wps start at path[1]
  }
  minRadius() {
    let m = 1e9; const P = this.path;
    for (let i = 1; i < P.length - 1; i++) {
      const a = P[i - 1], b = P[i], c = P[i + 1];
      const ab = Math.hypot(b.N - a.N, b.E - a.E), bc = Math.hypot(c.N - b.N, c.E - b.E), ac = Math.hypot(c.N - a.N, c.E - a.E);
      const cross = Math.abs((b.N - a.N) * (c.E - a.E) - (b.E - a.E) * (c.N - a.N));
      if (cross > 1e-6) m = Math.min(m, ab * bc * ac / (2 * cross));
    }
    return m;
  }
}
function cr(p0, p1, p2, p3, t) {   // centripetal Catmull-Rom (alpha = 0.5) in N/E
  const P = [p0, p1, p2, p3].map(p => [p.N, p.E]);
  const tj = (a, b) => Math.max(1e-3, Math.hypot(b[0] - a[0], b[1] - a[1]) ** 0.5);
  const t0 = 0, t1 = t0 + tj(P[0], P[1]) + (P[0] === P[1] || (p0 === p1) ? 0 : 0), t2 = t1 + tj(P[1], P[2]), t3 = t2 + tj(P[2], P[3]);
  const T = t1 + (t2 - t1) * t;
  const L = (A, B, ta, tb) => { const k = tb - ta < 1e-6 ? 0 : (T - ta) / (tb - ta); return [A[0] + (B[0] - A[0]) * k, A[1] + (B[1] - A[1]) * k]; };
  const A1 = L(P[0], P[1], t0, t1), A2 = L(P[1], P[2], t1, t2), A3 = L(P[2], P[3], t2, t3);
  const B1 = L(A1, A2, t0, t2), B2 = L(A2, A3, t1, t3);
  return L(B1, B2, t1, t2);
}
const norm2 = v => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
