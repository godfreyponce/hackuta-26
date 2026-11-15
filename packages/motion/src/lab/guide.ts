// Guided gesture test for the Motion Lab: asks for every movement one at a time, waits for it,
// and reports PASS / FAIL with the reason (what the tracker saw).
import type { Hand, InputEvent, PlayerInputState } from '@ithaca/shared';
import { config } from '../config';
import type { DetectorFlags } from '../gestures';

export interface GuideSource {
  on(cb: (e: InputEvent) => void): () => void;
  getState(): PlayerInputState;
  getDebugGestures?(): DetectorFlags;
}

interface Ctx {
  state: PlayerInputState;
  flags: DetectorFlags | null;
}

/** null = not this event; ok = stage passed; hint = near miss (stay, explain why). */
type EventResult = null | { ok: true; detail?: string } | { ok: false; hint: string; restart?: boolean };

interface Stage {
  say: string;
  event?: (e: InputEvent) => EventResult;
  /** Passes the stage when it returns true (state-based checks: lean, crouch, arm extended). */
  poll?: (c: Ctx) => boolean;
  /** Live feedback while waiting. */
  hint?: (c: Ctx) => string | null;
  /** Detail for the result when a poll-stage passes. */
  detail?: (c: Ctx) => string;
}

interface StepDef {
  id: string;
  title: string;
  stages: Stage[];
}

export type StepStatus = 'pending' | 'active' | 'pass' | 'fail' | 'skipped';

export interface GuideView {
  running: boolean;
  done: boolean;
  index: number;
  steps: { id: string; title: string; status: StepStatus; detail: string }[];
  /** Current step, when running. */
  current: null | {
    title: string;
    say: string;
    hint: string;
    stage: number;
    stages: number;
    remainingMs: number;
    totalMs: number;
    /** Set for ~1.5 s after a result. */
    flash: 'pass' | 'fail' | null;
    paused: boolean;
  };
}

const STEP_TIMEOUT_MS = 15000;
const PASS_FLASH_MS = 1300;

const fmt = (v: number, d = 1) => v.toFixed(d);
const speed = (v: { x: number; y: number; z: number }) => Math.hypot(v.x, v.y, v.z);
/** Angle (deg) between a direction and straight forward (−Z). */
const offForward = (v: { x: number; y: number; z: number }) => {
  const s = speed(v);
  return s > 1e-6 ? (Math.acos(Math.max(-1, Math.min(1, -v.z / s))) * 180) / Math.PI : 180;
};

function handGrab(hand: Hand): StepDef {
  const H = hand.toUpperCase();
  const gripping = (c: Ctx) => (hand === 'left' ? c.flags?.gripL : c.flags?.gripR) ?? false;
  const handHint = (c: Ctx): string | null => {
    const hs = c.state.hands[hand];
    if (!hs.visible) return `I can't see your ${hand} hand. Hold it up in front of you`;
    return `grip ${fmt(hs.grip, 2)} · fist needs > ${config.gripOn}, open needs < ${config.gripOff}`;
  };
  return {
    id: `grab_${hand}`,
    title: `${hand === 'left' ? 'Left' : 'Right'} hand: fist, then open`,
    stages: [
      {
        say: `Close your ${H} hand into a tight fist`,
        event: (e) => (e.type === 'grab' && e.hand === hand ? { ok: true } : null),
        poll: gripping,
        hint: handHint,
      },
      {
        say: `Now open your ${H} hand wide`,
        event: (e) => (e.type === 'release' && e.hand === hand ? { ok: true, detail: 'grab + release fired' } : null),
        hint: handHint,
      },
    ],
  };
}

