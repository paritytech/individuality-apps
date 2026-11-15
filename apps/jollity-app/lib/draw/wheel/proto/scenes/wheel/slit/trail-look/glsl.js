// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

/* THE TRAIL, AS A SHADER — one program for every colour and every edge, so
   any pair of them is one family: one spectrum, one noise, the same fade by
   age the flat trail has (paint.js's TRAIL alphas). GLSL ES 3.00 (WebGL2).

   A trail arrives as quads (gl.js): a line's run along it, a circle's
   square round it. Each fragment knows
     u       its age, 0 at the ticket, 1 at the tail's end
     d       how far out from the middle, in half-widths: 1 is the
             ticket's edge — the geometry reaches past it, for an edge that
             glows or drifts out
     tp      where it is on the trail, px: along it from the ticket and
             across it (a circle's: from its centre)
     world   where it is on the stage, nominal px — dust is hashed here, so
             it stays where it fell while the trail passes on
   Colours are mixed in linear light and written premultiplied.

   Turbo is Google's polynomial fit (Apache-2.0, Anton Mikhailov); the
   wavelength → colour is Wyman, Sloan & Shirley's multi-lobe fit to the CIE
   1931 observer (JCGT 2013). */

export const VERT = /* glsl */ `#version 300 es
in vec2 aPos;    // nominal stage px
in vec2 aLocal;  // a line: (px along it from the ticket, across in half-widths); a circle: (x, y) in radii
in vec4 aInfo;   // age, half-width px, alpha, kind (0 line, 1 circle)
in vec4 aHead;   // the ticket's colour (sRGB 0..1), and the tint: how much of the palette (−1: plain, its own colour)
in float aDepth;
uniform vec3 uXform; // nominal → device px: scale, tx, ty (the 2D canvas's own transform)
uniform vec2 uRes;
out vec2 vWorld;
out vec2 vLocal;
out vec4 vInfo;
out vec4 vHead;
void main() {
  vec2 px = aPos * uXform.x + uXform.yz;
  vec2 c = px / uRes * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, aDepth, 1.0);
  vWorld = aPos;
  vLocal = aLocal;
  vInfo = aInfo;
  vHead = aHead;
}
`

