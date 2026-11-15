// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: GPL-3.0-or-later

// Part of the wrapping effect: its names are Wrapping*, except these exports (SHELL_*).
// The GLSL the wrapping is made of. Four sources, no logic.
//
// The fragment shader is kept lean: the item field is the only distance
// field (`sdAt` reads it alone), and there are no morph or drop uniforms.
// `uZoom` is needed: the quad opens while the shards fly and
// `uZoom` maps the wrapping back into the middle of the larger quad.
//
// Things below that look wrong and are not:
//
//   * `vec2 e=vec2(1.8/512.0,0.0)` samples the normal at a FIXED step, not at
//     one texel of the current buffer. The looks were tuned with it. Leave it.
//   * The ripple reads live noise every frame. Channel B of the SDF texture
//     holds a baked ripple that nothing reads — the baked one read as a grid.
//   * The `sEarly` early-out returns transparent before the expensive work. It
//     is most of the fill-rate saving.
//   * `ii` and `si` reject samples outside the quad. Without them clamp-to-edge
//     smears border pixels into streaks.

/** The wrapping quad. */
export const SHELL_VS =
  'attribute vec2 aPos;varying vec2 vUv;void main(){vUv=aPos*0.5+0.5;gl_Position=vec4(aPos,0.0,1.0);}'

/** The wrapping itself: a height field over the item's signed distance field, lit
 *  by a faked view vector, with a Voronoi shatter on `uBreak`. */