export const GUIDE_STEPS: StepDef[] = [
  handGrab('right'),
  handGrab('left'),
  {
    id: 'throw',
    title: 'Throw (right hand)',
    stages: [
      {
        say: 'Make a fist with your RIGHT hand, like holding a ball',
        event: (e) => (e.type === 'grab' && e.hand === 'right' ? { ok: true } : null),
        poll: (c) => c.flags?.gripR ?? false,
        hint: (c) => `grip ${fmt(c.state.hands.right.grip, 2)}`,
      },
      {
        say: 'Throw it at the screen: swing forward and open your hand',
        event: (e) => {
          if (e.type !== 'release' || e.hand !== 'right') return null;
          const s = speed(e.vel);
          const off = offForward(e.vel);
          if (s < 1.5) return { ok: false, hint: `Too soft (${fmt(s)} m/s). Make a fist and throw harder`, restart: true };
          if (e.vel.z > -0.3) return { ok: false, hint: `That went ${off > 90 ? 'backward' : 'sideways'} (${fmt(off, 0)}° off). Throw toward the screen`, restart: true };
          return { ok: true, detail: `${fmt(s)} m/s, ${fmt(off, 0)}° off straight ahead` };
        },
        hint: (c) => `hand speed ${fmt(speed(c.state.hands.right.vel))} m/s`,
      },
    ],
  },
  {
    id: 'swing',
    title: 'Sword swing',
    stages: [
      {
        say: 'Make a fist and SLASH fast across your body',
        event: (e) => (e.type === 'swing' ? { ok: true, detail: `${e.hand} hand, ${fmt(e.speed)} m/s` } : null),
        hint: (c) => {
          const r = c.state.hands.right, l = c.state.hands.left;
          const best = speed(r.vel) > speed(l.vel) ? r : l;
          if (best.grip <= config.swingMinGrip) return 'Close your fist first (like holding a sword)';
          return `speed ${fmt(speed(best.vel))} m/s · needs > ${config.swingSpeed}`;
        },
      },
    ],
  },
  {
    id: 'block',
    title: 'Block',
    stages: [
      {
        say: 'Raise both forearms FLAT in front of your face, like a shield',
        event: (e) => (e.type === 'block_start' ? { ok: true } : null),
        hint: (c) => (c.flags?.blockPose ? 'Block pose seen. Hold it…' : 'Both wrists above elbows, forearms horizontal, at eye height'),
      },
      {
        say: 'Now drop your arms',
        event: (e) => (e.type === 'block_end' ? { ok: true, detail: 'block_start + block_end fired' } : null),
      },
    ],
  },
  {
    id: 'bow',
    title: 'Bow shot',
    stages: [
      {
        say: 'Hold your LEFT arm straight out toward the screen (the bow)',
        poll: (c) => c.flags?.bowArm ?? false,
        hint: () => `Straighten it fully (elbow > ${config.bowElbowAngle}°) and reach forward`,
      },
      {
        say: 'Make a RIGHT fist and touch it to your left wrist (nock the arrow)',
        event: (e) => (e.type === 'bow_nock' ? { ok: true } : null),
        hint: (c) => (!c.flags?.bowArm ? 'Keep your left arm straight out' : !c.flags.gripR ? 'Close your right hand into a fist' : 'Bring your right fist closer to your left wrist'),
      },
      {
        say: 'Pull your right fist back to your chin, then OPEN it to shoot',
        event: (e) => {
          if (e.type !== 'bow_release') return null;
          return { ok: true, detail: `draw ${fmt(e.draw * 100, 0)}%, ${fmt(offForward(e.aim), 0)}° off straight ahead` };
        },
        hint: (c) =>
          c.flags?.nocked
            ? `draw ${fmt(c.state.bowDraw * 100, 0)}% · needs > ${fmt(config.bowMinDraw * 100, 0)}% before you open`
            : 'Arrow dropped. Fist back on your left wrist to nock again',
      },
    ],
  },
  {
    id: 'drink',
    title: 'Drink potion',
    stages: [
      {
        say: 'Make a fist (holding a cup) and hold it at your MOUTH for 1 second',
        event: (e) => (e.type === 'drink' ? { ok: true, detail: `${e.hand} hand` } : null),
        hint: (c) => (!c.flags?.gripL && !c.flags?.gripR ? 'Close your hand into a fist first' : 'Bring the fist right up to your mouth and hold'),
      },
    ],
  },
  {
    id: 'call',
    title: 'Phone a Friend (call sign)',
    stages: [
      {
        say: 'Phone hand 🤙 (thumb + pinky out) next to your EAR. Hold 1 second',
        event: (e) => (e.type === 'call_sign' ? { ok: true, detail: 'call_sign fired' } : null),
        hint: (c) => {
          const f = c.flags;
          if (!f?.phoneShape) return 'Thumb and pinky out, other three fingers curled';
          if (!f.nearEar) return 'Phone shape seen ✓. Move it right next to your ear';
          return 'Hold it… (5 s cooldown after each call)';
        },
      },
    ],
  },
  {
    id: 'request',
    title: 'Request a weapon',
    stages: [
      {
        say: 'Raise BOTH hands above your head. Hold 1 second',
        event: (e) => (e.type === 'request_weapon' ? { ok: true, detail: 'request_weapon fired' } : null),
        hint: (c) => (c.flags?.armsUp ? 'Both hands up ✓. Hold…' : 'Both wrists clearly above the top of your head'),
      },
    ],
  },
  {
    id: 'lean_left',
    title: 'Dodge left',
    stages: [
      {
        say: 'Lean or step to your LEFT',
        poll: (c) => c.state.body.lean < -0.5,
        hint: (c) => `lean ${fmt(c.state.body.lean, 2)} · needs < −0.50`,
        detail: (c) => `lean ${fmt(c.state.body.lean, 2)}`,
      },
    ],
  },
  {
    id: 'lean_right',
    title: 'Dodge right',
    stages: [
      {
        say: 'Lean or step to your RIGHT',
        poll: (c) => c.state.body.lean > 0.5,
        hint: (c) => `lean ${fmt(c.state.body.lean, 2)} · needs > 0.50`,
        detail: (c) => `lean ${fmt(c.state.body.lean, 2)}`,
      },
    ],
  },
  {
    id: 'crouch',
    title: 'Crouch',
    stages: [
      {
        say: 'CROUCH down (bend your knees)',
        poll: (c) => c.state.body.crouch > 0.5,
        hint: (c) => `crouch ${fmt(c.state.body.crouch, 2)} · needs > 0.50`,
        detail: (c) => `crouch ${fmt(c.state.body.crouch, 2)}`,
      },
    ],
  },
];

