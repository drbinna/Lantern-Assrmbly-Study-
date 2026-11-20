// Stork VTOL sound: synthesised live from the flight model, no recordings.
// Each lift motor and the pusher is an oscillator at its blade-pass frequency (RPM / 60 × 2 blades),
// with the ESC/motor whine on top, prop-wash and wind noise, and distance filtering from the camera.

const LIFT_RPM_MAX = 15000, PUSH_RPM_MAX = 11000, POLE_PAIRS = 7;

export class StorkAudio {
  constructor() {
    this.ctx = null; this.on = false;
    try { this.muted = localStorage.getItem('stork-sim:muted') === '1'; } catch { this.muted = false; }
  }
  // must be called from a user gesture the first time
  ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const c = this.ctx = new AC();
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.9;
    const comp = c.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 4;
    this.master.connect(comp).connect(c.destination);
    this.air = c.createBiquadFilter(); this.air.type = 'lowpass'; this.air.frequency.value = 9000; this.air.connect(this.master);
    this.engine = c.createGain(); this.engine.gain.value = 0; this.engine.connect(this.air);
    this.fx = c.createGain(); this.fx.gain.value = 0.55; this.fx.connect(this.master);
    const wave = (k, odd) => { const n = 24, re = new Float32Array(n), im = new Float32Array(n);
      for (let h = 1; h < n; h++) im[h] = (h % 2 ? 1 : odd) / Math.pow(h, k) * (1 + 0.15 * Math.sin(h * 1.7)); return c.createPeriodicWave(re, im); };
    const liftWave = wave(1.15, 0.75), pushWave = wave(1.5, 0.55);
    const motor = (w, detune) => {
      const o = c.createOscillator(); o.setPeriodicWave(w); o.frequency.value = 60; o.detune.value = detune;
      const g = c.createGain(); g.gain.value = 0; o.connect(g).connect(this.engine);
      const wh = c.createOscillator(); wh.type = 'triangle'; wh.frequency.value = 400;
      const wg = c.createGain(); wg.gain.value = 0; wh.connect(wg).connect(this.engine);
      o.start(); wh.start(); return { o, g, wh, wg };
    };
    this.lift = [motor(liftWave, -9), motor(liftWave, 4), motor(liftWave, 11), motor(liftWave, -3)];
    this.push = motor(pushWave, 0);
    const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate), d = noise.getChannelData(0);
    let b = 0; for (let i = 0; i < d.length; i++) { const w = Math.random() * 2 - 1; b = 0.97 * b + 0.03 * w; d[i] = w * 0.6 + b * 3; }
    this.noiseBuf = noise;
    const loop = () => { const s = c.createBufferSource(); s.buffer = noise; s.loop = true; s.start(0, Math.random() * 2); return s; };
    this.washF = c.createBiquadFilter(); this.washF.type = 'bandpass'; this.washF.Q.value = 0.8; this.washG = c.createGain(); this.washG.gain.value = 0;
    loop().connect(this.washF).connect(this.washG).connect(this.engine);
    this.windF = c.createBiquadFilter(); this.windF.type = 'lowpass'; this.windF.frequency.value = 400; this.windG = c.createGain(); this.windG.gain.value = 0;
    loop().connect(this.windF).connect(this.windG).connect(this.master);
    this.on = true;
  }
  setMuted(m) {
    this.muted = m; try { localStorage.setItem('stork-sim:muted', m ? '1' : '0'); } catch {}
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05);
  }
  // st: { lift:[N×4], push:N, armed, airspeed, dist (camera → aircraft, m), onboard, active }
  update(st) {
    if (!this.on) return;
    const c = this.ctx, t = c.currentTime, k = 0.035;
    const set = (p, v, tc = k) => p.setTargetAtTime(v, t, tc);
    if (!st.active) { set(this.engine.gain, 0, 0.08); set(this.windG.gain, 0, 0.1); return; }
    const idle = st.armed ? 0.16 : 0;
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      const m = this.lift[i], fr = Math.max(idle, Math.sqrt(Math.max(0, st.lift[i]) / 16));
      const rpm = LIFT_RPM_MAX * fr; sum += fr;
      set(m.o.frequency, Math.max(20, rpm / 60 * 2)); set(m.g.gain, fr > 0 ? 0.05 * (0.2 + 1.3 * fr * fr) : 0);
      set(m.wh.frequency, Math.max(40, rpm / 60 * POLE_PAIRS)); set(m.wg.gain, 0.006 * fr);
    }
    const pf = st.armed ? Math.sqrt(Math.max(0, st.push) / 20) : 0, prpm = PUSH_RPM_MAX * pf;
    set(this.push.o.frequency, Math.max(20, prpm / 60 * 2)); set(this.push.g.gain, pf > 0.05 ? 0.07 * (0.15 + 1.4 * pf * pf) : 0);
    set(this.push.wh.frequency, Math.max(40, prpm / 60 * POLE_PAIRS)); set(this.push.wg.gain, 0.005 * pf);
    const avg = sum / 4;
    set(this.washF.frequency, 380 + 900 * avg); set(this.washG.gain, 0.09 * avg * avg + 0.05 * pf * pf);
    // the farther the camera, the quieter and duller (air absorbs the highs)
    const d = st.onboard ? 0.6 : Math.max(1, st.dist);
    const att = st.onboard ? 0.55 : 1 / (1 + Math.pow(d / 9, 1.25));
    set(this.engine.gain, Math.min(1, att * 2.2), 0.06);
    set(this.air.frequency, st.onboard ? 5200 : Math.max(500, 16000 / (1 + d / 35)), 0.06);
    const va = st.airspeed || 0;
    set(this.windF.frequency, 250 + va * 28); set(this.windG.gain, Math.min(0.22, (st.onboard ? 0.0009 : 0.00028) * va * va), 0.1);
  }
  // ---------- one-shot effects ----------
  _tone(f, t0, dur, type = 'sine', gain = 0.2, f2) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain(); o.type = type; o.frequency.setValueAtTime(f, t0);
    if (f2) o.frequency.exponentialRampToValueAtTime(f2, t0 + dur);
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(gain, t0 + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.fx); o.start(t0); o.stop(t0 + dur + 0.05);
  }
  _noise(t0, dur, f0, f1, gain = 0.4, type = 'lowpass') {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noiseBuf; fl.type = type; fl.frequency.setValueAtTime(f0, t0); fl.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(gain, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(fl).connect(g).connect(this.fx); s.start(t0, Math.random()); s.stop(t0 + dur + 0.05);
  }
  arm() { // ESC arming tones, played through the motors
    if (!this.on) return; const t = this.ctx.currentTime + 0.02;
    [[1046, 0], [1318, 0.16], [1568, 0.32]].forEach(([f, dt]) => this._tone(f, t + dt, 0.13, 'square', 0.05));
    this._tone(1568, t + 0.62, 0.35, 'square', 0.04);
  }
  ring(k, n) { // rising chime as you progress through the course
    if (!this.on) return; const t = this.ctx.currentTime + 0.01;
    const scale = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24, 26, 28, 31];
    const f = 660 * Math.pow(2, scale[Math.min(k, scale.length - 1)] / 12);
    this._tone(f, t, 0.5, 'sine', 0.22); this._tone(f * 1.5, t + 0.07, 0.45, 'sine', 0.14); this._tone(f * 2, t + 0.07, 0.3, 'triangle', 0.05);
    this._noise(t, 0.35, 6000, 2500, 0.05, 'highpass');
  }
  clip() { if (!this.on) return; const t = this.ctx.currentTime + 0.01; this._tone(180, t, 0.18, 'square', 0.12, 70); this._noise(t, 0.12, 2500, 300, 0.35); }
  wrong() { if (!this.on) return; const t = this.ctx.currentTime + 0.01; this._tone(330, t, 0.16, 'sawtooth', 0.06); this._tone(262, t + 0.15, 0.22, 'sawtooth', 0.06); }
  complete() {
    if (!this.on) return; const t = this.ctx.currentTime + 0.05;
    [523, 659, 784, 1046, 1318].forEach((f, i) => { this._tone(f, t + i * 0.11, 0.9 - i * 0.08, 'triangle', 0.13); this._tone(f * 2, t + i * 0.11, 0.4, 'sine', 0.04); });
  }
  landed() { if (!this.on) return; const t = this.ctx.currentTime + 0.01; this._tone(1568, t, 0.1, 'square', 0.04); this._tone(1046, t + 0.13, 0.18, 'square', 0.04); }
  crash() {
    if (!this.on) return; const t = this.ctx.currentTime + 0.01;
    this._noise(t, 1.1, 5000, 120, 0.9); this._tone(90, t, 0.6, 'sine', 0.5, 35); this._noise(t + 0.05, 0.4, 9000, 1500, 0.25, 'highpass');
  }
  beep() { if (!this.on) return; const t = this.ctx.currentTime + 0.01; this._tone(2093, t, 0.09, 'square', 0.035); this._tone(2093, t + 0.16, 0.09, 'square', 0.035); }
}
