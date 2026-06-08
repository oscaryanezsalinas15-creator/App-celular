'use strict';

/* ═══════════════════════════════════════════════════════
   Visor Panorámico — app.js
   Renderizado WebGL con proyección equirectangular 360°
   ═══════════════════════════════════════════════════════ */

// ── Elementos del DOM ──────────────────────────────────
const $ = id => document.getElementById(id);
const welcomeScreen   = $('welcome-screen');
const viewerScreen    = $('viewer-screen');
const canvas          = $('panorama-canvas');
const btnUpload       = $('btn-upload');
const btnDemo         = $('btn-demo');
const fileInput       = $('file-input');
const btnBack         = $('btn-back');
const btnInfo         = $('btn-info');
const btnGyro         = $('btn-gyro');
const btnZoomIn       = $('btn-zoom-in');
const btnZoomOut      = $('btn-zoom-out');
const btnReset        = $('btn-reset');
const loadingOverlay  = $('loading-overlay');
const loadingText     = $('loading-text');
const infoPanel       = $('info-panel');
const infoDetails     = $('info-details');
const btnCloseInfo    = $('btn-close-info');
const imageName       = $('image-name');
const compassNeedle   = $('compass-needle');
const gyroIndicator   = $('gyro-indicator');

// ── Estado ─────────────────────────────────────────────
const state = {
  yaw:        0,        // rotación horizontal (radianes)
  pitch:      0,        // rotación vertical
  fov:        75,       // campo de visión (grados)
  fovMin:     30,
  fovMax:     120,
  gyroOn:     true,
  gyroAvail:  false,
  dragging:   false,
  lastX:      0,
  lastY:      0,
  pinching:   false,
  pinchDist0: 0,
  fov0:       75,
  imgW:       0,
  imgH:       0,
  imgName:    '',
  // inercia
  velYaw:     0,
  velPitch:   0,
  // giroscopio
  gyroAlpha:  0,
  gyroBeta:   0,
  gyroGamma:  0,
  gyroBase:   null,
};

// ── WebGL ───────────────────────────────────────────────
let gl, prog, tex;
let uTex, uYaw, uPitch, uFov, uAspect;

// ── Shaders ─────────────────────────────────────────────
const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Proyección equirectangular inversa:
// Convierte cada pixel de pantalla → dirección 3D → coordenada UV en el panorama
const FRAG_SRC = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_fov;
uniform float u_aspect;

#define PI 3.14159265358979