export class GestureGuide {
  private status: StepStatus[] = GUIDE_STEPS.map(() => 'pending');
  private details: string[] = GUIDE_STEPS.map(() => '');
  private index = 0;
  private stage = 0;
  private running = false;
  private elapsedMs = 0;
  private lastTick = -1;
  private nearMiss = '';
  private flash: { kind: 'pass' | 'fail'; until: number } | null = null;
  private paused = false;
  private unsub: (() => void) | null = null;

  constructor(
    private readonly src: GuideSource,
    private readonly onResult: (title: string, ok: boolean, detail: string) => void = () => {},
  ) {}

  start(from = 0): void {
    this.unsub?.();
    this.unsub = this.src.on((e) => this.handle(e));
    if (from === 0) {
      this.status = GUIDE_STEPS.map(() => 'pending');
      this.details = GUIDE_STEPS.map(() => '');
    }
    this.running = true;
    this.begin(from);
  }

  stop(): void {
    this.running = false;
    this.unsub?.();
    this.unsub = null;
    if (this.status[this.index] === 'active') this.status[this.index] = 'pending';
  }

  /** Re-run one step (click in the checklist), then continue to the next unfinished one. */
  runStep(i: number): void {
    if (!this.running) {
      this.unsub?.();
      this.unsub = this.src.on((e) => this.handle(e));
      this.running = true;
    } else if (this.status[this.index] === 'active') {
      this.status[this.index] = 'pending';
    }
    this.begin(i);
  }

  /** Move on after a failed step (keeps the FAIL). */
  next(): void {
    if (this.running) this.advance();
  }

  retry(): void {
    this.runStep(this.index);
  }

  skip(): void {
    if (!this.running) return;
    this.status[this.index] = 'skipped';
    this.details[this.index] = 'skipped';
    this.advance();
  }