export const SHELL_FS = `precision highp float;
varying vec2 vUv;
uniform sampler2D uSDF,uItem,uCol,uNoise;
uniform float uTime,uInflate,uSmooth,uEdge,uDome,uRelief,uBump,uRefract,uChroma;
uniform float uOpacity,uBlurMix,uSatCut,uBlue,uFres,uSpec,uSweep;
uniform float uMode,uBreak,uCells,uAmp,uScale,uSpeed,uShatterSpin;
uniform float uGlowMix,uGlowGain,uGlowFall,uRipple;
uniform float uZoneLo,uZoneHi,uZoneSpec,uZoneChroma,uZoneSharp;
uniform float uShardSpread,uCrackLight,uCrackDark,uTri;
uniform vec2 uTilt,uHit;
uniform float uZoom;
float sdAt(vec2 uv){
  vec2 b = texture2D(uSDF, uv).rg;
  return (mix(b.r, b.g, uSmooth) - 0.5) * 2.0;
}
vec2 hash2(vec2 p){
  vec3 a=fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  a+=dot(a,a.yzx+33.33);
  return fract((a.xx+a.yz)*a.zy);
}
vec4 voro(vec2 p,float cells){
  vec2 n=floor(p*cells),f=fract(p*cells);
  float f1=8.0,f2=8.0; vec2 best=vec2(0.0);
  for(int j=-1;j<=1;j++){for(int i=-1;i<=1;i++){
    vec2 g=vec2(float(i),float(j));
    vec2 o=hash2(n+g);
    vec2 r=g+o-f;
    float d=dot(r,r);
    if(d<f1){f2=f1;f1=d;best=n+g+o;}else if(d<f2){f2=d;}
  }}
  return vec4(best/cells,sqrt(f1),sqrt(f2));
}
float wobble(vec2 uv){
  if(uMode>0.5||uAmp<=0.0) return 0.0;
  float t=uTime*uSpeed;
  float a=texture2D(uNoise,uv*uScale+vec2(t*0.031,t*0.019)).r;
  float b=texture2D(uNoise,uv*uScale*2.3-vec2(t*0.017,t*0.024)).g;
  return ((a-0.5)+(b-0.5)*0.55)*uAmp;
}
float field(vec2 uv,float brk){
  float d=sdAt(uv)-uInflate+wobble(uv);
  if(uMode<0.5){
    float peel=brk*1.2;
    float grain=texture2D(uNoise,uv*uScale*4.5).b-0.5;
    d+=peel*0.85+grain*peel*0.8;
  }
  return d;
}
float height(vec2 uv,float f){
  float h=smoothstep(0.0,uDome,-f);
  if(h<=0.0) return 0.0;
  vec4 t=texture2D(uSDF,uv);
  float relief=t.a-0.5;
  float rip=uRipple>0.0
    ? (texture2D(uNoise,uv*uScale*1.6+vec2(uTime*0.008,uTime*0.005)).a-0.5)*uRipple
    : 0.0;
  return clamp(h*(1.0+relief*uBump*2.0)+rip*h,0.0,1.4);
}
void main(){
  vec2 vUvz=(vUv-0.5)*uZoom+0.5;
  vec2 suv=vUvz;
  float brk=uBreak;
  float cellFade=1.0,crack=0.0;
  if(brk>0.0&&uShardSpread>0.0){
    vec2 rel=suv-uHit;
    float ar=atan(rel.y,rel.x)/6.2831853+0.5;
    float rr=sqrt(length(rel));
    float sa=uCells*0.42,sr=uCells*0.30;
    vec4 vc=voro(vec2(ar*sa,rr*sr)/uCells,uCells);
    float a2=(vc.x*uCells/sa-0.5)*6.2831853;
    float r2=vc.y*uCells/sr; r2=r2*r2;
    vec2 cen=uHit+vec2(cos(a2),sin(a2))*r2;
    float sang=atan(suv.y-cen.y,suv.x-cen.x)/6.2831853+0.5;
    float sect=floor(sang*uTri);
    float sfrac=fract(sang*uTri);
    vec2 rnd=hash2(floor(vec2(ar*sa,rr*sr)*7.0)+vec2(sect*17.0,sect*29.0));
    float seam=1.0-smoothstep(0.0,0.035+0.05*brk,vc.w-vc.z);
    float ssea=1.0-smoothstep(0.0,0.05,min(sfrac,1.0-sfrac));
    seam=max(seam,ssea*step(1.5,uTri));
    // Crack lines hold a little longer (to 0.30–0.55) than one continuous
    // ramp would keep them (out by brk 0.34, yielding to the shards), so the
    // seams read for a beat as the one-tap shatter runs 0 → 1, before the
    // shards take over.
    float fl=smoothstep(0.0,0.05,brk)*(1.0-smoothstep(0.30,0.55,brk));
    crack=seam*fl*fl;
    float fly=smoothstep(0.18,1.0,brk);
    vec2 away=cen-uHit; float dist=length(away)+0.001;
    vec2 dirC=normalize(normalize(away/dist)+(rnd-0.5)*0.7);
    float delay=rnd.y*0.4;
    float kk=max(0.0,(fly-delay)/max(0.1,1.0-delay));
    float lag=0.5+rnd.x*0.8+dist*0.6;
    suv-=dirC*kk*lag*uShardSpread;
    suv.y-=kk*kk*0.10*uShardSpread;
    float sp=(rnd.x-0.5)*uShatterSpin*kk*2.0;
    vec2 q=suv-cen;
    suv=cen+vec2(q.x*cos(sp)-q.y*sin(sp),q.x*sin(sp)+q.y*cos(sp));
    cellFade=1.0-smoothstep(0.5,1.0,kk);
  }
  vec4 t0=texture2D(uSDF,vUvz);
  float sEarly=(mix(t0.r,t0.g,uSmooth)-0.5)*2.0-uInflate+wobble(vUvz);
  if(brk<0.02 && sEarly>uEdge*2.0){ gl_FragColor=vec4(0.0); return; }
  float f=field(suv,brk);
  float hf=0.5*uZoom;
  vec2 smA=smoothstep(vec2(0.5-hf),vec2(0.5-hf+0.05),suv);
  vec2 smB=vec2(1.0)-smoothstep(vec2(0.5+hf-0.05),vec2(0.5+hf),suv);
  vec2 sm=smA*smB;
  float cov=(1.0-smoothstep(-uEdge,uEdge,f))*cellFade*sm.x*sm.y;
  float h=height(suv,f);
  vec2 e=vec2(1.8/512.0,0.0);
  float hx=height(suv+e.xy,field(suv+e.xy,brk))-height(suv-e.xy,field(suv-e.xy,brk));
  float hy=height(suv+e.yx,field(suv+e.yx,brk))-height(suv-e.yx,field(suv-e.yx,brk));
  vec3 N=normalize(vec3(vec2(hx,hy)*uRelief*120.0,1.0));
  vec3 V=normalize(vec3(uTilt*0.9,1.0));
  float zone=smoothstep(uZoneLo,uZoneHi,t0.a);
  float fade=1.0-brk;
  vec2 off=N.xy*uRefract*h*fade;
  vec2 par=uTilt*0.05*h*fade;
  float chro=uChroma*(1.0+zone*uZoneChroma)*fade;
  vec4 mid=texture2D(uItem,vUvz+off+par);
  vec3 sharpC=vec3(texture2D(uItem,vUvz+off*(1.0+chro)+par).r,
                   mid.g,
                   texture2D(uItem,vUvz+off*(1.0-chro)+par).b);
  float ia=mid.a;
  vec3 blurC=texture2D(uCol,vUvz+off+par).rgb;
  float blurAmt=clamp(uBlurMix*(0.35+h)*(1.0-zone*uZoneSharp),0.0,1.0)*(1.0-brk*0.85);
  vec3 inner=mix(sharpC,blurC,blurAmt);
  float lum=dot(inner,vec3(0.2126,0.7152,0.0722));
  inner=mix(inner,vec3(lum),uSatCut*(1.0-brk*0.8));
  inner=mix(inner,inner*vec3(0.80,0.90,1.16)+vec3(0.0,0.012,0.05),uBlue*(1.0-brk*0.8));
  vec3 R=reflect(-V,N);
  float band=sin((R.x*2.4+R.y*1.7)*3.14159+1.2);
  float sweep=pow(max(band,0.0),12.0)+0.45*pow(max(-band,0.0),20.0);
  float fres=pow(1.0-max(dot(N,V),0.0),3.0);
  float gm=uGlowMix*(1.0-brk*0.9);
  vec3 glowC=texture2D(uCol,(vUvz-0.5)*0.85+0.5+par).rgb;
  vec3 glow=glowC*pow(clamp(h,0.0,1.0),uGlowFall)*uGlowGain*gm;
  vec3 body=mix(inner,vec3(0.02),gm)*(0.72+0.34*h)+glow;
  body+=fres*uFres*vec3(0.86,0.92,1.0);
  body+=sweep*uSweep*uSpec*(1.0+zone*uZoneSpec)*vec3(1.0);
  body+=crack*uCrackLight*vec3(1.0,1.0,1.05);
  body*=1.0-crack*0.35*uCrackDark;
  float sBase=sdAt(vUvz)-uInflate+wobble(vUvz);
  float wrappingMask=1.0-smoothstep(-uEdge,uEdge,sBase);
  float clip=mix(wrappingMask,1.0,brk);
  vec2 ii=step(vec2(0.0),vUvz)*step(vUvz,vec2(1.0));
  vec2 si=step(vec2(0.0),suv)*step(suv,vec2(1.0));
  float inItem=ii.x*ii.y, inWrapping=si.x*si.y;
  cov*=inWrapping;
  float outA=max(ia*(0.06+0.94*brk)*clip*inItem,cov*uOpacity);
  vec3 under=mix(sharpC,blurC,0.15*fade);
  vec3 outC=mix(under*clip*inItem,body,cov);
  gl_FragColor=vec4(outC*outA,outA);
}`

