// ---------- Minimal WebGL2 engine (no external dependencies) ----------
const M4 = {
  ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  copy(a) { return new Float32Array(a); },
  mul(a, b, o = new Float32Array(16)) {
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++)
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  },
  persp(fovy, asp, n, f) {
    const t = 1 / Math.tan(fovy / 2), m = new Float32Array(16);
    m[0] = t / asp; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = 2 * f * n / (n - f); return m;
  },
  lookAt(e, c, u) {
    let zx = e[0] - c[0], zy = e[1] - c[1], zz = e[2] - c[2]; let l = Math.hypot(zx, zy, zz); zx /= l; zy /= l; zz /= l;
    let xx = u[1] * zz - u[2] * zy, xy = u[2] * zx - u[0] * zz, xz = u[0] * zy - u[1] * zx; l = Math.hypot(xx, xy, xz); xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    const m = new Float32Array(16);
    m[0] = xx; m[1] = yx; m[2] = zx; m[4] = xy; m[5] = yy; m[6] = zy; m[8] = xz; m[9] = yz; m[10] = zz;
    m[12] = -(xx * e[0] + xy * e[1] + xz * e[2]); m[13] = -(yx * e[0] + yy * e[1] + yz * e[2]); m[14] = -(zx * e[0] + zy * e[1] + zz * e[2]); m[15] = 1;
    return m;
  },
  // in-place post-multiplications
  t(m, x, y, z) { m[12] += m[0] * x + m[4] * y + m[8] * z; m[13] += m[1] * x + m[5] * y + m[9] * z; m[14] += m[2] * x + m[6] * y + m[10] * z; return m; },
  s(m, x, y, z) { for (let i = 0; i < 3; i++) { m[i] *= x; m[4 + i] *= y; m[8 + i] *= z; } return m; },
  rx(m, a) { const c = Math.cos(a), s = Math.sin(a); for (let i = 0; i < 3; i++) { const a1 = m[4 + i], a2 = m[8 + i]; m[4 + i] = c * a1 + s * a2; m[8 + i] = -s * a1 + c * a2; } return m; },
  ry(m, a) { const c = Math.cos(a), s = Math.sin(a); for (let i = 0; i < 3; i++) { const a0 = m[i], a2 = m[8 + i]; m[i] = c * a0 - s * a2; m[8 + i] = s * a0 + c * a2; } return m; },
  rz(m, a) { const c = Math.cos(a), s = Math.sin(a); for (let i = 0; i < 3; i++) { const a0 = m[i], a1 = m[4 + i]; m[i] = c * a0 + s * a1; m[4 + i] = -s * a0 + c * a1; } return m; },
  trs(x, y, z, ry, sx, sy, sz) { const m = M4.ident(); M4.t(m, x, y, z); if (ry) M4.ry(m, ry); M4.s(m, sx, sy, sz); return m; },
};

