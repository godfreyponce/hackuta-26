// Procedural WebAudio — no samples, no licensed music.
// Palette (after the score's documented textures): bronze gongs (inharmonic partials), found-metal hits
// (noise → high-Q bandpasses), Karplus-Strong bowstring & lyre, a two-reed aulos drone, sub pulse, hall reverb.

type Ctx = AudioContext;

const GONG_RATIOS = [1, 1.47, 2.09, 2.56, 3.18, 4.1];

// ── impact engine: modal synthesis (contact sounds = banks of decaying sine modes; ring time from the
// material's loss factor τ = 1/(π·f·tanφ); hardness from the contact transient) — research brief §impact
// bronze xiphos (0.6 m × 6 mm, free-free bar): bending (out-of-plane) and edge-wise (in-plane) modes, Hz
const XIPHOS_OOP = [801, 1118, 1489, 1912, 2390, 2920, 3502, 4136];
const XIPHOS_IP = [1323, 2594, 4288, 6403];
const CUIRASS = [310, 470, 690, 980, 1350, 1820, 2600];
const HELMET = GONG_RATIOS.map((r) => r * 560);
const WOOD = [180, 410, 760];
const RIM = [900, 1450, 2100];
const db = (d: number) => Math.pow(10, d / 20);
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

class Audio {
  ctx: Ctx | null = null;
  master!: GainNode;
  sfx!: GainNode;
  music!: GainNode;
  amb!: GainNode;
  reverbSend!: GainNode;
  muffle!: BiquadFilterNode;
  private noiseBuf: AudioBuffer | null = null;
  private ksCache = new Map<string, AudioBuffer>();
  private droneNodes: { stop: () => void } | null = null;
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private crackleTimer: ReturnType<typeof setInterval> | null = null;
  rate = 1;            // global pitch factor (slow-mo)
  /** camera-space pan for a world point (set by the engine): −1 left … +1 right */
  panOf: ((x: number, y: number, z: number) => number) | null = null;
  private voices = 0;
  private lastVoice = new Map<string, number>();
  intensity = 0;       // 0..1 music intensity
  enabled = true;

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.008; comp.release.value = 0.12; comp.knee.value = 6;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.08;
      this.muffle = ctx.createBiquadFilter();
      this.muffle.type = 'lowpass';
      this.muffle.frequency.value = 20000;
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.muffle).connect(comp).connect(limiter).connect(ctx.destination);
      this.sfx = ctx.createGain(); this.sfx.connect(this.master);
      this.music = ctx.createGain(); this.music.gain.value = 0.5; this.music.connect(this.master);
      this.amb = ctx.createGain(); this.amb.gain.value = 0.55; this.amb.connect(this.master);
      const conv = ctx.createConvolver();
      conv.buffer = this.impulse(2.1);
      this.reverbSend = ctx.createGain();
      this.reverbSend.gain.value = 0.32;
      this.reverbSend.connect(conv).connect(this.master);
      this.noiseBuf = this.makeNoise(2);
    } catch (err) {
      console.warn('[audio] unavailable', err);
      this.ctx = null;
    }
  }

  private impulse(seconds: number) {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 3.2) * (i < 200 ? i / 200 : 1);
      }
    }
    return buf;
  }
  private makeNoise(seconds: number) {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }
  /** Karplus-Strong pluck buffer (bowstring, lyre). */
  private ks(freq: number, seconds: number, damping = 0.996) {
    const ctx = this.ctx!;
    const key = `${freq.toFixed(1)}:${seconds}:${damping}`;
    const hit = this.ksCache.get(key);
    if (hit) return hit;
    const sr = ctx.sampleRate;
    const n = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    const period = Math.max(2, Math.round(sr / freq));
    const ring = new Float32Array(period);
    for (let i = 0; i < period; i++) ring[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const next = (idx + 1) % period;
      const v = (ring[idx] + ring[next]) * 0.5 * damping;
      d[i] = ring[idx];
      ring[idx] = v;
      idx = next;
    }
    this.ksCache.set(key, buf);
    return buf;
  }

  private out(gain: number, reverb = 0.3, dest?: AudioNode) {
    const ctx = this.ctx!;
    const g = ctx.createGain();
    g.gain.value = gain;
    g.connect(dest ?? this.sfx);
    if (reverb > 0) {
      const s = ctx.createGain();
      s.gain.value = reverb;
      g.connect(s).connect(this.reverbSend);
    }
    return g;
  }

  private noise(dest: AudioNode, t0: number, dur: number) {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    src.connect(dest);
    src.start(t0, Math.random() * 1.5);
    src.stop(t0 + dur + 0.05);
    return src;
  }

  private env(g: GainNode, t0: number, a: number, peak: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + decay);
  }

  private ready() { return this.enabled && !!this.ctx && this.ctx.state === 'running'; }

  // ── swing voice (continuous, per hand): band follows blade speed; a narrow whistle when the edge leads ──
  private swingV: Record<string, { bp: BiquadFilterNode; wh: BiquadFilterNode; g: GainNode; gw: GainNode; pan: StereoPannerNode } | undefined> = {};
  swing(key: string, v: number, edge: number, pan: number) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    let s = this.swingV[key];
    if (!s) {
      if (v < 2.5) return;
      const src = ctx.createBufferSource(); src.buffer = this.noiseBuf; src.loop = true;
      const bp = ctx.createBiquadFilter(); bp.type = 'bandpass';
      const wh = ctx.createBiquadFilter(); wh.type = 'bandpass';
      const g = ctx.createGain(); g.gain.value = 0;
      const gw = ctx.createGain(); gw.gain.value = 0;
      const pn = ctx.createStereoPanner();
      src.connect(bp).connect(g).connect(pn);
      src.connect(wh).connect(gw).connect(pn);
      pn.connect(this.sfx);
      const rs = ctx.createGain(); rs.gain.value = 0.08; pn.connect(rs).connect(this.reverbSend);
      src.start();
      s = this.swingV[key] = { bp, wh, g, gw, pan: pn };
    }
    const t = ctx.currentTime;
    const x = clamp01((v - 2.5) / (14 - 2.5));
    const e = clamp01(edge);
    s.bp.frequency.setTargetAtTime(Math.min(3200, 220 + 120 * v) * this.rate, t, 0.015);
    s.bp.Q.setTargetAtTime(Math.min(2.4, 1 + 0.12 * v), t, 0.015);
    s.g.gain.setTargetAtTime(Math.min(0.5, 0.12 + 0.5 * x * x * x) * (v < 2.5 ? 0 : 1), t, v < 2.5 ? 0.06 : 0.015);
    const d = 0.045 + (0.006 - 0.045) * e;
    s.wh.frequency.setTargetAtTime(Math.max(150, Math.min(1400, (0.2 * v) / d)) * this.rate, t, 0.015);
    s.wh.Q.setTargetAtTime(1.2 + 12.8 * e * e, t, 0.015);
    s.gw.gain.setTargetAtTime(v < 2.5 ? 0 : 0.35 * x * x * x * (0.2 + 0.8 * e * e), t, v < 2.5 ? 0.06 : 0.015);
    s.pan.pan.setTargetAtTime(Math.max(-0.8, Math.min(0.8, pan)), t, 0.03);
  }

  // ── impact engine ────────────────────────────────────────────────
  pan(p?: { x: number; y: number; z: number } | null) { return p && this.panOf ? this.panOf(p.x, p.y, p.z) : 0; }
  /** One impact voice: gain by intensity (−22…0 dB along I^0.7, ±1.5 dB), brightness lowpass, pan, reverb. */
  private voice(kind: string, I: number, pan: number, reverb: number, trimDb = 0) {
    if (!this.ready()) return null;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    // anti-flam: the same class within 35 ms just reinforces the last voice
    const last = this.lastVoice.get(kind) ?? -1;
    if (t0 - last < 0.035) return null;
    this.lastVoice.set(kind, t0);
    // the voice budget: the sounds that tell you what happened (steel on steel, a limb or head coming off) may
    // borrow past the cap; ambience-class hits wait their turn. Each voice frees its slot when it has rung out.
    const priority = kind === 'clash' || kind === 'parry' || kind === 'severThump' || kind === 'decap' || kind === 'block' || kind === 'shield';
    if (this.voices >= (priority ? 16 : 12)) return null;
    this.voices++;
    setTimeout(() => { this.voices = Math.max(0, this.voices - 1); }, kind === 'parry' ? 1400 : 900);
    const g = ctx.createGain();
    g.gain.value = db(-22 + 22 * Math.pow(clamp01(I), 0.7) + trimDb + (Math.random() - 0.5) * 3);
    const lp = ctx.createBiquadFilter();
    // metal keeps its bite at any intensity (a dull clash reads as a miss); soft classes still darken when light
    const lpMin = kind === 'clash' || kind === 'parry' ? 8000 : 0;
    lp.type = 'lowpass'; lp.Q.value = 0.5; lp.frequency.value = Math.min(18000, Math.max(lpMin, 2500 * Math.pow(2, 2.8 * clamp01(I))));
    const pn = ctx.createStereoPanner();
    pn.pan.value = Math.max(-0.9, Math.min(0.9, pan));
    g.connect(lp).connect(pn).connect(this.sfx);
    if (reverb > 0) { const s = ctx.createGain(); s.gain.value = reverb; pn.connect(s).connect(this.reverbSend); }
    return { dest: g as AudioNode, t0 };
  }
  /** a decaying sine mode */
  private mode(dest: AudioNode, t0: number, f: number, a: number, tau: number, jitter = true) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = f * this.rate * (jitter ? 1 + (Math.random() - 0.5) * 0.012 : 1);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(a, t0 + 0.0008);
    g.gain.setTargetAtTime(0, t0 + 0.0008, tau);
    o.connect(g).connect(dest);
    o.start(t0); o.stop(t0 + Math.min(4, 5 * tau) + 0.02);
  }
  /** a bank of modes with loss factor tanφ; brighter (energy in high modes) when hit harder */
  private modes(dest: AudioNode, t0: number, freqs: number[], amps: number[], tanphi: number, I: number, scale = 1, pick = 6) {
    const idx = freqs.map((_, i) => i).sort(() => Math.random() - 0.5).slice(0, Math.min(pick, freqs.length));
    for (const i of idx) {
      const f = freqs[i] * scale;
      const tilt = Math.pow(f / 2000, -0.8 + 1.1 * clamp01(I));
      const tau = Math.max(0.015, Math.min(2, 1 / (Math.PI * f * tanphi)));
      this.mode(dest, t0, f, (amps[i] ?? 0.3) * tilt * (0.75 + Math.random() * 0.5) * 0.35, tau);
    }
  }
  /** contact micro-collisions: noise bursts through a highpass at +0/3/7/12 ms */
  private tick(dest: AudioNode, t0: number, hp: number, ms: number, A: number) {
    const ctx = this.ctx!;
    [0, 3, 7, 12].forEach((dt, k) => {
      const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; f.Q.value = 0.7;
      const g = ctx.createGain();
      const t = t0 + dt / 1000;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(A * [1, 0.5, 0.3, 0.15][k], t + 0.0005);
      g.gain.setTargetAtTime(0, t + 0.0005, ms / 3000);
      this.noise(f, t, ms / 1000 + 0.01);
      f.connect(g).connect(dest);
    });
  }
  /** pitched body thump (sine sweep) */
  private thump(dest: AudioNode, t0: number, f0: number, f1: number, ms: number, A: number) {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f0 * this.rate, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1 * this.rate), t0 + ms / 1000);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(A, t0 + 0.002); g.gain.setTargetAtTime(0, t0 + 0.002, ms / 3000);
    o.connect(g).connect(dest); o.start(t0); o.stop(t0 + ms / 1000 + 0.2);
  }
  /** filtered noise burst */
  private burst(dest: AudioNode, t0: number, type: BiquadFilterType, f: number, q: number, A: number, tau: number, dur = 0.2) {
    const ctx = this.ctx!;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.value = f * this.rate; fl.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(A, t0 + 0.002); g.gain.setTargetAtTime(0, t0 + 0.002, tau);
    this.noise(fl, t0, dur); fl.connect(g).connect(dest);
  }
  private duck(db0: number, ms: number) {
    if (!this.ready()) return;
    const t0 = this.ctx!.currentTime;
    for (const bus of [this.music, this.amb]) {
      const base = bus === this.music ? 0.5 : 0.55;
      bus.gain.setTargetAtTime(base * db(db0), t0, 0.02);
      bus.gain.setTargetAtTime(base, t0 + ms / 1000, 0.12);
    }
  }

  /** blade meets blade: edge-on-edge ring (enemy blade ×0.93) */
  clashEdge(I = 0.7, pan = 0, tanphi = 0.0009, trimDb = 0) {
    I = Math.max(0.45, I); // bronze meeting bronze always rings out of the mix, even at mouse speeds
    const v = this.voice('clash', I, pan, 0.35, trimDb); if (!v) return;
    const { dest, t0 } = v;
    this.tick(dest, t0, 3500, 2.5, 0.7);
    this.modes(dest, t0, XIPHOS_IP, [1, 0.8, 0.55, 0.35], tanphi, I, 1, 4);
    this.modes(dest, t0, [1489, 1912, 2920, 3502], [0.5, 0.45, 0.35, 0.25], tanphi, I, 1, 4);
    this.modes(dest, t0, XIPHOS_IP, [0.8, 0.64, 0.44, 0.28], tanphi, I, 0.93, 3);
    this.burst(dest, t0, 'bandpass', 1800, 1.2, 0.35, 0.012, 0.08);
    this.thump(dest, t0, 140, 80, 45, 0.25);
    this.duck(-3, 150);
  }
  /** a held guard absorbing a blow, flat on flat */
  blockFlat(I = 0.6, pan = 0) {
    const v = this.voice('block', I, pan, 0.3, -4); if (!v) return;
    const { dest, t0 } = v;
    this.modes(dest, t0, [537, 801, 1118, 1489, 1912, 2390], [0.8, 1, 0.8, 0.6, 0.4, 0.25], 0.0018, I);
    this.tick(dest, t0, 2000, 4, 0.5);
    this.burst(dest, t0, 'bandpass', 900, 1.5, 0.5, 0.018, 0.1);
    this.thump(dest, t0, 120, 55, 70, 0.6);
  }
  /** perfect deflect: long ring, partials locked to the drone's key of D, shimmer beating */
  parryPerfect(pan = 0) {
    const v = this.voice('parry', 1, pan, 0.55); if (!v) return;
    const { dest, t0 } = v;
    this.tick(dest, t0, 4500, 1.5, 0.9);
    this.modes(dest, t0, XIPHOS_IP, [1, 0.8, 0.55, 0.35], 0.0005, 1, 1, 4);
    this.mode(dest, t0, 1174.66, 0.3 * 0.35, 0.9, false);
    this.mode(dest, t0, 1760, 0.18 * 0.35, 0.7, false);
    this.mode(dest, t0, 2920, 0.2 * 0.35, 0.5, false);
    this.mode(dest, t0, 2925.5, 0.2 * 0.35, 0.5, false);
    this.thump(dest, t0, 70, 42, 120, 0.5);
    this.duck(-6, 250);
  }
  /** sword on a bronze cuirass / greave (damped by padding) — plus the blade's own ring */
  armourBonk(I = 0.6, pan = 0) {
    const v = this.voice('armour', I, pan, 0.25); if (!v) return;
    const { dest, t0 } = v;
    this.modes(dest, t0, CUIRASS, [1, 0.9, 0.75, 0.6, 0.45, 0.3, 0.2], 0.006, I, 1 + (Math.random() - 0.5) * 0.08, 6);
    this.modes(dest, t0, XIPHOS_OOP, [0.35, 0.35, 0.35, 0.35, 0.3, 0.3, 0.25, 0.2], 0.0012, I, 1, 4);
    this.tick(dest, t0, 1500, 3, 0.6);
    this.thump(dest, t0, 150, 75, 60, 0.55);
  }
  /** head hit stopped by the bronze helmet */
  helmetBell(I = 0.7, pan = 0) {
    const v = this.voice('helmet', I, pan, 0.35); if (!v) return;
    const { dest, t0 } = v;
    this.modes(dest, t0, HELMET, [1, 0.7, 0.6, 0.45, 0.3, 0.2], 0.0025, I);
    this.tick(dest, t0, 2500, 2, 0.6);
    this.thump(dest, t0, 200, 110, 40, 0.3);
  }
  /** blade on the aspis: wood body + bronze rim */
  shieldWood(I = 0.6, pan = 0) {
    const v = this.voice('shield', I, pan, 0.3); if (!v) return;
    const { dest, t0 } = v;
    this.modes(dest, t0, WOOD, [1, 0.7, 0.45], 0.02, I, 1, 3);
    this.modes(dest, t0, RIM, [0.5, 0.35, 0.25], 0.003, I, 1, 3);
    this.thump(dest, t0, 90, 50, 80, 0.6);
    this.tick(dest, t0, 1200, 4, 0.4);
  }
  /** a glancing scrape along bronze */
  glanceScrape(I = 0.5, pan = 0) {
    const v = this.voice('scrape', I, pan, 0.25); if (!v) return;
    const { dest, t0 } = v;
    const dur = Math.max(0.08, Math.min(0.2, 0.06 + 0.012 * I * 12));
    const ctx = this.ctx!;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 5;
    bp.frequency.setValueAtTime((900 + 260 * I * 8) * this.rate, t0);
    bp.frequency.exponentialRampToValueAtTime((900 + 260 * I * 8) * 0.85 * this.rate, t0 + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.5, t0 + 0.01); g.gain.setTargetAtTime(0, t0 + dur * 0.6, dur * 0.3);
    this.noise(bp, t0, dur + 0.1); bp.connect(g).connect(dest);
    for (const f of [1912, 2594, 3502, 4288]) {
      const r = ctx.createBiquadFilter(); r.type = 'bandpass'; r.frequency.value = f * this.rate; r.Q.value = 60;
      const rg = ctx.createGain(); rg.gain.value = 0.5; bp.connect(r).connect(rg).connect(dest);
    }
    this.modes(dest, t0, CUIRASS, [1, 0.9, 0.75, 0.6, 0.45, 0.3, 0.2], 0.006, I * 0.6, 1, 4);
  }
  /** the missing one: a blade going into a man (slice + wet + meat thump) */
  fleshCut(I = 0.6, linen = false, pan = 0) {
    const v = this.voice('flesh', I, pan, 0.1, -2); if (!v) return;
    const { dest, t0 } = v;
    const k = 1.25 - 0.5 * clamp01(I);
    const ctx = this.ctx!;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.8;
    bp.frequency.setValueAtTime(4500 * (0.8 + 0.4 * I) * this.rate, t0);
    bp.frequency.exponentialRampToValueAtTime(1600 * this.rate, t0 + 0.06 * k);
    const sg = ctx.createGain(); sg.gain.setValueAtTime(0, t0); sg.gain.linearRampToValueAtTime(0.55, t0 + 0.002); sg.gain.setTargetAtTime(0, t0 + 0.002, 0.022 * k);
    this.noise(bp, t0, 0.2); bp.connect(sg).connect(dest);
    this.burst(dest, t0 + 0.004, 'lowpass', 700 + (Math.random() - 0.5) * 300, 5, 0.4, 0.045 * k, 0.25);
    this.thump(dest, t0, 170, 70, 70 * k, 0.45);
    this.burst(dest, t0, 'lowpass', 350, 0.7, 0.3, 0.02, 0.1);
    if (linen) for (const d of [0, 0.009, 0.017]) this.burst(dest, t0 + d, 'highpass', 2500, 0.7, 0.25, 0.002, 0.02);
  }
  /** celery-snap bone: N micro-clicks + low crunch */
  boneCrunch(N = 5, pan = 0) {
    const v = this.voice('bone' + N, 1, pan, 0.1); if (!v) return;
    const { dest, t0 } = v;
    let t = t0, a = 1;
    for (let i = 0; i < N; i++) {
      this.burst(dest, t, 'bandpass', 1800 + Math.random() * 1600, 2.5, a * 0.5, 0.0012, 0.01);
      t += (3 + Math.random() * 6) / 1000; a *= 0.82;
    }
    this.burst(dest, t0, 'lowpass', 500, 0.7, 0.4, 0.03, 0.12);
  }
  /** limb comes off */
  severSound(pan = 0) {
    this.fleshCut(1, false, pan);
    this.boneCrunch(5, pan);
    const v = this.voice('severThump', 1, pan, 0.05); if (v) this.thump(v.dest, v.t0, 110, 50, 90, 0.6);
  }
  /** off with his head: cut, neck crunch, dry sub thump, then a pulsing arterial hiss */
  decap(pan = 0) {
    this.fleshCut(1, false, pan);
    setTimeout(() => this.boneCrunch(8, pan), 6);
    const v = this.voice('decap', 1, pan, 0);
    if (!v) return;
    const { dest, t0 } = v;
    this.thump(dest, t0, 95, 36, 200, 0.85);
    const ctx = this.ctx!;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 2200;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 5000; bp.Q.value = 0.7;
    const g = ctx.createGain();
    const start = t0 + 0.07;
    g.gain.setValueAtTime(0, start);
    for (let i = 0; i < 32; i++) {
      const t = start + i * 0.05;
      g.gain.linearRampToValueAtTime(0.22 * (0.45 + 0.55 * Math.max(0, Math.sin(2 * Math.PI * 2 * i * 0.05))) * (i > 26 ? (32 - i) / 6 : 1), t);
    }
    g.gain.linearRampToValueAtTime(0, start + 1.7);
    this.noise(hp, start, 1.8); hp.connect(bp).connect(g).connect(dest);
    this.duck(-6, 250);
  }
  /** enemy wind-up glint: a short three-mode 'shing', panned by lane */
  glint(pan = 0) {
    const v = this.voice('glint', 0.6, pan, 0.3, -14); if (!v) return;
    this.modes(v.dest, v.t0, [2594, 3502, 4288], [1, 0.8, 0.6], 0.0012, 0.6, 0.93, 3);
    this.tick(v.dest, v.t0, 5000, 1, 0.3);
  }

  // ── SFX ──────────────────────────────────────────────────────────
  gong(freq = 110, decay = 5, gain = 0.35) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000;
    lp.connect(this.out(gain, 0.6));
    GONG_RATIOS.forEach((r, i) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const f = freq * r * this.rate;
      o.frequency.setValueAtTime(f, t0);
      o.frequency.exponentialRampToValueAtTime(f * 0.98, t0 + decay);
      const g = ctx.createGain();
      this.env(g, t0, 0.008 + i * 0.004, 0.5 / (i + 1), decay * (1 - i * 0.12));
      o.connect(g).connect(lp);
      o.start(t0); o.stop(t0 + decay + 0.1);
    });
  }

  metal(intensity = 1, base = 1400) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const out = this.out(0.35 * intensity, 0.35);
    [base, base * 1.53, base * 2.31].forEach((f, i) => {
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.frequency.value = f * this.rate; bp.Q.value = 28;
      const g = ctx.createGain();
      this.env(g, t0, 0.002, 1.4 / (i + 1), 0.25 + 0.3 * intensity);
      this.noise(bp, t0, 0.6);
      bp.connect(g).connect(out);
    });
  }

  thunk(heavy = 1) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 * this.rate, t0);
    o.frequency.exponentialRampToValueAtTime(42 * this.rate, t0 + 0.18);
    const g = ctx.createGain();
    this.env(g, t0, 0.004, 0.9 * heavy, 0.28);
    o.connect(g).connect(this.out(0.6, 0.15));
    o.start(t0); o.stop(t0 + 0.4);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900 * this.rate;
    const ng = ctx.createGain(); this.env(ng, t0, 0.002, 0.5 * heavy, 0.09);
    this.noise(lp, t0, 0.15); lp.connect(ng).connect(this.out(0.5, 0.1));
  }

  whoosh(speed = 3) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const dur = 0.22;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(400 * this.rate, t0);
    bp.frequency.exponentialRampToValueAtTime(Math.min(4000, 900 + speed * 300) * this.rate, t0 + dur * 0.6);
    const g = ctx.createGain(); this.env(g, t0, dur * 0.4, Math.min(0.5, 0.12 + speed * 0.05), dur * 0.6);
    this.noise(bp, t0, dur); bp.connect(g).connect(this.out(0.6, 0.1));
  }

  bowDraw() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 2200; bp.Q.value = 6;
    const g = ctx.createGain(); this.env(g, t0, 0.3, 0.12, 0.5);
    this.noise(bp, t0, 0.8); bp.connect(g).connect(this.out(0.5, 0.05));
  }

  bowRelease(draw = 1) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.ks(98 + draw * 60, 1.2, 0.992);   // pitch rises with draw
    src.playbackRate.value = this.rate;
    src.connect(this.out(0.55, 0.35));
    src.start();
    this.whoosh(5 + draw * 4);
  }

  lyre(notes: number[] = [0, 4, 7, 12], gap = 0.09, base = 220) {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    notes.forEach((n, i) => {
      const src = ctx.createBufferSource();
      src.buffer = this.ks(base * Math.pow(2, n / 12), 2.2, 0.997);
      src.playbackRate.value = this.rate;
      src.connect(this.out(0.32, 0.5));
      src.start(ctx.currentTime + i * gap);
    });
  }

  hurt() {
    if (!this.ready()) return;
    this.thunk(1.2);
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    this.muffle.frequency.cancelScheduledValues(t0);
    this.muffle.frequency.setValueAtTime(700, t0);
    this.muffle.frequency.exponentialRampToValueAtTime(this.baseMuffle, t0 + 0.45);
  }

  private baseMuffle = 20000;
  setHealth(h: number) {
    if (!this.ctx) return;
    this.baseMuffle = h < 25 ? 1400 + h * 40 : 20000;
    this.muffle.frequency.setTargetAtTime(this.baseMuffle, this.ctx.currentTime, 0.3);
  }

  explosion() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t0); lp.frequency.exponentialRampToValueAtTime(120, t0 + 1.2);
    const g = ctx.createGain(); this.env(g, t0, 0.005, 1.2, 1.4);
    this.noise(lp, t0, 1.6); lp.connect(g).connect(this.out(0.8, 0.4));
    const o = ctx.createOscillator(); o.frequency.setValueAtTime(70, t0); o.frequency.exponentialRampToValueAtTime(28, t0 + 0.8);
    const og = ctx.createGain(); this.env(og, t0, 0.005, 1, 0.9);
    o.connect(og).connect(this.out(0.8, 0.1)); o.start(t0); o.stop(t0 + 1);
  }

  heal() { this.lyre([0, 7, 12, 19], 0.07, 330); }
  forgeArrive() { this.gong(196, 4, 0.3); this.lyre([0, 4, 7, 11, 14], 0.06, 392); }
  parry(pan = 0) { this.clashEdge(0.85, pan); }
  block(pan = 0) { this.blockFlat(0.6, pan); }
  ui(kind: 'move' | 'select' | 'back' = 'move') {
    if (!this.ready()) return;
    if (kind === 'move') this.lyre([0], 0, 660);
    else if (kind === 'select') this.lyre([0, 7], 0.05, 440);
    else this.lyre([7, 0], 0.05, 330);
  }
  ring() { this.lyre([0, 4, 7, 12, 7, 4], 0.12, 293.7); }
  stinger(big = false) {
    this.gong(big ? 82 : 123, big ? 6 : 3.5, big ? 0.45 : 0.3);
    this.metal(big ? 1 : 0.6, 1800);
  }
  slowIn() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(220, t0); o.frequency.exponentialRampToValueAtTime(38, t0 + 0.6);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 500;
    const g = ctx.createGain(); this.env(g, t0, 0.02, 0.4, 0.8);
    o.connect(lp).connect(g).connect(this.out(0.5, 0.5)); o.start(t0); o.stop(t0 + 1);
    // heartbeat
    [0.3, 0.62].forEach((d) => {
      const h = ctx.createOscillator(); h.frequency.setValueAtTime(58, t0 + d); h.frequency.exponentialRampToValueAtTime(34, t0 + d + 0.15);
      const hg = ctx.createGain(); this.env(hg, t0 + d, 0.005, 0.8, 0.2);
      h.connect(hg).connect(this.out(0.7, 0)); h.start(t0 + d); h.stop(t0 + d + 0.3);
    });
  }
  arrowWhiz() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 9;
    bp.frequency.setValueAtTime(3200, t0); bp.frequency.exponentialRampToValueAtTime(900, t0 + 0.35);
    const g = ctx.createGain(); this.env(g, t0, 0.05, 0.35, 0.3);
    this.noise(bp, t0, 0.4); bp.connect(g).connect(this.out(0.5, 0.1));
  }
  grunt() {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t0 = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    const f = (95 + Math.random() * 40) * this.rate;
    o.frequency.setValueAtTime(f, t0); o.frequency.exponentialRampToValueAtTime(f * 0.7, t0 + 0.25);
    const f1 = ctx.createBiquadFilter(); f1.type = 'bandpass'; f1.frequency.value = 650; f1.Q.value = 5;
    const g = ctx.createGain(); this.env(g, t0, 0.02, 0.25, 0.25);
    o.connect(f1).connect(g).connect(this.out(0.45, 0.25)); o.start(t0); o.stop(t0 + 0.35);
  }

  // ── music & ambience ────────────────────────────────────────────
  startAmbience() {
    if (!this.ctx || this.droneNodes) return;
    const ctx = this.ctx;
    // aulos-like drone: two detuned pulse-ish reeds through a formant band
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass'; formant.frequency.value = 1400; formant.Q.value = 1.2;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
    const g = ctx.createGain(); g.gain.value = 0.0;
    g.gain.setTargetAtTime(0.05, ctx.currentTime, 2);
    formant.connect(lp).connect(g).connect(this.music);
    const s = ctx.createGain(); s.gain.value = 0.4; g.connect(s).connect(this.reverbSend);
    const oscs = [73.4, 73.9, 110.2].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = 0.33;
      o.connect(og).connect(formant);
      o.start();
      return o;
    });
    // slow breath LFO on the formant
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = ctx.createGain(); lfoG.gain.value = 300;
    lfo.connect(lfoG).connect(formant.frequency); lfo.start();
    // fire crackle
    this.crackleTimer = setInterval(() => {
      if (!this.ready() || Math.random() > 0.55) return;
      const t0 = ctx.currentTime;
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 1800 + Math.random() * 2500;
      const cg = ctx.createGain(); this.env(cg, t0, 0.001, 0.15 + Math.random() * 0.25, 0.03 + Math.random() * 0.05);
      this.noise(hp, t0, 0.1); hp.connect(cg).connect(this.amb);
    }, 70);
    // sub pulse (scales with intensity)
    let beat = 0;
    this.pulseTimer = setInterval(() => {
      if (!this.ready() || this.intensity <= 0.05) return;
      beat++;
      const t0 = ctx.currentTime;
      const accent = beat % 4 === 0;
      const o = ctx.createOscillator();
      o.frequency.setValueAtTime((accent ? 55 : 46) * this.rate, t0);
      o.frequency.exponentialRampToValueAtTime(32 * this.rate, t0 + 0.25);
      const og = ctx.createGain(); this.env(og, t0, 0.006, (accent ? 0.7 : 0.4) * this.intensity, 0.3);
      o.connect(og).connect(this.music); o.start(t0); o.stop(t0 + 0.4);
      if (accent && this.intensity > 0.6 && Math.random() < 0.3) this.metal(0.25, 1200);
    }, 470);
    this.droneNodes = {
      stop: () => { oscs.forEach((o) => o.stop()); lfo.stop(); g.disconnect(); },
    };
  }

  setIntensity(v: number) { this.intensity = v; }
}

export const audio = new Audio();