/** Every `uniform` name the wrapping program declares. The renderer looks them all
 *  up once, so this list and the source above must stay in step. */
export const SHELL_UNIFORMS = [
  'uSDF', 'uItem', 'uCol', 'uNoise',
  'uTime', 'uInflate', 'uSmooth', 'uEdge', 'uDome', 'uRelief', 'uBump', 'uRefract', 'uChroma',
  'uOpacity', 'uBlurMix', 'uSatCut', 'uBlue', 'uFres', 'uSpec', 'uSweep',
  'uMode', 'uBreak', 'uCells', 'uAmp', 'uScale', 'uSpeed', 'uShatterSpin',
  'uGlowMix', 'uGlowGain', 'uGlowFall', 'uRipple',
  'uZoneLo', 'uZoneHi', 'uZoneSpec', 'uZoneChroma', 'uZoneSharp',
  'uShardSpread', 'uCrackLight', 'uCrackDark', 'uTri',
  'uTilt', 'uHit', 'uZoom',
] as const

// ---------------------------------------------------------------------------
// The blit
// ---------------------------------------------------------------------------
//
// A blit could set the GL viewport to the wrapping's screen box, but a viewport
// is an axis-aligned rectangle, so it CANNOT rotate, and a placement carries a
// rotation. So the viewport covers the whole canvas and the vertex shader
// places the quad instead.
//
// THE ROTATION MUST HAPPEN IN PIXELS, NOT IN CLIP SPACE. Clip space is -1..1 on
// both axes whatever the canvas shape, so one clip unit is `W/2` pixels across
// and `H/2` pixels down. Rotating a clip-space offset therefore shears the quad
// on any canvas that is not square. The conversion this shader uses:
//
//     offset in device px  ->  clip = (px.x * 2/W, px.y * -2/H)
//     uPxToClip = (2/W, -2/H)          the y sign flips because a screen y
//                                      grows downwards and clip y grows up
//     uCentre   = (2*cx/W - 1, 1 - 2*cy/H)     the quad centre, screen px in
//
// `aPos.y` is +1 at the TOP of the shaded texture, so the local offset negates
// it to reach a y-down pixel frame. In that frame [[c,-s],[s,c]] turns
// clockwise, which is what a CSS `rotate()` of the same sign does.
export const BLIT_VS = `attribute vec2 aPos;
varying vec2 vUv;
uniform vec2 uCentre;
uniform vec2 uPxToClip;
uniform float uHalfPx;
uniform float uRot;
void main(){
  vUv=aPos*0.5+0.5;
  vec2 q=vec2(aPos.x,-aPos.y)*uHalfPx;
  float c=cos(uRot), s=sin(uRot);
  vec2 r=vec2(q.x*c-q.y*s, q.x*s+q.y*c);
  gl_Position=vec4(uCentre+r*uPxToClip,0.0,1.0);
}`

/** The shaded texture is PREMULTIPLIED, so the placement opacity multiplies all
 *  four channels, not the alpha alone. */
export const BLIT_FS = `precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform float uAlpha;
void main(){gl_FragColor=texture2D(uTex,vUv)*uAlpha;}`