// ---------- Unit meshes ----------
const MESH = (() => {
  function box() {
    const p = [], n = [], u = [], i = [];
    const faces = [
      [[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
      [[0, 1, 0], [1, 0, 0], [0, 0, -1]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
      [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [-1, 0, 0], [0, 1, 0]],
    ];
    for (const [N, U, V] of faces) {
      const b = p.length / 3;
      for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        p.push(0.5 * (N[0] + a * U[0] + c * V[0]), 0.5 * (N[1] + a * U[1] + c * V[1]), 0.5 * (N[2] + a * U[2] + c * V[2]));
        n.push(...N); u.push((a + 1) / 2, (c + 1) / 2);
      }
      i.push(b, b + 1, b + 2, b, b + 2, b + 3);
    }
    return { p, n, u, i };
  }
  function sphere(seg = 12, rings = 8) {
    const p = [], n = [], u = [], i = [];
    for (let r = 0; r <= rings; r++) {
      const th = r / rings * Math.PI;
      for (let s = 0; s <= seg; s++) {
        const ph = s / seg * Math.PI * 2;
        const x = Math.sin(th) * Math.cos(ph), y = Math.cos(th), z = Math.sin(th) * Math.sin(ph);
        p.push(x * 0.5, y * 0.5, z * 0.5); n.push(x, y, z); u.push(s / seg, r / rings);
      }
    }
    for (let r = 0; r < rings; r++) for (let s = 0; s < seg; s++) {
      const a = r * (seg + 1) + s, b = a + seg + 1;
      i.push(a, a + 1, b, b, a + 1, b + 1);
    }
    return { p, n, u, i };
  }
  function cyl(seg = 16, caps = true) {
    const p = [], n = [], u = [], i = [];
    for (let s = 0; s <= seg; s++) {
      const a = s / seg * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
      p.push(x * 0.5, -0.5, z * 0.5, x * 0.5, 0.5, z * 0.5); n.push(x, 0, z, x, 0, z); u.push(s / seg, 0, s / seg, 1);
    }
    for (let s = 0; s < seg; s++) { const a = s * 2; i.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    if (caps) for (const y of [0.5, -0.5]) {
      const c = p.length / 3; p.push(0, y, 0); n.push(0, Math.sign(y), 0); u.push(0.5, 0.5);
      for (let s = 0; s <= seg; s++) { const a = s / seg * Math.PI * 2; p.push(Math.cos(a) * 0.5, y, Math.sin(a) * 0.5); n.push(0, Math.sign(y), 0); u.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5); }
      for (let s = 0; s < seg; s++) y > 0 ? i.push(c, c + 2 + s, c + 1 + s) : i.push(c, c + 1 + s, c + 2 + s);
    }
    return { p, n, u, i };
  }
  function plane() { // XY quad facing +Z
    return { p: [-.5, -.5, 0, .5, -.5, 0, .5, .5, 0, -.5, .5, 0], n: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], u: [0, 0, 1, 0, 1, 1, 0, 1], i: [0, 1, 2, 0, 2, 3] };
  }
  return { box: box(), sphere: sphere(), sphereLo: sphere(8, 6), cyl: cyl(), cylLo: cyl(8), tube: cyl(16, false), plane: plane() };
})();

// ---------- Static batch builder ----------
class Batch {
  constructor(name, opts = {}) { this.name = name; this.o = opts; this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; }
  add(mesh, m, col = [1, 1, 1, 0], uv = null) {
    const base = this.p.length / 3, P = mesh.p, N = mesh.n, U = mesh.u;
    const ao = this.o.ao;
    for (let k = 0; k < P.length; k += 3) {
      const x = P[k], y = P[k + 1], z = P[k + 2];
      const wx = m[0] * x + m[4] * y + m[8] * z + m[12], wy = m[1] * x + m[5] * y + m[9] * z + m[13], wz = m[2] * x + m[6] * y + m[10] * z + m[14];
      // normal (inverse-transpose approx via scale division)
      const nx0 = N[k], ny0 = N[k + 1], nz0 = N[k + 2];
      const s0 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2], s1 = m[4] * m[4] + m[5] * m[5] + m[6] * m[6], s2 = m[8] * m[8] + m[9] * m[9] + m[10] * m[10];
      const ax = nx0 / s0, ay = ny0 / s1, az = nz0 / s2;
      let nx = m[0] * ax + m[4] * ay + m[8] * az, ny = m[1] * ax + m[5] * ay + m[9] * az, nz = m[2] * ax + m[6] * ay + m[10] * az;
      const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
      this.p.push(wx, wy, wz); this.n.push(nx, ny, nz);
      const ku = k / 3 * 2;
      if (!uv || uv.mode === 'mesh') { const s = uv && uv.s || [1, 1]; this.u.push(U[ku] * s[0], U[ku + 1] * s[1]); }
      else if (uv.mode === 'world') {
        const s = uv.s, ox = uv.o || 0;
        const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
        if (any >= anx && any >= anz) this.u.push(wx * s + ox, wz * s);
        else if (anx >= anz) this.u.push(wz * s + ox, wy * s);
        else this.u.push(wx * s + ox, wy * s);
      } else if (uv.mode === 'rect') { const r = uv.r; this.u.push(r[0] + U[ku] * (r[2] - r[0]), r[1] + U[ku + 1] * (r[3] - r[1])); }
      let f = 1;
      if (ao) { const h = ao; f = wy < h ? 0.62 + 0.38 * Math.pow(Math.max(wy, 0) / h, 0.6) : 1; }
      this.c.push(col[0] * f, col[1] * f, col[2] * f, col[3] || 0);
    }
    for (const idx of mesh.i) this.i.push(base + idx);
    return this;
  }
  get verts() { return this.p.length / 3; }
}