export const FRAG = /* glsl */ `#version 300 es
precision highp float;
in vec2 vWorld;
in vec2 vLocal;
in vec4 vInfo;
in vec4 vHead;
out vec4 oColor;

uniform float uTime;
uniform int uColour;   // 0 gamma, 1 spectral, 2 heatmap, 3 70s
uniform int uEdge;     // 0 none, 1 spectral, 2 dots, 3 dust, 4 glass

uniform int uStops;
uniform float uTicketFirst;
uniform vec3 uC[4];    // linear
uniform float uCurve;
uniform vec2 uNm;
uniform float uSat;
uniform vec4 uHeat;    // warp, grain, drift, reverse
uniform int uPalN;
uniform vec3 uPal[8];  // linear
uniform float uLanes;
uniform vec4 uGap;     // linear rgb, width px

uniform vec4 uFringe;  // width, softness, red outside, strength
uniform vec3 uDots;    // pitch px, size, depth
uniform vec4 uDust;    // spread, density, speck px, twinkle
uniform vec4 uGlass;   // roundness, rim, rainbow, wobble
uniform float uGlassHeat;

const float TAU = 6.2831853;

vec3 lin(vec3 c) { return pow(max(c, 0.0), vec3(2.2)); }
vec3 srgb(vec3 c) { return pow(max(c, 0.0), vec3(1.0 / 2.2)); }

float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) {
    s += a * noise(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s / 0.875;
}

/* the fade by age — the flat trail's: 1, 0.711 at 45/138.5, 0.5 at 77.9/138.5, 0 */
float ageAlpha(float u) {
  if (u < 0.325) return mix(1.0, 0.711, u / 0.325);
  if (u < 0.5625) return mix(0.711, 0.5, (u - 0.325) / 0.2375);
  return mix(0.5, 0.0, clamp((u - 0.5625) / 0.4375, 0.0, 1.0));
}

/* a wavelength, nm → linear RGB at its brightest, dimming toward the ends of sight */
float lobe(float x, float mu, float s1, float s2) {
  float t = (x - mu) / (x < mu ? s1 : s2);
  return exp(-0.5 * t * t);
}
vec3 spectrum(float l) {
  float X = 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
  float Y = 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
  float Z = 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
  vec3 c = max(mat3(3.2406, -0.9689, 0.0557, -1.5372, 1.8758, -0.2040, -0.4986, 0.0415, 1.0570) * vec3(X, Y, Z), 0.0);
  /* at its brightest: over a smooth max (a 4-norm), so the hue never kinks where one channel overtakes another */
  vec3 c2 = c * c;
  float m = pow(dot(c2, c2), 0.25);
  return c / max(m, 1e-3) * clamp(m * 2.2, 0.0, 1.0);
}

/* the cosine spectrum: one turn of the hue per unit of phase */
vec3 cosSpectrum(float phase) { return 0.5 + 0.5 * cos(TAU * (vec3(0.0, 0.33, 0.67) + phase)); }

vec3 turbo(float x) {
  const vec4 kR = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(dot(v4, kR) + dot(v2, kR2), dot(v4, kG) + dot(v2, kG2), dot(v4, kB) + dot(v2, kB2));
}

vec3 palette(float x) {
  float s = clamp(x, 0.0, 1.0) * float(uPalN - 1);
  int i = int(min(floor(s), float(uPalN - 2)));
  return mix(uPal[i], uPal[i + 1], s - float(i));
}

/* THE COLOUR at age u; across: −1..1 over a line, 0..1 out from a circle's middle */
vec3 colourAt(float u, float across, bool disc, float hw, vec3 head, float tint) {
  if (tint < 0.0) return head;
  if (uColour == 1) {
    vec3 c = spectrum(mix(uNm.x, uNm.y, u));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    return mix(vec3(l), c, uSat);
  }
  if (uColour == 2) {
    float h = uHeat.w > 0.5 ? u : 1.0 - u;
    h += uHeat.x * (fbm(vWorld * 0.014 + vec2(0.0, uTime * uHeat.z)) - 0.5) * 1.3;
    h += (hash(gl_FragCoord.xy + floor(uTime * 30.0) * 17.0) - 0.5) * uHeat.y;
    return lin(turbo(clamp(h, 0.0, 1.0) * 0.86 + 0.07));
  }
  if (uColour == 3) {
    float t = clamp(disc ? across : across * 0.5 + 0.5, 0.0, 0.9999); // a line's lanes run along it; a circle's are rings
    float n = uLanes;
    float lane = floor(t * n);
    vec3 c = palette((lane + 0.5) / n);
    /* the dark line between two lanes, uGap.w px wide */
    float k = t * n;
    float edge = abs(fract(k + 0.5) - 0.5) / n * (disc ? hw : 2.0 * hw); // px to the nearest lane boundary
    float inner = step(0.5, k) * step(k, n - 0.5);
    float aa = max(fwidth(edge), 1e-3);
    return mix(c, uGap.rgb, inner * (1.0 - smoothstep(uGap.w * 0.5 - aa, uGap.w * 0.5 + aa, edge)));
  }
  /* gamma: uStops colours, evenly, along pow(u, curve) */
  float x = pow(clamp(u, 0.0, 1.0), uCurve) * float(uStops - 1);
  int i = int(min(floor(x), float(uStops - 2)));
  vec3 a = (i == 0 && uTicketFirst > 0.5) ? head : uC[i];
  vec3 c = mix(a, uC[i + 1], x - float(i));
  return uTicketFirst > 0.5 ? mix(head, c, tint) : c;
}

void main() {
  float u = clamp(vInfo.x, 0.0, 1.0);
  float hw = max(vInfo.y, 0.01);
  bool disc = vInfo.w > 0.5;
  float d = disc ? length(vLocal) : abs(vLocal.y);
  vec2 tp = disc ? vLocal * hw : vec2(vLocal.x, vLocal.y * hw);
  float across = disc ? d : vLocal.y;
  float shown = vInfo.z * ageAlpha(u);
  vec3 head = lin(vHead.rgb);
  vec3 col = colourAt(u, clamp(across, -1.0, 1.0), disc, hw, head, vHead.w);
  float aa = max(fwidth(d), 1e-4);
  float A = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, d); // none: the ticket's edge, one pixel soft

  if (uEdge == 1) {
    /* SPECTRAL: the trail's own colour running into a rainbow band at its
       rim — red to violet outward (or back), glowing out to nothing */
    float w = uFringe.x;
    float out_ = w * mix(0.35, 1.0, uFringe.y); // how far the glow reaches past the edge
    float t = (d - (1.0 - w)) / (w + out_); //    0 where the band starts inside, 1 at the glow's end
    float tc = clamp(t, 0.0, 1.0);
    /* evenly through the hues (the cosine spectrum, run backward: red, yellow, green, blue, violet),
       not the physical one — whose green is most of it and whose red is a hairline */
    vec3 sp = lin(cosSpectrum(-0.72 * (uFringe.z > 0.5 ? 1.0 - tc : tc))) * 1.25;
    col = mix(col, sp, smoothstep(-0.12, 0.06, t) * uFringe.w);
    float past = clamp((d - 1.0) / out_, 0.0, 1.0);
    A = d <= 1.0 ? 1.0 - smoothstep(1.0 - aa, 1.0, d) * 0.15 : pow(1.0 - past, mix(0.7, 2.2, uFringe.y)) * 0.85;
  } else if (uEdge == 2) {
    /* DOTS: a halftone in the trail's own frame, rows running along it,
       the dots shrinking toward the edge and the tail; solid inside them */
    float P = uDots.x;
    vec2 q = tp / P;
    float row = floor(q.y);
    float shift = mod(row, 2.0) * 0.5;
    q.x += shift;
    vec2 cell = fract(q) - 0.5;
    vec2 cc = (floor(q) + 0.5 - vec2(shift, 0.0)) * P;
    float dc = disc ? length(cc) / hw : abs(cc.y) / hw;
    float inner = 1.0 - uDots.z;
    float field = 1.0 - smoothstep(inner, 1.0, dc);
    float r = 0.5 * uDots.y * mix(0.3, 1.0, field) * mix(0.45, 1.0, ageAlpha(u)) * step(dc, 1.02);
    float aq = max(fwidth(q.x), 1e-3);
    float dotA = 1.0 - smoothstep(r - aq, r + aq, length(cell));
    float solid = inner > 0.0 ? 1.0 - smoothstep(inner - aa, inner + aa, d) : 0.0;
    A = max(solid, dotA);
  } else if (uEdge == 3) {
    /* DUST: the body thins toward its edge and comes apart into specks that
       stay where they fell — two layers of them, twinkling */
    float spread = uDust.x;
    float body = (1.0 - smoothstep(1.0 - min(0.9, spread * 0.6 + 0.1), 1.0, d)) * (0.78 + 0.22 * hash(floor(vWorld * 3.0)));
    float chance = uDust.y * (1.0 - smoothstep(0.55, 1.0 + spread, d));
    float sp = 0.0;
    for (int L = 0; L < 2; L++) {
      float g = uDust.z * (L == 0 ? 3.2 : 5.1);
      vec2 q = vWorld / g + float(L) * 17.3;
      vec2 c = floor(q);
      float h = hash(c);
      vec2 o = vec2(hash(c + 3.1), hash(c + 7.7)) * 0.6 + 0.2;
      float dd = length(fract(q) - o) * g;
      float rr = uDust.z * (0.45 + 0.55 * hash(c + 11.0));
      float tw = mix(1.0, pow(0.5 + 0.5 * sin(h * 60.0 + uTime * (2.0 + h * 6.0)), 2.0), uDust.w);
      float ad = max(fwidth(dd), 1e-3);
      sp = max(sp, step(h, chance) * tw * (1.0 - smoothstep(rr - ad, rr + ad, dd)));
    }
    col = mix(col, mix(col, vec3(1.0), 0.6), sp * (1.0 - body));
    A = max(body, sp);
  } else if (uEdge == 4) {
    /* HOT LIQUID GLASS: a poured tube — its edge wobbling, its middle
       see-through, its rim lit white with an oil-film rainbow in it, and a
       warm glow in its core, hottest at the ticket */
    float wob = uGlass.w * (noise(vWorld * 0.035 + vec2(uTime * 0.6, 0.0)) - 0.5) * 0.5;
    float dg = d * (1.0 + wob);
    float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, dg);
    float h = sqrt(max(0.0, 1.0 - dg * dg));
    vec2 nxy = disc ? vLocal * (1.0 + wob) : vec2(0.0, vLocal.y * (1.0 + wob));
    vec3 N = normalize(vec3(nxy * (0.3 + 1.7 * uGlass.x), max(h, 0.02)));
    float fres = pow(1.0 - N.z, 2.0);
    float rimBand = smoothstep(0.35, 0.95, dg);
    vec3 film = lin(cosSpectrum(dg * 1.1 + dot(N.xy, vec2(0.6, 0.9)) + tp.x * 0.006 + uTime * 0.18));
    /* the light along it: a broad streak down one side, a fainter one down the other */
    float streak = disc ? exp(-pow(length(vLocal - vec2(-0.38, -0.38)) / 0.26, 2.0)) : exp(-pow((across - 0.45) / 0.16, 2.0)) + 0.35 * exp(-pow((across + 0.6) / 0.1, 2.0));
    vec3 c = col * (0.45 + 0.75 * h);
    c += film * uGlass.z * rimBand * 1.5;
    c += vec3(1.0) * uGlass.y * (fres * 0.8 + streak * 0.9);
    c += uGlassHeat * vec3(1.0, 0.36, 0.08) * pow(h, 3.0) * (1.0 - u) * 1.3;
    /* past the rim: a little of the film's light */
    float glow = (1.0 - inside) * exp(-max(0.0, dg - 1.0) * 10.0) * 0.4 * uGlass.z;
    col = inside > 0.0 ? c : film;
    A = inside * max(mix(0.6, 1.0, max(fres, rimBand)), min(1.0, streak * uGlass.y)) + glow;
  }

  float alpha = clamp(A * shown, 0.0, 1.0);
  if (alpha < 0.002) discard;
  oColor = vec4(srgb(col) * alpha, alpha);
}
`
