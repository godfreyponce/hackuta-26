// Procedural WebAudio — no samples, no licensed music.
// Palette (after the score's documented textures): bronze gongs (inharmonic partials), found-metal hits
// (noise → high-Q bandpasses), Karplus-Strong bowstring & lyre, a two-reed aulos drone, sub pulse, hall reverb.

type Ctx = AudioContext;

const GONG_RATIOS = [1, 1.47, 2.09, 2.56, 3.18, 4.1];

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
  intensity = 0;       // 0..1 music intensity
  enabled = true;

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') void this.ctx.resume(); return; }
    try {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
      this.muffle = ctx.createBiquadFilter();
      this.muffle.type = 'lowpass';
      this.muffle.frequency.value = 20000;
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.muffle).connect(comp).connect(ctx.destination);
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
  parry() { this.metal(1.3, 2100); }
  block() { this.metal(0.8, 900); this.thunk(0.5); }
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