// ---------- Renderer ----------
const VS_STATIC = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec2 aUv; layout(location=3) in vec4 aCol;
uniform mat4 uVP;
out vec3 vPos; out vec3 vNrm; out vec2 vUv; out vec4 vCol;
void main(){ vPos=aPos; vNrm=aNrm; vUv=aUv; vCol=aCol; gl_Position=uVP*vec4(aPos,1.); }`;
const VS_INST = `#version 300 es
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNrm; layout(location=2) in vec2 aUv;
layout(location=4) in vec4 aM0; layout(location=5) in vec4 aM1; layout(location=6) in vec4 aM2; layout(location=7) in vec4 aM3; layout(location=8) in vec4 aICol;
uniform mat4 uVP;
out vec3 vPos; out vec3 vNrm; out vec2 vUv; out vec4 vCol;
void main(){ mat4 M=mat4(aM0,aM1,aM2,aM3); vec4 wp=M*vec4(aPos,1.); vPos=wp.xyz;
 vec3 sc=vec3(dot(aM0.xyz,aM0.xyz),dot(aM1.xyz,aM1.xyz),dot(aM2.xyz,aM2.xyz));
 vNrm=mat3(M)*(aNrm/max(sc,vec3(1e-6))); vUv=aUv; vCol=aICol; gl_Position=uVP*wp; }`;
const FS = `#version 300 es
precision highp float;
in vec3 vPos; in vec3 vNrm; in vec2 vUv; in vec4 vCol;
uniform sampler2D uTex; uniform vec3 uCam; uniform vec3 uSky; uniform vec3 uGnd; uniform vec3 uKeyDir; uniform vec3 uKeyCol;
uniform int uNL; uniform vec4 uLP[12]; uniform vec4 uLC[12];
uniform float uSpec; uniform float uShin; uniform float uUnlit; uniform float uAlpha; uniform vec3 uFog; uniform float uFogD; uniform float uExpo;
out vec4 o;
vec3 aces(vec3 x){return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.);}
void main(){
 vec4 t=texture(uTex,vUv);
 vec3 alb=pow(t.rgb*vCol.rgb,vec3(2.2));
 vec3 N=normalize(vNrm); if(!gl_FrontFacing) N=-N;
 vec3 V=normalize(uCam-vPos);
 vec3 lit=alb*mix(uGnd,uSky,N.y*.5+.5);
 lit+=alb*uKeyCol*max(dot(N,-uKeyDir),0.);
 vec3 sp=vec3(0.);
 for(int i=0;i<12;i++){ if(i>=uNL) break; vec3 L=uLP[i].xyz-vPos; float d=length(L); L/=d;
   float a=clamp(1.-d/uLP[i].w,0.,1.); a*=a; vec3 c=uLC[i].rgb*uLC[i].a*a;
   lit+=alb*c*max(dot(N,L),0.); sp+=c*pow(max(dot(N,normalize(L+V)),0.),uShin); }
 lit+=sp*uSpec;
 float fr=pow(1.-max(dot(N,V),0.),5.); lit+=uSpec*fr*uSky*.5;
 vec3 col=mix(lit,alb*1.5,uUnlit)+alb*vCol.a*3.;
 float f=1.-exp(-uFogD*length(uCam-vPos)); col=mix(col,uFog,f);
 col=pow(aces(col*uExpo),vec3(1./2.2));
 o=vec4(col,t.a*uAlpha);
}`;

class Renderer {
  constructor(canvas, opts = {}) {
    const gl = canvas.getContext('webgl2', { antialias: opts.antialias !== false, powerPreference: 'high-performance', preserveDrawingBuffer: !!opts.preserve });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl; this.canvas = canvas;
    this.pStatic = this.prog(VS_STATIC, FS); this.pInst = this.prog(VS_INST, FS);
    this.aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    this.white = this.texFromCanvas(Object.assign(document.createElement('canvas'), { width: 4, height: 4 }), { fill: '#fff' });
    this.stats = { draws: 0, tris: 0 };
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }
  prog(vs, fs) {
    const gl = this.gl;
    const mk = (t, s) => { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); return sh; };
    const p = gl.createProgram(); gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let k = 0; k < n; k++) { const info = gl.getActiveUniform(p, k); const nm = info.name.replace('[0]', ''); u[nm] = gl.getUniformLocation(p, nm); }
    return { p, u };
  }
  texFromCanvas(cv, o = {}) {
    const gl = this.gl;
    if (o.fill) { const x = cv.getContext('2d'); x.fillStyle = o.fill; x.fillRect(0, 0, cv.width, cv.height); }
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    const wrap = o.clamp ? gl.CLAMP_TO_EDGE : gl.REPEAT;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    if (o.nomip) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); }
    else { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (this.aniso && !o.nomip) gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
    t.o = o; return t;
  }
  updateTex(t, cv) {
    const gl = this.gl; gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
    if (!t.o.nomip) gl.generateMipmap(gl.TEXTURE_2D);
  }
  upload(batch, tex) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = (data, loc, size) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    buf(batch.p, 0, 3); buf(batch.n, 1, 3); buf(batch.u, 2, 2); buf(batch.c, 3, 4);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(batch.i), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: batch.i.length, tex: tex || this.white, o: batch.o, name: batch.name };
  }
  instMesh(mesh, tex, opts = {}) {
    const gl = this.gl, vao = gl.createVertexArray(); gl.bindVertexArray(vao);
    const buf = (data, loc, size) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0); };
    buf(mesh.p, 0, 3); buf(mesh.n, 1, 3); buf(mesh.u, 2, 2);
    gl.disableVertexAttribArray(3); gl.vertexAttrib4f(3, 1, 1, 1, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(mesh.i), gl.STATIC_DRAW);
    const inst = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    for (let k = 0; k < 5; k++) { gl.enableVertexAttribArray(4 + k); gl.vertexAttribPointer(4 + k, 4, gl.FLOAT, false, 80, k * 16); gl.vertexAttribDivisor(4 + k, 1); }
    gl.bindVertexArray(null);
    return { vao, inst, count: mesh.i.length, tex: tex || this.white, o: opts, data: new Float32Array(20 * 512), n: 0 };
  }
  push(im, m, col) { // add an instance
    if ((im.n + 1) * 20 > im.data.length) { const d = new Float32Array(im.data.length * 2); d.set(im.data); im.data = d; }
    const o = im.n * 20; im.data.set(m, o); im.data[o + 16] = col[0]; im.data[o + 17] = col[1]; im.data[o + 18] = col[2]; im.data[o + 19] = col[3] || 0; im.n++;
  }
  setFrame(f) { this.f = f; this.stats.draws = 0; this.stats.tris = 0; }
  bindCommon(P, o) {
    const gl = this.gl, f = this.f, u = P.u;
    gl.useProgram(P.p);
    gl.uniformMatrix4fv(u.uVP, false, f.vp); gl.uniform3fv(u.uCam, f.cam);
    gl.uniform3fv(u.uSky, f.sky); gl.uniform3fv(u.uGnd, f.gnd); gl.uniform3fv(u.uKeyDir, f.keyDir); gl.uniform3fv(u.uKeyCol, f.keyCol);
    gl.uniform1i(u.uNL, f.nl); gl.uniform4fv(u.uLP, f.lp); gl.uniform4fv(u.uLC, f.lc);
    gl.uniform3fv(u.uFog, f.fog); gl.uniform1f(u.uFogD, f.fogD); gl.uniform1f(u.uExpo, f.expo);
    gl.uniform1f(u.uSpec, o.spec || 0); gl.uniform1f(u.uShin, o.shin || 24); gl.uniform1f(u.uUnlit, o.unlit || 0); gl.uniform1f(u.uAlpha, o.alpha == null ? 1 : o.alpha);
    gl.uniform1i(u.uTex, 0);
  }
  blendState(o) {
    const gl = this.gl;
    if (o.alpha != null && o.alpha < 1 || o.blend) { gl.enable(gl.BLEND); gl.depthMask(false); } else { gl.disable(gl.BLEND); gl.depthMask(true); }
    if (o.twoSided) gl.disable(gl.CULL_FACE); else gl.enable(gl.CULL_FACE);
  }
  draw(d) {
    const gl = this.gl; this.blendState(d.o); this.bindCommon(this.pStatic, d.o);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, d.tex);
    gl.bindVertexArray(d.vao); gl.drawElements(gl.TRIANGLES, d.count, gl.UNSIGNED_INT, 0);
    this.stats.draws++; this.stats.tris += d.count / 3;
  }
  drawInst(im) {
    if (!im.n) return; const gl = this.gl; this.blendState(im.o); this.bindCommon(this.pInst, im.o);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, im.tex);
    gl.bindVertexArray(im.vao); gl.bindBuffer(gl.ARRAY_BUFFER, im.inst); gl.bufferData(gl.ARRAY_BUFFER, im.data.subarray(0, im.n * 20), gl.DYNAMIC_DRAW);
    gl.drawElementsInstanced(gl.TRIANGLES, im.count, gl.UNSIGNED_SHORT, 0, im.n);
    this.stats.draws++; this.stats.tris += im.count / 3 * im.n; im.n = 0;
  }
}
