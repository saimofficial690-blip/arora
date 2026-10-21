/* ==========================================================================
   Pixel Winter Night — script.js

   How it works
   ------------
   The whole scene is drawn procedurally on a small "logical" pixel grid
   (about 180 pixels tall on desktop). Each visual layer has its own <canvas>;
   CSS scales them up by a whole-number factor with nearest-neighbour filtering,
   so every pixel is a crisp square. Soft gradients are never used — instead we
   use ordered (Bayer) dithering and a few stepped colour levels, which is what
   keeps the 16-bit look.

   Sections
     0. Constants, helpers, palette
     1. Layers & layout
     2. Sky, stars, moon
     3. Aurora (animated)
     4. Clouds (animated)
     5. Mountains
     6. Pines, snowy ground, snow glints
     7. Mist (animated)
     8. Snowfall (animated)
     9. Parallax, main loop, resize, reduced-motion
   ========================================================================== */
(() => {
  'use strict';

  /* ======================================================================
     0. CONSTANTS, HELPERS, PALETTE
     ====================================================================== */

  const TAU  = Math.PI * 2;
  const PAD  = 6;      // extra logical pixels around the viewport (room for parallax shifts)
  const SEED = 1987;   // fixed seed -> the landscape is identical on every load / resize
  const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp  = (a, b, t) => a + (b - a) * t;
  const smoothstep = (e0, e1, x) => {
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /** Small seeded random generator (mulberry32). */
  function rngFrom(seed) {
    let a = seed | 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 4x4 ordered-dither threshold in (0,1) for pixel (x, y). */
  const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  const bayer = (x, y) => (BAYER[((y & 3) << 2) | (x & 3)] + 0.5) / 16;

  /** '#rrggbb' -> packed 32-bit pixel (for writing into ImageData via Uint32Array). */
  function pack(hex, alpha = 255) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const v = LITTLE_ENDIAN
      ? (alpha << 24) | (b << 16) | (g << 8) | r
      : (r << 24) | (g << 16) | (b << 8) | alpha;
    return v >>> 0;
  }

  /* Palette: midnight blue, navy, dark purple, icy blue, white, turquoise, aurora green. */
  const PAL = {
    sky: ['#050a20', '#080f2e', '#0b1540', '#101c52', '#1a2060', '#262068', '#322670', '#402e78'],

    moon: {
      body:  ['#e8f4fc', '#d6e8f6', '#c0d8ee', '#a9c5e2'],
      rim:   '#9bb8da',
      mariaA: '#b0cae6',
      mariaB: '#9db9d9',
      glow:  '#a4ccf2'
    },

    cloud: {
      far:  { lit: '#2e3d84', body: '#1e285c', shade: '#161d49' },
      mid:  { lit: '#3d4d98', body: '#282f6b', shade: '#1c2254' },
      near: { lit: '#4d519f', body: '#302a72', shade: '#221d5a' }
    },

    // Aurora: each layer has [bottom, middle, top] colours.
    aurora: [
      { stops: ['#2fa7a3', '#4a78c0', '#7a52b8'] },  // back: teal -> blue -> purple
      { stops: ['#36d1c0', '#29a8a8', '#2a6fa0'] },  // middle: turquoise
      { stops: ['#7bf0a0', '#3fcf9a', '#2a9a9a'] }   // front: aurora green
    ],

    mountainFar: {
      litA: '#2a3478', litB: '#222b6b', shA: '#1c2360', shB: '#171c52',
      edgeLit: '#6c9ad6', edgeSh: '#3d4f98',
      snowLit: ['#f4faff', '#d4e8fb', '#aecbee'],
      snowSh:  ['#c3d9f3', '#93b0e0', '#7790cc'],
      gully: '#141a4a'
    },
    mountainNear: {
      litA: '#222a68', litB: '#1b2158', shA: '#161b4c', shB: '#150f3c',
      edgeLit: '#5b86c8', edgeSh: '#2f3f84',
      snowLit: ['#e9f4ff', '#c4def7', '#9dbce6'],
      snowSh:  ['#aac4ea', '#7f9ad0', '#6680bc'],
      gully: '#0e1236'
    },

    ground: {
      far:   { edge: '#86aee6', lit: '#5b82c4', body: '#3a5198', deep: '#2a3b80', spark: '#c4e0ff' },
      mid:   { edge: '#a9cffa', lit: '#6890d0', body: '#34498e', deep: '#1f2d68', spark: '#d8ecff' },
      front: { edge: '#4d74b6', lit: '#2c4888', body: '#17275f', deep: '#0c1338', spark: '#7ea8e0' }
    },

    pine: {
      far: [
        { trunk: '#10183f', dark: '#141d4f', mid: '#1b2762', lit: '#3a5ca8', snow: '#8fb2e6', snow2: '#4f6fb4', tip: '#b9d3f5', mound: '#2a3b7a' },
        { trunk: '#10183f', dark: '#171a4e', mid: '#212068', lit: '#41559f', snow: '#8fb2e6', snow2: '#5a64b0', tip: '#b9d3f5', mound: '#2a3b7a' }
      ],
      mid: [
        { trunk: '#0a0f2c', dark: '#0b1238', mid: '#121a4c', lit: '#2f58a8', snow: '#b5d3f7', snow2: '#5f82c6', tip: '#e2f0ff', mound: '#1f2d63' },
        { trunk: '#0a0f2c', dark: '#0e1038', mid: '#181650', lit: '#35509c', snow: '#b5d3f7', snow2: '#6a78c0', tip: '#e2f0ff', mound: '#1f2d63' }
      ],
      front: [
        { trunk: '#04061a', dark: '#050818', mid: '#090e2a', lit: '#1c3470', snow: '#5f86c4', snow2: '#2a4584', tip: '#8fb6e8', mound: '#0f1638' },
        { trunk: '#04061a', dark: '#060718', mid: '#0c0c2c', lit: '#222f6c', snow: '#5f86c4', snow2: '#2f4084', tip: '#8fb6e8', mound: '#0f1638' }
      ]
    },

    mist: '#97abe6',
    reflect: ['#62f2da', '#2fb8b4']
  };

  /* Soft patches that give the moon its surface detail (positions relative to its radius). */
  const MOON_SPOTS = [
    { x: -0.38, y: -0.28, rx: 0.30, ry: 0.24 },
    { x:  0.05, y: -0.52, rx: 0.18, ry: 0.14 },
    { x: -0.08, y:  0.18, rx: 0.34, ry: 0.26 },
    { x:  0.42, y:  0.22, rx: 0.20, ry: 0.16 },
    { x:  0.52, y: -0.20, rx: 0.13, ry: 0.10 },
    { x: -0.52, y:  0.46, rx: 0.12, ry: 0.10 }
  ];

  /* ======================================================================
     1. LAYERS & LAYOUT
     ====================================================================== */

  // How far each layer slides with the mouse (in logical pixels). 0 = never moves.
  // Sky, stars and moon stay locked together so the moon is effectively fixed.
  const LAYER_DEPTH = {
    aurora: 0.6, clouds: 0.8,
    'mtn-far': 1.2, 'mtn-near': 1.8,
    'forest-far': 2.2, mist: 2.4,
    'forest-mid': 2.8, reflect: 2.8,
    'forest-front': 3.4
  };
  const LAYER_IDS = ['sky', 'stars', 'aurora', 'moon', 'clouds', 'mtn-far', 'mtn-near',
                     'forest-far', 'mist', 'forest-mid', 'reflect', 'forest-front', 'snow'];

  const layers = {};
  LAYER_IDS.forEach((id) => {
    const el = document.getElementById(id);
    layers[id] = { el, ctx: el.getContext('2d'), depth: LAYER_DEPTH[id] || 0, sx: 0, sy: 0 };
  });

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionQuery.matches;

  // Layout state (recomputed on resize)
  let vw = 0, vh = 0;       // viewport in CSS pixels
  let P = 0;                // CSS pixels per logical pixel (whole number)
  let W = 0, H = 0;         // logical size of the viewport
  let CW = 0, CH = 0;       // canvas size = viewport + padding on every side
  let U = 0;                // landscape unit: scales scenery sensibly on tall phone screens
  let horizonY = 0;         // where the sky gradient reaches its purple horizon
  let built = false;
  const moon = { x: 0, y: 0, r: 0 };

  function measure() {
    vw = window.innerWidth;
    vh = window.innerHeight;
    // Whole-number pixel size: ~170 logical px tall on desktop, at least ~200 wide on phones.
    const p = Math.max(2, Math.floor(Math.min(vh / 170, vw / 200)));
    return { p, w: Math.ceil(vw / p), h: Math.ceil(vh / p) };
  }

  /** Size and position every canvas. The scene is bottom-anchored and centred. */
  function placeLayers() {
    const left = Math.round((vw - CW * P) / 2);
    const top = vh - (H + PAD) * P;
    for (const id of LAYER_IDS) {
      const { el } = layers[id];
      el.style.width = CW * P + 'px';
      el.style.height = CH * P + 'px';
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    }
  }

  function rebuild() {
    const m = measure();
    const changed = !built || m.p !== P || m.w !== W || m.h !== H;
    P = m.p; W = m.w; H = m.h;
    CW = W + PAD * 2;
    CH = H + PAD * 2;
    U = Math.min(H, W * 0.62);
    placeLayers();
    if (!changed) return;

    for (const id of LAYER_IDS) {          // resizing a canvas also clears it
      layers[id].el.width = CW;
      layers[id].el.height = CH;
      layers[id].ctx.imageSmoothingEnabled = false;
      layers[id].sx = layers[id].sy = 0;
      layers[id].el.style.transform = '';
    }
    built = true;

    horizonY = PAD + H - Math.round(0.32 * U);

    // Moon: upper-right, never in the centre.
    moon.r = Math.round(clamp(Math.min(W * 0.14, H * 0.11), 12, 28));
    moon.x = PAD + W - Math.round(Math.max(moon.r * 2.2, W * 0.16));
    moon.y = PAD + Math.max(Math.round(moon.r * 1.9), Math.round(H * 0.17));

    // Static layers (drawn once)
    drawSky();
    drawMoon();
    drawMountains('mtn-far',  { seed: SEED + 1, base: 0.35, amp: 0.21, spacing: 85, snowLine: 0.50, snowDepth: 0.55, pal: PAL.mountainFar });
    drawMountains('mtn-near', { seed: SEED + 2, base: 0.28, amp: 0.20, spacing: 70, snowLine: 0.52, snowDepth: 0.55, pal: PAL.mountainNear });
    drawForestFar();
    drawForestMid();
    drawForestFront();

    // Animated layers (state is rebuilt, frames are drawn by the loop)
    buildStars();
    buildAurora();
    buildClouds();
    buildMist();
    initSnow();

    renderStillFrame();
  }

  /* ======================================================================
     2. SKY, STARS, MOON
     ====================================================================== */

  /** Deep navy at the top -> dark purple at the horizon, in dithered steps. */
  function drawSky() {
    const ctx = layers.sky.ctx;
    const img = ctx.createImageData(CW, CH);
    const u32 = new Uint32Array(img.data.buffer);
    const cols = PAL.sky.map((h) => pack(h));
    const n = cols.length;
    for (let y = 0; y < CH; y++) {
      const t = Math.pow(clamp(y / horizonY, 0, 1), 1.35);
      const pos = t * (n - 1);
      const i = Math.min(n - 1, Math.floor(pos));
      const f = pos - i;
      for (let x = 0; x < CW; x++) {
        u32[y * CW + x] = cols[i < n - 1 && f > bayer(x, y) ? i + 1 : i];
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  let stars = [];

  function buildStars() {
    const rng = rngFrom(SEED + 11);
    stars = [];
    const count = Math.round((CW * CH) / 320);
    const limitY = horizonY * 0.94;
    let guard = 0;
    while (stars.length < count && guard++ < count * 5) {
      const x = 2 + Math.floor(rng() * (CW - 4));
      const y = 2 + Math.floor(Math.pow(rng(), 1.2) * limitY);
      const dx = x - moon.x, dy = y - moon.y;
      if (dx * dx + dy * dy < Math.pow(moon.r * 2.4, 2)) continue;   // keep the moon's neighbourhood calm
      const k = rng();
      const big = k < 0.05;                                         // a few cross-shaped stars
      stars.push({
        x, y, big,
        color: big ? '#ffffff' : k < 0.3 ? '#dbe9ff' : k < 0.6 ? '#9db8e8' : '#6f8fcf',
        twinkle: big || rng() < 0.3,                                // only some stars twinkle
        period: 2.5 + rng() * 4.5,
        phase: rng() * TAU
      });
    }
  }

  /** Stars twinkle in three stepped brightness levels (no smooth fading). */
  function drawStars(t, still) {
    const ctx = layers.stars.ctx;
    ctx.clearRect(0, 0, CW, CH);
    for (const s of stars) {
      let a = 1;
      if (s.twinkle && !still) {
        const v = Math.sin((t * TAU) / s.period + s.phase);
        a = v < -0.4 ? 0.35 : v < 0.3 ? 0.7 : 1;
      }
      ctx.fillStyle = s.color;
      ctx.globalAlpha = a;
      ctx.fillRect(s.x, s.y, 1, 1);
      if (s.big) {
        ctx.globalAlpha = a * 0.55;
        ctx.fillRect(s.x - 1, s.y, 1, 1);
        ctx.fillRect(s.x + 1, s.y, 1, 1);
        ctx.fillRect(s.x, s.y - 1, 1, 1);
        ctx.fillRect(s.x, s.y + 1, 1, 1);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Full moon with dithered limb shading, soft "maria" patches and a stepped pixel glow. */
  function drawMoon() {
    const ctx = layers.moon.ctx;
    ctx.clearRect(0, 0, CW, CH);
    const img = ctx.createImageData(CW, CH);
    const u32 = new Uint32Array(img.data.buffer);
    const { x: cx, y: cy, r } = moon;
    const glowR = Math.round(r * 1.9);

    const body = PAL.moon.body.map((h) => pack(h));
    const rim = pack(PAL.moon.rim);
    const mariaA = pack(PAL.moon.mariaA);
    const mariaB = pack(PAL.moon.mariaB);
    const glow = [1, 2, 3].map((l) => pack(PAL.moon.glow, l * 20));

    for (let y = Math.max(0, cy - glowR - 1); y <= Math.min(CH - 1, cy + glowR + 1); y++) {
      for (let x = Math.max(0, cx - glowR - 1); x <= Math.min(CW - 1, cx + glowR + 1); x++) {
        const dx = x - cx, dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const idx = y * CW + x;

        if (d > r) {                               // glow: three dithered levels
          const t = 1 - (d - r) / (glowR - r);
          if (t <= 0) continue;
          const lvl = Math.min(3, Math.floor(t * t * 3 + bayer(x, y)));
          if (lvl > 0) u32[idx] = glow[lvl - 1];
          continue;
        }

        let c;
        if (d > r - 1) {
          c = rim;                                 // darker outer ring keeps the edge crisp
        } else {
          const nd = d / r;
          c = body[clamp(Math.floor(nd * nd * 3.2 + bayer(x, y) * 0.9), 0, 3)];
          for (const m of MOON_SPOTS) {
            const ex = (dx / r - m.x) / m.rx, ey = (dy / r - m.y) / m.ry;
            const e = ex * ex + ey * ey;
            if (e <= 1) {
              if (e < 0.4) c = mariaB;
              else if (e < 0.75 || bayer(x, y) < 0.5) c = mariaA;
            }
          }
        }
        u32[idx] = c;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ======================================================================
     3. AURORA BOREALIS (animated)
     Three overlapping curtains. For each screen column we compute where the
     curtain's bright lower edge sits, how tall it is and how bright (rays +
     slow envelope). The result is quantised to 4 levels with ordered dithering,
     so it looks like stepped pixel art, not a blurry gradient.
     Every term is a sine of time, so the motion never resets or jumps.
     ====================================================================== */

  const AURORA_LEVELS = 4;
  const AURORA_PARAMS = [
    { base: 0.40, aA: 0.070, aB: 0.030, h: 0.34, alpha: 0.62, sp: 0.8, ph: 0.0, fm: 1.00 },
    { base: 0.50, aA: 0.080, aB: 0.035, h: 0.36, alpha: 0.68, sp: 1.0, ph: 2.1, fm: 0.92 },
    { base: 0.58, aA: 0.060, aB: 0.030, h: 0.30, alpha: 0.74, sp: 1.2, ph: 4.2, fm: 1.08 }
  ];
  let auroraLayers = [];
  let auroraH = 0;

  function buildAurora() {
    auroraH = Math.ceil(horizonY);
    auroraLayers = AURORA_PARAMS.map((p, i) => {
      const canvas = document.createElement('canvas');
      canvas.width = CW;
      canvas.height = auroraH;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(CW, auroraH);
      // packed[band][level]: band 0 = bottom colour, 1 = middle, 2 = top
      const packed = PAL.aurora[i].stops.map((hex) => {
        const row = [0];
        for (let l = 1; l <= AURORA_LEVELS; l++) row.push(pack(hex, Math.round(255 * p.alpha * (l / AURORA_LEVELS))));
        return row;
      });
      return { ...p, canvas, ctx, img, u32: new Uint32Array(img.data.buffer), packed };
    });
  }

  function drawAurora(t) {
    const out = layers.aurora.ctx;
    out.clearRect(0, 0, CW, CH);
    const Sh = horizonY - PAD;                 // sky height
    const Q = Math.min(Sh, W * 0.8);           // size unit for wave amplitude / curtain height
    const mx = moon.x, my = moon.y, mr = moon.r;

    for (const l of auroraLayers) {
      const u32 = l.u32;
      u32.fill(0);
      const breath = 0.82 + 0.18 * Math.sin(t * 0.21 + l.ph);   // slow brightness change over time

      for (let x = 0; x < CW; x++) {
        const a = x * l.fm;
        // Lower edge of the curtain (sum of slow travelling waves)
        const bot = PAD + Sh * l.base + Q * (
          l.aA * Math.sin(a * 0.018 + t * 0.16 * l.sp + l.ph) +
          l.aB * Math.sin(a * 0.043 - t * 0.21 * l.sp + l.ph * 1.7) +
          0.012 * Math.sin(a * 0.110 + t * 0.30 * l.sp));
        // Height of the curtain
        const hgt = Math.max(6, Q * l.h * (0.78 + 0.22 * Math.sin(a * 0.012 + t * 0.09 * l.sp + l.ph * 0.6)));
        // Slow envelope: bright clusters with calmer gaps between them
        const e = 0.5 * (0.5 + 0.5 * Math.sin(a * 0.013 + t * 0.07 * l.sp + l.ph)) +
                  0.5 * (0.5 + 0.5 * Math.sin(a * 0.031 - t * 0.05 * l.sp + l.ph * 2));
        const env = 0.2 + 0.8 * smoothstep(0.25, 0.75, e);
        // Vertical rays
        const ray = clamp(0.62 + 0.25 * Math.sin(a * 0.31 + t * 0.22 * l.sp + l.ph) +
                          0.20 * Math.sin(a * 0.83 - t * 0.17 * l.sp), 0.15, 1);
        const amp = env * ray * breath;
        if (amp < 0.04) continue;

        const yTop = Math.max(0, Math.floor(bot - hgt));
        const yBot = Math.min(auroraH - 1, Math.floor(bot + 3));
        const nearMoonX = Math.abs(x - mx) < mr * 4.2;

        for (let y = yTop; y <= yBot; y++) {
          let i;
          if (y > bot) {
            i = 1 - (y - bot) / 3.5;                         // crisp lower edge
          } else {
            const u = (bot - y) / hgt;
            i = Math.pow(1 - u, 1.5);                        // fades out toward the top
            if (bot - y < 2) i = Math.min(1, i * 1.25);      // bright bottom rim
          }
          i *= amp;
          if (nearMoonX) {                                   // keep the moon clearly visible
            const dx = x - mx, dy = y - my;
            i *= smoothstep(mr * 1.2, mr * 4.2, Math.sqrt(dx * dx + dy * dy));
          }
          const lvl = Math.min(AURORA_LEVELS, Math.floor(i * AURORA_LEVELS + bayer(x, y)));
          if (lvl <= 0) continue;
          const u2 = (bot - y) / hgt;
          const band = y > bot ? 0 : u2 < 0.28 ? 0 : u2 < 0.62 ? 1 : 2;
          u32[y * CW + x] = l.packed[band][lvl];
        }
      }
      l.ctx.putImageData(l.img, 0, 0);
      out.drawImage(l.canvas, 0, 0);
    }
  }

  /* ======================================================================
     4. CLOUDS (animated)
     Cloud sprites are drawn once as hard-edged pixel blobs. Each cloud then
     drifts at its own slow speed, wrapping only after it has fully left the
     screen, so there is never a visible jump. One cloud is placed to
     cross the moon; clouds are slightly translucent so the moon stays visible.
     ====================================================================== */

  let clouds = [];

  function makeCloudSprite(w, h, pal, rng) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    const baseY = h - 2;
    const n = Math.max(3, Math.round(w / 14));
    const blobs = [];
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      const edge = 1 - Math.abs(t - 0.5) * 2;                  // 1 in the middle, 0 at the ends
      blobs.push({
        cx: w * (0.1 + 0.8 * t) + (rng() - 0.5) * w * 0.06,
        rx: w * (0.11 + 0.09 * rng()) * (0.75 + 0.5 * edge),
        ry: Math.min(baseY - 1, (h - 3) * (0.35 + 0.65 * edge * (0.55 + 0.45 * rng())))
      });
    }
    const mask = new Uint8Array(w * h);
    for (let y = 0; y <= baseY; y++) {
      for (let x = 0; x < w; x++) {
        for (const b of blobs) {
          const dx = (x + 0.5 - b.cx) / b.rx;
          const dy = (y + 0.5 - (baseY + 1)) / b.ry;           // ellipses sit on a flat base
          if (dx * dx + dy * dy <= 1) { mask[y * w + x] = 1; break; }
        }
      }
    }
    const get = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : mask[y * w + x]);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!mask[y * w + x]) continue;
        let col;
        if (!get(x, y - 1) || !get(x + 1, y)) col = pal.lit;                  // moonlit top / right rim
        else if (y >= baseY - 1 || (y === baseY - 2 && ((x + y) & 1))) col = pal.shade;   // dithered underside
        else col = pal.body;
        c.fillStyle = col;
        c.fillRect(x, y, 1, 1);
      }
    }
    return cv;
  }

  function buildClouds() {
    const rng = rngFrom(SEED + 31);
    clouds = [];
    // Clouds stay in the lower part of the sky so the aurora above them remains the star of the show.
    const cfg = [
      { pal: PAL.cloud.far,  n: Math.max(2, Math.round(CW / 130)), w: [0.20, 0.34], y: [0.72, 0.88], speed: 1.1, alpha: 0.92 },
      { pal: PAL.cloud.mid,  n: Math.max(2, Math.round(CW / 190)), w: [0.30, 0.48], y: [0.56, 0.72], speed: 2.2, alpha: 0.80 },
      { pal: PAL.cloud.near, n: Math.max(1, Math.round(CW / 260)), w: [0.42, 0.62], y: [0.64, 0.80], speed: 3.4, alpha: 0.88 }
    ];

    cfg.forEach((layer, li) => {
      for (let i = 0; i < layer.n; i++) {
        const sw = Math.round(clamp(U * lerp(layer.w[0], layer.w[1], rng()), 20, CW * 0.9));
        const sh = Math.max(8, Math.round(sw * lerp(0.20, 0.27, rng())));
        const period = CW + sw;
        clouds.push({
          sprite: makeCloudSprite(sw, sh, layer.pal, rng),
          sw, period,
          x0: ((i + rng() * 0.5) / layer.n) * period,
          y: Math.round(horizonY * lerp(layer.y[0], layer.y[1], rng()) - sh / 2),
          speed: layer.speed * (0.85 + 0.3 * rng()),
          alpha: layer.alpha
        });
      }
      if (li === 1) {
        // The "moon cloud": starts to the left of the moon and drifts across it.
        const sw = Math.round(clamp(U * 0.46, 24, CW * 0.9));
        const sh = Math.max(9, Math.round(sw * 0.25));
        clouds.push({
          sprite: makeCloudSprite(sw, sh, PAL.cloud.mid, rng),
          sw, period: CW + sw,
          x0: moon.x - sw * 0.9 - 30 + sw,
          y: Math.round(moon.y - sh * 0.55),
          speed: 3.0,
          alpha: 0.74
        });
      }
    });
  }

  function drawClouds(t) {
    const ctx = layers.clouds.ctx;
    ctx.clearRect(0, 0, CW, CH);
    for (const c of clouds) {
      const pos = (((c.x0 + c.speed * t) % c.period) + c.period) % c.period;
      ctx.globalAlpha = c.alpha;
      ctx.drawImage(c.sprite, Math.floor(pos - c.sw), c.y);
    }
    ctx.globalAlpha = 1;
  }

  /* ======================================================================
     5. SNOWY MOUNTAINS
     Ridge lines come from a handful of random peaks. Faces that look toward
     the moon (right side) get lighter rock and brighter snow; the other side
     stays cool and dark. Snow depth grows with altitude and has a jagged edge.
     ====================================================================== */

  function drawMountains(id, o) {
    const ctx = layers[id].ctx;
    const rng = rngFrom(o.seed);
    const baseY = PAD + H - Math.round(o.base * U);
    const amp = Math.round(o.amp * U);
    const count = Math.max(3, Math.round(CW / o.spacing));

    const peaks = [];
    for (let i = 0; i < count; i++) {
      peaks.push({
        x: ((i + 0.15 + rng() * 0.7) * CW) / count,
        h: amp * (0.42 + 0.58 * rng()),
        sl: 0.8 + 0.7 * rng(),     // slope steepness on the left / right
        sr: 0.8 + 0.7 * rng()
      });
    }

    // Ridge line (y of the top of the mountain for every column)
    const top = new Int16Array(CW);
    let walk = 0;
    for (let x = 0; x < CW; x++) {
      let best = 0;
      for (const p of peaks) {
        const d = x - p.x;
        const v = p.h - Math.abs(d) * (d < 0 ? p.sl : p.sr);
        if (v > best) best = v;
      }
      walk = clamp(walk + (rng() - 0.5) * 1.4, -2.2, 2.2);       // slight rocky roughness
      top[x] = Math.round(baseY - amp * 0.16 - best + walk * (best > 2 ? 1 : 0.3));
    }

    const snowH = o.snowLine * amp;
    const jag = new Uint8Array(CW);
    for (let x = 0; x < CW; x++) jag[x] = Math.floor(rng() * 3);
    const depthAt = (x) => {
      const high = baseY - top[x];
      return high <= snowH ? 0 : Math.round((high - snowH) * o.snowDepth) + jag[x];
    };

    const pl = o.pal;
    const litA = pack(pl.litA), litB = pack(pl.litB), shA = pack(pl.shA), shB = pack(pl.shB);
    const edgeLit = pack(pl.edgeLit), edgeSh = pack(pl.edgeSh);
    const snowLit = pl.snowLit.map((h) => pack(h));
    const snowSh = pl.snowSh.map((h) => pack(h));
    const gully = pack(pl.gully);

    const img = ctx.createImageData(CW, CH);
    const u32 = new Uint32Array(img.data.buffer);
    const gradH = amp + 1;
    let lit = true;
    for (let x = 0; x < CW; x++) {
      // Slopes that descend to the right face the moon (upper right).
      const s = top[Math.min(CW - 1, x + 2)] - top[Math.max(0, x - 2)];
      if (s > 0) lit = true; else if (s < 0) lit = false;
      const t0 = top[x];
      const sd = depthAt(x);
      for (let y = Math.max(0, t0); y < CH; y++) {
        const k = y - t0;
        let c;
        if (k < sd) {
          const set = lit ? snowLit : snowSh;
          c = k === 0 ? set[0] : k < sd * 0.55 ? set[1] : set[2];
        } else if (k === 0) {
          c = lit ? edgeLit : edgeSh;
        } else {
          const useB = bayer(x, y) < clamp(k / gradH, 0, 1);
          c = lit ? (useB ? litB : litA) : (useB ? shB : shA);
        }
        u32[y * CW + x] = c;
      }
    }

    // Thin dark gullies running down from the snow line give the rock some detail.
    const gullies = Math.round(CW / 9);
    for (let i = 0; i < gullies; i++) {
      const x = Math.floor(rng() * CW);
      const y0 = top[x] + depthAt(x) + 1 + Math.floor(rng() * 4);
      const len = 4 + Math.floor(rng() * 10);
      const slant = (rng() - 0.5) * 0.7;
      for (let k = 0; k < len; k++) {
        const xx = Math.round(x + k * slant), yy = y0 + k;
        if (xx < 0 || xx >= CW || yy >= CH) break;
        if (yy <= top[xx] + depthAt(xx)) continue;
        u32[yy * CW + xx] = gully;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ======================================================================
     6. PINES, SNOWY GROUND, SNOW GLINTS
     ====================================================================== */

  /** Rolling snow line (y of the ground top for every column). */
  function groundProfile(base, amp, rng) {
    const g = new Int16Array(CW);
    const p1 = rng() * TAU, p2 = rng() * TAU;
    const f1 = 0.012 + rng() * 0.006, f2 = 0.031 + rng() * 0.010;
    const y0 = PAD + H - Math.round(base * U);
    const a = amp * U;
    for (let x = 0; x < CW; x++) {
      g[x] = Math.round(y0 - a * (0.55 * Math.sin(x * f1 + p1) + 0.45 * Math.sin(x * f2 + p2)));
    }
    return g;
  }

  /** Snow ground: bright moonlit rim on top, dithered into darker snow below. */
  function drawGround(ctx, g, pal, rng) {
    const img = ctx.createImageData(CW, CH);
    const u32 = new Uint32Array(img.data.buffer);
    const edge = pack(pal.edge), lit = pack(pal.lit), body = pack(pal.body);
    const deep = pack(pal.deep), spark = pack(pal.spark);
    const fadeLen = 0.12 * U + 1;
    for (let x = 0; x < CW; x++) {
      const g0 = g[x];
      for (let y = Math.max(0, g0); y < CH; y++) {
        const k = y - g0;
        let c;
        if (k === 0) c = edge;
        else if (k === 1) c = lit;
        else if (k === 2) c = bayer(x, y) < 0.5 ? lit : body;
        else c = bayer(x, y) < clamp((k - 3) / fadeLen, 0, 1) ? deep : body;
        if (k <= 2 && rng() < 0.03) c = spark;           // tiny glints on the snow
        u32[y * CW + x] = c;
      }
    }
    return img;
  }

  /**
   * One pixel-art pine, built from overlapping triangular tiers.
   * Left side is darker, right side catches moonlight, and snow sits on the
   * upper slope of each tier.
   */
  function drawPine(ctx, cx, baseY, h, pal, rng, snowAmt) {
    const trunk = Math.max(1, Math.round(h * 0.09));
    const bodyH = h - trunk;
    const topY = baseY - h;
    const tiers = clamp(Math.round(h / 6), 2, 8);
    const th = Math.min(bodyH, Math.max(3, Math.round((bodyH / tiers) * 1.7)));
    const maxHW = Math.max(2, Math.round(h * 0.30));

    // trunk
    ctx.fillStyle = pal.trunk;
    ctx.fillRect(cx - (h > 20 ? 1 : 0), baseY - trunk, h > 20 ? 2 : 1, trunk);

    for (let t = 0; t < tiers; t++) {
      const y0 = topY + Math.round((t * (bodyH - th)) / (tiers - 1));
      const hw = Math.max(1, Math.round(maxHW * (0.28 + 0.72 * ((t + 1) / tiers))));
      for (let r = 0; r < th; r++) {
        const y = y0 + r;
        const half = Math.round((hw * (r + 0.5)) / th);
        const x0 = cx - half, x1 = cx + half;
        const split = cx - Math.round(half * 0.15);

        ctx.fillStyle = pal.dark;
        ctx.fillRect(x0, y, split - x0, 1);                  // shadow side
        ctx.fillStyle = pal.mid;
        ctx.fillRect(split, y, x1 - split + 1, 1);           // lit side
        if (half >= 1 && (r & 1) === 0) {
          ctx.fillStyle = pal.lit;
          ctx.fillRect(x1, y, 1, 1);                         // moonlit edge
        }
        if (r === th - 1) {
          ctx.fillStyle = pal.dark;
          ctx.fillRect(x0, y, x1 - x0 + 1, 1);               // dark underside separates tiers
        }
        // snow patches on the upper slope of the tier
        if (snowAmt > 0 && half >= 1 && r < th * 0.5 && rng() < snowAmt) {
          ctx.fillStyle = pal.snow;
          ctx.fillRect(Math.max(cx, x1 - (half >= 3 ? 1 : 0)), y, half >= 3 ? 2 : 1, 1);
          if (rng() < 0.6) {
            ctx.fillStyle = pal.snow2;
            ctx.fillRect(x0, y, 1, 1);
          }
        }
      }
    }
    // bright tip and a little snow mound at the foot
    ctx.fillStyle = pal.tip;
    ctx.fillRect(cx, topY, 1, 1);
    const m = Math.max(2, Math.round(maxHW * 0.7));
    ctx.fillStyle = pal.mound;
    ctx.fillRect(cx - m, baseY, m * 2 + 1, 1);
    ctx.fillRect(cx - Math.round(m * 0.55), baseY - 1, Math.round(m * 1.1) + 1, 1);
  }

  function plantTrees(ctx, g, o) {
    const rng = o.rng;
    const list = [];
    let x = -PAD + Math.floor(rng() * 5);
    while (x < CW + PAD) {
      const cx = clamp(x, 0, CW - 1);
      let h = lerp(o.hMin, o.hMax, rng()) * U;
      if (o.edgeBias) {                                       // foreground: tall at the sides, low in the middle
        const d = Math.abs(cx - CW / 2) / (CW / 2);
        h *= 0.4 + 0.6 * smoothstep(0.3, 0.85, d);
      }
      h = Math.max(6, Math.round(h));
      list.push({ x, h, y: g[cx] + Math.floor(rng() * 3) });
      x += Math.max(3, Math.round(h * lerp(o.gap[0], o.gap[1], rng())));
    }
    list.sort((a, b) => a.y - b.y);                           // lower trees overlap higher ones
    for (const t of list) {
      drawPine(ctx, t.x, t.y, t.h, rng() < 0.3 ? o.pals[1] : o.pals[0], rng, o.snow);
    }
  }

  function drawForestFar() {
    const ctx = layers['forest-far'].ctx;
    const rng = rngFrom(SEED + 41);
    const g = groundProfile(0.24, 0.025, rng);
    ctx.putImageData(drawGround(ctx, g, PAL.ground.far, rng), 0, 0);
    plantTrees(ctx, g, { rng, hMin: 0.05, hMax: 0.09, gap: [0.28, 0.55], pals: PAL.pine.far, snow: 0.25 });
  }

  let midGround = null;       // kept so the aurora glints can sit on the snow

  function drawForestMid() {
    const ctx = layers['forest-mid'].ctx;
    const rng = rngFrom(SEED + 51);
    const g = groundProfile(0.14, 0.03, rng);
    const img = drawGround(ctx, g, PAL.ground.mid, rng);
    ctx.putImageData(img, 0, 0);
    const before = new Uint8ClampedArray(img.data);          // ground only
    plantTrees(ctx, g, { rng, hMin: 0.10, hMax: 0.17, gap: [0.40, 0.70], pals: PAL.pine.mid, snow: 0.5 });
    const after = ctx.getImageData(0, 0, CW, CH).data;       // ground + trees
    midGround = { g, before, after };
    drawReflections();
  }

  function drawForestFront() {
    const ctx = layers['forest-front'].ctx;
    const rng = rngFrom(SEED + 61);
    const g = groundProfile(0.05, 0.02, rng);
    ctx.putImageData(drawGround(ctx, g, PAL.ground.front, rng), 0, 0);
    plantTrees(ctx, g, { rng, hMin: 0.20, hMax: 0.34, gap: [0.7, 1.3], pals: PAL.pine.front, snow: 0.22, edgeBias: true });
  }

  /**
   * Turquoise glints on the snow, only where the snow is bare (not under a tree).
   * The canvas opacity is pulsed by a slow CSS animation (see style.css).
   */
  function drawReflections() {
    const ctx = layers.reflect.ctx;
    ctx.clearRect(0, 0, CW, CH);
    const { g, before, after } = midGround;
    const img = ctx.createImageData(CW, CH);
    const u32 = new Uint32Array(img.data.buffer);
    const c0 = pack(PAL.reflect[0], 70), c1 = pack(PAL.reflect[0], 130);
    const d0 = pack(PAL.reflect[1], 60), d1 = pack(PAL.reflect[1], 110);
    const depth = Math.max(6, Math.round(0.07 * U));
    for (let x = 0; x < CW; x++) {
      const patch = smoothstep(0.35, 0.9, 0.5 + 0.5 * Math.sin(x * 0.024 + 0.6)) * (0.6 + 0.4 * Math.sin(x * 0.11));
      if (patch <= 0.05) continue;
      for (let k = 0; k < depth; k++) {
        const y = g[x] + k;
        if (y < 0 || y >= CH) continue;
        const p = (y * CW + x) * 4;
        if (before[p] !== after[p] || before[p + 1] !== after[p + 1] || before[p + 2] !== after[p + 2]) continue;   // a tree is here
        const i = patch * (1 - k / depth);
        const lvl = Math.floor(i * 3 + bayer(x, y) - 0.3);
        if (lvl <= 0) continue;
        u32[y * CW + x] = k < 2 ? (lvl > 1 ? c1 : c0) : (lvl > 1 ? d1 : d0);
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ======================================================================
     7. MIST (animated)
     Two thin dithered bands drifting slowly. Each is a tile whose pattern is
     built from whole-number sine cycles, so it repeats with no seam.
     ====================================================================== */

  let mistTiles = [];

  function buildMist() {
    const mk = (yc, thick, phases, speed) => {
      const cv = document.createElement('canvas');
      cv.width = CW; cv.height = CH;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(CW, CH);
      const u32 = new Uint32Array(img.data.buffer);
      const col = [1, 2, 3].map((l) => pack(PAL.mist, l * 26));
      for (let x = 0; x < CW; x++) {
        const f = x / CW;
        const s = 0.5 + 0.25 * Math.sin(TAU * f + phases[0]) + 0.15 * Math.sin(TAU * 2 * f + phases[1]) + 0.10 * Math.sin(TAU * 5 * f + phases[2]);
        const th = thick * (0.75 + 0.25 * Math.sin(TAU * 3 * f + phases[1]));
        for (let y = Math.floor(yc - th); y <= Math.ceil(yc + th); y++) {
          if (y < 0 || y >= CH) continue;
          const v = Math.max(0, 1 - Math.abs(y - yc) / th);
          const lvl = Math.min(3, Math.floor(v * s * 3.2 + bayer(x, y) - 0.15));
          if (lvl > 0) u32[y * CW + x] = col[lvl - 1];
        }
      }
      ctx.putImageData(img, 0, 0);
      return { cv, speed };
    };
    const bottom = PAD + H;
    mistTiles = [
      mk(bottom - 0.30 * U, 0.060 * U + 2, [0.4, 1.9, 3.1], 2.0),   // around the mountain bases
      mk(bottom - 0.20 * U, 0.050 * U + 2, [2.2, 0.7, 4.4], 3.3)    // around the distant trees
    ];
  }

  function drawMist(t) {
    const ctx = layers.mist.ctx;
    ctx.clearRect(0, 0, CW, CH);
    for (const m of mistTiles) {
      const off = Math.floor((t * m.speed) % CW);
      ctx.drawImage(m.cv, off, 0);
      ctx.drawImage(m.cv, off - CW, 0);
    }
  }

  /* ======================================================================
     8. SNOWFALL (animated)
     Three depth layers. Distant flakes are small, pale and quick; foreground
     flakes are a bit bigger, brighter and slower. Counts scale with the canvas
     area and are capped, so snow stays light and never hides the scene.
     ====================================================================== */

  const SNOW_LAYERS = [
    { n: 70, size: 1, vy: [13, 19], amp: [1, 3], colors: ['#6d8fd0', '#8aa8e0'],            alpha: 0.75 },
    { n: 40, size: 1, vy: [8, 12],  amp: [2, 5], colors: ['#cfe3ff', '#e8f3ff', '#9fd4f0'], alpha: 1 },
    { n: 12, size: 2, vy: [5, 8],   amp: [3, 7], colors: ['#ffffff', '#dbeaff', '#a8e0f5'], alpha: 1 }
  ];
  const WIND = 1.6;              // gentle sideways drift (logical px / second)
  let flakes = [];

  function initSnow() {
    flakes = [];
    const area = (CW * CH) / 57600;
    for (const d of SNOW_LAYERS) {
      const n = Math.min(150, Math.round(d.n * area));
      for (let i = 0; i < n; i++) {
        flakes.push({
          x: Math.random() * CW,
          y: Math.random() * CH,
          vy: lerp(d.vy[0], d.vy[1], Math.random()),
          amp: lerp(d.amp[0], d.amp[1], Math.random()),
          f: lerp(0.3, 0.8, Math.random()),
          ph: Math.random() * TAU,
          s: d.size,
          c: d.colors[Math.floor(Math.random() * d.colors.length)],
          a: d.alpha
        });
      }
    }
  }

  function stepSnow(dt) {
    for (const f of flakes) {
      f.y += f.vy * dt;
      f.x += WIND * dt;
      if (f.y > CH + 2) { f.y -= CH + 6; f.x = Math.random() * CW; }   // re-enter above the top
      if (f.x > CW) f.x -= CW;
    }
  }

  function drawSnow(t) {
    const ctx = layers.snow.ctx;
    ctx.clearRect(0, 0, CW, CH);
    for (const f of flakes) {
      ctx.globalAlpha = f.a;
      ctx.fillStyle = f.c;
      ctx.fillRect(Math.floor(f.x + Math.sin(t * f.f + f.ph) * f.amp), Math.floor(f.y), f.s, f.s);
    }
    ctx.globalAlpha = 1;
  }

  /* ======================================================================
     9. PARALLAX, MAIN LOOP, RESIZE, REDUCED MOTION
     ====================================================================== */

  // Optional, very subtle mouse parallax: layers shift in whole logical pixels,
  // so they always stay aligned to the pixel grid.
  const mouse = { tx: 0, ty: 0, x: 0, y: 0 };

  window.addEventListener('pointermove', (e) => {
    if (reduced || e.pointerType !== 'mouse') return;
    mouse.tx = (e.clientX / window.innerWidth - 0.5) * 2;
    mouse.ty = (e.clientY / window.innerHeight - 0.5) * 2;
  }, { passive: true });
  document.addEventListener('mouseleave', () => { mouse.tx = 0; mouse.ty = 0; });

  function updateParallax(dt) {
    mouse.x += (mouse.tx - mouse.x) * Math.min(1, dt * 1.5);
    mouse.y += (mouse.ty - mouse.y) * Math.min(1, dt * 1.5);
    applyParallax();
  }

  function applyParallax() {
    for (const id of LAYER_IDS) {
      const L = layers[id];
      if (!L.depth) continue;
      const sx = Math.round(-mouse.x * L.depth);
      const sy = Math.round(-mouse.y * L.depth * 0.4);
      if (sx !== L.sx || sy !== L.sy) {
        L.sx = sx; L.sy = sy;
        L.el.style.transform = `translate(${sx * P}px, ${sy * P}px)`;
      }
    }
  }

  function resetParallax() {
    mouse.tx = mouse.ty = mouse.x = mouse.y = 0;
    applyParallax();
  }

  /** One calm frame of everything (used for reduced motion, and as the first paint). */
  function renderStillFrame() {
    drawStars(0, true);
    drawAurora(40);
    drawClouds(0);
    drawMist(0);
    drawSnow(0);
  }

  let rafId = 0, last = 0, t = 0;
  const acc = { aurora: 0, stars: 0, mist: 0, clouds: 0 };
  const STEP = { aurora: 1 / 16, stars: 1 / 8, mist: 1 / 20, clouds: 1 / 30 };   // throttled for performance

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    const dt = Math.min(0.1, (now - last) / 1000);   // clamp so a hidden tab doesn't cause a jump
    last = now;
    t += dt;

    updateParallax(dt);
    stepSnow(dt);
    drawSnow(t);

    acc.aurora += dt; acc.stars += dt; acc.mist += dt; acc.clouds += dt;
    if (acc.aurora >= STEP.aurora) { acc.aurora = 0; drawAurora(t); }
    if (acc.stars  >= STEP.stars)  { acc.stars  = 0; drawStars(t, false); }
    if (acc.mist   >= STEP.mist)   { acc.mist   = 0; drawMist(t); }
    if (acc.clouds >= STEP.clouds) { acc.clouds = 0; drawClouds(t); }
  }

  function start() {
    if (rafId) return;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stop() {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  motionQuery.addEventListener('change', (e) => {
    reduced = e.matches;
    if (reduced) { stop(); resetParallax(); renderStillFrame(); } else { start(); }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(rebuild, 120);
  });

  rebuild();
  if (!reduced) start();
})();