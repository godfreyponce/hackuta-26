// One-pass "IMAX night" grade: desaturate (fire hues exempt) · split-tone (cool shadows / warm highs)
// · shadow-weighted grain · vignette · damage edge flash · 2.20:1 killcam letterbox (baked into the
// canvas so it also shows in recorded killcams and on the friend's FaceTime view).
import { Effect, BlendFunction } from 'postprocessing';
import { Uniform } from 'three';

const frag = /* glsl */ `
uniform float uSat;
uniform float uFlash;
uniform float uHeal;
uniform float uLetterbox;
uniform float uTime;
uniform float uAspect;
uniform float uGrain;
uniform float uVignette;

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = inputColor.rgb;
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float warm = clamp((c.r - c.b) * 2.2 - 0.12, 0.0, 1.0) * smoothstep(0.18, 0.65, l);
  float sat = mix(uSat, max(uSat, 0.98), warm);
  c = mix(vec3(l), c, sat);
  c *= mix(vec3(0.84, 0.95, 1.14), vec3(1.07, 0.99, 0.88), smoothstep(0.04, 0.55, l));
  vec2 d = uv - 0.5;
  d.x *= uAspect;
  float r = length(d);
  c *= mix(1.0 - uVignette, 1.0, smoothstep(0.95, 0.28, r));
  float edge = smoothstep(0.35, 0.95, r);
  c = mix(c, vec3(0.5, 0.05, 0.035), clamp(uFlash, 0.0, 1.0) * edge * 0.8);
  c += vec3(0.05, 0.13, 0.09) * uHeal * edge;
  float n = fract(sin(dot(floor(uv * vec2(1280.0, 720.0)) + fract(uTime * 7.31) * 113.0, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  c += n * uGrain * (1.0 - clamp(l, 0.0, 1.0) * 0.75);
  float bar = uLetterbox * max(0.0, 1.0 - uAspect / 2.2) * 0.5;
  if (uv.y < bar || uv.y > 1.0 - bar) c = vec3(0.0);
  outputColor = vec4(max(c, 0.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor() {
    super('GradeEffect', frag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['uSat', new Uniform(0.72)],
        ['uFlash', new Uniform(0)],
        ['uHeal', new Uniform(0)],
        ['uLetterbox', new Uniform(0)],
        ['uTime', new Uniform(0)],
        ['uAspect', new Uniform(16 / 9)],
        ['uGrain', new Uniform(0.026)],
        ['uVignette', new Uniform(0.3)],
      ]),
    });
  }
  set(name: 'uSat' | 'uFlash' | 'uHeal' | 'uLetterbox' | 'uTime' | 'uAspect' | 'uGrain' | 'uVignette', v: number) {
    const u = this.uniforms.get(name);
    if (u) u.value = v;
  }
}