void main() {
  float fovRad = u_fov * PI / 180.0;

  // Rayo en espacio de cámara (campo de vista)
  float tanHalfFov = tan(fovRad * 0.5);
  vec3 dir;
  dir.x = v_uv.x * u_aspect * tanHalfFov;
  dir.y = v_uv.y * tanHalfFov;
  dir.z = -1.0;

  // Rotar por pitch (X)
  float cp = cos(u_pitch), sp = sin(u_pitch);
  float y2 = dir.y * cp - dir.z * sp;
  float z2 = dir.y * sp + dir.z * cp;
  dir = vec3(dir.x, y2, z2);

  // Rotar por yaw (Y)
  float cy = cos(u_yaw), sy = sin(u_yaw);
  float x3 = dir.x * cy + dir.z * sy;
  float z3 = -dir.x * sy + dir.z * cy;
  dir = vec3(x3, dir.y, z3);

  dir = normalize(dir);

  // Spherical coords → UV
  float lon = atan(dir.x, -dir.z);
  float lat = asin(clamp(dir.y, -1.0, 1.0));

  float u = lon / (2.0 * PI) + 0.5;
  float v = lat / PI + 0.5;

  gl_FragColor = texture2D(u_tex, vec2(u, 1.0 - v));
}`;

// ── Init WebGL ──────────────────────────────────────────
function initGL() {
  gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false });
  if (!gl) { alert('Tu navegador no soporta WebGL'); return false; }

  const vs = compileShader(gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl.FRAGMENT_SHADER, FRAG_SRC);
  prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.useProgram(prog);

  // Quad que cubre toda la pantalla
  const quad = new Float32Array([-1,-1, 1,-1, -1,1, 1,1]);
  const buf  = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

  uTex    = gl.getUniformLocation(prog, 'u_tex');
  uYaw    = gl.getUniformLocation(prog, 'u_yaw');
  uPitch  = gl.getUniformLocation(prog, 'u_pitch');
  uFov    = gl.getUniformLocation(prog, 'u_fov');
  uAspect = gl.getUniformLocation(prog, 'u_aspect');

  tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  // Pixel temporal mientras carga
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
    new Uint8Array([20, 20, 20, 255]));

  return true;
}

function compileShader(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(s));
  }
  return s;
}

// ── Cargar textura ──────────────────────────────────────
function loadTexture(img) {
  gl.bindTexture(gl.TEXTURE_2D, tex);

  // Si la imagen es muy grande, la reducimos para evitar límites de GPU
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  let src = img;

  if (img.naturalWidth > maxTex || img.naturalHeight > maxTex) {
    const scale = Math.min(maxTex / img.naturalWidth, maxTex / img.naturalHeight);
    const offCanvas = document.createElement('canvas');
    offCanvas.width  = Math.floor(img.naturalWidth  * scale);
    offCanvas.height = Math.floor(img.naturalHeight * scale);
    offCanvas.getContext('2d').drawImage(img, 0, 0, offCanvas.width, offCanvas.height);
    src = offCanvas;
  }

  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

  // Mip maps solo si las dimensiones son potencia de 2
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  if (isPow2(w) && isPow2(h)) {
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  }
}

const isPow2 = n => n && (n & (n - 1)) === 0;

// ── Render loop ─────────────────────────────────────────
let rafId = null;
function startRender() {
  if (rafId) return;
  function frame() {
    resize();
    applyInertia();
    clampPitch();
    draw();
    updateCompass();
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);
}

function stopRender() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
}

function resize() {
  const w = window.innerWidth  * devicePixelRatio;
  const h = window.innerHeight * devicePixelRatio;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width  = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
  }
}

function draw() {
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.uniform1i(uTex,    0);
  gl.uniform1f(uYaw,    state.yaw);
  gl.uniform1f(uPitch,  state.pitch);
  gl.uniform1f(uFov,    state.fov);
  gl.uniform1f(uAspect, canvas.width / canvas.height);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function applyInertia() {
  if (!state.dragging && !state.gyroOn) {
    state.velYaw   *= 0.88;
    state.velPitch *= 0.88;
    state.yaw   += state.velYaw;
    state.pitch += state.velPitch;
  }
}

function clampPitch() {
  const limit = (80 * Math.PI) / 180;
  state.pitch = Math.max(-limit, Math.min(limit, state.pitch));
}

function updateCompass() {
  const deg = ((-state.yaw * 180 / Math.PI) % 360 + 360) % 360;
  compassNeedle.style.transform = `rotate(${deg}deg)`;
}

// ── Generar imagen demo ─────────────────────────────────
function generateDemoImage() {
  const W = 4096, H = 2048;
  const offCanvas = document.createElement('canvas');
  offCanvas.width  = W;
  offCanvas.height = H;
  const ctx = offCanvas.getContext('2d');

  // Cielo degradado
  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.55);
  sky.addColorStop(0, '#0a0a2e');
  sky.addColorStop(0.5, '#1a1a5e');
  sky.addColorStop(1, '#3a2a8e');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H * 0.55);

  // Suelo
  const ground = ctx.createLinearGradient(0, H * 0.55, 0, H);
  ground.addColorStop(0, '#1a0a00');
  ground.addColorStop(1, '#0a0500');
  ctx.fillStyle = ground;
  ctx.fillRect(0, H * 0.55, W, H * 0.45);

  // Estrellas
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  for (let i = 0; i < 800; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H * 0.5;
    const r = Math.random() * 1.5 + 0.3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Nebulosa de fondo
  for (let i = 0; i < 5; i++) {
    const x = Math.random() * W;
    const y = Math.random() * H * 0.45;
    const r = 80 + Math.random() * 200;
    const colors = [
      ['rgba(120,60,200,0)', 'rgba(120,60,200,0.08)'],
      ['rgba(60,120,220,0)', 'rgba(60,120,220,0.07)'],
      ['rgba(200,80,100,0)', 'rgba(200,80,100,0.06)'],
    ];
    const [c1, c2] = colors[i % colors.length];
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, c2);
    g.addColorStop(1, c1);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // Luna
  const moonX = W * 0.15, moonY = H * 0.18, moonR = 60;
  const moonGlow = ctx.createRadialGradient(moonX, moonY, 0, moonX, moonY, moonR * 2);
  moonGlow.addColorStop(0, 'rgba(220,220,255,0.3)');
  moonGlow.addColorStop(1, 'rgba(220,220,255,0)');
  ctx.fillStyle = moonGlow;
  ctx.fillRect(moonX - moonR*2, moonY - moonR*2, moonR*4, moonR*4);

  ctx.fillStyle = '#e8e8ff';
  ctx.beginPath();
  ctx.arc(moonX, moonY, moonR, 0, Math.PI * 2);
  ctx.fill();

  // Cráteres
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  [[moonX-20, moonY-15, 14], [moonX+18, moonY+10, 10], [moonX-5, moonY+22, 8]].forEach(([cx,cy,cr]) => {
    ctx.beginPath(); ctx.arc(cx, cy, cr, 0, Math.PI*2); ctx.fill();
  });

  // Montañas
  const drawMountains = (baseY, count, maxH, fillStyle, strokeStyle) => {
    ctx.beginPath();
    ctx.moveTo(0, baseY);
    const step = W / count;
    for (let i = 0; i <= count; i++) {
      const x = i * step + (Math.random() - 0.5) * step * 0.5;
      const y = baseY - Math.random() * maxH;
      if (i === 0) ctx.lineTo(0, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineTo(W, baseY);
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
    if (strokeStyle) {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  };

  drawMountains(H * 0.58, 14, H * 0.25, '#1a1040', 'rgba(100,80,180,0.3)');
  drawMountains(H * 0.60, 10, H * 0.18, '#120c30', 'rgba(80,60,150,0.2)');
  drawMountains(H * 0.62, 7,  H * 0.12, '#0d0820', null);

  // Nieve en picos (línea superior)
  ctx.fillStyle = 'rgba(200,200,255,0.25)';
  for (let i = 0; i < 8; i++) {
    const x = (i + 0.5) * W / 8 + (Math.random() - 0.5) * 100;
    const y = H * 0.42 + Math.random() * H * 0.08;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 30 - Math.random()*20, y + 40 + Math.random()*20);
    ctx.lineTo(x + 30 + Math.random()*20, y + 40 + Math.random()*20);
    ctx.closePath();
    ctx.fill();
  }

  // Árboles (horizonte)
  ctx.fillStyle = '#060318';
  for (let i = 0; i < 60; i++) {
    const tx = Math.random() * W;
    const th = 30 + Math.random() * 60;
    const ty = H * 0.62 - th;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 12, ty + th);
    ctx.lineTo(tx + 12, ty + th);
    ctx.closePath();
    ctx.fill();
  }

  // Texto indicativo
  ctx.font = 'bold 48px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.textAlign = 'center';
  ctx.fillText('360°', W/2, H * 0.52);
  ctx.font = '28px sans-serif';
  ctx.fillText('Demo Panorámico — Carga tu propia imagen', W/2, H * 0.57);

  return offCanvas;
}

// ── Cargar imagen desde archivo ─────────────────────────
function loadImageFile(file) {
  showLoading('Cargando imagen...');
  state.imgName = file.name;

  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      loadingText.textContent = 'Preparando visor...';
      requestAnimationFrame(() => {
        state.imgW = img.naturalWidth;
        state.imgH = img.naturalHeight;
        loadTexture(img);
        resetView();
        showViewer();
        updateInfoPanel();
        hideLoading();
      });
    };
    img.onerror = () => { hideLoading(); alert('No se pudo cargar la imagen.'); };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function loadDemoImage() {
  showLoading('Generando demo...');
  state.imgName = 'Paisaje nocturno (demo)';

  setTimeout(() => {
    const offCanvas = generateDemoImage();
    state.imgW = offCanvas.width;
    state.imgH = offCanvas.height;
    loadTexture(offCanvas);
    resetView();
    showViewer();
    updateInfoPanel();
    hideLoading();
  }, 100);
}

// ── UI helpers ──────────────────────────────────────────
function showLoading(msg) {
  loadingText.textContent = msg;
  loadingOverlay.classList.remove('hidden');
}

function hideLoading() { loadingOverlay.classList.add('hidden'); }

function showViewer() {
  welcomeScreen.classList.add('hidden');
  viewerScreen.classList.remove('hidden');
  imageName.textContent = state.imgName;
  startRender();
  requestGyroPermission();
}

function hideViewer() {
  viewerScreen.classList.add('hidden');
  welcomeScreen.classList.remove('hidden');
  stopRender();
  disableGyro();
}

function resetView() {
  state.yaw   = 0;
  state.pitch = 0;
  state.fov   = 75;
  state.velYaw = state.velPitch = 0;
}

function updateInfoPanel() {
  infoDetails.innerHTML = `
    <div class="info-row"><span class="info-label">Imagen</span><span class="info-value">${state.imgName}</span></div>
    <div class="info-row"><span class="info-label">Dimensiones</span><span class="info-value">${state.imgW} × ${state.imgH}px</span></div>
    <div class="info-row"><span class="info-label">Giroscopio</span><span class="info-value">${state.gyroAvail ? 'Disponible' : 'No disponible'}</span></div>
    <div class="info-row"><span class="info-label">Campo de visión</span><span class="info-value">${Math.round(state.fov)}°</span></div>
  `;
}

// ── Giroscopio ──────────────────────────────────────────
function requestGyroPermission() {
  if (typeof DeviceOrientationEvent === 'undefined') {
    state.gyroAvail = false;
    return;
  }

  // iOS 13+ requiere permiso explícito
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission()
      .then(result => {
        if (result === 'granted') enableGyro();
        else state.gyroAvail = false;
      })
      .catch(() => { state.gyroAvail = false; });
  } else {
    enableGyro();
  }
}

function enableGyro() {
  state.gyroAvail = true;
  state.gyroBase  = null;
  window.addEventListener('deviceorientation', onDeviceOrientation, true);

  gyroIndicator.classList.remove('hidden');
  setTimeout(() => gyroIndicator.classList.add('hidden'), 3000);
}

function disableGyro() {
  window.removeEventListener('deviceorientation', onDeviceOrientation, true);
  state.gyroAvail = false;
}

function onDeviceOrientation(e) {
  if (!state.gyroOn || state.dragging) return;

  const alpha = e.alpha || 0; // compás (0-360)
  const beta  = e.beta  || 0; // inclinación adelante/atrás (-180 a 180)
  const gamma = e.gamma || 0; // inclinación izquierda/derecha (-90 a 90)

  if (!state.gyroBase) {
    state.gyroBase = { alpha, beta, gamma };
    return;
  }

  // Yaw: azimut del giroscopio
  let dAlpha = alpha - state.gyroBase.alpha;
  if (dAlpha >  180) dAlpha -= 360;
  if (dAlpha < -180) dAlpha += 360;

  // Pitch: inclinación vertical según orientación del teléfono
  const dBeta = beta - state.gyroBase.beta;

  state.yaw   -= (dAlpha * Math.PI / 180) * 0.4;
  state.pitch  = clampVal(
    -(dBeta * Math.PI / 180) * 0.5,
    (-80 * Math.PI) / 180,
    ( 80 * Math.PI) / 180
  );

  state.gyroBase = { alpha, beta, gamma };
}

const clampVal = (v, mn, mx) => Math.max(mn, Math.min(mx, v));

// ── Touch / Mouse ───────────────────────────────────────
const sensitivity = 0.003;

function getTouchDist(t) {
  const dx = t[0].clientX - t[1].clientX;
  const dy = t[0].clientY - t[1].clientY;
  return Math.sqrt(dx*dx + dy*dy);
}

canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (e.touches.length === 2) {
    state.pinching  = true;
    state.pinchDist0 = getTouchDist(e.touches);
    state.fov0 = state.fov;
  } else {
    state.dragging = true;
    state.pinching = false;
    state.lastX = e.touches[0].clientX;
    state.lastY = e.touches[0].clientY;
    state.velYaw = state.velPitch = 0;
  }
}, { passive: false });

canvas.addEventListener('touchmove', e => {
  e.preventDefault();
  if (state.pinching && e.touches.length === 2) {
    const d = getTouchDist(e.touches);
    state.fov = clampVal(state.fov0 * (state.pinchDist0 / d), state.fovMin, state.fovMax);
    return;
  }
  if (!state.dragging) return;
  const dx = e.touches[0].clientX - state.lastX;
  const dy = e.touches[0].clientY - state.lastY;
  state.velYaw   = -dx * sensitivity;
  state.velPitch =  dy * sensitivity;
  state.yaw   += state.velYaw;
  state.pitch += state.velPitch;
  state.lastX = e.touches[0].clientX;
  state.lastY = e.touches[0].clientY;
}, { passive: false });

canvas.addEventListener('touchend', e => {
  e.preventDefault();
  if (e.touches.length < 2) state.pinching = false;
  if (e.touches.length === 0) state.dragging = false;
}, { passive: false });

// Mouse (desktop testing)
canvas.addEventListener('mousedown', e => {
  state.dragging = true;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
  state.velYaw = state.velPitch = 0;
});

canvas.addEventListener('mousemove', e => {
  if (!state.dragging) return;
  const dx = e.clientX - state.lastX;
  const dy = e.clientY - state.lastY;
  state.velYaw   = -dx * sensitivity;
  state.velPitch =  dy * sensitivity;
  state.yaw   += state.velYaw;
  state.pitch += state.velPitch;
  state.lastX = e.clientX;
  state.lastY = e.clientY;
});

canvas.addEventListener('mouseup',    () => { state.dragging = false; });
canvas.addEventListener('mouseleave', () => { state.dragging = false; });

canvas.addEventListener('wheel', e => {
  e.preventDefault();
  state.fov = clampVal(state.fov + e.deltaY * 0.05, state.fovMin, state.fovMax);
}, { passive: false });

// ── Controles HUD ───────────────────────────────────────
btnBack.addEventListener('click', () => hideViewer());

btnInfo.addEventListener('click', () => {
  updateInfoPanel();
  infoPanel.classList.toggle('hidden');
});

btnCloseInfo.addEventListener('click', () => infoPanel.classList.add('hidden'));

btnGyro.addEventListener('click', () => {
  state.gyroOn = !state.gyroOn;
  btnGyro.classList.toggle('active', state.gyroOn);

  if (state.gyroOn && state.gyroAvail) {
    state.gyroBase = null;
  }
});

btnZoomIn.addEventListener('click', () => {
  state.fov = clampVal(state.fov - 10, state.fovMin, state.fovMax);
});

btnZoomOut.addEventListener('click', () => {
  state.fov = clampVal(state.fov + 10, state.fovMin, state.fovMax);
});

btnReset.addEventListener('click', () => {
  state.yaw   = 0;
  state.pitch = 0;
  state.fov   = 75;
  state.velYaw = state.velPitch = 0;
  state.gyroBase = null;
});

// ── Carga de imagen ─────────────────────────────────────
btnUpload.addEventListener('click', () => {
  // iOS requiere que el click en input sea en respuesta directa a gesto
  fileInput.click();
});

fileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) loadImageFile(file);
  fileInput.value = '';
});

btnDemo.addEventListener('click', () => loadDemoImage());

// ── Drag & drop de archivos ─────────────────────────────
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) loadImageFile(file);
});

// ── Init ─────────────────────────────────────────────────
(function init() {
  if (!initGL()) return;
  gl.clearColor(0, 0, 0, 1);
})();