  /** Call every animation frame. */
  tick(now: number): void {
    if (!this.running) return;
    const dt = this.lastTick < 0 ? 0 : now - this.lastTick;
    this.lastTick = now;
    if (this.flash) {
      if (now >= this.flash.until) {
        const kind = this.flash.kind;
        this.flash = null;
        if (kind === 'pass') this.advance();
      }
      return;
    }
    if (this.status[this.index] !== 'active') return;
    const state = this.src.getState();
    // Don't burn the clock while the player isn't tracked.
    this.paused = state.tracking === 'lost' || state.tracking === 'off' || state.tracking === 'calibrating';
    if (this.paused) return;
    this.elapsedMs += dt;
    const st = this.stageDef();
    if (st?.poll && st.poll(this.ctx(state))) {
      this.passStage(st.detail?.(this.ctx(state)));
      return;
    }
    if (this.elapsedMs >= STEP_TIMEOUT_MS) {
      const hint = this.nearMiss || this.liveHint(state) || 'Not detected';
      this.finishStep(false, `${st?.say ?? ''}: not detected. ${hint}`, now);
    }
  }

  view(): GuideView {
    const def = GUIDE_STEPS[this.index];
    const st = this.stageDef();
    const state = this.src.getState();
    return {
      running: this.running,
      done: !this.running && this.status.every((s) => s !== 'pending' && s !== 'active'),
      index: this.index,
      steps: GUIDE_STEPS.map((s, i) => ({ id: s.id, title: s.title, status: this.status[i] ?? 'pending', detail: this.details[i] ?? '' })),
      current:
        this.running && def
          ? {
              title: def.title,
              say: this.flash ? (this.flash.kind === 'pass' ? 'PASSED' : 'FAILED') : (st?.say ?? ''),
              hint: this.flash
                ? (this.details[this.index] ?? '')
                : this.paused
                  ? "I can't see you. Step back into the frame"
                  : this.nearMiss || this.liveHint(state) || '',
              stage: this.stage + 1,
              stages: def.stages.length,
              remainingMs: Math.max(0, STEP_TIMEOUT_MS - this.elapsedMs),
              totalMs: STEP_TIMEOUT_MS,
              flash: this.flash?.kind ?? null,
              paused: this.paused,
            }
          : null,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Status of the step currently shown (lets the UI offer Retry after a fail). */
  get currentStatus(): StepStatus {
    return this.status[this.index] ?? 'pending';
  }

  private ctx(state: PlayerInputState): Ctx {
    return { state, flags: this.src.getDebugGestures?.() ?? null };
  }

  private liveHint(state: PlayerInputState): string | null {
    return this.stageDef()?.hint?.(this.ctx(state)) ?? null;
  }

  private stageDef(): Stage | undefined {
    return GUIDE_STEPS[this.index]?.stages[this.stage];
  }

  private begin(i: number): void {
    this.index = i;
    this.stage = 0;
    this.elapsedMs = 0;
    this.lastTick = -1;
    this.nearMiss = '';
    this.flash = null;
    this.status[i] = 'active';
    this.details[i] = '';
  }

  private handle(e: InputEvent): void {
    if (!this.running || this.flash || this.status[this.index] !== 'active') return;
    const st = this.stageDef();
    const r = st?.event?.(e) ?? null;
    if (!r) return;
    if (r.ok) this.passStage(r.detail);
    else {
      this.nearMiss = r.hint;
      if (r.restart) this.stage = 0;
    }
  }

  private passStage(detail?: string): void {
    const def = GUIDE_STEPS[this.index];
    if (!def) return;
    this.nearMiss = '';
    if (this.stage + 1 < def.stages.length) {
      this.stage++;
      return;
    }
    this.finishStep(true, detail ?? 'detected', Math.max(this.lastTick, 0));
  }

  private finishStep(ok: boolean, detail: string, now: number): void {
    this.status[this.index] = ok ? 'pass' : 'fail';
    this.details[this.index] = detail;
    this.flash = { kind: ok ? 'pass' : 'fail', until: now + (ok ? PASS_FLASH_MS : 2500) };
    this.onResult(GUIDE_STEPS[this.index]?.title ?? '', ok, detail);
  }

  private advance(): void {
    const next = this.status.findIndex((s, i) => i > this.index && s === 'pending');
    if (next < 0) {
      this.running = false;
      this.unsub?.();
      this.unsub = null;
      return;
    }
    this.begin(next);
  }
}
