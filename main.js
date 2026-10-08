/* ============================================================
   FROSTLINE — 겨울 산길 드라이빙 MVP (Three.js)

   - 절차적 무한 도로: 헤딩 적분 기반 부드러운 곡선 + 완만한 고저차
   - 세미 리얼리스틱 저용량 렌더링: 노이즈 눈 지형, 캔버스 절차 텍스처,
     InstancedMesh 식생/가드레일, fog 로 원거리 정리
   - 아케이드 차량 물리: 관성/미끄러짐, 노면/눈밭 접지 차이
   ============================================================ */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import Terrain, { TerrainNS, createSeededRandom } from './vendor/three.terrain.js';
const RUN = new URLSearchParams(location.search);
const WORLD_SEED = Number(RUN.get('seed')) || Math.floor(Math.random() * 1000000);
const SEASONS = {
  spring: { name: '봄', ground: [0.28,0.43,0.16], leaf: [0.28,0.55,0.16], pine: [0.08,0.23,0.12], sky: 0x8cbfdc },
  summer: { name: '여름', ground: [0.15,0.30,0.08], leaf: [0.08,0.34,0.09], pine: [0.045,0.17,0.075], sky: 0x6caddb },
  autumn: { name: '가을', ground: [0.38,0.27,0.10], leaf: [0.68,0.20,0.045], pine: [0.07,0.20,0.10], sky: 0x9bbbd0 },
  winter: { name: '겨울', ground: [0.72,0.80,0.88], leaf: null, pine: [0.09,0.19,0.16], sky: 0x91bed9 }
};
let season = SEASONS[RUN.get('season')] ? RUN.get('season') : 'winter';
let seasonTransition = null, queuedSeason = null;
let visualWinter = season === 'winter' ? 1 : 0;
const seasonDuration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 4;
let natureAuto = false, natureHours = 0, weatherHours = 0, weatherStep = 0, natureSeasonIndex = 0;
let weatherTransition = null;
const SEASON_ORDER = ['spring','summer','autumn','winter'];
const NATURAL_WEATHER = {
 spring: ['clear','drizzle','rain','clear'],
 summer: ['clear','rain','storm','clear'],
 autumn: ['clear','drizzle','rain','clear'],
 winter: ['clear','snow','snow','clear']
};
// 비율을 안 건드리거나 50,22,16,12이면 지금 초반 해안과 2.2km 이후 배치를 유지한다.
let mixCustom = false;
let MIX = { mountain: 50, coast: 22, city: 16, river: 12 };
let COMPLEX = 50;
let complexMul = 1;
let mapPreview = false;
const PREVIEW_LOOK = 80, PREVIEW_BACK = 18, PREVIEW_UP = 22, PREVIEW_SPAN = 8000;
let previewS = 6;
let previewYaw = 0;
let previewPitch = -Math.atan2(PREVIEW_UP - 1.6, PREVIEW_BACK + PREVIEW_LOOK);
// 첫 900m: 낮은 구릉의 리듬. 해안 형상은 계절과 무관해 전환 중에도 연속적이다.
const scenicBlend = s => mixCustom ? 0 : 1 - sstep(900, 1200, s);
const showcaseAmount = s => mixCustom ? 0 : 1 - sstep(1200, 1800, s);
const coastZoneBlend = s => {
  const z = zoneAt(s);
  if (!z || z.type !== 'coast') return 0;
  return sstep(z.s0, z.s0 + 40, s) * (1 - sstep(z.s1 - 40, z.s1, s));
};
const coastAmount = s => {
  if (mixCustom) return coastZoneBlend(s);
  return (RUN.get('coast') === '1' ? 1 : lerp(
    sstep(0.30, 0.61, fbm(s * 0.0011 + WORLD_SEED % 1000, 7.3)), 1, showcaseAmount(s)))
    * (1 - cityAmount(s)) * (1 - riverAmount(s));
};
// 해안 방향을 거리 노이즈의 부호로 뒤집지 않는다: 절벽·수면·나무가 중간에 튀는 원인.
const coastSide = s => 1;

// --- 구간 스케줄러: 도시/강 랜드마크가 서로, 그리고 해안·쇼케이스 구간과 겹치지 않게 배치 ---
const ZONE_START = 2200;
const ZONE_PERIOD = 3000;
function zoneBlockType(b) {
  const r = hash2(b + WORLD_SEED, 311);
  if (!mixCustom) return r < 0.22 ? 'city' : r < 0.40 ? 'river' : 'none';
  const cuts = [MIX.mountain, MIX.mountain + MIX.coast, MIX.mountain + MIX.coast + MIX.city, 100];
  const names = ['mountain', 'coast', 'city', 'river'];
  const x = r * 100;
  for (let i = 0; i < names.length; i++) if (x < cuts[i]) return names[i];
  return 'river';
}
function zoneSpan(b, type) {
  const base = b * ZONE_PERIOD;
  if (mixCustom) return { s0: base, s1: base + ZONE_PERIOD };
  const margin = ZONE_PERIOD * 0.25;
  const len = type === 'city' ? lerp(320, 480, hash2(b + WORLD_SEED, 401))
    : lerp(70, 110, hash2(b + WORLD_SEED, 401));
  const room = ZONE_PERIOD - margin * 2 - len;
  const s0 = base + margin + hash2(b + WORLD_SEED, 433) * Math.max(0, room);
  return { s0, s1: s0 + len };
}
function zoneAt(s) {
  if (s < 0 || (!mixCustom && s < ZONE_START)) return null;
  const b = Math.floor(s / ZONE_PERIOD);
  const type = zoneBlockType(b);
  if (type === 'none' || type === 'mountain') return null;
  const span = zoneSpan(b, type);
  return { type, s0: span.s0, s1: span.s1 };
}
const cityAmount = s => {
  const z = zoneAt(s);
  if (!z || z.type !== 'city') return 0;
  return sstep(z.s0, z.s0 + 50, s) * (1 - sstep(z.s1 - 50, z.s1, s));
};
const riverAmount = s => {
  const z = zoneAt(s);
  if (!z || z.type !== 'river') return 0;
  return sstep(z.s0, z.s0 + 18, s) * (1 - sstep(z.s1 - 18, z.s1, s));
};
function terrainKind(s) {
  if (mixCustom) {
    if (s < 0) return 'mountain';
    const type = zoneBlockType(Math.floor(s / ZONE_PERIOD));
    return type === 'none' ? 'mountain' : type;
  }
  if (cityAmount(s) > 0.45) return 'city';
  if (riverAmount(s) > 0.45) return 'river';
  if (coastAmount(s) > 0.45) return 'coast';
  return 'mountain';
}

const summerVisual = () => seasonTransition
  ? lerp(seasonTransition.from === 'summer' ? 1 : 0, seasonTransition.to === 'summer' ? 1 : 0, seasonTransition.blend)
  : season === 'summer' ? 1 : 0;

window.__booted = false;

/* ---------------- 수학 유틸 ---------------- */
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
// 결정적 해시 노이즈: 세그먼트를 나중에 다시 만들어도 지형이 정확히 이어짐
const hash2 = (x, y) => { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453123; return s - Math.floor(s); };
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x, y) {
  let f = 0, amp = 0.5, fr = 1;
  for (let i = 0; i < 4; i++) { f += amp * vnoise(x * fr, y * fr); fr *= 2.02; amp *= 0.5; }
  return f;
}
function parseMixParam(raw) {
  const fallback = { mountain: 50, coast: 22, city: 16, river: 12, custom: false };
  if (!raw) return fallback;
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isFinite(n))) return fallback;
  let vals = parts.map(n => clamp(Math.round(n), 0, 100));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (sum <= 0) return fallback;
  if (sum !== 100) {
    const scaled = vals.map(v => Math.floor((v * 100) / sum));
    const left = 100 - scaled.reduce((a, b) => a + b, 0);
    const rank = vals.map((v, i) => ({ i, f: (v * 100) / sum - scaled[i] })).sort((a, b) => b.f - a.f || a.i - b.i);
    for (let k = 0; k < left; k++) scaled[rank[k].i]++;
    vals = scaled;
  }
  const custom = !(vals[0] === 50 && vals[1] === 22 && vals[2] === 16 && vals[3] === 12);
  return { mountain: vals[0], coast: vals[1], city: vals[2], river: vals[3], custom };
}
{
  const parsed = parseMixParam(RUN.get('mix'));
  MIX = { mountain: parsed.mountain, coast: parsed.coast, city: parsed.city, river: parsed.river };
  mixCustom = parsed.custom;
  if (RUN.has('complex')) {
    const n = Number(RUN.get('complex'));
    if (Number.isFinite(n)) COMPLEX = clamp(Math.round(n), 0, 100);
  }
  complexMul = COMPLEX <= 50 ? lerp(0.35, 1, COMPLEX / 50) : lerp(1, 1.7, (COMPLEX - 50) / 50);
}
mapPreview = !RUN.has('drive') && !RUN.has('demo') && !RUN.has('startS');

/* ---------------- 렌더러 / 씬 / 카메라 ---------------- */
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); // 저사양 대비 DPR 상한
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.02;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0xe7eff3); // 지평선의 하얀 헤이즈와 같은 색
scene.fog = new THREE.Fog(FOG_COLOR, 90, 560);
renderer.setClearColor(FOG_COLOR);

const camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 4000);

/* ---------------- 조명: 차분한 확산광의 겨울 낮 ---------------- */
const SUN_DIR = new THREE.Vector3(0.35, 0.42, -0.84).normalize();
const hemi = new THREE.HemisphereLight(0xd8e7fa, 0xeef1f4, 1.15); // 하늘빛 반사광
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff3e2, 1.75); // 낮은 겨울 햇살
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, near: 20, far: 340 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.7;
scene.add(sun, sun.target);

/* ---------------- 환경광(자동차 도장/유리 반사용) ----------------
   외부 에셋 없이 그라데이션 구 + 흰 바닥 + 태양 구로 아주 작은 씬을 만들어
   PMREM 으로 구워냅니다. */
function buildEnvironment() {
  const es = new THREE.Scene();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { top: { value: new THREE.Color(0x9cc2ec) }, bot: { value: new THREE.Color(0xeef2f7) } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y * 0.5 + 0.5, 0.0, 1.0); gl_FragColor = vec4(mix(bot, top, pow(h, 0.75)), 1.0); }'
  });
  es.add(new THREE.Mesh(new THREE.SphereGeometry(50, 16, 10), skyMat));
  const ground = new THREE.Mesh(new THREE.CircleGeometry(40, 24), new THREE.MeshBasicMaterial({ color: 0xf3f6f9 }));
  ground.rotation.x = -Math.PI / 2;
  es.add(ground);
  const sunBall = new THREE.Mesh(new THREE.SphereGeometry(5, 10, 8), new THREE.MeshBasicMaterial({ color: 0xfff3dd }));
  sunBall.position.copy(SUN_DIR).multiplyScalar(38);
  es.add(sunBall);
  const pm = new THREE.PMREMGenerator(renderer);
  const tex = pm.fromScene(es, 0.05).texture;
  pm.dispose();
  return tex;
}
scene.environment = buildEnvironment();

/* ---------------- 하늘 돔: 연한 파랑 그라데이션 + 은은한 태양 ---------------- */
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2600, 24, 14),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: {
      top: { value: new THREE.Color(0xa8cfe5) },
      horizon: { value: FOG_COLOR.clone() },
      sunDir: { value: SUN_DIR.clone() }
    },
    vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `
      uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        float h = clamp(d.y, 0.0, 1.0);
        vec3 col = mix(horizon, top, pow(h, 0.6));
        float s = max(dot(d, sunDir), 0.0);
        col += vec3(1.0, 0.94, 0.82) * (pow(s, 700.0) * 1.1 + pow(s, 10.0) * 0.07);
        gl_FragColor = vec4(col, 1.0);
      }`
  })
);
sky.frustumCulled = false;
scene.add(sky);

/* ---------------- 원경 실루엣 산맥 + 구름 (fog 밖 배경판) ---------------- */
const mountains = new THREE.Group();
const mountainTiles = [];
// 중경 구릉 / 먼 능선 / 가장 먼 산: 높이와 색을 분리해 겹쳐지는 설원 구성.
const distanceAtmosphere = { color: { value: FOG_COLOR.clone() }, density: { value: 1 } };
for (let layer = 0; layer < 3; layer++) for (const side of [-1, 1]) {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, fog: false });
  const tile = Terrain({
    heightmap: TerrainNS.PerlinDiamond, random: createSeededRandom(WORLD_SEED + side * 17 + layer * 139),
    xSize: 1100 + layer * 500, ySize: 2800 + layer * 600, xSegments: 56, ySegments: 80,
    minHeight: 12, maxHeight: 135 + layer * 100, frequency: 1.6 + layer * 0.3, material
  });
  const geo = tile.children[0].geometry, p = geo.attributes.position;
  const colors = new Float32Array(p.count * 3);
  const valley = new THREE.Color(0xb3c5d2), snow = new THREE.Color(0xe6eef2);
  for (let i = 0; i < p.count; i++) {
    const h = p.getZ(i), localX = p.getX(i), halfWidth = (1100 + layer * 500) / 2;
    const inner = sstep(-halfWidth, -halfWidth * 0.25, localX * side);
    p.setZ(i, h * inner);
    const c = valley.clone().lerp(snow, sstep(35, 160 + layer * 70, h));
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals(); geo.computeBoundingSphere();
  tile.position.set(side * (740 + layer * 520), -25 + layer * 7, -700 - layer * 450);
  tile.userData.side = side; tile.userData.layer = layer;
  mountains.add(tile); mountainTiles.push(tile);
}
scene.add(mountains);
// 카메라 바로 아래를 공유 정점으로 삼는 거대한 삼각형 부채꼴은 근거리 클리핑에 취약하다.
// 작은 세계 좌표 격자로 수면을 그려 실내·육지와의 깊이 관계를 유지한다.
const SEA_LEVEL = -24, SEA_ANCHOR_STEP = 200, RIVER_DEPTH = 5; // 강바닥은 항상 해수면보다 RIVER_DEPTH만큼 더 낮게 유지
const sea = new THREE.Mesh(new THREE.PlaneGeometry(6400, 6400, 128, 128), new THREE.ShaderMaterial({
  side: THREE.FrontSide, depthTest: true, depthWrite: true,
  uniforms: { time: { value: 0 }, light: { value: 1 }, night: { value: 0 }, summer: { value: season === 'summer' ? 1 : 0 },
    haze: { value: FOG_COLOR.clone() }, fogNear: { value: 90 }, fogFar: { value: 560 } },
  vertexShader: `varying vec2 uvSea; varying float seaDistance;
    void main(){ vec4 world=modelMatrix*vec4(position,1.0); uvSea=world.xz;
      vec4 view=modelViewMatrix*vec4(position,1.0); seaDistance=length(view.xyz);
      gl_Position=projectionMatrix*view; }`,
  fragmentShader: `uniform float time; uniform float light; uniform float night; uniform float summer;
    uniform vec3 haze; uniform float fogNear; uniform float fogFar;
    varying vec2 uvSea; varying float seaDistance;
    void main(){ float wave=sin(uvSea.x*0.16+time*0.55+sin(uvSea.y*0.06))*sin(uvSea.y*0.32-time*0.4);
      float grainFade=1.0-smoothstep(60.0,360.0,seaDistance);
      float glint=pow(max(0.0,wave),18.0)*grainFade;
      vec3 cool=mix(vec3(0.025,0.18,0.23),vec3(0.13,0.38,0.44),wave*0.16+0.5);
      vec3 turquoise=mix(vec3(0.018,0.36,0.43),vec3(0.08,0.66,0.61),wave*0.10+0.65);
      vec3 dayC=(mix(cool,turquoise,summer)+glint*vec3(0.30,0.37,0.30))*light;
      float fade=1.0-smoothstep(40.0,520.0,seaDistance);
      float shimmer=0.62+0.38*sin(uvSea.y*0.42-time*1.3+sin(uvSea.x*0.05));
      float lane=abs(fract(uvSea.x*0.048)-0.5);
      float streak=smoothstep(0.085,0.0,lane)*shimmer*fade;
      float which=fract(sin(floor(uvSea.x*0.048)*91.7)*47.3);
      vec3 warm=vec3(1.0,0.58,0.26), coolL=vec3(0.55,0.8,1.0), green=vec3(0.35,1.0,0.55), red=vec3(1.0,0.25,0.32);
      vec3 lamp=mix(warm,coolL,step(0.76,which));
      lamp=mix(lamp,green,step(0.92,which));
      lamp=mix(lamp,red,step(0.97,which));
      float win=smoothstep(0.78,0.96,fract(sin(floor(uvSea.x*0.37)+floor(uvSea.y*0.11)*17.0)*43.1));
      vec3 nightC=vec3(0.012,0.022,0.045)+lamp*streak*1.25+mix(warm,coolL,fract(uvSea.x*0.02))*win*0.28*fade;
      vec3 c=mix(dayC,nightC,night);
      c=mix(c,haze,smoothstep(fogNear,fogFar,seaDistance)*0.82);
      gl_FragColor=vec4(c,1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`
}));
sea.rotation.x = -Math.PI / 2; sea.position.y = SEA_LEVEL; scene.add(sea);

/* ---------------- 도로 절차 텍스처 (256px 캔버스 2장) ----------------
   짙은 차콜 아스팔트 + 밝은 타이어 마모 자국 + 얼음/젖은 패치 + 가장자리 눈.
   얼음 패치는 거칠기맵에서 매끄러워져 햇빛에 반사광이 생깁니다. */
function buildRoadTextures() {
  const S = 256;
  const blobs = []; // 컬러맵/거칠기맵이 같은 위치를 공유
  // 큰 원형 얼음 패치 대신 미세한 아스팔트 질감만 반복한다.

  // 컬러맵
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.fillStyle = '#45484d'; g.fillRect(0, 0, S, S);
  const img = g.getImageData(0, 0, S, S), d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 16;
    d[i] += n; d[i + 1] += n; d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
  for (const cx of [S * 0.30, S * 0.70]) { // 밝은 타이어 자국
    const lg = g.createLinearGradient(cx - 24, 0, cx + 24, 0);
    lg.addColorStop(0, 'rgba(212,218,224,0)');
    lg.addColorStop(0.5, 'rgba(212,218,224,0.30)');
    lg.addColorStop(1, 'rgba(212,218,224,0)');
    g.fillStyle = lg; g.fillRect(cx - 24, 0, 48, S);
  }
  for (const [x, y, r] of blobs) { // 얼음/젖은 패치
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(185,198,210,0.32)');
    rg.addColorStop(1, 'rgba(185,198,210,0)');
    g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // 가장자리 눈은 텍스처에 넣지 않는다 — 지오메트리(눈 어깨 스트립)로 처리
  // (텍스처 가장자리 흰색은 원거리 밉맵에서 번져 노면이 하얗게 씻겨 나감)

  const map = new THREE.CanvasTexture(cv);
  map.wrapS = THREE.ClampToEdgeWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());

  // 거칠기맵 (어두울수록 매끄러움 = 얼음)
  const cv2 = document.createElement('canvas'); cv2.width = cv2.height = S;
  const g2 = cv2.getContext('2d');
  g2.fillStyle = '#d6d6d6'; g2.fillRect(0, 0, S, S);
  for (const [x, y, r] of blobs) {
    const rg = g2.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, 'rgba(70,70,70,0.85)');
    rg.addColorStop(1, 'rgba(70,70,70,0)');
    g2.fillStyle = rg; g2.beginPath(); g2.arc(x, y, r, 0, Math.PI * 2); g2.fill();
  }
  const rough = new THREE.CanvasTexture(cv2);
  rough.wrapS = THREE.ClampToEdgeWrapping;
  rough.wrapT = THREE.RepeatWrapping;
  return { map, rough };
}

/* ---------------- 공유 머티리얼 ---------------- */
const { map: roadMap, rough: roadRough } = buildRoadTextures();
const roadMat = new THREE.MeshStandardMaterial({
  map: roadMap, roughnessMap: roadRough, roughness: 1.0, metalness: 0.04,
  vertexColors: true, envMapIntensity: 0.45
});
const terrainMat = new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.92, metalness: 0, envMapIntensity: 0.24
});
// 월드 좌표의 연속 질감. 눈은 넓고 조용한 면으로, 노면만 약한 요철을 사용한다.
const roadSurfaceState = { snowCover: { value: 0 }, winterEdge: { value: season === 'winter' ? 1 : 0 } };
function detailSurface(material, kind) {
  material.onBeforeCompile = shader => {
    const isRoad = kind === 'road';
    shader.vertexShader = 'varying vec3 vSurfaceWorld;\n' + (isRoad ? 'varying vec2 vRoadUV;\n' : '') + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvSurfaceWorld=(modelMatrix*vec4(transformed,1.0)).xyz;' + (isRoad ? '\nvRoadUV=uv;' : ''));
    if (isRoad) { shader.uniforms.snowCover = roadSurfaceState.snowCover; shader.uniforms.winterEdge = roadSurfaceState.winterEdge; }
    shader.fragmentShader = `varying vec3 vSurfaceWorld;
      ${isRoad ? 'varying vec2 vRoadUV; uniform float snowCover; uniform float winterEdge;' : ''}
      float surfaceHash(vec3 p){return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453);}
      float surfaceNoise(vec3 p){vec3 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);
      return mix(mix(mix(surfaceHash(i),surfaceHash(i+vec3(1,0,0)),f.x),mix(surfaceHash(i+vec3(0,1,0)),surfaceHash(i+vec3(1,1,0)),f.x),f.y),mix(mix(surfaceHash(i+vec3(0,0,1)),surfaceHash(i+vec3(1,0,1)),f.x),mix(surfaceHash(i+vec3(0,1,1)),surfaceHash(i+vec3(1,1,1)),f.x),f.y),f.z);}
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
      float detailFade=1.0-smoothstep(25.0,95.0,length(vViewPosition));
      float grain=mix(0.5,surfaceNoise(vSurfaceWorld*6.0),detailFade);
      float broad=surfaceNoise(vSurfaceWorld*0.08);
      diffuseColor.rgb *= ${kind === 'snow' ? '0.975 + broad*0.025 + (grain-0.5)*0.012' : '0.96 + grain*0.04'};
      ${isRoad ? `
        float trackDistance=min(min(abs(vRoadUV.x-0.15),abs(vRoadUV.x-0.36)),min(abs(vRoadUV.x-0.64),abs(vRoadUV.x-0.85)));
        float aa=max(fwidth(vRoadUV.x),0.001);
        float tracks=1.0-smoothstep(0.013,0.029+aa,trackDistance);
        float edgeSnow=smoothstep(0.34,0.49,abs(vRoadUV.x-0.5));
        float cover=clamp(snowCover+edgeSnow*0.20*winterEdge,0.0,0.96);
        vec3 packedSnow=vec3(0.72,0.78,0.82)*(0.98+broad*0.02);
        diffuseColor.rgb=mix(diffuseColor.rgb,packedSnow,cover*(1.0-tracks*0.52));
        // 도로 UV로 그려 모든 커브와 세그먼트 이음새에 정확히 붙는 원본 차선.
        float center=1.0-smoothstep(0.008,0.008+aa,abs(vRoadUV.x-0.5));
        float dashPhase=mod(vRoadUV.y*13.0,12.0);
        float dash=smoothstep(0.0,0.25,dashPhase)*(1.0-smoothstep(4.75,5.0,dashPhase));
        float edgeDist=min(abs(vRoadUV.x-0.045),abs(vRoadUV.x-0.955));
        float edgeLine=1.0-smoothstep(0.009,0.009+aa,edgeDist);
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.84,0.70,0.40),center*dash*(1.0-cover*0.85)*0.78);
        diffuseColor.rgb=mix(diffuseColor.rgb,vec3(0.83,0.85,0.79),edgeLine*(1.0-cover*0.85)*0.82);
      ` : ''}
    `);
    if (isRoad) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
      // 면의 접선과 법선을 모두 뷰 좌표로 계산해 좌표계 혼합을 막는다.
      vec3 surfDx=dFdx(-vViewPosition), surfDy=dFdy(-vViewPosition);
      vec3 tangentX=cross(surfDy,normal), tangentY=cross(normal,surfDx);
      float determinant=dot(surfDx,tangentX);
      vec3 gradient=sign(determinant)*(dFdx(grain)*tangentX+dFdy(grain)*tangentY)*0.003;
      normal=normalize(abs(determinant)*normal-gradient);
    `);
  };
  material.customProgramCacheKey = () => 'winter-surface-v2-' + kind;
}
detailSurface(roadMat, 'road'); detailSurface(terrainMat, 'snow');
mountainTiles.forEach(tile => {
  const material = tile.children[0].material;
  material.onBeforeCompile = shader => {
    shader.uniforms.distanceHaze = distanceAtmosphere.color;
    shader.uniforms.hazeDensity = distanceAtmosphere.density;
    shader.fragmentShader = 'uniform vec3 distanceHaze; uniform float hazeDensity;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', `
      float haze=clamp((0.36+${(tile.userData.layer * 0.16).toFixed(2)}+smoothstep(400.0,2500.0,length(vViewPosition))*0.30)*hazeDensity,0.0,0.98);
      outgoingLight=mix(outgoingLight,distanceHaze,haze);
      #include <opaque_fragment>`);
  };
  material.customProgramCacheKey = () => 'winter-ridge-' + tile.userData.layer;
});
const trunkMat = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 1, envMapIntensity: 0.15 });
const railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.4, envMapIntensity: 0.7 });
const reflMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, envMapIntensity: 0.5 });

/* ---------------- 도로 중심선: 헤딩 적분으로 만드는 무한 곡선 ---------------- */
// 헤딩/높이를 s(주행거리)의 연속 함수로 정의 → 세그먼트가 자연스럽게 이어짐
const headingAt = s => {
  const original = 0.72 * Math.sin(s * 0.0032 + WORLD_SEED % 19) + 0.42 * Math.sin(s * 0.0079 + 1.6) + 0.18 * Math.sin(s * 0.017 + 4.0) + 0.10 * Math.sin(s * 0.0011);
  // 넓은 해안 S자 도로. 짧은 주기의 급커브를 줄이고 같은 도로를 사계절 공유한다.
  const promenade = 0.46 * Math.sin(s * 0.0052) + 0.16 * Math.sin(s * 0.009 + 0.4);
  if (!mixCustom) {
    const opening = 1 - sstep(1200, 1800, s);
    return original * complexMul * (1 - opening) + promenade * opening;
  }
  const coast = coastZoneBlend(s);
  const flat = Math.min(1, cityAmount(s) + riverAmount(s));
  const coastW = coast * (1 - flat);
  const mount = Math.max(0, 1 - coastW - flat);
  return original * complexMul * mount + promenade * coastW + original * flat;
};
const roadYAt = s => {
  const original = 10.5 * Math.sin(s * 0.0019 + 0.8) + 5.2 * Math.sin(s * 0.0053 + WORLD_SEED % 13) + 1.6 * Math.sin(s * 0.012 + 2.1);
  const coastalFlat = -17.5 + 1.2 * Math.sin(s * 0.004) + 0.45 * Math.sin(s * 0.011);
  if (!mixCustom) {
    const opening = 1 - sstep(1200, 1800, s);
    return lerp(original * complexMul, coastalFlat, opening);
  }
  const coast = coastZoneBlend(s);
  const flat = Math.min(1, cityAmount(s) + riverAmount(s));
  const coastW = coast * (1 - flat);
  const mount = Math.max(0, 1 - coastW - flat);
  return original * complexMul * mount + coastalFlat * coastW + original * flat;
};
// 가드레일이 등장하는 구간(약 40%)
const railActive = s => Math.sin(s * 0.0043 + 1.1) > 0.30;

const roadSamples = []; // 1m 간격 샘플 { x, z, y, h }
let baseS = 0, genS = 0, lastX = 0, lastZ = 0;
roadSamples.push({ x: 0, z: 0, y: roadYAt(0), h: headingAt(0) });
function genTo(target) {
  while (genS < target) {
    const h = headingAt(genS);
    lastX += -Math.sin(h); // 전진 벡터 = (-sin h, -cos h)
    lastZ += -Math.cos(h);
    genS += 1;
    roadSamples.push({ x: lastX, z: lastZ, y: roadYAt(genS), h: headingAt(genS) });
  }
}
// s(m) 위치의 중심선 샘플 보간
function sampleAt(s) {
  const n = roadSamples.length;
  const fi = clamp(s - baseS, 0, n - 1.0001);
  const i = fi | 0, t = fi - i;
  const a = roadSamples[i], b = roadSamples[Math.min(n - 1, i + 1)];
  const x = a.x + (b.x - a.x) * t;
  const z = a.z + (b.z - a.z) * t;
  const y = a.y + (b.y - a.y) * t;
  const h = a.h + (b.h - a.h) * t;
  return { x, z, y, h, rx: Math.cos(h), rz: -Math.sin(h) }; // rx,rz = 우측 단위벡터
}

/* ---------------- 눈 지형 높이 함수 (도로 주변은 평평하게) ---------------- */
function groundY(s, lat) {
  const a = Math.abs(lat);
  let h = sampleAt(s).y - 0.06;           // 도로보다 6cm 아래 복도
  h += 0.55 * sstep(5.2, 7.2, a) * (1 - sstep(7.2, 11.5, a)); // 제설 뱅크
  const m = sstep(7.2, 35, a);            // 도로 가장자리에서 연속적으로 올라오는 구릉
  const scenic = scenicBlend(s);
  const seedPhase = WORLD_SEED % 37;
  const rolling = (Math.sin(s * 0.013 + lat * 0.025 + seedPhase) * 4.8
    + Math.sin(s * 0.006 - lat * 0.041 + 1.7) * 3.6) * complexMul;
  h += lerp((fbm(s * 0.012, lat * 0.02) - 0.5) * 11 * complexMul, rolling, scenic) * m;
  h += (fbm(s * 0.035 + 40, lat * 0.035 - 17) - 0.5) * lerp(1.5, 0.65, scenic) * complexMul * m;
  h += sstep(48, 185, a) * (12 + fbm(s * 0.006, lat * 0.009) * 19) * complexMul; // 뒤쪽의 넓은 사면
  h -= scenic * sstep(25, 70, a) * (1 - sstep(95, 175, a)) * 4.5 * complexMul; // 낮은 중경 계곡
  const opening = showcaseAmount(s);
  // 부드러운 육지 구릉은 낮게 유지해 운전석에서 수평선이 보이게 한다.
  const lowHills = sampleAt(s).y - 0.06 + sstep(7.2, 80, a) *
    (3.5 + complexMul * (2.2 * Math.sin(s * 0.009 + lat * 0.022) + 1.2 * Math.sin(s * 0.017 - lat * 0.03)));
  h = lerp(h, lowHills, opening);
  const coastal = coastAmount(s) * (Math.sign(lat) === coastSide(s) ? 1 : 0);
  // 도로 → 잔디 어깨 → 모래 테라스 → 얕은 수심 → 바다. 도로와 같은 단면 좌표를 공유한다.
  const shelf = lerp(sampleAt(s).y - 0.06, -23.15, sstep(8, 22, a));
  const beach = lerp(shelf, -24.05, sstep(22, 35, a));
  const seabed = lerp(beach, -30.5, sstep(35, 68, a));
  h = lerp(h, seabed, coastal * sstep(6.4, 11.5, a));
  // 도시 구간: 도로 근처를 광장/거리 높이로 평탄화
  const city = cityAmount(s);
  if (city > 0.001) {
    const cityFlat = sampleAt(s).y - 0.06;
    const cityBelt = 1 - sstep(60, 90, a);
    h = lerp(h, cityFlat, city * cityBelt);
  }
  // 강 구간: 도로 양옆 전체 폭에서 수면보다 확실히 낮은 강바닥까지 내려가는 계곡(다리 상판은 roadYAt로 별도 유지)
  const river = riverAmount(s);
  if (river > 0.001) {
    const bedY = Math.min(SEA_LEVEL - RIVER_DEPTH, sampleAt(s).y - 8);
    const bank = lerp(bedY, h, sstep(8, 70, a));
    h = lerp(h, bank, river);
  }
  return h;
}
// 눈 버텍스 컬러: 순백이 아닌 블루/그레이가 섞인 흰색
function snowColorRaw(s, lat, name) {
  const a = Math.abs(lat);
  const n = fbm(s * 0.043 + 11.3, lat * 0.043 + 4.7);
  const n2 = fbm(s * 0.16 - 7.1, lat * 0.16 + 23.7);
  const shade = sstep(0.25, 0.75, n);
  if (name !== 'winter') {
    const base = SEASONS[name].ground;
    const rock = sstep(0.58,0.79,n2) * sstep(12,70,a);
    const grass = base.map((v,i) => lerp(v * (0.76 + n * 0.4), [0.27,0.25,0.21][i], rock * 0.65));
    const seaside = Math.sign(lat) === coastSide(s) ? coastAmount(s) : 0;
    const sand = seaside * sstep(7.5, 17, a);
    const beachTint = name === 'summer' ? [0.72,0.55,0.30] : name === 'spring' ? [0.60,0.52,0.35] : [0.53,0.41,0.24];
    return grass.map((v,i) => lerp(v, beachTint[i] * (0.93 + n * 0.12), sand));
  }
  let r = lerp(0.84, 0.56, shade), g = lerp(0.90, 0.67, shade), b = lerp(0.96, 0.79, shade);
  const near = 1 - sstep(4.2, 9.5, a); // 도로 주변은 살짝 묻은 눈
  r = lerp(r, 0.84, near * 0.45); g = lerp(g, 0.86, near * 0.45); b = lerp(b, 0.90, near * 0.45);
  const sp = sstep(0.78, 0.95, n2) * (1 - near); // 반짝이는 눈 구름
  r = Math.min(1, r + sp * 0.05); g = Math.min(1, g + sp * 0.03);
  return [r, g, b];
}

function snowColor(s, lat) {
  const target = snowColorRaw(s, lat, season);
  if (!seasonTransition) return target;
  const from = snowColorRaw(s, lat, seasonTransition.from);
  return target.map((v,i)=>lerp(from[i],v,seasonTransition.blend));
}

/* ---------------- 세그먼트 지오메트리 빌더 ---------------- */
const SEG = 24; // 세그먼트 길이(m)
// 도로 단면: [가로오프셋, 높이, u, r, g, b] — 양 끝은 스커트(노면 옆면)
// 가장자리 눈은 지형 복도가 담당, 텍스처는 순수 아스팔트만 사용(밉맵 블리딩 방지)
const CROSS = [
   [-4.22, -0.30, 0.00, 0.50, 0.53, 0.58],
  [-4.20, 0.00, 0.00, 1, 1, 1],
  [4.20, 0.00, 1.00, 1, 1, 1],
  [4.22, -0.30, 1.00, 0.50, 0.53, 0.58]
];
function buildRoadGeo(s0, s1) {
  const rows = [];
  for (let s = s0; s <= s1 + 0.001; s += 2) rows.push(sampleAt(s));
  const nV = rows.length * 4;
  const pos = new Float32Array(nV * 3), uv = new Float32Array(nV * 2), col = new Float32Array(nV * 3);
  const idx = [];
  rows.forEach((r, ri) => {
    const jit = 0.90 + 0.12 * vnoise(s0 + ri * 2 + 3.3, 7.7); // 미세한 밝기 차이
    for (let k = 0; k < 4; k++) {
      const c = CROSS[k], vi = ri * 4 + k;
      pos[vi * 3] = r.x + r.rx * c[0];
      pos[vi * 3 + 1] = r.y + c[1];
      pos[vi * 3 + 2] = r.z + r.rz * c[0];
      uv[vi * 2] = c[2]; uv[vi * 2 + 1] = (s0 + ri * 2) / 13;
      const b = (k === 1 || k === 2) ? jit : 1; // 아스팔트 상판만 밝기 지터
      col[vi * 3] = c[3] * b; col[vi * 3 + 1] = c[4] * b; col[vi * 3 + 2] = c[5] * b;
    }
  });
  for (let ri = 0; ri < rows.length - 1; ri++) {
    const a = ri * 4, b = (ri + 1) * 4;
    for (let k = 0; k < 3; k++) idx.push(a + k, a + k + 1, b + k, a + k + 1, b + k + 1, b + k);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

// 지형 그리드: 도로에서 멀어질수록 넓어지는 열 배치
// ±4.9열은 도로 바로 옆 평평한 복도(뱅크는 5.2부터 시작) — 이 열이 도로 옆 눈가 역할
const TCOLS = [-220,-180,-160,-140,-122,-106,-92,-80,-68,-59,-50,-43,-36,-30,-25,-21,-17,-14,-11.5,-8.6,-6.4,-4.9,
  4.9,6.4,8.6,11.5,14,17,21,25,30,36,43,50,59,68,80,92,106,122,140,160,180,220];
function tpos(s, lat) {
  const r = sampleAt(s);
  return { x: r.x + r.rx * lat, y: groundY(s, lat), z: r.z + r.rz * lat };
}
function buildTerrainGeo(s0) {
  const nC = TCOLS.length, rows = 7; // 양쪽 끝 1열씩은 법선 계산용 헬퍼
  const pos = new Float32Array(rows * nC * 3), nor = new Float32Array(rows * nC * 3), col = new Float32Array(rows * nC * 3);
  const idx = [];
  for (let j = 0; j < rows; j++) {
    const s = s0 + (j - 1) * 6;
    for (let i = 0; i < nC; i++) {
      const lat = TCOLS[i], k = j * nC + i;
      const p = tpos(s, lat);
      pos[k * 3] = p.x; pos[k * 3 + 1] = p.y; pos[k * 3 + 2] = p.z;
      // 해석적 법선(유한차분): 세그먼트 경계에서도 동일값으로 이음새 제거
      const e = 0.8;
      const s1p = tpos(s + e, lat), s0p = tpos(s - e, lat);
      const l1p = tpos(s, lat + e), l0p = tpos(s, lat - e);
      const dsx = s1p.x - s0p.x, dsy = s1p.y - s0p.y, dsz = s1p.z - s0p.z;
      const dlx = l1p.x - l0p.x, dly = l1p.y - l0p.y, dlz = l1p.z - l0p.z;
      let nx = dly * dsz - dlz * dsy, ny = dlz * dsx - dlx * dsz, nz = dlx * dsy - dly * dsx;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nor[k * 3] = nx / nl; nor[k * 3 + 1] = ny / nl; nor[k * 3 + 2] = nz / nl;
      const cc = snowColor(s, lat);
      col[k * 3] = cc[0]; col[k * 3 + 1] = cc[1]; col[k * 3 + 2] = cc[2];
    }
  }
  for (let j = 1; j <= rows - 3; j++) for (let i = 0; i < nC - 1; i++) {
    const a = j * nC + i, b = (j + 1) * nC + i;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/* ---------------- 식생/가드레일 지오메트리 (한 번만 만들어 재사용) ---------------- */
function colorize(geo, r, g, b) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = r; arr[i * 3 + 1] = g; arr[i * 3 + 2] = b; }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}
// 수종마다 한 번 만드는 실제 분기 지오메트리: 잎 없는 나무 / 눈 얹힌 가지형 침엽수 / 낮은 덤불.
function mergePlantParts(parts) {
  // 원통은 인덱스가 있고 정이십면체는 없으므로 병합 전에 형식을 통일한다.
  const normalized = parts.map(part => part.index ? part.toNonIndexed() : part);
  const geo = mergeGeometries(normalized);
  normalized.forEach(part => part.dispose());
  parts.forEach(part => { if (part.index) part.dispose(); });
  if (!geo) throw new Error('겨울 식생 지오메트리 병합 실패');
  geo.computeBoundingSphere();
  return geo;
}
function branchPart(parts, a, b, radius, tip, tint) {
  const delta = b.clone().sub(a);
  const geo = new THREE.CylinderGeometry(tip, radius, delta.length(), 5, 1, true);
  geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), delta.normalize()));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  colorize(geo, ...tint); parts.push(geo);
}
function snowLobe(parts, x, y, z, sx, sy, sz, tint, rotation = 0) {
  const geo = new THREE.IcosahedronGeometry(1, 0);
  geo.scale(sx, sy, sz); geo.rotateY(rotation); geo.translate(x, y, z);
  colorize(geo, ...tint); parts.push(geo);
}
function leafCluster(parts, center, size, tint, seed) {
  // 크고 매끈한 다면체 대신 작은 잎 무리와 밝고 어두운 면을 겹친다.
  for (let k = 0; k < 5; k++) {
    const az = k * 2.399 + seed;
    const r = k === 0 ? 0 : size * (0.35 + hash2(k, seed) * 0.25);
    const geo = new THREE.IcosahedronGeometry(1, 1);
    const scale = size * (0.48 + hash2(k + 11, seed) * 0.19);
    geo.scale(scale, scale * (0.8 + hash2(k, seed + 9) * 0.4), scale * 0.88);
    geo.rotateY(az);
    geo.translate(center.x + Math.cos(az) * r, center.y + (hash2(k, seed + 2) - 0.35) * size * 0.55, center.z + Math.sin(az) * r);
    const p = geo.attributes.position, colors = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const light = 0.70 + 0.22 * Math.max(0, (p.getY(i) - center.y) / size + 0.5) + hash2(i + k * 31, seed) * 0.10;
      colors.set(tint.map(v => v * light), i * 3);
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3)); parts.push(geo);
  }
}
function seasonalLeaf(id, seed, variant, shrub) {
  const density = {spring:0.78,summer:1,autumn:0.57,winter:0}[season];
  if (hash2(id,seed+8)>density || season==='winter') return null;
  const base=SEASONS[season].leaf;
  const autumnColors=[[0.72,0.36,0.055],[0.65,0.12,0.035],[0.82,0.52,0.10]];
  const tint=season==='autumn'?autumnColors[Math.floor(hash2(id,seed+19)*3)]:base;
  return {color:tint.map(v=>v*(0.72+hash2(id,seed)*0.4)),
    size:(shrub?0.32:season==='summer'?0.95:season==='spring'?0.62:0.55)*(0.8+hash2(id,seed+3)*0.35),
    flower:season==='spring' && variant===1 && hash2(id,seed+4)>0.63};
}
function buildBareGeo(variant, shrub = false) {
  const parts = [], seed = variant * 71 + (shrub ? 313 : 11);
  const bark = shrub ? [0.24, 0.27, 0.29] : [0.19, 0.22, 0.24];
  function fork(a, direction, length, radius, depth, id) {
    const b = a.clone().addScaledVector(direction, length);
    branchPart(parts, a, b, radius, Math.max(0.009, radius * 0.48), bark);
    if (depth === 0) {
      const leaf=seasonalLeaf(id,seed,variant,shrub);
      if (leaf) {
        const size=leaf.size;
        leafCluster(parts, b, size, leaf.color, id + seed);
        if (leaf.flower) snowLobe(parts,b.x,b.y+size*.5,b.z,size*.48,size*.30,size*.42,[0.91,0.64,0.69]);
      }
      return;
    }
    const az = hash2(id, seed) * Math.PI * 2;
    for (let k = 0; k < 3; k++) {
      const angle = az + k * Math.PI * 2 / 3 + hash2(id + k, seed + 1) * 0.35;
      const spread = depth === 3 ? 0.72 : 0.52;
      const d = direction.clone().multiplyScalar(0.55).add(new THREE.Vector3(Math.cos(angle) * spread, 0.45, Math.sin(angle) * spread)).normalize();
      fork(b, d, length * lerp(0.55, 0.76, hash2(id * 3 + k, seed)), radius * 0.50, depth - 1, id * 3 + k + 1);
    }
  }
  const height = shrub ? 0.62 : 2.8 + variant * 0.28;
  fork(new THREE.Vector3(), new THREE.Vector3(0.05 * (variant - 1), 1, 0.06).normalize(), height, shrub ? 0.05 : 0.24, shrub ? 2 : 3, 1);
  // 낮은 가지를 별도로 두어 하나의 부채꼴이 아닌 비대칭 수관을 만든다.
  for (let k = 0; k < (shrub ? 5 : 4); k++) {
    const angle = k * 2.4 + seed;
    const origin = new THREE.Vector3(0, shrub ? 0.08 : 1.3 + k * 0.48, 0);
    fork(origin, new THREE.Vector3(Math.cos(angle) * 0.8, 0.65, Math.sin(angle) * 0.8).normalize(), shrub ? 0.58 : 1.65, shrub ? 0.026 : 0.075, shrub ? 1 : 2, 101 + k);
  }
  if (!shrub) for (let k = 0; k < 5; k++) {
    const az = seed + k * 1.256;
    branchPart(parts, new THREE.Vector3(0, .30, 0), new THREE.Vector3(Math.cos(az) * .45, .035, Math.sin(az) * .45), .07, .012, bark.map(v => v * .8));
  }
  if (shrub && season === 'winter') snowLobe(parts, 0, 0.09, 0, 0.63, 0.16, 0.53, [0.82, 0.88, 0.94]);
  return mergePlantParts(parts);
}
function buildConiferGeo(variant) {
  const parts = [], bark = [0.22, 0.25, 0.26];
  branchPart(parts, new THREE.Vector3(), new THREE.Vector3(0, 6.4, 0), 0.18, 0.025, bark);
  for (let tier = 0; tier < 6; tier++) {
    const y = 1.15 + tier * 0.86, reach = (2.0 - tier * 0.28) * (variant ? 0.88 : 1);
    for (let k = 0; k < 5; k++) {
      const az = k * Math.PI * 2 / 5 + tier * 0.66 + variant * 1.7;
      const length = reach * lerp(0.8, 1.08, hash2(tier * 5 + k, variant + 44));
      const end = new THREE.Vector3(Math.cos(az) * length, y - 0.27, Math.sin(az) * length);
      branchPart(parts, new THREE.Vector3(0, y, 0), end, 0.045, 0.011, bark);
      // 원뿔 덩어리 대신 가지마다 침엽과 눈 덩어리를 따로 얹는다.
      for (const f of [0.38, 0.67, 0.91]) {
        const x = end.x * f, z = end.z * f;
        const shade = 0.78 + hash2(k + tier * 11 + f, variant + 4) * 0.32;
        snowLobe(parts, x, y - f * 0.30, z, length * 0.26, 0.16 + (1-f)*.16, 0.25, SEASONS[season].pine.map(v=>v*shade), -az);
        for (const side of [-1, 1]) {
          const tip = new THREE.Vector3(x - Math.sin(az)*side*.33, y-f*.30-.12, z + Math.cos(az)*side*.33);
          branchPart(parts, new THREE.Vector3(x,y-f*.2,z),tip,.015,.006,bark);
          snowLobe(parts,tip.x,tip.y,tip.z,.27,.12,.18,SEASONS[season].pine.map(v=>v*shade*.85),-az);
        }
        if (season === 'winter') snowLobe(parts, x, y + 0.08 - f * 0.30, z, length * 0.23, 0.10, 0.22, [0.80, 0.87, 0.93], -az);
      }
    }
  }
  snowLobe(parts, 0, 6.18, 0, 0.23, 0.48, 0.24, season === 'winter' ? [0.80, 0.87, 0.94] : SEASONS[season].pine);
  return mergePlantParts(parts);
}
function buildSnowRockGeo() {
  const parts = [];
  snowLobe(parts, 0, 0.26, 0, 0.85, 0.55, 0.65, [0.35, 0.41, 0.46]);
  if (season === 'winter') snowLobe(parts, -0.06, 0.56, 0.02, 0.78, 0.28, 0.61, [0.78, 0.85, 0.92]);
  return mergePlantParts(parts);
}
// 독자적인 절차적 야자수: 휘어진 마디 줄기와 아래로 늘어진 리본 잎.
function buildPalmGeo() {
  const parts = [], bark = [0.36,0.25,0.14];
  const point = t => new THREE.Vector3(0.65*t*t, 6.8*t, 0.18*Math.sin(t*2));
  for (let k=0;k<9;k++) branchPart(parts,point(k/9),point((k+1)/9),0.21-k*0.012,0.20-k*0.012,bark);
  const crown=point(1);
  if (season === 'winter') return mergePlantParts(parts);
  for(let leaf=0;leaf<9;leaf++) {
    const az=leaf*Math.PI*2/9, positions=[], indices=[];
    for(let k=0;k<=8;k++) {
      const t=k/8, reach=3.1*t, y=crown.y+Math.sin(t*Math.PI)*0.85-t*t*1.0;
      const width=Math.sin(Math.PI*t)*0.36+0.012;
      for(const side of [-1,1])positions.push(crown.x+Math.cos(az)*reach-Math.sin(az)*width*side,y,crown.z+Math.sin(az)*reach+Math.cos(az)*width*side);
      if(k<8){const i=k*2;indices.push(i,i+2,i+1,i+1,i+2,i+3);}
    }
    const geo=new THREE.BufferGeometry();geo.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
    geo.setAttribute('uv',new THREE.Float32BufferAttribute(new Float32Array(positions.length/3*2),2));
    // 양면을 지오메트리로 만들어 기존 나무 재질·계절 페이드와 동일하게 처리한다.
    geo.setIndex(indices);geo.computeVertexNormals();
    geo.setIndex([...indices,...indices.slice().reverse()]);
    colorize(geo,0.09+leaf%3*0.025,0.31+leaf%3*0.035,0.13);parts.push(geo);
  }
  return mergePlantParts(parts);
}
// 야간 외벽 4종. 0 주거(따뜻한 창), 1 오피스(차가운 유리), 2 간판·옥상 색등, 3 흰 격자 첨탑.
function buildFacadeTextures(style) {
  const W = 128, H = 192;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const ecv = document.createElement('canvas'); ecv.width = W; ecv.height = H;
  const eg = ecv.getContext('2d');
  g.fillStyle = ['#c8c2b4', '#8ea6ba', '#5c636e', '#c5ced6'][style];
  g.fillRect(0, 0, W, H);
  eg.fillStyle = '#000'; eg.fillRect(0, 0, W, H);
  const cols = [6, 8, 5, 4][style], rows = [10, 14, 9, 16][style];
  const cw = W / cols, ch = H / rows;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = c * cw, y = r * ch;
    const padX = cw * [0.14, 0.16, 0.18, 0.18][style], padY = ch * [0.18, 0.2, 0.2, 0.16][style];
    const band = style === 2 && r % 4 === 1;
    const lattice = style === 3 && ((r + c) % 3 === 0 || r > rows - 4);
    const lit = band || lattice || Math.random() < [0.78, 0.88, 0.64, 0.8][style];
    g.fillStyle = lit ? (style === 1 ? '#24343f' : '#2c3036') : '#3e434a';
    g.fillRect(x + padX, y + padY, cw - padX * 2, ch - padY * 2);
    if (!lit) continue;
    let col;
    if (band) col = `hsl(${[330, 188, 28, 128][r % 4]},85%,58%)`;
    else if (style === 3 && r > rows - 4) col = `hsl(42,28%,${82 + Math.random() * 14}%)`;
    else if (style === 3) col = `hsl(206,18%,${74 + Math.random() * 18}%)`;
    else if (style === 1) col = `hsl(${198 + Math.random() * 16},40%,${64 + Math.random() * 22}%)`;
    else if (Math.random() < 0.14) col = `hsl(202,50%,${56 + Math.random() * 22}%)`;
    else col = `hsl(${28 + Math.random() * 20},80%,${48 + Math.random() * 26}%)`;
    eg.fillStyle = col;
    eg.fillRect(x + padX, y + padY, cw - padX * 2, ch - padY * 2);
  }
  eg.fillStyle = ['#e8b15a', '#e7f7ff', '#7dffe0', '#fff6d8'][style];
  eg.fillRect(0, 0, W, H * 0.04);
  const map = new THREE.CanvasTexture(cv);
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set([4, 5, 3, 2][style], [7, 9, 6, 8][style]);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const emissiveMap = new THREE.CanvasTexture(ecv);
  emissiveMap.wrapS = emissiveMap.wrapT = THREE.RepeatWrapping;
  emissiveMap.repeat.copy(map.repeat);
  emissiveMap.colorSpace = THREE.SRGBColorSpace;
  return { map, emissiveMap };
}
const buildingMats = [0, 1, 2, 3].map(style => {
  const tex = buildFacadeTextures(style);
  return new THREE.MeshStandardMaterial({
    vertexColors: true, map: tex.map, emissiveMap: tex.emissiveMap,
    emissive: 0xffffff, emissiveIntensity: 0,
    roughness: style === 1 ? 0.42 : 0.82, metalness: style === 1 ? 0.18 : 0.04, envMapIntensity: 0.2
  });
});
const spireMat = buildingMats[3].clone();
// 도시 건물: 단순 박스 벽 + 얇은 지붕 캡. 인스턴스 컬러가 전체에 곱해져 지붕은 벽보다 자동으로 어두워짐.
function buildBoxBuildingGeo() {
  const wall = new THREE.BoxGeometry(1, 1, 1); wall.translate(0, 0.5, 0);
  colorize(wall, 1, 1, 1);
  const roof = new THREE.BoxGeometry(1.08, 0.05, 1.08); roof.translate(0, 1.025, 0);
  colorize(roof, 0.60, 0.62, 0.66);
  return mergeGeometries([wall, roof]);
}
function buildTowerBuildingGeo() {
  const base = new THREE.BoxGeometry(1, 0.62, 1); base.translate(0, 0.31, 0);
  colorize(base, 1, 1, 1);
  const upper = new THREE.BoxGeometry(0.62, 0.38, 0.62); upper.translate(0, 0.81, 0);
  colorize(upper, 1, 1, 1);
  const roof = new THREE.BoxGeometry(0.67, 0.05, 0.67); roof.translate(0, 1.025, 0);
  colorize(roof, 0.60, 0.62, 0.66);
  return mergeGeometries([base, upper, roof]);
}
// 저층 슬래브형 아파트: 가로로 넓고 납작한 블록 — 박스/타워와는 다른 실루엣으로 스카이라인에 리듬을 준다.
function buildSlabBuildingGeo() {
  const wall = new THREE.BoxGeometry(1.6, 0.45, 1); wall.translate(0, 0.225, 0);
  colorize(wall, 1, 1, 1);
  const roof = new THREE.BoxGeometry(1.68, 0.04, 1.08); roof.translate(0, 0.47, 0);
  colorize(roof, 0.56, 0.58, 0.62);
  return mergeGeometries([wall, roof]);
}
function buildSpireBuildingGeo() {
  const parts = [];
  const add = (w, h, d, y, rotY = 0) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    if (rotY) geo.rotateY(rotY);
    geo.translate(0, y, 0);
    colorize(geo, 1, 1, 1);
    parts.push(geo);
  };
  add(0.72, 0.14, 0.72, 0.07);
  add(0.34, 0.5, 0.34, 0.39);
  add(0.2, 0.16, 0.2, 0.72);
  add(0.09, 0.2, 0.09, 0.9);
  add(0.035, 0.3, 0.52, 0.68, Math.PI / 4);
  add(0.035, 0.3, 0.52, 0.68, -Math.PI / 4);
  return mergeGeometries(parts);
}
const plantGeometries = [buildBareGeo(0), buildBareGeo(1), buildBareGeo(2), buildConiferGeo(0), buildConiferGeo(1), buildBareGeo(0, true), buildBareGeo(1, true), buildSnowRockGeo(), buildPalmGeo()];
const buildingGeos = [buildBoxBuildingGeo(), buildTowerBuildingGeo(), buildSlabBuildingGeo()];
// 가드레일: 회색 레일 + 위에 얹은 눈층을 하나로 합침
function buildRailBandGeo() {
  const rail = new THREE.BoxGeometry(0.12, 0.28, 2.3); rail.translate(0, 0.55, 0);
  colorize(rail, 0.48, 0.51, 0.56);
  const snow = new THREE.BoxGeometry(0.15, 0.07, 2.3); snow.translate(0, 0.715, 0);
  colorize(snow, 0.94, 0.96, 1.0);
  if (season !== 'winter') { snow.dispose(); return rail; }
  return mergeGeometries([rail, snow]);
}
const railBandGeo = buildRailBandGeo();
const railPostGeo = new THREE.BoxGeometry(0.12, 0.75, 0.12);
railPostGeo.translate(0, 0.375, 0);
// 시선유도봉: 흰 기둥 + 붉은 상단 띠
function buildReflectorGeo() {
  const post = new THREE.BoxGeometry(0.09, 0.85, 0.09); post.translate(0, 0.425, 0);
  colorize(post, 0.93, 0.94, 0.96);
  const band = new THREE.BoxGeometry(0.105, 0.15, 0.105); band.translate(0, 0.70, 0);
  colorize(band, 0.82, 0.12, 0.10);
  return mergeGeometries([post, band]);
}
const reflGeo = buildReflectorGeo();
// 다리 교각: 상판 바로 아래 캡 빔(넓음) + 강바닥까지 뻗는 기둥(좁음). 단면은 높이와 무관하게 일정.
function buildPierGeo() {
  const cap = new THREE.BoxGeometry(1.5, 0.12, 1.2); cap.translate(0, -0.06, 0);
  colorize(cap, 0.50, 0.50, 0.53);
  const shaft = new THREE.BoxGeometry(0.72, 0.88, 0.56); shaft.translate(0, -0.56, 0);
  colorize(shaft, 0.58, 0.58, 0.60);
  return mergeGeometries([cap, shaft]);
}
const pierGeo = buildPierGeo();
const pierMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
// 가로등: 기둥+팔 (비발광) + 등 머리(야간 nightF로 발광, 도시·다리 구간에 배치)
function buildLampPoleGeo() {
  const pole = new THREE.BoxGeometry(0.1, 3.4, 0.1); pole.translate(0, 1.7, 0);
  const arm = new THREE.BoxGeometry(0.55, 0.08, 0.08); arm.translate(0.3, 3.4, 0);
  colorize(pole, 0.22, 0.23, 0.25); colorize(arm, 0.22, 0.23, 0.25);
  return mergeGeometries([pole, arm]);
}
const lampPoleGeo = buildLampPoleGeo();
const lampPoleMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
const lampHeadGeo = new THREE.BoxGeometry(0.22, 0.14, 0.22);
lampHeadGeo.translate(0.56, 3.33, 0);
const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1d2, emissive: 0xffc56b, emissiveIntensity: 0, roughness: 0.35 });
const lampGlowGeo = new THREE.SphereGeometry(0.42, 8, 6);
lampGlowGeo.translate(0.56, 3.33, 0);
const lampGlowMat = new THREE.MeshBasicMaterial({
  color: 0xffc27a, transparent: true, opacity: 0, depthWrite: false,
  blending: THREE.AdditiveBlending, toneMapped: false
});
// 타워 꼭대기 항공등: 적색이 기본, 일부는 남산타워처럼 녹색
const beaconGeo = new THREE.SphereGeometry(0.16, 8, 6);
const beaconMat = new THREE.MeshStandardMaterial({ color: 0x4a0804, emissive: 0xff2200, emissiveIntensity: 0.4, roughness: 0.5 });
const beaconGreenMat = new THREE.MeshStandardMaterial({ color: 0x0c3a18, emissive: 0x3dff7a, emissiveIntensity: 0.25, roughness: 0.5 });

/* ---------------- InstancedMesh 풀 ---------------- */
const TREE_CAP = 720, RAIL_CAP = 300, POST_CAP = 150, REFL_CAP = 90, PIER_CAP = 36, LAMP_CAP = 120, BEACON_CAP = 40;
function makeInst(geo, mat, cap) {
  const m = new THREE.InstancedMesh(geo, mat, cap);
  m.frustumCulled = false;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = true;
  scene.add(m);
  return m;
}
const plantPools = plantGeometries.map((geo, kind) => {
  const mesh = makeInst(geo, trunkMat, kind < 5 ? 200 : kind < 7 ? 300 : 100);
  mesh.count = 0; mesh.receiveShadow = true;
  return mesh;
});
const buildingCaps = [56, 40, 40];
const buildingMeshes = buildingGeos.map((geo, ki) => buildingMats.map(mat => {
  const mesh = makeInst(geo, mat, buildingCaps[ki]);
  mesh.count = 0; mesh.receiveShadow = true;
  return mesh;
}));
const spireMesh = makeInst(buildSpireBuildingGeo(), spireMat, 8);
spireMesh.count = 0; spireMesh.receiveShadow = true;
const bandMesh = makeInst(railBandGeo, railMat, RAIL_CAP);
const postMesh = makeInst(railPostGeo, railMat, POST_CAP);
const reflMesh = makeInst(reflGeo, reflMat, REFL_CAP);
const pierMesh = makeInst(pierGeo, pierMat, PIER_CAP);
pierMesh.receiveShadow = true;
const lampPoleMesh = makeInst(lampPoleGeo, lampPoleMat, LAMP_CAP);
const lampHeadMesh = makeInst(lampHeadGeo, lampMat, LAMP_CAP);
const lampGlowMesh = makeInst(lampGlowGeo, lampGlowMat, LAMP_CAP);
lampGlowMesh.castShadow = false; lampGlowMesh.receiveShadow = false;
const beaconMesh = makeInst(beaconGeo, beaconMat, BEACON_CAP);
const beaconGreenMesh = makeInst(beaconGeo, beaconGreenMat, BEACON_CAP);

const UP = new THREE.Vector3(0, 1, 0);
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(1, 1, 1), _c = new THREE.Color();
const activeTrees = []; // 충돌 판정용
let dirtyPools = true;

function buildingTint(style, tint) {
  const v1 = (tint * 7) % 1, v2 = (tint * 13) % 1;
  if (style === 1) _c.setHSL(lerp(0.55, 0.62, v1), lerp(0.28, 0.48, v2), lerp(0.46, 0.62, v1));
  else if (style === 2) _c.setHSL(0, 0, lerp(0.28, 0.42, v1));
  else if (style === 3) _c.setHSL(0.58, 0.08, lerp(0.72, 0.86, v1));
  else _c.setHSL(0.08 + v1 * 0.04, lerp(0.08, 0.18, v2), lerp(0.74, 0.9, v1));
}
function rebuildPools() {
  let nT = 0, nB = 0, nP = 0, nR = 0, nPier = 0, nLamp = 0, nBeacon = 0, nBeaconG = 0, nSpire = 0;
  const plantCounts = plantPools.map(() => 0);
  const buildingCounts = buildingMeshes.map(row => row.map(() => 0));
  activeTrees.length = 0;
  // 풀이 가득 차도 차량 근처의 군집을 우선해 눈앞의 식생이 사라지지 않게 한다.
  const ordered = Array.from(segments.entries()).sort((a, b) => Math.abs(a[0] * SEG - car.s) - Math.abs(b[0] * SEG - car.s));
  for (const [, seg] of ordered) {
    for (const t of seg.trees) {
      _q.setFromAxisAngle(UP, t.rot);
      _p.set(t.x, t.y, t.z); _s.set(t.s * t.width, t.s, t.s * t.width);
      _m4.compose(_p, _q, _s);
      if (t.kind === 12) {
        if (nSpire >= spireMesh.instanceMatrix.count) continue;
        spireMesh.setMatrixAt(nSpire, _m4);
        _c.setRGB(0.9, 0.93, 0.96);
        spireMesh.setColorAt(nSpire, _c);
        nSpire++;
        continue;
      }
      if (t.kind >= 9) {
        const bi = t.kind - 9, style = t.lite % 4;
        const pool = buildingMeshes[bi][style], index = buildingCounts[bi][style];
        if (index >= pool.instanceMatrix.count) continue;
        pool.setMatrixAt(index, _m4);
        buildingTint(style, t.tint);
        pool.setColorAt(index, _c);
        buildingCounts[bi][style]++;
        continue;
      }
      const pool = plantPools[t.kind], index = plantCounts[t.kind];
      if (index >= pool.instanceMatrix.count || (t.kind < 5 && nT >= TREE_CAP)) continue;
      pool.setMatrixAt(index, _m4);
      _c.setRGB(0.92 + t.tint * 0.08, 0.95 + t.tint * 0.05, 1);
      pool.setColorAt(index, _c);
      plantCounts[t.kind]++;
      if (t.kind < 5) {
        activeTrees.push({ x: t.x, z: t.z, r: 0.30 * t.s });
        nT++;
      }
    }
    for (const b of seg.bands) {
      if (nB >= RAIL_CAP) break;
      _q.setFromAxisAngle(UP, b.rot);
      _p.set(b.x, b.y, b.z); _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      bandMesh.setMatrixAt(nB, _m4); nB++;
    }
    for (const p of seg.posts) {
      if (nP >= POST_CAP) break;
      _q.identity();
      _p.set(p.x, p.y, p.z); _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      postMesh.setMatrixAt(nP, _m4); nP++;
    }
    for (const rf of seg.refls) {
      if (nR >= REFL_CAP) break;
      _q.setFromAxisAngle(UP, rf.rot);
      _p.set(rf.x, rf.y, rf.z); _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      reflMesh.setMatrixAt(nR, _m4); nR++;
    }
    for (const p of seg.piers) {
      if (nPier >= PIER_CAP) break;
      _q.identity();
      _p.set(p.x, p.y, p.z); _s.set(1, p.height, 1);
      _m4.compose(_p, _q, _s);
      pierMesh.setMatrixAt(nPier, _m4); nPier++;
    }
    for (const l of seg.lamps) {
      if (nLamp >= LAMP_CAP) break;
      _q.setFromAxisAngle(UP, l.rot);
      _p.set(l.x, l.y, l.z); _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      lampPoleMesh.setMatrixAt(nLamp, _m4);
      lampHeadMesh.setMatrixAt(nLamp, _m4);
      nLamp++;
    }
    for (const bc of seg.beacons) {
      const mesh = bc.green ? beaconGreenMesh : beaconMesh;
      const n = bc.green ? nBeaconG : nBeacon;
      if (n >= mesh.instanceMatrix.count) continue;
      _q.identity();
      _p.set(bc.x, bc.y, bc.z); _s.set(1, 1, 1);
      _m4.compose(_p, _q, _s);
      mesh.setMatrixAt(n, _m4);
      if (bc.green) nBeaconG++; else nBeacon++;
    }
  }
  plantPools.forEach((pool, kind) => {
    pool.count = plantCounts[kind]; pool.instanceMatrix.needsUpdate = true;
    if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
  });
  bandMesh.count = nB; postMesh.count = nP; reflMesh.count = nR; pierMesh.count = nPier;
  lampPoleMesh.count = nLamp; lampHeadMesh.count = nLamp; lampGlowMesh.count = 0;
  beaconMesh.count = nBeacon; beaconGreenMesh.count = nBeaconG; spireMesh.count = nSpire;
  buildingMeshes.forEach((row, bi) => row.forEach((pool, style) => {
    pool.count = buildingCounts[bi][style];
    pool.instanceMatrix.needsUpdate = true;
    if (pool.instanceColor) pool.instanceColor.needsUpdate = true;
  }));
  bandMesh.instanceMatrix.needsUpdate = true;
  postMesh.instanceMatrix.needsUpdate = true;
  reflMesh.instanceMatrix.needsUpdate = true;
  pierMesh.instanceMatrix.needsUpdate = true;
  lampPoleMesh.instanceMatrix.needsUpdate = true;
  lampHeadMesh.instanceMatrix.needsUpdate = true;
  lampGlowMesh.instanceMatrix.needsUpdate = true;
  beaconMesh.instanceMatrix.needsUpdate = true;
  beaconGreenMesh.instanceMatrix.needsUpdate = true;
  spireMesh.instanceMatrix.needsUpdate = true;
  if (spireMesh.instanceColor) spireMesh.instanceColor.needsUpdate = true;
}

/* ---------------- 세그먼트 추가/제거 ---------------- */
const segments = new Map(); // index → 세그먼트 데이터
function placeScenery(seg, s, lat, kind, id) {
  const r = sampleAt(s), x = r.x + r.rx * lat, z = r.z + r.rz * lat;
  // 굽은 도로의 다른 부분도 확인한다. 가지·눈 덩어리까지 도로 밖에 남긴다.
  const isBuilding = kind >= 9;
  // 건물은 scale/width를 작은 배율이 아니라 "실제 미터" 단위로 써서 높이·바닥면적을 직접 지정한다.
  // kind 11(슬래브)은 로컬 지오메트리 자체가 가로로 넓어(1.6:1) footprintM은 세로(Z) 기준이다.
  const footprintM = !isBuilding ? 0 : kind === 12 ? lerp(9, 12, hash2(id, 119))
    : lerp(kind === 11 ? 9 : 7, kind === 11 ? 15 : 16, hash2(id, 119));
  const scale = kind === 12 ? lerp(52, 74, hash2(id, 113))
    : isBuilding ? (kind === 9 ? lerp(8, 20, hash2(id, 113)) : kind === 10 ? lerp(16, 36, hash2(id, 113)) : lerp(12, 22, hash2(id, 113)))
    : kind < 3 ? lerp(0.95, 1.65, hash2(id, 111))
    : kind < 5 ? lerp(0.8, 1.45, hash2(id, 113))
    : kind < 7 ? lerp(0.65, 1.3, hash2(id, 115)) : lerp(0.55, 1.1, hash2(id, 117));
  const width = isBuilding ? footprintM / scale : lerp(0.82, 1.18, hash2(id, 119));
  const crown = kind === 12 ? 8 : isBuilding ? footprintM * (kind === 11 ? 1.6 : 1) * 0.6 + 5.6
    : (kind === 8 ? 3.2 : kind < 3 ? 3.4 : kind < 5 ? 2.4 : 1.1) * scale * width;
  for (let j = Math.max(0, Math.floor(s - baseS - 140)); j < Math.min(roadSamples.length, s - baseS + 140); j += 3) {
    const p = roadSamples[j];
    if (Math.hypot(x - p.x, z - p.z) < 5.6 + crown) return;
  }
  const y = groundY(s, lat);
  const slope = Math.max(Math.abs(groundY(s + 1, lat) - groundY(s - 1, lat)), Math.abs(groundY(s, lat + 1) - groundY(s, lat - 1))) / 2;
  if (y < -21 || slope > 0.95) return;
  // 렌더링된 지형 삼각형에 뿌리를 맞춰 언덕 위에서 나무가 뜨지 않게 한다.
  const rowS = Math.floor(s / 6) * 6, f = (s - rowS) / 6;
  const column = Math.max(0, TCOLS.findIndex(v => v > lat) - 1);
  const a = TCOLS[column], b = TCOLS[column + 1], u = (lat - a) / (b - a);
  const h00 = groundY(rowS, a), h10 = groundY(rowS, b), h01 = groundY(rowS + 6, a), h11 = groundY(rowS + 6, b);
  const meshY = u + f <= 1 ? h00 + u * (h10 - h00) + f * (h01 - h00)
    : h11 + (1 - u) * (h01 - h11) + (1 - f) * (h10 - h11);
  seg.trees.push({ x, z, y: meshY - 0.08, s: scale, width, kind,
    rot: hash2(id, 121) * Math.PI * 2, tint: hash2(id, 123),
    lite: kind === 12 ? 3 : Math.floor(hash2(id, 307) * 4) % 4 });
  if (kind === 10 || kind === 12) seg.beacons.push({
    x, y: meshY - 0.08 + scale, z, green: kind === 10 && hash2(id, 333) < 0.28
  });
}
function addSegment(i) {
  const s0 = i * SEG, s1 = s0 + SEG;
  const seg = { trees: [], bands: [], posts: [], refls: [], piers: [], beacons: [], lamps: [] };

  const roadMesh = new THREE.Mesh(buildRoadGeo(s0, s1), roadMat);
  roadMesh.receiveShadow = true;
  scene.add(roadMesh);
  seg.roadMesh = roadMesh;

  const terMesh = new THREE.Mesh(buildTerrainGeo(s0), terrainMat);
  terMesh.receiveShadow = true;
  scene.add(terMesh);
  seg.terMesh = terMesh;

  // 0~900m: 가까운 앙상한 나무 → 중경 침엽수 군집 → 열린 설원으로 리듬을 만든다.
  // 격자 간격은 후보 생성용일 뿐, 실제 좌표는 군집 중심에 독립적으로 흩어진다.
  for (const side of [-1, 1]) {
    if (cityAmount(s0) > 0.5) continue; // 도시 구간에는 유기적 식생 군집을 생성하지 않는다
    const patch = vnoise(s0 * 0.018 + WORLD_SEED % 97, side * 17.3);
    const clusterLat = side * lerp(14, 55, hash2(i + WORLD_SEED, side * 29));
    const meadow = Math.pow(0.5 + 0.5 * Math.sin(s0 * 0.017 + side * 1.8), 4);
    const count = Math.round(lerp(4, 11, patch) * (1 - meadow * 0.55));
    for (let k = 0; k < count; k++) {
      const id = i * 43 + k + WORLD_SEED % 1009;
      const s = s0 + 1 + hash2(id, side * 7) * (SEG - 2);
      const lat = side * clamp(Math.abs(clusterLat) + (hash2(id, side * 11) - 0.5) * 25, 10, 74);
      const pick = hash2(id, side * 19);
      const kind = pick < lerp(0.28, 0.62, scenicBlend(s)) ? Math.floor(hash2(id, 57) * 3) : 3 + Math.floor(hash2(id, 73) * 2);
      // 열린 수면과 모래를 가리지 않는다. 내륙의 기존 활엽수 군집은 유지한다.
      if (side === coastSide(s) && coastAmount(s) > 0.8) continue;
      placeScenery(seg, s, lat, kind, id);
    }
    // 나무 군집 주변과 도로변의 낮은 잔가지. 넓은 눈밭은 과밀하게 채우지 않는다.
    for (let k = 0; k < 11; k++) {
      const id = i * 59 + k + WORLD_SEED % 1013;
      const s = s0 + 0.5 + hash2(id, side * 31) * (SEG - 1);
      const lat = side * lerp(7.5, 47, Math.pow(hash2(id, side * 37), 1.7));
      if (hash2(id, 91) > 0.48 + patch * 0.3) continue;
      placeScenery(seg, s, lat, 5 + Math.floor(hash2(id, 53) * 2), id);
    }
    if (hash2(i + WORLD_SEED, side * 83) < 0.35) {
      placeScenery(seg, s0 + 5 + hash2(i, side * 41) * 13, side * lerp(8, 28, hash2(i, side * 43)), 7, i + 777);
    }
  }

  // 해안의 마른 어깨에만 작은 야자수 군집. 계절 공통 배치로 전환 중 위치가 바뀌지 않는다.
  if (coastAmount(s0) > 0.8 && Math.floor(i / 3) % 4 === 1) {
    for(let k=0;k<2;k++) {
      const s=s0+5+k*11, id=i*71+k+WORLD_SEED;
      placeScenery(seg,s,coastSide(s)*(12.2+hash2(id,151)*2.2),8,id);
    }
  }

  // 도시 구간: 길가는 아파트·슬래브, 뒤쪽은 높은 타워. 구역 한가운데에 흰 격자 첨탑 하나.
  if (cityAmount(s0) > 0.5) {
    const zone = zoneAt(s0 + 8);
    if (zone && zone.type === 'city') {
      const mid = (zone.s0 + zone.s1) * 0.5;
      if (mid >= s0 && mid < s1) {
        const side = hash2(Math.floor(zone.s0), 19) < 0.5 ? -1 : 1;
        placeScenery(seg, mid, side * 36, 12, Math.floor(zone.s0) + 17);
      }
    }
    for (const side of [-1, 1]) {
      for (let row = 0; row < 3; row++) {
        const rowLat = 9 + row * 12;
        for (let s = s0 + 2; s < s1; s += 13) {
          const id = i * 97 + side * 131 + row * 13 + Math.floor(s) + WORLD_SEED % 2017;
          const jitterLat = (hash2(id, 211) - 0.5) * 4;
          const jitterS = (hash2(id, 223) - 0.5) * 4;
          const pick = hash2(id, 227);
          const kind = row === 0 ? (pick < 0.58 ? 11 : 9)
            : row === 1 ? (pick < 0.42 ? 9 : pick < 0.74 ? 11 : 10)
            : (pick < 0.32 ? 9 : 10);
          placeScenery(seg, s + jitterS, side * (rowLat + jitterLat), kind, id);
        }
      }
    }
  }

  // 강 구간: 다리 상판 아래 교각(장식용, 차량과 충돌하지 않음)
  for (let s = s0; s < s1; s += 10) {
    if (riverAmount(s) < 0.5) continue;
    const r = sampleAt(s), deckY = r.y - 0.06, bedY = Math.min(SEA_LEVEL - RIVER_DEPTH, r.y - 8);
    for (const side of [-1, 1]) {
      const lat = side * 3.6;
      seg.piers.push({ x: r.x + r.rx * lat, y: deckY, z: r.z + r.rz * lat, height: deckY - bedY });
    }
  }

  // 가로등: 다리는 14m, 도시는 한 칸 걸러 두어 강변 반영이 더 촘촘하다.
  for (let s = s0 + 6; s < s1; s += 14) {
    const city = cityAmount(s), river = riverAmount(s);
    if (city < 0.5 && river < 0.5) continue;
    if (city >= 0.5 && Math.floor(s / 14) % 2 === 1) continue;
    const r = sampleAt(s), lat0 = city >= 0.5 ? 7.4 : 5.6;
    for (const side of [-1, 1]) {
      const lat = side * lat0;
      // 다리 구간은 교각처럼 상판 높이에 세우고(강바닥이 아니라), 도시는 평탄화된 거리 높이 그대로 사용
      seg.lamps.push({ x: r.x + r.rx * lat, y: r.y - 0.06, z: r.z + r.rz * lat, rot: side > 0 ? r.h + Math.PI : r.h });
    }
  }

  // 가드레일(우측, 구간별 · 도시에서는 생략, 다리 구간은 강제 표시)
  for (let s = s0; s < s1; s += 2) {
    if (cityAmount(s) > 0.5) continue;
    if (!railActive(s) && riverAmount(s) < 0.5) continue;
    const r = sampleAt(s), lat = 4.75;
    const x = r.x + r.rx * lat, z = r.z + r.rz * lat;
    const y = r.y - 0.06;
    seg.bands.push({ x, y, z, rot: r.h });
    if (Math.floor(s / 2) % 2 === 0) seg.posts.push({ x, y: y - 0.02, z });
  }

  // 시선유도봉(커브 바깥쪽)
  for (let s = s0 + 4; s < s1; s += 8) {
    if (cityAmount(s) > 0.5) continue;
    const curv = (headingAt(s + 2) - headingAt(s - 2)) / 4;
    if (Math.abs(curv) < 0.0045 || railActive(s)) continue;
    const side = curv > 0 ? 1 : -1;
    const r = sampleAt(s), lat = side * 4.55;
    seg.refls.push({ x: r.x + r.rx * lat, y: groundY(s, lat) - 0.03, z: r.z + r.rz * lat, rot: Math.PI - r.h });
  }

  segments.set(i, seg);
}
function removeSegment(seg) {
  scene.remove(seg.roadMesh); seg.roadMesh.geometry.dispose();
  scene.remove(seg.terMesh); seg.terMesh.geometry.dispose();
}
function ensureSegments() {
  const ahead = Math.ceil((car.s + 500) / SEG);
  const behind = Math.floor((car.s - 90) / SEG);
  genTo(ahead * SEG + 60);
  let changed = false;
  for (let i = Math.max(0, behind); i <= ahead; i++) {
    if (!segments.has(i)) { addSegment(i); changed = true; }
  }
  for (const [i, seg] of Array.from(segments)) {
    if (i < behind || i > ahead) { removeSegment(seg); segments.delete(i); changed = true; }
  }
  if (!mapPreview) while (baseS < car.s - 170) { roadSamples.shift(); baseS++; } // 미리보기 중에는 8km를 앞뒤로 보게 샘플을 남긴다
  if (changed) rebuildPools();
}

/* ---------------- 차량: 흰색 세단 ---------------- */
const carGroup = new THREE.Group();
carGroup.rotation.order = 'YXZ';
const bodyGroup = new THREE.Group(); // 서스펜션 자세(롤/피치)용
carGroup.add(bodyGroup);
const procBody = new THREE.Group();  // 프로시저럴 차체(GLB 모델 로드 시 숨김)
bodyGroup.add(procBody);
// 시점 앵커 + 실내 소품 (GLB/폴백 공통)
const camDash = new THREE.Object3D(); camDash.position.set(-0.36, 1.18, -0.05); bodyGroup.add(camDash);
const camHood = new THREE.Object3D(); camHood.position.set(0, 1.12, -1.5); bodyGroup.add(camHood);
const dashMat = new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.85, metalness: 0.05 });
const dash = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.3, 0.42), dashMat);
dash.position.set(0, 0.82, -0.72); bodyGroup.add(dash);
const steer = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.025, 10, 28), new THREE.MeshStandardMaterial({ color: 0x191c20, roughness: 0.7 }));
steer.position.set(-0.36, 0.71, -0.38); steer.rotation.x = -0.28; bodyGroup.add(steer);
// 실시간 계기판 (CanvasTexture — 실차 클러스터 스타일)
const clCanvas = document.createElement('canvas'); clCanvas.width = 1024; clCanvas.height = 512;
const clCtx = clCanvas.getContext('2d');
const clTex = new THREE.CanvasTexture(clCanvas); clTex.colorSpace = THREE.SRGBColorSpace;
const cluster = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.28), new THREE.MeshBasicMaterial({ map: clTex, toneMapped: false }));
cluster.position.set(-0.36, 1.01, -0.49); cluster.rotation.x = -0.14; cluster.visible = false;
bodyGroup.add(cluster);
let lastClKey = '';
function drawGauge(cx, cy, r, val, max, unit, redFrom) {
  const x = clCtx, a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.lineWidth = 4; x.strokeStyle = 'rgba(110,168,255,0.22)'; x.stroke();
  x.beginPath(); x.arc(cx, cy, r, a0, a1); x.lineWidth = 10; x.strokeStyle = 'rgba(20,25,33,0.9)'; x.stroke();
  for (let i = 0; i <= 10; i++) {
    const a = a0 + (a1 - a0) * i / 10;
    const red = redFrom != null && i / 10 * max >= redFrom;
    x.strokeStyle = red ? '#ff453a' : 'rgba(223,231,242,0.85)';
    x.lineWidth = i % 2 ? 3 : 5;
    x.beginPath();
    x.moveTo(cx + Math.cos(a) * (r - 28), cy + Math.sin(a) * (r - 28));
    x.lineTo(cx + Math.cos(a) * (r - 8), cy + Math.sin(a) * (r - 8));
    x.stroke();
    if (i % 2 === 0) {
      x.fillStyle = 'rgba(223,231,242,0.7)'; x.font = '600 24px sans-serif'; x.textAlign = 'center';
      x.fillText(String(Math.round(i / 10 * max)), cx + Math.cos(a) * (r - 52), cy + Math.sin(a) * (r - 52) + 8);
    }
  }
  x.fillStyle = 'rgba(223,231,242,0.75)'; x.font = '600 24px sans-serif'; x.textAlign = 'center';
  x.fillText(unit, cx, cy + r * 0.45);
  const va = a0 + (a1 - a0) * Math.min(Math.max(val / max, 0), 1);
  x.strokeStyle = '#ff3b30'; x.lineWidth = 7; x.lineCap = 'round';
  x.beginPath(); x.moveTo(cx - Math.cos(va) * 18, cy - Math.sin(va) * 18);
  x.lineTo(cx + Math.cos(va) * (r - 36), cy + Math.sin(va) * (r - 36)); x.stroke();
  x.beginPath(); x.arc(cx, cy, 10, 0, Math.PI * 2); x.fillStyle = '#1c2129'; x.fill();
  x.lineWidth = 3; x.strokeStyle = 'rgba(110,168,255,0.5)'; x.stroke();
}
function drawCluster() {
  if (!cluster.visible) return;
  const kmh = Math.round(Math.hypot(car.vx, car.vz) * 3.6);
  const bands = [0, 16, 30, 46, 64, 90];
  let g = 1; while (g < 5 && kmh >= bands[g]) g++;
  const lo = bands[g - 1], hi = bands[g];
  const rpm = kmh > 0.5 ? 1000 + Math.min(1, (kmh - lo) / (hi - lo)) * 4600 : (key.w || key.s ? 1300 : 800);
  const hh = Math.floor(timeOfDay), mm = Math.floor((timeOfDay % 1) * 60);
  const stamp = kmh + '|' + Math.round(rpm / 50) + '|' + hh + ':' + mm + '|' + Math.round(car.dist);
  if (stamp === lastClKey) return;
  lastClKey = stamp;
  const x = clCtx;
  x.fillStyle = '#0a0d12'; x.fillRect(0, 0, 1024, 512);
  x.fillStyle = 'rgba(110,168,255,0.06)'; x.fillRect(408, 36, 208, 440);
  drawGauge(250, 290, 200, kmh, 220, 'km/h', null);
  drawGauge(774, 290, 200, rpm / 1000, 8, 'x1000 rpm', 6.5);
  x.textAlign = 'center';
  x.fillStyle = '#e8eef8'; x.font = '700 72px sans-serif'; x.fillText(String(kmh), 512, 226);
  x.font = '500 22px sans-serif'; x.fillStyle = 'rgba(232,238,248,0.6)'; x.fillText('km/h', 512, 258);
  x.font = '700 40px sans-serif'; x.fillStyle = '#9cc2ec'; x.fillText(kmh > 0.5 ? String(g) : 'P', 512, 336);
  x.font = '500 26px sans-serif'; x.fillStyle = 'rgba(232,238,248,0.7)';
  x.fillText((hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm, 512, 92);
  x.font = '400 20px sans-serif'; x.fillText('TRIP ' + (car.dist / 1000).toFixed(1) + ' km', 512, 428);
  clTex.needsUpdate = true;
}
scene.add(carGroup);

const paint = new THREE.MeshPhysicalMaterial({
  color: 0xf4f6f8, metalness: 0.12, roughness: 0.38,
  clearcoat: 0.9, clearcoatRoughness: 0.22, envMapIntensity: 1.0
});
const darkTrim = new THREE.MeshStandardMaterial({ color: 0x23282e, roughness: 0.55, metalness: 0.35 });
const glassMat = new THREE.MeshPhysicalMaterial({
  color: 0x24313f, metalness: 0.55, roughness: 0.08,
  transparent: true, opacity: 0.78, envMapIntensity: 1.4
});
const wheels = [];
let tailMat;

function buildCar() {
  // 차체: 세단 실루엣을 2D Shape 으로 그려 돌출(빔벨 포함) — 박스가 아닌 형태
  const bs = new THREE.Shape();
  bs.moveTo(-2.16, 0.32);
  bs.lineTo(-2.12, 0.56);
  bs.quadraticCurveTo(-1.80, 0.62, -1.25, 0.665);  // 후드
  bs.lineTo(1.30, 0.705);                           // 벨트라인
  bs.quadraticCurveTo(1.92, 0.70, 2.14, 0.60);      // 트렁크
  bs.lineTo(2.16, 0.32);
  bs.closePath();
  const bodyGeo = new THREE.ExtrudeGeometry(bs, { depth: 1.78, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, steps: 1 });
  bodyGeo.translate(0, 0, -0.89);
  bodyGeo.rotateY(-Math.PI / 2); // 앞부분이 -Z를 향하도록
  const bodyMesh = new THREE.Mesh(bodyGeo, paint);
  bodyMesh.castShadow = bodyMesh.receiveShadow = true;
  procBody.add(bodyMesh);

  // 캐빈(화이트 프레임) — 유리가 안쪽으로 들어가 기둥이 자연스럽게 보임
  const cs = new THREE.Shape();
  cs.moveTo(-1.04, 0.64);
  cs.quadraticCurveTo(-0.84, 1.04, -0.58, 1.30);
  cs.lineTo(0.52, 1.31);
  cs.quadraticCurveTo(0.84, 1.02, 1.10, 0.66);
  cs.closePath();
  const cabGeo = new THREE.ExtrudeGeometry(cs, { depth: 1.56, bevelEnabled: true, bevelThickness: 0.05, bevelSize: 0.05, bevelSegments: 2, steps: 1 });
  cabGeo.translate(0, 0, -0.78);
  cabGeo.rotateY(-Math.PI / 2);
  const cabin = new THREE.Mesh(cabGeo, paint);
  cabin.castShadow = true;
  procBody.add(cabin);

  // 유리(어두운 회청색 반투명)
  const gs = new THREE.Shape();
  gs.moveTo(-0.97, 0.64);
  gs.quadraticCurveTo(-0.79, 1.02, -0.545, 1.245);
  gs.lineTo(0.485, 1.255);
  gs.quadraticCurveTo(0.775, 1.0, 1.03, 0.66);
  gs.closePath();
  const glassGeo = new THREE.ExtrudeGeometry(gs, { depth: 1.42, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1, steps: 1 });
  glassGeo.translate(0, 0, -0.71);
  glassGeo.rotateY(-Math.PI / 2);
  const glass = new THREE.Mesh(glassGeo, glassMat);
  procBody.add(glass);

  // 전/후 범퍼
  const bF = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.20, 0.28), darkTrim);
  bF.position.set(0, 0.35, -2.08);
  const bR = new THREE.Mesh(new THREE.BoxGeometry(1.86, 0.20, 0.28), darkTrim);
  bR.position.set(0, 0.35, 2.08);
  procBody.add(bF, bR);

  // 라디에이터 그릴 + 헤드라이트
  const grille = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.14, 0.05), darkTrim);
  grille.position.set(0, 0.50, -2.16);
  const hlMat = new THREE.MeshStandardMaterial({ color: 0xdfeaff, emissive: 0xbfd4ff, emissiveIntensity: 0.55, roughness: 0.2 });
  for (const sx of [-1, 1]) {
    const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.11, 0.06), hlMat);
    hl.position.set(sx * 0.55, 0.575, -2.15);
    procBody.add(hl);
  }
  procBody.add(grille);

  // 후미등(브레이크 시 밝아짐) + 번호판
  tailMat = new THREE.MeshStandardMaterial({ color: 0x531016, emissive: 0xd01818, emissiveIntensity: 0.35, roughness: 0.3 });
  for (const sx of [-1, 1]) {
    const tl = new THREE.Mesh(new THREE.BoxGeometry(0.40, 0.12, 0.06), tailMat);
    tl.position.set(sx * 0.58, 0.60, 2.15);
    procBody.add(tl);
  }
  const plate = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.12, 0.03), new THREE.MeshStandardMaterial({ color: 0xdfe3e6, roughness: 0.5 }));
  plate.position.set(0, 0.38, 2.19);
  procBody.add(plate);

  // 사이드 미러 + 언더바디
  for (const sx of [-1, 1]) {
    const mir = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.10, 0.18), paint);
    mir.position.set(sx * 0.93, 0.80, -0.78);
    procBody.add(mir);
  }
  const under = new THREE.Mesh(new THREE.BoxGeometry(1.60, 0.16, 3.4), darkTrim);
  under.position.set(0, 0.26, 0);
  procBody.add(under);

  // 바퀴(검은 원통 + 림) — 앞바퀴는 조향 그룹으로 감싸 스티어링 표현
  const wheelGeo = new THREE.CylinderGeometry(0.345, 0.345, 0.26, 18);
  wheelGeo.rotateZ(Math.PI / 2); // 축을 X로
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.88 });
  const rimGeo = new THREE.CylinderGeometry(0.20, 0.20, 0.27, 12);
  rimGeo.rotateZ(Math.PI / 2);
  const rimMat = new THREE.MeshStandardMaterial({ color: 0x8f959c, roughness: 0.3, metalness: 0.85 });
  function addWheel(x, z, front) {
    const steer = new THREE.Group();
    steer.position.set(x, 0.345, z);
    const spin = new THREE.Group();
    steer.add(spin);
    const tire = new THREE.Mesh(wheelGeo, wheelMat);
    tire.castShadow = true;
    spin.add(tire, new THREE.Mesh(rimGeo, rimMat));
    procBody.add(steer);
    wheels.push({ spin, steer: front ? steer : null });
  }
  addWheel(-0.86, -1.40, true);
  addWheel(0.86, -1.40, true);
  addWheel(-0.86, 1.42, false);
  addWheel(0.86, 1.42, false);
}
buildCar();

/* ---------------- 공개 GLB 차량 (로드 성공 시 프로시저럴 대체, 실패 시 유지) ----------------
   - 차량: Khronos glTF Sample Assets "ToyCar" (CC0) */
const gltfLoader = new GLTFLoader();

// --- 자동차 GLB ---
gltfLoader.load('assets/ToyCar.glb', gltf => {
  const root = gltf.scene;
  const cams = [];
  root.traverse(o => { if (o.isCamera) cams.push(o); });
  cams.forEach(c => c.parent && c.parent.remove(c)); // 모델에 포함된 카메라 제거
  const fab = [];
  root.traverse(o => { if (o.isMesh && o.material && (o.material.name || '').toLowerCase().includes('fabric')) fab.push(o); });
  fab.forEach(o => o.parent && o.parent.remove(o)); // 전시용 받침 천(Fabric) 제거
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  root.scale.setScalar(4.35 / Math.max(size.x, size.z)); // 전장 4.35m로 정규화
  const holder = new THREE.Group();
  holder.add(root);
  if (size.x >= size.z) root.rotation.y = -Math.PI / 2; // 전방(-Z) 정렬 + 반전 (앞모습 플립 수정)
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(holder);
  holder.position.y -= box2.min.y; // 바퀴가 지면에 닿도록
  holder.traverse(o => {
    if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  // 도장 재질만 흰색으로 (유리는 원본 유지)
  root.traverse(o => {
    if (o.isMesh && o.material) {
      const mn = (o.material.name || '').toLowerCase();
      if (mn.includes('toycar') || mn.includes('paint') || mn.includes('body')) {
        o.material = o.material.clone();
        // 원본은 차체·타이어·크롬이 하나의 텍스처를 공유한다.
        // 텍스처를 보존하고 붉은 도장 부분만 은백색으로 치환한다.
        o.material.color = new THREE.Color(0xffffff);
        o.material.onBeforeCompile = shader => {
          shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `
            #include <map_fragment>
            float paintMask = smoothstep(0.06, 0.20, diffuseColor.r - max(diffuseColor.g, diffuseColor.b));
            float paintShade = clamp(diffuseColor.r * 1.1, 0.12, 0.88);
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.88, 0.93, 0.98) * paintShade, paintMask);
          `);
        };
        o.material.customProgramCacheKey = () => 'silver-paint-preserve-atlas-v1';
        o.material.envMapIntensity = 1.3;
      }
    }
  });
  glassMeshes.length = 0;
  root.traverse(o => { if (o.isMesh && o.material && (o.material.name || '').toLowerCase().includes('glass')) glassMeshes.push(o); });
  applyCamMode();
  bodyGroup.add(holder);
  fitWindshieldGlass(); // 원본 유리 메시의 앞쪽 면만 차량 로컬 좌표로 보관
  procBody.visible = false; // GLB 차량으로 교체
}, undefined, () => console.warn('자동차 GLB 로드 실패 — 프로시저럴 차량 유지'));

// 단일 GLB 소나무로 전체 식생을 덮어쓰지 않는다. 차량 로더는 기존 그대로 유지한다.

/* ---------------- 눈 분진 파티클 ---------------- */
const PMAX = 300;
const pPos = new Float32Array(PMAX * 3), pVel = new Float32Array(PMAX * 3), pLife = new Float32Array(PMAX);
for (let i = 0; i < PMAX; i++) pPos[i * 3 + 1] = -9999;
const pGeo = new THREE.BufferGeometry();
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3).setUsage(THREE.DynamicDrawUsage));
const points = new THREE.Points(pGeo, new THREE.PointsMaterial({
  color: 0xffffff, size: 0.13, transparent: true, opacity: 0.8, depthWrite: false, sizeAttenuation: true
}));
points.frustumCulled = false;
scene.add(points);
let pHead = 0, spawnAcc = 0;

function updateEffects(dt) {
  const c = car;
  // 미끄러짐/오프로드일 때 뒷바퀴에서 눈 분진 발생
  const rate = (c.slip > 2.2 ? c.slip * 9 : 0) + (c.offroad > 0.5 && Math.abs(c.vF) > 4 ? Math.abs(c.vF) * 2.5 : 0);
  spawnAcc += rate * dt;
  const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
  const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
  while (spawnAcc >= 1) {
    spawnAcc -= 1;
    const i = pHead; pHead = (pHead + 1) % PMAX;
    const side = Math.random() < 0.5 ? -1 : 1;
    pPos[i * 3] = c.pos.x + rx * side * 0.86 - fx * 1.42;
    pPos[i * 3 + 1] = c.y + 0.25;
    pPos[i * 3 + 2] = c.pos.z + rz * side * 0.86 - fz * 1.42;
    pVel[i * 3] = -fx * 2.5 + (Math.random() - 0.5) * 1.6 + rx * side * 0.8;
    pVel[i * 3 + 1] = 1.2 + Math.random() * 1.6;
    pVel[i * 3 + 2] = -fz * 2.5 + (Math.random() - 0.5) * 1.6 + rz * side * 0.8;
    pLife[i] = 0.75 + Math.random() * 0.4;
  }
  for (let i = 0; i < PMAX; i++) {
    if (pLife[i] <= 0) continue;
    pLife[i] -= dt;
    if (pLife[i] <= 0) { pPos[i * 3 + 1] = -9999; continue; }
    pPos[i * 3] += pVel[i * 3] * dt;
    pPos[i * 3 + 1] += pVel[i * 3 + 1] * dt;
    pPos[i * 3 + 2] += pVel[i * 3 + 2] * dt;
    pVel[i * 3] *= 0.985;
    pVel[i * 3 + 1] = pVel[i * 3 + 1] * 0.985 - 2.2 * dt;
    pVel[i * 3 + 2] *= 0.985;
  }
  pGeo.attributes.position.needsUpdate = true;
}

/* ---------------- 입력 ---------------- */
const key = { w: false, a: false, s: false, d: false, space: false, r: false };
const KEYMAP = { KeyW: 'w', ArrowUp: 'w', KeyA: 'a', ArrowLeft: 'a', KeyS: 's', ArrowDown: 's', KeyD: 'd', ArrowRight: 'd', Space: 'space', KeyR: 'r' };
addEventListener('keydown', e => {
  initAudio();
  const k = KEYMAP[e.code];
  if (k) { key[k] = true; if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault(); }
  if (mapPreview && !(e.target instanceof Element && e.target.closest('input, textarea'))) {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') previewYaw = clamp(previewYaw - 0.12, -Math.PI, Math.PI);
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') previewYaw = clamp(previewYaw + 0.12, -Math.PI, Math.PI);
    else if (e.code === 'ArrowUp' || e.code === 'KeyW') previewS = clamp(previewS + 80, 0, PREVIEW_SPAN);
    else if (e.code === 'ArrowDown' || e.code === 'KeyS') previewS = clamp(previewS - 80, 0, PREVIEW_SPAN);
  }
  if (e.code === 'KeyC') cycleCam();
  else if (e.code === 'KeyN') togglePanel();
  else if (e.code === 'KeyM') toggleMute();
  else if (e.code === 'KeyT') toggleAuto();
  else if (e.code === 'KeyV' || (e.code === 'Escape' && cinematic)) toggleCinema();
});
addEventListener('pointerdown', initAudio);
function previewUI(target) {
  return target instanceof Element && !!target.closest('#mapPick, #wpanel, #bStartMusic, .tc-top, a');
}
const previewPointers = new Map();
addEventListener('pointerdown', e => {
  if (!mapPreview || e.button !== 0 || previewUI(e.target)) return;
  previewPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
});
addEventListener('pointermove', e => {
  const p = previewPointers.get(e.pointerId);
  if (!p || !mapPreview) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  p.x = e.clientX; p.y = e.clientY;
  if (previewPointers.size >= 2) previewS = clamp(previewS + dy * 1.6, 0, PREVIEW_SPAN);
  else {
    previewYaw = clamp(previewYaw - dx * 0.005, -Math.PI, Math.PI);
    previewPitch = clamp(previewPitch - dy * 0.004, -1.15, 0.55);
  }
});
const endPreviewPointer = e => previewPointers.delete(e.pointerId);
addEventListener('pointerup', endPreviewPointer);
addEventListener('pointercancel', endPreviewPointer);
addEventListener('wheel', e => {
  if (!mapPreview || previewUI(e.target)) return;
  e.preventDefault();
  previewS = clamp(previewS + e.deltaY * 0.85, 0, PREVIEW_SPAN);
}, { passive: false });
addEventListener('keyup', e => { const k = KEYMAP[e.code]; if (k) key[k] = false; });
addEventListener('blur', () => { for (const k in key) key[k] = false; touchSteer = 0; touchGas = 0; touchBrake = 0; });

/* ---------------- 터치 컨트롤(모바일) ---------------- */
let touchSteer = 0; // 조이스틱 아날로그 조향(-1 좌 ~ 1 우)
let touchGas = 0, touchBrake = 0; // 조이스틱 아날로그 가속/제동(0~1)
const isTouch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
if (isTouch) {
  document.documentElement.classList.add('touch');
  document.body.classList.add('touch');
  const touchRoot = document.getElementById('touchControls');
  if (touchRoot) touchRoot.setAttribute('aria-hidden', 'false');
  if (mapPreview) {
    for (const id of ['tcJoyBase', 'tcHandbrake', 'tcGas', 'tcBrake']) {
      const el = document.getElementById(id);
      if (el) el.setAttribute('aria-hidden', 'true');
    }
  }
  const hint = document.getElementById('hint');
  if (hint) hint.textContent = '조이스틱으로 조향·가속·제동 · P 핸드브레이크 · 상단 아이콘 시점/날씨/소리';

  const bindHold = (id, k) => {
    const el = document.getElementById(id);
    if (!el) return;
    const on = e => { e.preventDefault(); initAudio(); key[k] = true; };
    const off = e => { e.preventDefault(); key[k] = false; };
    el.addEventListener('pointerdown', on);
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
  };
  bindHold('tcGas', 'w');
  bindHold('tcBrake', 's');
  bindHold('tcHandbrake', 'space');

  const bindTap = (id, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', e => { e.preventDefault(); fn(); });
  };
  bindTap('tcCam', cycleCam);
  bindTap('tcWeather', togglePanel);
  bindTap('tcMute', toggleMute);

  const joyBase = document.getElementById('tcJoyBase');
  const joyKnob = document.getElementById('tcJoyKnob');
  if (joyBase && joyKnob) {
    const RADIUS = 36;
    let joyPid = null;
    const setKnob = (dx, dy) => { joyKnob.style.transform = `translate(${dx}px, ${dy}px)`; };
    const resetJoy = () => { touchSteer = 0; touchGas = 0; touchBrake = 0; setKnob(0, 0); joyBase.classList.remove('active'); joyPid = null; };
    const moveJoy = (clientX, clientY) => {
      const r = joyBase.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let dx = clientX - cx, dy = clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) { dx = dx / len * RADIUS; dy = dy / len * RADIUS; }
      setKnob(dx, dy);
      touchSteer = Math.max(-1, Math.min(1, -dx / RADIUS));
      const ny = Math.max(-1, Math.min(1, -dy / RADIUS)); // 위로 당기면 +(가속), 아래면 -(제동)
      touchGas = Math.max(0, ny);
      touchBrake = Math.max(0, -ny);
    };
    joyBase.addEventListener('pointerdown', e => {
      e.preventDefault(); initAudio(); joyPid = e.pointerId; joyBase.classList.add('active');
      moveJoy(e.clientX, e.clientY);
    });
    joyBase.addEventListener('pointermove', e => { if (joyPid === e.pointerId) { e.preventDefault(); moveJoy(e.clientX, e.clientY); } });
    const endJoy = e => { if (joyPid === e.pointerId) { e.preventDefault(); resetJoy(); } };
    joyBase.addEventListener('pointerup', endJoy);
    joyBase.addEventListener('pointercancel', endJoy);
    joyBase.addEventListener('pointerleave', endJoy);
  }
}

/* ---------------- 차량 상태 + 아케이드 물리 ---------------- */
const car = {
  pos: new THREE.Vector3(), yaw: 0, vx: 0, vz: 0, vF: 0, vR: 0, steer: 0,
  s: 6, lat: 0, y: 0, dist: 0, slip: 0, offroad: 0, accelSm: 0, yawRateSm: 0
};
const PHYS = { engine: 13.0, brake: 17.0, revAccel: 6.0, revMax: 9.0, dragQ: 0.0006, dragL: 0.035, wheelbase: 2.82, maxSteerBase: 0.60, steerFade: 0.042 };

function updateVehicle(dt) {
  const c = car, P = PHYS;
  let thr = Math.max(key.w ? 1 : 0, touchGas), brk = Math.max(key.s ? 1 : 0, touchBrake);
  let sIn = Math.max(-1, Math.min(1, (key.a ? 1 : 0) - (key.d ? 1 : 0) + touchSteer));
  if (demo || auto24) { const d = demoDrive(); thr = d[0]; brk = d[1]; sIn = d[2]; }

  // 노면 판정: 도로 > 어깨 > 눈밭
  const a = Math.abs(c.lat);
  const onRoad = a <= 3.9, onShoulder = a <= 5.9;
  const engineMul = onRoad ? 1 : onShoulder ? 0.8 : 0.55;
  const rollRes = onRoad ? 0.3 : onShoulder ? 1.6 : 3.8;
  let grip = onRoad ? 7.5 : onShoulder ? 4.6 : 2.3;
  if (key.space) grip *= 0.3; // 핸드브레이크 = 의도적인 미끄러짐
  grip *= roadGripMul(); // 날씨 노면 영향(비/눈 그립 저하)

  // 조향: 속도가 붙을수록 최대 조향각 축소
  const maxSteer = P.maxSteerBase / (1 + Math.abs(c.vF) * P.steerFade);
  c.steer += (sIn * maxSteer - c.steer) * Math.min(1, dt * 8);

  // 요 레이트(자전거 모델)
  const yawRate = (c.vF / P.wheelbase) * Math.tan(c.steer);
  c.yaw += yawRate * dt;
  c.yawRateSm += (yawRate - c.yawRateSm) * Math.min(1, dt * 6);

  // 속도를 새 헤딩 축으로 분해 → 관성이 남아 차가 미끄러짐
  const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
  const rx = Math.cos(c.yaw), rz = -Math.sin(c.yaw);
  let vF = c.vx * fx + c.vz * fz;
  let vR = c.vx * rx + c.vz * rz;
  const prevVF = vF;

  if (thr) vF += thr * P.engine * engineMul * (1 - clamp(vF / 46, 0, 1)) * dt;
  if (brk) {
    if (vF > 0.4) vF = Math.max(0, vF - brk * P.brake * roadGripMul() * dt); // 연속 제동량 적용
    else if (!(demo || auto24)) vF = Math.max(vF - brk * P.revAccel * dt, -P.revMax); // 정지 후 후진
  }
  // 공기항력 + 구름저항(눈밭은 훨씬 무거움)
  vF -= (P.dragQ * vF * Math.abs(vF) + P.dragL * vF + Math.sign(vF) * rollRes) * dt;
  if (!thr && !brk && Math.abs(vF) < 0.5) vF *= Math.max(0, 1 - 3 * dt);
  // 횡방향 그립 감쇠 → 접지가 낮으면 관성이 남아 미끄러짐
  vR -= vR * Math.min(1, grip * dt);

  c.vx = fx * vF + rx * vR;
  c.vz = fz * vF + rz * vR;
  c.pos.x += c.vx * dt;
  c.pos.z += c.vz * dt;
  c.vF = vF; c.vR = vR;
  c.slip = Math.abs(vR);
  c.accelSm += ((vF - prevVF) / Math.max(dt, 1e-4) - c.accelSm) * Math.min(1, dt * 4);
  c.dist += Math.hypot(c.vx, c.vz) * dt;
  c.offroad = onRoad ? 0 : onShoulder ? 0.5 : 1;

  // 도로 투영: 주변 60m 샘플에서 최근접점을 찾아 s/횡방향 오프셋 갱신
  const i0 = Math.round(c.s) - baseS;
  let best = -1, bd = Infinity;
  const lo = Math.max(0, i0 - 30), hi = Math.min(roadSamples.length - 1, i0 + 30);
  for (let j = lo; j <= hi; j++) {
    const p = roadSamples[j];
    const dx = c.pos.x - p.x, dz = c.pos.z - p.z;
    const d = dx * dx + dz * dz;
    if (d < bd) { bd = d; best = j; }
  }
  if (best >= 0) {
    const p = roadSamples[best];
    const dx = c.pos.x - p.x, dz = c.pos.z - p.z;
    const along = dx * (-Math.sin(p.h)) + dz * (-Math.cos(p.h));
    c.s = baseS + best + clamp(along, -1, 1);
    c.lat = dx * Math.cos(p.h) - dz * Math.sin(p.h);
  }

  // 지면 높지(도로 위/눈밭 부드럽게 블렌딩)
  const rc = sampleAt(c.s);
  const tY = lerp(rc.y + 0.02, groundY(c.s, c.lat), sstep(3.9, 5.3, a));
  c.y += (tY - c.y) * Math.min(1, dt * 10);

  // 나무 충돌
  for (const t of activeTrees) {
    const dx = c.pos.x - t.x, dz = c.pos.z - t.z;
    const rr = t.r + 0.9;
    if (dx * dx + dz * dz < rr * rr) {
      const d = Math.max(Math.hypot(dx, dz), 1e-4);
      const nx = dx / d, nz = dz / d;
      c.pos.x = t.x + nx * rr; c.pos.z = t.z + nz * rr;
      const vn = c.vx * nx + c.vz * nz;
      if (vn < 0) { c.vx -= vn * nx * 1.5; c.vz -= vn * nz * 1.5; }
      c.vx *= 0.6; c.vz *= 0.6;
    }
  }
  // 가드레일 충돌(우측)
  if (c.lat > 4.35 && railActive(c.s)) {
    const pr = sampleAt(c.s);
    const push = c.lat - 4.35;
    c.pos.x -= pr.rx * push; c.pos.z -= pr.rz * push;
    const vr = c.vx * pr.rx + c.vz * pr.rz;
    if (vr > 0) { c.vx -= vr * pr.rx * 1.3; c.vz -= vr * pr.rz * 1.3; }
    c.vx *= 0.8; c.vz *= 0.8;
    c.lat = 4.35;
  }

  // R = 도로 복귀
  if (key.r) {
    key.r = false;
    const rr2 = sampleAt(c.s + 4);
    c.pos.set(rr2.x, 0, rr2.z);
    c.yaw = rr2.h; c.vx = c.vz = 0; c.y = rr2.y + 0.02;
  }

  // 메시 반영
  carGroup.position.set(c.pos.x, c.y, c.pos.z);
  carGroup.rotation.y = c.yaw;
  const yA = sampleAt(c.s + 2.5).y, yB = sampleAt(c.s - 2.5).y;
  const gpitch = Math.atan2(yA - yB, 5); // 경사 따라 피치
  carGroup.rotation.x += (gpitch - carGroup.rotation.x) * Math.min(1, dt * 6);
  // 서스펜션 자세: 코너에서 몸이 바깥으로 기울고 가속/제동에 피치
  const calm = auto24 || demo ? 0.2 : 1;
  bodyGroup.rotation.z += (clamp(-c.vF * c.yawRateSm * 0.02 * calm, -0.08, 0.08) - bodyGroup.rotation.z) * Math.min(1, dt * 5);
  bodyGroup.rotation.x += (clamp(c.accelSm * 0.0045 * calm, -0.04, 0.04) - bodyGroup.rotation.x) * Math.min(1, dt * 5);

  const spin = (c.vF / 0.345) * dt; // 바퀴 회전
  for (const w of wheels) {
    w.spin.rotation.x += spin;
    if (w.steer) w.steer.rotation.y = c.steer;
  }
  tailMat.emissiveIntensity = (brk && c.vF > -0.2) ? 2.4 : 0.35; // 브레이크등
}

/* ---------------- 추적 카메라 ---------------- */
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3();
let fovCur = 62;
let snapNext = false;
let cinematic = false, cinemaElapsed = 0, cinemaShot = -1, cinemaRestore = null;
const CINEMA_SHOTS = [
  {name:'산길 추격',mode:0,back:10,side:0,height:3,look:7,fov:56},
  {name:'왼쪽 풍경',mode:0,back:5,side:-9,height:3.5,look:5,fov:58},
  {name:'능선 전경',mode:0,back:18,side:4,height:11,look:15,fov:64},
  {name:'운전석',mode:1,fov:70},
  {name:'오른쪽 풍경',mode:0,back:4,side:9,height:3,look:7,fov:58},
  {name:'도로 전경',mode:2,fov:66}
];
function updateCinemaCamera(dt) {
  cinemaElapsed+=dt;
  const index=Math.floor(cinemaElapsed/16)%CINEMA_SHOTS.length;
  const shot=CINEMA_SHOTS[index],phase=cinemaElapsed%16;
  const switched=index!==cinemaShot;
  if(switched){cinemaShot=index;camMode=shot.mode;applyCamMode();}
  const fade=phase<0.7?1-phase/0.7:phase>15.3?(phase-15.3)/0.7:0;
  document.getElementById('cinemaFade').style.opacity=fade;
  const position=new THREE.Vector3(),target=new THREE.Vector3();
  const heading=sampleAt(car.s).h,rx=Math.cos(heading),rz=-Math.sin(heading),fx=-Math.sin(heading),fz=-Math.cos(heading);
  if(shot.mode===0){
    const drift=Math.sin(phase/16*Math.PI)*1.1;
    const side=shot.side+drift;
    position.set(car.pos.x-fx*shot.back+rx*side,car.y+shot.height,car.pos.z-fz*shot.back+rz*side);
    position.y=Math.max(position.y,groundY(car.s-shot.back,side)+2);
    const ahead=sampleAt(car.s+shot.look);
    target.set(ahead.x,ahead.y+0.9,ahead.z);
    const blend=switched?1:1-Math.exp(-dt*3);
    camera.position.lerp(position,blend);
    const rotation=new THREE.Matrix4().lookAt(camera.position,target,UP);
    camera.quaternion.slerp(new THREE.Quaternion().setFromRotationMatrix(rotation),blend);
  }else{
    carGroup.updateWorldMatrix(true,false);
    position.copy((shot.mode===1?camDash:camHood).position).applyMatrix4(carGroup.matrixWorld);
    const blend=switched?1:1-Math.exp(-dt*5);
    camera.position.lerp(position,blend);camera.quaternion.slerp(carGroup.quaternion,blend);
  }
  fovCur+=(shot.fov-fovCur)*(switched?1:Math.min(1,dt*2));
  camera.fov=fovCur;camera.updateProjectionMatrix();
}
function updateCamera(dt, snap = false) {
  if(cinematic){updateCinemaCamera(dt);return;}
  const c = car;
  const fx = -Math.sin(c.yaw), fz = -Math.cos(c.yaw);
  const sp = Math.abs(c.vF);
  let fovBase = 62;
  if (camMode === 0) {
    const dist = 5.6 + sp * 0.055;      // 속도가 붙으면 살짝 멀어짐
    const hgt = 2.15 + sp * 0.012;
    const k = snap ? 1 : 1 - Math.exp(-dt * 4.6);
    const kl = snap ? 1 : 1 - Math.exp(-dt * 7);
    camPos.x += (c.pos.x - fx * dist - camPos.x) * k;
    camPos.y += (c.y + hgt - camPos.y) * k;
    camPos.z += (c.pos.z - fz * dist - camPos.z) * k;
    camLook.x += (c.pos.x + fx * 7 - camLook.x) * kl;
    camLook.y += (c.y + 1.15 - camLook.y) * kl;
    camLook.z += (c.pos.z + fz * 7 - camLook.z) * kl;
    camera.position.copy(camPos);
    camera.lookAt(camLook);
  } else {
    const anchor = camMode === 1 ? camDash : camHood;
    if (camMode === 1 || auto24 || demo) {
      carGroup.updateWorldMatrix(true, false);
      const targetPos = anchor.position.clone().applyMatrix4(carGroup.matrixWorld);
      const targetQ = carGroup.quaternion.clone();
      const blend = snap ? 1 : 1 - Math.exp(-dt * 5);
      camera.position.lerp(targetPos, blend);
      camera.quaternion.slerp(targetQ, blend);
    } else {
      anchor.getWorldPosition(camera.position);
      anchor.getWorldQuaternion(camera.quaternion);
    }
    fovBase = camMode === 1 ? 70 : 66;
  }
  const fovT = fovBase + sp * (auto24 || demo ? 0.04 : 0.26); // 속도감 FOV
  fovCur += (fovT - fovCur) * Math.min(1, dt * 3);
  if (Math.abs(camera.fov - fovCur) > 0.01) { camera.fov = fovCur; camera.updateProjectionMatrix(); }
  if (W.wind > 0.45 && camMode !== 1 && !(auto24 || demo)) { // 관람 자율주행에서는 무작위 떨림 해제
    const s = (W.wind - 0.45) * 0.09;
    camera.position.x += (Math.random() - 0.5) * s;
    camera.position.y += (Math.random() - 0.5) * s;
  }
}
// 미리보기: 도로는 f = (-sin h, 0, -cos h). 기본 자리는 그 뒤 18m, 위 22m이고 시선만 돌린다.
function updatePreviewCamera() {
  const s = clamp(previewS, 0, PREVIEW_SPAN);
  previewS = s;
  const anchor = sampleAt(s);
  car.s = s;
  car.pos.set(anchor.x, 0, anchor.z);
  car.yaw = anchor.h;
  car.y = anchor.y + 0.02;
  car.vx = car.vz = car.vF = car.vR = 0;
  carGroup.position.set(anchor.x, car.y, anchor.z);
  carGroup.rotation.y = anchor.h;
  const roadX = -Math.sin(anchor.h), roadZ = -Math.cos(anchor.h);
  const lookH = anchor.h + previewYaw;
  const fx = -Math.sin(lookH), fz = -Math.cos(lookH);
  const horiz = Math.cos(previewPitch), vert = Math.sin(previewPitch);
  camera.position.set(anchor.x - roadX * PREVIEW_BACK, anchor.y + PREVIEW_UP, anchor.z - roadZ * PREVIEW_BACK);
  camera.up.set(0, 1, 0);
  camera.lookAt(camera.position.x + fx * horiz, camera.position.y + vert, camera.position.z + fz * horiz);
  if (camera.fov !== 56) { camera.fov = 56; camera.updateProjectionMatrix(); }
  const cursor = document.getElementById('mpCursor');
  if (cursor) cursor.style.left = (s / PREVIEW_SPAN * 100) + '%';
}

/* ---------------- 하늘/산/태양이 카메라를 따라다님 ---------------- */
function updateAnchors() {
  sky.position.copy(camera.position);
  mountains.position.set(camera.position.x, 0, camera.position.z);
  // 산맥의 방위는 고정한다. 코너마다 배경이 차량과 함께 회전하지 않는다.
  mountains.rotation.y = 0;
  for (const tile of mountainTiles) {
    tile.visible = !(coastAmount(car.s) > 0.65 && tile.userData.side === coastSide(car.s));
    tile.scale.y = lerp(1, 0.38 + tile.userData.layer * 0.07, showcaseAmount(car.s));
    tile.children[0].material.color.setScalar((0.12 + dayLight * 0.88) * (1 - W.dark * 0.35));
  }
  // 수면 높이는 고정한다. 격자는 매 프레임 카메라에 붙이지 않고 세계 좌표 셀로 이동한다.
  // 파도 무늬는 기존 world.xz를 사용하므로 셀 이동 후에도 해안 색과 무늬가 이어진다.
  sea.position.set(Math.floor(camera.position.x / SEA_ANCHOR_STEP) * SEA_ANCHOR_STEP,
    SEA_LEVEL, Math.floor(camera.position.z / SEA_ANCHOR_STEP) * SEA_ANCHOR_STEP);
  sea.material.uniforms.time.value = performance.now() * 0.001;
  sea.material.uniforms.light.value = (0.24 + dayLight * 0.76) * (1 - W.dark * 0.4);
  sea.material.uniforms.night.value = nightF;
  sea.material.uniforms.summer.value = summerVisual();
  sea.material.uniforms.haze.value.copy(scene.fog.color);
  sea.material.uniforms.fogNear.value = scene.fog.near;
  sea.material.uniforms.fogFar.value = scene.fog.far;
  sun.position.set(car.pos.x + SUN_CUR.x * 170, car.y + SUN_CUR.y * 170, car.pos.z + SUN_CUR.z * 170);
  sun.target.position.set(car.pos.x, car.y, car.pos.z);
}

/* ---------------- HUD ---------------- */
const speedEl = document.getElementById('speedVal');
const distEl = document.getElementById('distVal');
const roadEl = document.getElementById('roadState');
const clockEl = document.getElementById('clock');
let lastKmh = -1;
function updateHUD() {
  const kmh = Math.round(Math.hypot(car.vx, car.vz) * 3.6);
  if (kmh !== lastKmh) { speedEl.textContent = String(kmh); lastKmh = kmh; }
  const km = car.dist / 1000;
  distEl.textContent = (km < 10 ? km.toFixed(2) : km.toFixed(1)) + ' km';
  if (roadEl) {
    let txt = '노면 건조';
    if (W.precip > 0.02 && precipForm !== 'none') {
      const cond = precipForm === 'snow'
        ? (W.precip < 0.4 ? '노면 쌓임' : '적설 · 결빙')
        : (W.precip < 0.4 ? '노면 젖음' : '물웅덩이 · 미끄러움');
      txt = '노면: ' + cond + ' · 그립 ' + Math.round(roadGripMul() * 100) + '%';
    }
    if (roadEl.textContent !== txt) roadEl.textContent = txt;
  }
  if (clockEl) {
    const hh = Math.floor(timeOfDay), mm = Math.floor((timeOfDay % 1) * 60);
    const s = (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm;
    if (clockEl.textContent !== s) clockEl.textContent = s;
  }
  drawCluster();
}

/* ---------------- 데모 자율주행(?demo=1) — 검증/스크린샷 용 ---------------- */
const demo = new URLSearchParams(location.search).has('demo');
function demoDrive() {
  const speed = Math.hypot(car.vx, car.vz);
  const ahead = clamp(10 + speed * 1.15, 10, 30);
  const look = sampleAt(car.s + ahead);
  const dx = look.x - car.pos.x, dz = look.z - car.pos.z;
  const diff = Math.atan2(Math.sin(Math.atan2(-dx, -dz) - car.yaw), Math.cos(Math.atan2(-dx, -dz) - car.yaw));
  const angle = Math.atan2(2 * PHYS.wheelbase * Math.sin(diff), Math.max(6, Math.hypot(dx, dz)));
  const maxSteer = PHYS.maxSteerBase / (1 + Math.abs(car.vF) * PHYS.steerFade);
  const curvature = Math.max(...[8, 18, 30].map(d => Math.abs(headingAt(car.s+d+2)-headingAt(car.s+d-2))/4));
  const weatherCap = (55 - W.precip * 15 - W.wind * 10) / 3.6;
  const cornerCap = Math.sqrt(1.1 * roadGripMul() / Math.max(0.001, curvature));
  const target = Math.max(18 / 3.6, Math.min(weatherCap, cornerCap)) * (Math.abs(car.lat) > 2.5 ? 0.65 : 1);
  const error = target - speed;
  const resistance = PHYS.dragQ * speed * speed + PHYS.dragL * speed + 0.3;
  const feed = resistance / (PHYS.engine * Math.max(0.2, 1-speed/46));
  return [clamp(feed + error * 0.16, 0, 0.35), clamp(-error * 0.15, 0, 0.4), clamp(angle / maxSteer, -1, 1)];
}

/* ==================== 날씨 시스템 ==================== */
let camMode = RUN.get('view') === 'dash' ? 1 : RUN.get('view') === 'hood' ? 2 : 0; // 0=3인칭 추격, 1=대시보드, 2=후드
const glassMeshes = [];
const CAM_NAMES = ['3인칭 추격', '대시보드 1인칭', '후드 카메라'];
function applyCamMode() { const vis = camMode !== 1; glassMeshes.forEach(g => g.visible = vis); cluster.visible = camMode === 1; toast(CAM_NAMES[camMode]); }
function cycleCam() { if(cinematic)toggleCinema(); camMode = (camMode + 1) % 3; applyCamMode(); snapNext = true; }
function toast(msg) {
  const el = document.getElementById('camToast'); if (!el) return;
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 1400);
}
function togglePanel() { const p = document.getElementById('wpanel'); if (p) p.style.display = p.style.display === 'none' ? 'block' : 'none'; }

const PRESETS = {
  clear:   { precip: 0,   wind: 15, fog: 0,  dark: 0,  form: 'none' },
  snow:    { precip: 60,  wind: 25, fog: 30, dark: 15, form: 'snow' },
  drizzle: { precip: 30,  wind: 20, fog: 55, dark: 35, form: 'rain' },
  rain:    { precip: 65,  wind: 35, fog: 45, dark: 50, form: 'rain' },
  storm:   { precip: 100, wind: 90, fog: 70, dark: 70, form: 'rain' }
};
const Wui = { precip: 0, wind: 15, fog: 0, dark: 0 }; // 슬라이더 목표값(0~100)
const W = { precip: 0, wind: 0.15, fog: 0, dark: 0 };   // 보간된 현재값(0~1)
let precipForm = 'none';
const flashEl = document.getElementById('flash');

// 강수 파티클: 눈(Points) + 비 streak(LineSegments)
const SNOW_N = 1600, RAIN_N = 900;
const snowPos = new Float32Array(SNOW_N * 3), snowPhase = new Float32Array(SNOW_N);
for (let i = 0; i < SNOW_N; i++) { snowPos[i*3] = (Math.random()-0.5)*70; snowPos[i*3+1] = Math.random()*30; snowPos[i*3+2] = (Math.random()-0.5)*70; snowPhase[i] = Math.random()*Math.PI*2; }
const snowGeo = new THREE.BufferGeometry();
snowGeo.setAttribute('position', new THREE.BufferAttribute(snowPos, 3));
const snowPts = new THREE.Points(snowGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.13, transparent: true, opacity: 0.85, depthWrite: false }));
snowPts.frustumCulled = false; snowPts.visible = false; scene.add(snowPts);
const rainPos = new Float32Array(RAIN_N * 6);
for (let i = 0; i < RAIN_N; i++) { const x = (Math.random()-0.5)*60, y = Math.random()*26, z = (Math.random()-0.5)*60; rainPos.set([x, y, z, x, y + 0.55, z], i*6); }
const rainGeo = new THREE.BufferGeometry();
rainGeo.setAttribute('position', new THREE.BufferAttribute(rainPos, 3));
const rainLines = new THREE.LineSegments(rainGeo, new THREE.LineBasicMaterial({ color: 0xaebccb, transparent: true, opacity: 0.4, depthWrite: false }));
rainLines.frustumCulled = false; rainLines.visible = false; scene.add(rainLines);
// 별 (하늘 돔 자식 → 카메라 따라다님)
const starGeo = new THREE.BufferGeometry();
const starPos = new Float32Array(500 * 3);
for (let i = 0; i < 500; i++) {
  const az = Math.random() * Math.PI * 2, ce = Math.random();
  starPos[i*3] = 2400 * Math.sqrt(1 - ce * ce) * Math.cos(az);
  starPos[i*3+1] = 2400 * ce * 0.92 + 60;
  starPos[i*3+2] = 2400 * Math.sqrt(1 - ce * ce) * Math.sin(az);
}
starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xcfd8ea, size: 4, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, fog: false }));
stars.visible = false; sky.add(stars);
// 야간 헤드라이트
const headLights = [];
for (const sx of [-1, 1]) {
  const hl = new THREE.SpotLight(0xd8e6ff, 0, 70, 0.52, 0.55, 1.1);
  hl.position.set(sx * 0.55, 0.75, -2.05);
  const tg = new THREE.Object3D(); tg.position.set(sx * 0.9, 0, -26);
  bodyGroup.add(hl, tg); hl.target = tg; headLights.push(hl);
}

const _fogStorm = new THREE.Color(0x8b93a1);
const _topStorm = new THREE.Color(0x49535f);
let ltAcc = 0, flashT = 0;
/* ---- 시간 흐름 (낮/밤 순환) ---- */
let timeOfDay = 10.5, timeFlow = 0, auto24 = false, dayLight = 1, nightF = 0;
const SUN_CUR = SUN_DIR.clone();
const _top = new THREE.Color(), _hor = new THREE.Color(), _sunCol = new THREE.Color();
const PAL = {
  dayTop: new THREE.Color(0xa8cfe5), dayHor: new THREE.Color(0xe7eff3),
  setTop: new THREE.Color(0x6d7fae), setHor: new THREE.Color(0xf0b47c),
  nightTop: new THREE.Color(0x0b1220), nightHor: new THREE.Color(0x16202e),
  daySun: new THREE.Color(0xfff3e2), setSun: new THREE.Color(0xffb36b), moonCol: new THREE.Color(0x93a7c9)
};
function sunDirAt(t) {
  const th = (t - 6) / 12 * Math.PI; // 6시 동쪽 지평선, 18시 서쪽
  return new THREE.Vector3(Math.cos(th) * 0.9, Math.sin(th), -0.35).normalize();
}
function computeSky() {
  const sd = sunDirAt(timeOfDay);
  SUN_CUR.copy(sd);
  sky.material.uniforms.sunDir.value.copy(sd);
  const elev = sd.y;
  nightF = sstep(-0.06, -0.3, elev);
  const duskF = (1 - Math.min(1, Math.abs(elev) / 0.22)) * (1 - nightF);
  dayLight = sstep(0.1, 0.42, elev) * (1 - nightF);
  _top.lerpColors(PAL.dayTop, PAL.nightTop, nightF).lerp(PAL.setTop, duskF * 0.65);
  _hor.lerpColors(PAL.dayHor, PAL.nightHor, nightF).lerp(PAL.setHor, duskF * 0.8);
  _sunCol.lerpColors(PAL.daySun, PAL.setSun, duskF).lerp(PAL.moonCol, nightF);
  stars.material.opacity = nightF * 0.9;
  stars.visible = nightF > 0.02;
  headLights.forEach(h => h.intensity = nightF * 90);
  const facadeGlow = [3.1, 3.6, 4.0, 3.2];
  buildingMats.forEach((mat, i) => { mat.emissiveIntensity = nightF * facadeGlow[i]; });
  spireMat.emissiveIntensity = nightF * 5.2;
  lampMat.emissiveIntensity = nightF * 5;
  beaconMat.emissiveIntensity = 0.35 + nightF * 2.4;
  beaconGreenMat.emissiveIntensity = 0.2 + nightF * 3.0;
}
function updateWeather(dt) {
  const L = 1 - Math.exp(-dt * 0.9);
  for (const kk of ['precip', 'wind', 'fog', 'dark']) W[kk] += (Wui[kk] / 100 - W[kk]) * L;
  const d = W.dark, p = W.precip;
  timeOfDay = (timeOfDay + timeFlow * dt / 3600) % 24;
  computeSky();
  scene.fog.near = 90 - W.fog * 77;
  scene.fog.far = 560 - W.fog * 470;
  scene.fog.color.copy(_hor).lerp(_fogStorm.clone().multiplyScalar(0.18 + dayLight * 0.82), d);
  renderer.setClearColor(scene.fog.color);
  const u = sky.material.uniforms;
  u.horizon.value.copy(scene.fog.color);
  u.top.value.copy(_top).lerp(_topStorm.clone().multiplyScalar(0.18 + dayLight * 0.82), d);
  flashT = Math.max(0, flashT - dt * 3.2);
  distanceAtmosphere.color.value.copy(scene.fog.color);
  distanceAtmosphere.density.value = 1 + W.fog * 0.85;
  sun.intensity = (0.05 + dayLight * 1.37) * (1 - 0.65 * d) + flashT * 2.4;
  hemi.intensity = (0.035 + dayLight * 0.745) * (1 - 0.55 * d) + flashT * 1.2;
  sun.color.copy(_sunCol).lerp(new THREE.Color(0xffdda3), summerVisual()*dayLight*(1-d)*0.36);
  hemi.groundColor.setHex(0xeef1f4).lerp(new THREE.Color(0xd8ba8a), summerVisual()*0.65);
  roadMat.envMapIntensity = 0.45 + p * 0.6;   // 젖은 반사
  const wetBase = 1 - p * 0.32;               // 젖은 노면(어둡게)
  // 겨울 첫 구간은 얇은 잔설. 눈이 내려도 원본 노면 맵과 네 줄의 마모 자국을 유지한다.
  const freshSnow = precipForm === 'snow' ? sstep(0.02, 0.75, p) : 0;
  roadSurfaceState.snowCover.value = lerp(visualWinter * 0.10 * scenicBlend(car.s), 0.90, freshSnow);
  roadSurfaceState.winterEdge.value = Math.max(visualWinter, freshSnow);
  roadMat.roughness = precipForm === 'snow' ? 0.94 : 1 - p * 0.6;
  roadMat.color.setScalar(precipForm === 'snow' ? 1 : wetBase);
  if (d > 0.45 && p > 0.55) { // 번개 + 천둥
    ltAcc += dt * (0.16 + W.wind * 0.18);
    if (ltAcc > 1) {
      ltAcc = 0; flashT = 1;
      if (flashEl) { flashEl.style.opacity = 0.7; setTimeout(() => flashEl.style.opacity = 0, 110); }
      setTimeout(thunder, 250 + Math.random() * 1300);
    }
  }
  updatePrecip(dt);
}
function updatePrecip(dt) {
  const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
  const snowOn = precipForm === 'snow' && W.precip > 0.02;
  const rainOn = precipForm === 'rain' && W.precip > 0.02;
  snowPts.visible = snowOn; rainLines.visible = rainOn;
  if (snowOn) {
    snowGeo.setDrawRange(0, Math.floor(SNOW_N * Math.min(1, W.precip * 1.15)));
    const fall = (1.3 + W.wind * 2.5) * dt, drift = W.wind * 7 * dt, now = performance.now() * 0.001;
    for (let i = 0; i < SNOW_N; i++) {
      let x = snowPos[i*3] + Math.sin(snowPhase[i] + now) * 0.6 * dt + drift;
      let y = snowPos[i*3+1] - fall;
      let z = snowPos[i*3+2];
      if (y < cy - 5) y = cy + 22;
      if (x < cx - 35) x += 70; else if (x > cx + 35) x -= 70;
      if (z < cz - 35) z += 70; else if (z > cz + 35) z -= 70;
      snowPos[i*3] = x; snowPos[i*3+1] = y; snowPos[i*3+2] = z;
    }
    snowGeo.attributes.position.needsUpdate = true;
  }
  if (rainOn) {
    rainGeo.setDrawRange(0, Math.floor(RAIN_N * W.precip));
    const fall = (21 + W.wind * 4) * dt, drift = W.wind * 12 * dt;
    for (let i = 0; i < RAIN_N; i++) {
      let x = rainPos[i*6] + drift, y = rainPos[i*6+1] - fall, z = rainPos[i*6+2];
      const len = 0.5 + W.wind * 0.35;
      if (y < cy - 5) { y = cy + 22; x = cx + (Math.random()-0.5)*60; z = cz + (Math.random()-0.5)*60; }
      if (x < cx - 32) x += 64; else if (x > cx + 32) x -= 64;
      if (z < cz - 32) z += 64; else if (z > cz + 32) z -= 64;
      rainPos[i*6] = x; rainPos[i*6+1] = y; rainPos[i*6+2] = z;
      rainPos[i*6+3] = x + drift * 2; rainPos[i*6+4] = y + len; rainPos[i*6+5] = z;
    }
    rainGeo.attributes.position.needsUpdate = true;
  }
}

function roadGripMul() {
  const p = W.precip;
  if (p < 0.02 || precipForm === 'none') return 1;
  return precipForm === 'snow' ? 1 - 0.45 * p : 1 - 0.3 * p; // 눈: 최대 -45%, 비: 최대 -30%
}

/* ---------------- 앞유리 빗물과 자동 와이퍼 ---------------- */
const windCanvas = document.getElementById('wscan'), windCtx = windCanvas.getContext('2d');
const drops = [];
// 폴백 캐빈의 유리 안쪽 경계. GLB 로드 후 실제 앞유리 면으로 교체한다.
let windshieldLocal = [
  new THREE.Vector3(-0.68, 0.68, -0.96), new THREE.Vector3(0.68, 0.68, -0.96),
  new THREE.Vector3(0.68, 1.22, -0.55), new THREE.Vector3(-0.68, 1.22, -0.55)
];
let wipePhase = 0, lastWipeAngle = 0.08;
const glassScratch = new THREE.Vector3(), glassCamera = new THREE.Vector3();
const glassInverse = new THREE.Matrix4(), glassDirection = new THREE.Vector3();
function fitWindshieldGlass() {
  bodyGroup.updateWorldMatrix(true, true);
  const inverse = bodyGroup.matrixWorld.clone().invert(), vertices = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), normal = new THREE.Vector3();
  for (const mesh of glassMeshes) {
    const positions = mesh.geometry.attributes.position, index = mesh.geometry.index;
    const transform = new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld);
    const count = index ? index.count : positions.count;
    for (let i = 0; i < count; i += 3) {
      a.fromBufferAttribute(positions, index ? index.getX(i) : i).applyMatrix4(transform);
      b.fromBufferAttribute(positions, index ? index.getX(i+1) : i+1).applyMatrix4(transform);
      c.fromBufferAttribute(positions, index ? index.getX(i+2) : i+2).applyMatrix4(transform);
      normal.crossVectors(ab.subVectors(b,a), ac.subVectors(c,a)).normalize();
      // 뒷유리·측면 유리·두께 가장자리를 제외하고 앞쪽 경사면만 선택한다.
      if ((a.z+b.z+c.z)/3 < -0.55 && Math.abs(normal.z) > 0.35 && Math.abs(normal.y) > 0.5 && Math.abs(normal.x) < 0.4) {
        vertices.push(a.clone(), b.clone(), c.clone());
      }
    }
  }
  if (vertices.length < 3) return;
  vertices.sort((a,b) => a.x-b.x || a.y-b.y);
  const cross = (a,b,c) => (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
  const half = points => {
    const result = [];
    for (const p of points) {
      while (result.length > 1 && cross(result[result.length-2],result[result.length-1],p) <= 1e-8) result.pop();
      result.push(p);
    }
    return result;
  };
  const lower = half(vertices), upper = half(vertices.slice().reverse());
  lower.pop(); upper.pop();
  const hull = lower.concat(upper);
  if (hull.length < 3) return;
  const center = hull.reduce((sum,p) => sum.add(p), new THREE.Vector3()).divideScalar(hull.length);
  // 도장 프레임과 유리 두께까지 덮지 않도록 유리 안쪽에 안전 여백을 둔다.
  windshieldLocal = hull.map(p => p.clone().lerp(center, 0.045));
}
function updateWipers(dt) {
  const w = innerWidth, h = innerHeight;
  if (windCanvas.width !== w || windCanvas.height !== h) { windCanvas.width = w; windCanvas.height = h; }
  const g = windCtx; g.clearRect(0, 0, w, h);
  bodyGroup.updateWorldMatrix(true, false);
  camera.updateMatrixWorld(true); // 렌더 전 최신 카메라 역행렬로 투영한다.
  glassInverse.copy(bodyGroup.matrixWorld).invert();
  glassCamera.copy(camera.position).applyMatrix4(glassInverse);
  camera.getWorldDirection(glassDirection).transformDirection(glassInverse);
  // 모드 번호만 믿지 않는다: 영화 시점 전환 중 실외 카메라에는 그리지 않는다.
  const realDash = camMode === 1 && Math.abs(glassCamera.x) < 0.78 &&
    glassCamera.y > 0.88 && glassCamera.y < 1.43 && glassCamera.z > -0.40 && glassCamera.z < 0.45 &&
    glassDirection.z < -0.94;
  if (!realDash || precipForm !== 'rain' || W.precip <= 0.02) {
    drops.length = 0; lastWipeAngle = 0.08; return;
  }
  const project = p => {
    glassScratch.copy(p).applyMatrix4(bodyGroup.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
    if (glassScratch.z >= -camera.near) return null;
    glassScratch.applyMatrix4(camera.projectionMatrix);
    return {x:(glassScratch.x+1)*w*0.5, y:(1-glassScratch.y)*h*0.5};
  };
  const polygon = windshieldLocal.map(project);
  if (polygon.some(p => !p || !Number.isFinite(p.x+p.y))) { drops.length = 0; return; }
  const minY = Math.min(...windshieldLocal.map(p=>p.y)), maxY = Math.max(...windshieldLocal.map(p=>p.y));
  const height = maxY-minY;
  // 높이별 실제 유리 윤곽을 보간한다. 물방울과 피벗은 화면이 아니라 차체에 붙는다.
  const atHeight = (u,y) => {
    const hits = [];
    for (let i=0;i<windshieldLocal.length;i++) {
      const a=windshieldLocal[i],b=windshieldLocal[(i+1)%windshieldLocal.length];
      if (Math.abs(a.y-b.y)<1e-8) continue;
      const t=(y-a.y)/(b.y-a.y);
      if (t>=0 && t<=1) hits.push(a.clone().lerp(b,t));
    }
    hits.sort((a,b)=>a.x-b.x);
    return hits.length>1 ? hits[0].lerp(hits[hits.length-1],u) : null;
  };
  const surface = (x,y) => {
    const left=atHeight(0,clamp(y,minY+1e-6,maxY-1e-6));
    const right=atHeight(1,clamp(y,minY+1e-6,maxY-1e-6));
    if (!left || !right) return null;
    return left.lerp(right,(x-left.x)/Math.max(1e-6,right.x-left.x));
  };
  // 2D 오버레이에도 실내 소품의 깊이 가림을 적용한다. 유리 뒤쪽의 계기판이
  // 유리와 화면상 겹칠 수 있으므로 유리 윤곽만 클리핑하면 충분하지 않다.
  const occluders = [dash, cluster, steer].filter(mesh=>mesh.visible).map(mesh=>{
    mesh.updateWorldMatrix(true,false);
    mesh.geometry.computeBoundingBox();
    const box=mesh.geometry.boundingBox, pts=[];
    for (const x of [box.min.x,box.max.x]) for (const y of [box.min.y,box.max.y]) for (const z of [box.min.z,box.max.z]) {
      const p=new THREE.Vector3(x,y,z).applyMatrix4(mesh.matrixWorld).applyMatrix4(glassInverse);
      const screen=project(p); if(screen)pts.push(screen);
    }
    pts.sort((a,b)=>a.x-b.x || a.y-b.y);
    const cross=(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
    const half=points=>{const out=[];for(const p of points){while(out.length>1 && cross(out[out.length-2],out[out.length-1],p)<=0)out.pop();out.push(p);}return out;};
    const lo=half(pts),hi=half(pts.slice().reverse());lo.pop();hi.pop();return lo.concat(hi);
  }).filter(points=>points.length>=3);
  const inside=(p,points)=>{let hit=false;for(let i=0,j=points.length-1;i<points.length;j=i++){
    const a=points[i],b=points[j];if((a.y>p.y)!==(b.y>p.y) && p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)hit=!hit;
  }return hit;};
  const occluded=p=>occluders.some(points=>inside(p,points));
  g.save(); g.beginPath(); polygon.forEach((p,i)=>i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y)); g.closePath(); g.clip();
  for (const points of occluders) {
    g.beginPath();g.rect(0,0,w,h);points.forEach((p,i)=>i?g.lineTo(p.x,p.y):g.moveTo(p.x,p.y));g.closePath();g.clip('evenodd');
  }
  const count = Math.floor(W.precip * dt * 230) + (Math.random() < W.precip * dt * 230 % 1 ? 1 : 0);
  for (let i=0;i<count && drops.length<380;i++) {
    const p=atHeight(Math.random(),lerp(minY+height*0.015,maxY-height*0.015,Math.random()));
    if (p) drops.push({x:p.x,y:p.y,r:1.5+Math.random()*4,life:8});
  }
  wipePhase += dt * (W.precip < 0.4 ? 0.23 : 0.7 + W.precip * 0.6);
  const phase = wipePhase % 1, active = W.precip >= 0.4 || phase < 0.4;
  const cycle = W.precip < 0.4 ? phase / 0.4 : phase;
  const angle = active ? 0.08 + Math.sin(cycle * Math.PI) * 1.38 : 0.08;
  // 실내가 가리는 하단은 보이는 유리의 하단까지 피벗을 올린다.
  const pivots = [0.24,0.60].map(u=>{
    for(let v=0.025;v<0.85;v+=0.015){const p=atHeight(u,minY+height*v),screen=p && project(p);
      if(screen && !occluded(screen) && !occluded({x:screen.x,y:screen.y+3}))return p;
    }
    return null;
  }).filter(Boolean);
  const length = height*0.72;
  for (let i=drops.length-1;i>=0;i--) {
    const d=drops[i]; d.life-=dt; d.y-=dt*(0.003+d.r*0.002); d.x+=W.wind*dt*0.008;
    const left=atHeight(0,d.y),right=atHeight(1,d.y);
    let swept=false;
    if (active) for (const p of pivots) {
      const dx=d.x-p.x,dy=d.y-p.y,a=Math.atan2(dy,dx);
      if (Math.hypot(dx,dy)<length && a>=Math.min(angle,lastWipeAngle)-0.07 && a<=Math.max(angle,lastWipeAngle)+0.07) swept=true;
    }
    if (swept || d.life<=0 || !left || !right || d.x<left.x || d.x>right.x) { drops.splice(i,1); continue; }
    const p=surface(d.x,d.y),screen=p && project(p);
    if (!screen) continue;
    g.beginPath(); g.ellipse(screen.x,screen.y,d.r,d.r*1.6,0,0,Math.PI*2);
    g.fillStyle='rgba(150,190,215,0.13)'; g.fill();
    g.strokeStyle='rgba(210,234,248,0.48)'; g.lineWidth=0.8; g.stroke();
    g.beginPath(); g.moveTo(screen.x-d.r*0.35,screen.y-d.r); g.lineTo(screen.x-d.r*0.35,screen.y); g.stroke();
  }
  for (const pivot of pivots) {
    const end=surface(pivot.x+Math.cos(angle)*length,pivot.y+Math.sin(angle)*length);
    const p=project(pivot),tip=end && project(end);
    if (!p || !tip) continue;
    g.beginPath();g.arc(p.x,p.y,3.5,0,Math.PI*2);g.fillStyle='#171e26';g.fill();
    g.beginPath(); g.moveTo(p.x,p.y); g.lineTo(tip.x,tip.y); g.strokeStyle='rgba(9,13,18,0.95)'; g.lineWidth=3; g.lineCap='round'; g.stroke();
    g.beginPath(); g.moveTo(lerp(p.x,tip.x,0.47),lerp(p.y,tip.y,0.47)); g.lineTo(tip.x,tip.y); g.strokeStyle='#171e26'; g.lineWidth=5; g.stroke();
    g.beginPath(); g.moveTo(p.x,p.y); g.lineTo(tip.x,tip.y); g.strokeStyle='rgba(167,184,197,0.4)'; g.lineWidth=1; g.stroke();
  }
  lastWipeAngle=angle;
  g.restore();
}

/* ==================== 사운드 (절차적 Web Audio) ==================== */
let AC = null, master = null, engineBus = null, muted = false, thunderBuf = null;
let engineVolume = 1;
const snd = {};
document.getElementById('sEngine').addEventListener('input', e => {
  engineVolume = Number(e.target.value) / 100;
  document.getElementById('engineVolumeValue').textContent = Math.round(engineVolume * 100) + '%';
  if (AC && engineBus) {
    engineBus.gain.cancelScheduledValues(AC.currentTime);
    engineBus.gain.setTargetAtTime(engineVolume, AC.currentTime, 0.04);
  }
});
const ENGINE_AUDIO = './assets/sounds/engine-loop-1-normalized.wav';
const engineDecoded = (async () => {
  const response = await fetch(ENGINE_AUDIO);
  if (!response.ok) throw new Error('엔진 음원 응답 ' + response.status);
  const Decoder = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const decoder = new Decoder(2, 44100, 44100);
  const buffer = await decoder.decodeAudioData(await response.arrayBuffer());
  window.__engineDecoded = true;
  return buffer;
})();
engineDecoded.catch(error => console.warn('엔진 디코딩 실패', error));
async function loadRecordedEngine() {
  try {
    const original = await engineDecoded;
    if (snd.recorded) return;
    const fade = Math.floor(original.sampleRate * 0.045), count = original.length - fade;
    const buffer = AC.createBuffer(original.numberOfChannels, count, original.sampleRate);
    for (let channel = 0; channel < original.numberOfChannels; channel++) {
      const from = original.getChannelData(channel), to = buffer.getChannelData(channel);
      to.set(from.subarray(fade, fade + count));
      for (let i = 0; i < fade; i++) {
        const k = i / fade;
        to[count-fade+i] = from[original.length-fade+i] * (1-k) + from[i] * k;
      }
    }
    const source = AC.createBufferSource(), gain = AC.createGain();
    source.buffer = buffer; source.loop = true; gain.gain.value = 0.16;
    source.connect(gain); gain.connect(engineBus); source.start();
    snd.recorded = { source, gain }; snd.eng.g.gain.value = 0;
    window.__engineLoaded = true;
  } catch (error) { console.warn(error); toast('엔진 녹음 로딩 실패 · 기본 소리 사용'); }
}
function noiseBuffer(ctx) {
  const b = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
const JAZZ_AUDIO = './assets/sounds/backbay-lounge.mp3';
const BOSSA_AUDIO = './assets/sounds/bossa-antigua.mp3';
// 공식 다운로드: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Bossa%20Antigua.mp3
// Bossa Antigua — Kevin MacLeod (incompetech.com), CC BY 4.0. 원곡이나 커버가 아닌 별도 곡.
const MUSIC_TRACKS = {
  jazz: { audio: JAZZ_AUDIO, title: 'Backbay Lounge', source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1700068&Search=Search' },
  bossa: { audio: BOSSA_AUDIO, title: 'Bossa Antigua', source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1700069&Search=Search' }
};
let musicTrack = MUSIC_TRACKS[RUN.get('track')] ? RUN.get('track') : 'jazz';
const jazz = new Audio(MUSIC_TRACKS[musicTrack].audio);
jazz.loop = true; jazz.preload = 'auto'; jazz.volume = 0.32;
let musicEnabled = true, musicVolume = 0.32, musicStarting = false;
const musicButton = document.getElementById('bMusic');
const musicStartButton = document.getElementById('bStartMusic');
const trackSelect = document.getElementById('sTrack');
function musicStartLabel(message) {
  if (message) return message;
  return document.documentElement.classList.contains('touch') ? '▶ 소리 켜기' : '▶ 전체 소리 켜기 · 눌러서 시작';
}
function updateMusicStatus(message) {
  const playing = musicEnabled && !muted && !jazz.paused;
  musicButton.textContent = message || (playing ? '음악 끄기' : '음악 재생');
  musicStartButton.style.display = playing || !musicEnabled ? 'none' : 'block';
  musicStartButton.textContent = musicStartLabel(message);
}
function syncMusic() {
  jazz.volume = muted || !musicEnabled ? 0 : musicVolume;
  if (!musicEnabled || muted) { jazz.pause(); updateMusicStatus(); return; }
  if (jazz.paused && !musicStarting) {
    musicStarting = true;
    updateMusicStatus('음악 불러오는 중…');
    jazz.play().then(() => updateMusicStatus()).catch(e => {
      updateMusicStatus(e.name === 'NotAllowedError' ? '▶ 눌러서 음악 시작' : '음악 재생 실패 · 눌러서 다시 시도');
    }).finally(() => { musicStarting = false; });
  } else if (!musicStarting) updateMusicStatus();
}
function startMusic() {
  musicEnabled = true; muted = false;
  if (master) master.gain.value = 0.55;
  if (musicVolume === 0) { musicVolume = 0.32; document.getElementById('sMusic').value = 32; }
  syncMusic(); initAudio();
}
function updateMusicCredit() {
  const track = MUSIC_TRACKS[musicTrack], credit = document.getElementById('musicCredit');
  credit.textContent = track.title + ' — Kevin MacLeod (incompetech.com)';
  credit.href = track.source;
  trackSelect.value = musicTrack;
}
function selectMusicTrack(id) {
  if (!MUSIC_TRACKS[id] || id === musicTrack) return;
  jazz.pause();
  musicTrack = id;
  jazz.src = MUSIC_TRACKS[id].audio;
  jazz.load();
  updateMusicCredit();
  syncMusic();
}
trackSelect.addEventListener('change', e => selectMusicTrack(e.target.value));
jazz.addEventListener('error', () => { updateMusicStatus('음악 로딩 실패 · 다시 시도'); toast('음악 로딩 실패 · 다른 곡을 선택해 주세요'); });
jazz.addEventListener('playing', () => updateMusicStatus());
updateMusicCredit();
updateMusicStatus();
musicStartButton.onclick = startMusic;
musicButton.onclick = () => { if (jazz.paused || muted) startMusic(); else { musicEnabled = false; syncMusic(); } };
document.getElementById('sMusic').addEventListener('input', e => { musicVolume = Number(e.target.value) / 100; syncMusic(); });
function initAudio() {
  syncMusic();
  if (!AC) {
    try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    master = AC.createGain(); master.gain.value = 0.55; master.connect(AC.destination);
    engineBus = AC.createGain(); engineBus.gain.value = engineVolume; engineBus.connect(master);
    const eng = AC.createOscillator(); eng.type = 'sawtooth'; eng.frequency.value = 60;
    const eng2 = AC.createOscillator(); eng2.type = 'square'; eng2.frequency.value = 30;
    const engLP = AC.createBiquadFilter(); engLP.type = 'lowpass'; engLP.frequency.value = 320; engLP.Q.value = 2.5;
    const engG = AC.createGain(); engG.gain.value = 0.0;
    eng.connect(engLP); eng2.connect(engLP); engLP.connect(engG); engG.connect(engineBus); eng.start(); eng2.start();
    snd.eng = { o1: eng, o2: eng2, g: engG, lp: engLP };
    const nb = noiseBuffer(AC);
    const chain = (type, freq, q) => {
      const s = AC.createBufferSource(); s.buffer = nb; s.loop = true;
      const f = AC.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = AC.createGain(); g.gain.value = 0;
      s.connect(f); f.connect(g); g.connect(master); s.start();
      return { f, g };
    };
    snd.wind = chain('lowpass', 420, 0.6);
    snd.rain = chain('highpass', 1400, 0.5);
    snd.skid = chain('bandpass', 900, 1.6);
    loadRecordedEngine();
  }
  if (AC.state === 'suspended' || AC.state === 'interrupted') {
    AC.resume().catch(() => { musicStartButton.style.display = 'block'; musicStartButton.textContent = musicStartLabel('▶ 다시 눌러 시작'); });
  }
}
function toggleMute() { muted = !muted; if (master) master.gain.value = muted ? 0 : 0.55; syncMusic(); toast(muted ? '소리 끔' : '소리 켬'); }
function updateSound() {
  if (!AC || muted || !snd.eng) return;
  const t = AC.currentTime, sp = Math.hypot(car.vx, car.vz), rpm = Math.min(1, sp / 42);
  snd.eng.o1.frequency.setTargetAtTime(55 + rpm * 145 + Math.abs(car.accelSm) * 6, t, 0.08);
  snd.eng.o2.frequency.setTargetAtTime(28 + rpm * 72, t, 0.08);
  snd.eng.lp.frequency.setTargetAtTime(240 + rpm * 1400, t, 0.1);
   snd.eng.g.gain.setTargetAtTime(snd.recorded ? 0 : sp > 0.3 ? 0.05 + rpm * 0.1 : 0.03, t, 0.1);
   if (snd.recorded) {
     snd.recorded.source.playbackRate.setTargetAtTime(0.72 + rpm * 1.15 + Math.abs(car.accelSm) * 0.08, t, 0.12);
     snd.recorded.gain.gain.setTargetAtTime((0.11 + rpm * 0.15) * (camMode === 1 ? 0.68 : 1), t, 0.15);
   }
  snd.wind.g.gain.setTargetAtTime(Math.min(0.16, sp * 0.004) + W.wind * 0.1, t, 0.2);
  snd.rain.g.gain.setTargetAtTime(W.precip * (precipForm === 'snow' ? 0.01 : 0.13), t, 0.3);
  snd.skid.g.gain.setTargetAtTime(car.slip > 2.2 ? Math.min(0.12, car.slip * 0.03) : 0, t, 0.06);
}
function thunder() {
  if (!AC || muted) return;
  if (!thunderBuf) thunderBuf = noiseBuffer(AC);
  const src = AC.createBufferSource(); src.buffer = thunderBuf;
  const f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 140; f.Q.value = 0.8;
  const g = AC.createGain(); const t = AC.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.7, t + 0.06);
  g.gain.exponentialRampToValueAtTime(0.001, t + 2.6);
  src.connect(f); f.connect(g); g.connect(master); src.start(t); src.stop(t + 2.7);
}

/* 날씨 패널 연결 */
let weatherName = 'clear';
function setPreset(name) {
  const p = PRESETS[name]; if (!p) return;
  weatherName = name;
  precipForm = p.form;
  Wui.precip = p.precip; Wui.wind = p.wind; Wui.fog = p.fog; Wui.dark = p.dark;
  const map = { sPrecip: 'precip', sWind: 'wind', sFog: 'fog', sDark: 'dark' };
  for (const id in map) { const el = document.getElementById(id); if (el) el.value = Wui[map[id]]; }
  document.querySelectorAll('#wpanel button[data-w]').forEach(b => b.classList.toggle('on', b.dataset.w === name));
}
document.querySelectorAll('#wpanel button[data-w]').forEach(b => b.onclick = () => { stopNature(); setPreset(b.dataset.w); });
for (const [id, kk] of [['sPrecip','precip'],['sWind','wind'],['sFog','fog'],['sDark','dark']]) {
  const el = document.getElementById(id); if (!el) continue;
  el.addEventListener('input', () => { stopNature(); Wui[kk] = +el.value; if (kk === 'precip' && Wui.precip > 0 && precipForm === 'none') precipForm = 'snow'; });
}
function toggleAuto() {
  auto24 = !auto24;
  if (auto24 && timeFlow === 0) { timeFlow = 90; const f = document.getElementById('sFlow'); if (f) f.value = 38; }
  const b = document.getElementById('bAuto'); if (b) b.classList.toggle('on', auto24);
  toast(auto24 ? '24시간 자율주행 시작' : '자율주행 해제');
}
document.getElementById('sTime').addEventListener('input', e => { timeOfDay = +e.target.value % 24; });
document.getElementById('sFlow').addEventListener('input', e => { timeFlow = +e.target.value / 100 * 240; });
document.getElementById('bAuto').onclick = toggleAuto;
const mountainBaseColors = mountainTiles.map(tile => tile.children[0].geometry.attributes.color.array.slice());
function setSeasonImmediate(name) {
  if (!SEASONS[name]) return;
  season = name;
  const palette = SEASONS[name];
  PAL.dayTop.setHex(palette.sky);
  PAL.dayHor.setHex(name === 'winter' ? 0xc8d9e6 : name === 'autumn' ? 0xd6d0bc : name === 'summer' ? 0xf3dfbc : 0xc4d9df);
  const fresh = [buildBareGeo(0),buildBareGeo(1),buildBareGeo(2),buildConiferGeo(0),buildConiferGeo(1),buildBareGeo(0,true),buildBareGeo(1,true),buildSnowRockGeo(),buildPalmGeo()];
  // 건물(kind 9, 10)은 계절과 무관해 fresh에 포함하지 않는다 — 기존 지오메트리를 그대로 둔다.
  plantPools.forEach((pool,i)=>{ if (i >= fresh.length) return; pool.geometry.dispose(); pool.geometry=fresh[i]; });
  bandMesh.geometry.dispose(); bandMesh.geometry=buildRailBandGeo();
  for (const [s,seg] of segments) {
    seg.terMesh.geometry.dispose(); seg.terMesh.geometry=buildTerrainGeo(s*SEG);
  }
  mountainTiles.forEach((tile,i)=>{
    const colors=tile.children[0].geometry.attributes.color, base=mountainBaseColors[i];
    for(let j=0;j<colors.count;j++) {
      const bright=base[j*3]*0.3+base[j*3+1]*0.5+base[j*3+2]*0.2;
      const rock=bright<0.5;
      const ridge = tile.userData.layer;
      const summerRidge = ridge === 0 ? [0.26,0.38,0.33] : ridge === 1 ? [0.30,0.34,0.51] : [0.38,0.40,0.58];
      const rgb=name==='winter' ? [base[j*3],base[j*3+1],base[j*3+2]] : name==='summer' ? summerRidge.map(v=>v*(0.88+bright*.18)) : rock ? [bright*.70,bright*.68,bright*.63] : palette.ground.map(v=>v*(0.85+bright*.3));
      colors.setXYZ(j,...rgb);
    }
    colors.needsUpdate=true;
  });
  dirtyPools=true;
  document.querySelectorAll('[data-season]').forEach(b=>b.classList.toggle('on',b.dataset.season===name));
  toast(palette.name+' 풍경');
}
// 화면을 덮는 전환 효과 없이 실제 재질·식생·지형을 보간한다.
function fadePlantMaterial(material, fade) {
  const copy = material.clone();
  copy.onBeforeCompile = shader => {
    shader.uniforms.seasonFade = fade;
    shader.fragmentShader = 'uniform float seasonFade;\n' + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
      float seasonalNoise=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
      if(seasonalNoise>seasonFade)discard;`);
  };
  copy.customProgramCacheKey = ()=>'season-fade';
  return copy;
}
function setSeason(name) {
  if (!SEASONS[name]) return;
  if (seasonTransition) { queuedSeason = name; toast(SEASONS[name].name+' 전환 대기'); return; }
  if (season === name) return;
  const from = season;
  const oldMeshes = [...plantPools,bandMesh].map(mesh=>{
    const fade={value:1}, old=mesh.clone();
    old.geometry=mesh.geometry.clone(); old.material=fadePlantMaterial(mesh.material,fade);
    old.instanceMatrix=mesh.instanceMatrix.clone();
    if(mesh.instanceColor)old.instanceColor=mesh.instanceColor.clone();
    old.castShadow=false; scene.add(old);
    return {old,source:mesh,fade};
  });
  const mountainFrom=mountainTiles.map(tile=>tile.children[0].geometry.attributes.color.array.slice());
  const skyFrom=PAL.dayTop.clone(), horizonFrom=PAL.dayHor.clone();
  setSeasonImmediate(name);
  const mountainTo=mountainTiles.map(tile=>tile.children[0].geometry.attributes.color.array.slice());
  const skyTo=PAL.dayTop.clone(), horizonTo=PAL.dayHor.clone();
  const newMaterials=[...plantPools,bandMesh].map(mesh=>{
    const original=mesh.material, fade={value:0};
    mesh.material=fadePlantMaterial(original,fade);
    return {mesh,original,fade};
  });
  seasonTransition={from,to:name,elapsed:0,blend:0,duration:natureAuto ? 35 : seasonDuration,oldMeshes,newMaterials,mountainFrom,mountainTo,skyFrom,skyTo,horizonFrom,horizonTo};
  updateSeason(0);
  toast(SEASONS[from].name+' → '+SEASONS[name].name+' · 풍경 변화');
}
function updateSeason(dt) {
  const t=seasonTransition;
  if (!t) return;
  t.elapsed+=dt;
  const linear=clamp(t.elapsed/(t.duration || seasonDuration),0,1);
  t.blend=linear*linear*(3-2*linear);
  visualWinter=lerp(t.from==='winter'?1:0,t.to==='winter'?1:0,t.blend);
  PAL.dayTop.lerpColors(t.skyFrom,t.skyTo,t.blend);
  PAL.dayHor.lerpColors(t.horizonFrom,t.horizonTo,t.blend);
  for(const [id,seg] of segments){
    const color=seg.terMesh.geometry.attributes.color;
    const rows=7,nC=TCOLS.length;
    for(let j=0;j<rows;j++)for(let i=0;i<nC;i++)color.setXYZ(j*nC+i,...snowColor(id*SEG+(j-1)*6,TCOLS[i]));
    color.needsUpdate=true;
  }
  mountainTiles.forEach((tile,i)=>{
    const attribute=tile.children[0].geometry.attributes.color;
    for(let j=0;j<attribute.array.length;j++)attribute.array[j]=lerp(t.mountainFrom[i][j],t.mountainTo[i][j],t.blend);
    attribute.needsUpdate=true;
  });
  for(const {old,source,fade} of t.oldMeshes){
    fade.value=1-t.blend;
    old.count=source.count; old.instanceMatrix.array.set(source.instanceMatrix.array); old.instanceMatrix.needsUpdate=true;
    if(old.instanceColor&&source.instanceColor){old.instanceColor.array.set(source.instanceColor.array);old.instanceColor.needsUpdate=true;}
  }
  t.newMaterials.forEach(item=>item.fade.value=t.blend);
  if(linear>=1){
    t.oldMeshes.forEach(({old})=>{scene.remove(old);old.geometry.dispose();old.material.dispose();});
    t.newMaterials.forEach(({mesh,original})=>{mesh.material.dispose();mesh.material=original;});
    seasonTransition=null;
    toast(SEASONS[season].name+' 풍경');
    const next=queuedSeason;queuedSeason=null;
    if(next&&next!==season)setSeason(next);
  }
}
document.querySelectorAll('[data-season]').forEach(b=>b.onclick=()=>{stopNature();setSeason(b.dataset.season);});
function stopNature() {
  natureAuto=false;weatherTransition=null;queuedSeason=null;
  const b=document.getElementById('bNature'); if(b){b.classList.remove('on');b.textContent='자동 풍경 순환';}
}
function startWeatherChange(name) {
  const target=PRESETS[name];
  weatherTransition={elapsed:0,from:{...Wui},target,name,oldForm:precipForm};
}
function updateNature(dt) {
  if(!natureAuto) return;
  const hours=timeFlow*dt/3600;
  natureHours+=hours;weatherHours+=hours;
  if(natureHours>=48){
    natureHours%=48;natureSeasonIndex=(natureSeasonIndex+1)%4;
    setSeason(SEASON_ORDER[natureSeasonIndex]);
    weatherHours=0;weatherStep=0;startWeatherChange('clear');
  }
  if(weatherHours>=6){
    weatherHours%=6;weatherStep++;
    const list=NATURAL_WEATHER[SEASON_ORDER[natureSeasonIndex]];
    startWeatherChange(list[weatherStep%list.length]);
  }
  const t=weatherTransition;
  if(t){
    t.elapsed+=dt;const progress=clamp(t.elapsed/25,0,1),smooth=progress*progress*(3-2*progress);
    const switchForm=t.oldForm!==t.target.form;
    for(const kk of ['precip','wind','fog','dark']){
      if(kk==='precip'&&switchForm){
        if(progress<.5){Wui.precip=lerp(t.from.precip,0,sstep(0,.45,progress));}
        else {precipForm=t.target.form;Wui.precip=lerp(0,t.target.precip,sstep(.55,1,progress));}
      }else Wui[kk]=lerp(t.from[kk],t.target[kk],smooth);
    }
    for(const [id,kk] of [['sPrecip','precip'],['sWind','wind'],['sFog','fog'],['sDark','dark']])document.getElementById(id).value=Wui[kk];
    if(progress>=1){setPreset(t.name);weatherTransition=null;}
  }
  document.getElementById('sTime').value=timeOfDay;
}
document.getElementById('bNature').onclick=()=>{
  if(natureAuto){stopNature();toast('풍경 순환 해제 · 현재 풍경 유지');return;}
  natureAuto=true;natureHours=0;weatherHours=0;weatherStep=0;
  natureSeasonIndex=SEASON_ORDER.indexOf(season);
  if(timeFlow===0){timeFlow=240;document.getElementById('sFlow').value=100;}
  if(!auto24)toggleAuto();
  const b=document.getElementById('bNature');b.classList.add('on');b.textContent='자동 풍경 순환 중';
  toast('낮·밤 · 사계절 · 날씨 자동 순환');
};
function toggleCinema() {
  if(cinematic){
    cinematic=false;document.body.classList.remove('cinematic');
    document.getElementById('cinemaFade').style.opacity=0;
    const previous=cinemaRestore;
    auto24=previous.auto24;timeFlow=previous.timeFlow;camMode=previous.camMode;
    natureAuto=previous.natureAuto;
    if(!natureAuto)weatherTransition=null;
    musicEnabled=previous.musicEnabled;syncMusic();
    document.getElementById('bMusic').textContent=musicEnabled?'음악 켜짐':'음악 꺼짐';
    document.getElementById('wpanel').style.display=previous.panel;
    document.getElementById('bAuto').classList.toggle('on',auto24);
    const natureButton=document.getElementById('bNature');natureButton.classList.toggle('on',natureAuto);natureButton.textContent=natureAuto?'자동 풍경 순환 중':'자동 풍경 순환';
    document.getElementById('sFlow').value=timeFlow/240*100;
    applyCamMode();snapNext=true;return;
  }
  cinemaRestore={auto24,timeFlow,camMode,natureAuto,musicEnabled,panel:document.getElementById('wpanel').style.display};
  if(!natureAuto)document.getElementById('bNature').onclick();
  auto24=true;if(timeFlow===0)timeFlow=240;
  cinematic=true;cinemaElapsed=0;cinemaShot=-1;
  musicEnabled=true;syncMusic();
  document.getElementById('wpanel').style.display='none';
  document.body.classList.add('cinematic');
}
// 명시적인 재시작만 초기화한다. 보통 여름 진입도 동일한 공통 해안 도로에서 시작한다.
document.getElementById('bCoast').onclick=()=>{
  const target=new URL(location.href);
  target.search='';
  for(const [key,value] of Object.entries({seed:'42',season:'summer',coast:'1',auto:'1',time:'16',track:'bossa'}))target.searchParams.set(key,value);
  location.assign(target.href);
};
let crtEnabled = true;
function setCRT(enabled) {
  crtEnabled = enabled;
  document.body.classList.toggle('crt', enabled);
  const b = document.getElementById('bCRT');
  b.classList.toggle('on', enabled); b.setAttribute('aria-pressed', String(enabled));
  b.textContent = '90년대 브라운관 필터 · ' + (enabled ? '켜짐' : '꺼짐');
}
document.getElementById('bCRT').onclick = () => setCRT(!crtEnabled);
setCRT(true);
document.getElementById('bCinema').onclick=toggleCinema;
document.getElementById('exitCinema').onclick=toggleCinema;
setSeasonImmediate(season);
setPreset(RUN.get('weather') || 'clear');
if (RUN.has('time')) timeOfDay = Number(RUN.get('time')) % 24;
if (RUN.has('auto')) auto24 = true;

/* ---------------- 메인 루프 ---------------- */
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05); // 탭 전환 등 긴 프레임 방지
  if (mapPreview) car.s = clamp(previewS, 0, PREVIEW_SPAN);
  if (!mapPreview) updateVehicle(dt);
  ensureSegments();
  if (dirtyPools) { dirtyPools = false; rebuildPools(); } // GLB 로드 완료 등 풀 재구성 필요 시
  updateEffects(dt);
  updateNature(dt);
  updateSeason(dt);
  updateWeather(dt);
  if (mapPreview) updatePreviewCamera();
  else updateCamera(dt, snapNext);
  snapNext = false;
  updateAnchors();
  updateHUD();
  updateSound();
  updateWipers(dt);
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
});

/* ---------------- 지형 고르기 ---------------- */
const MIX_KEYS = ['mountain', 'coast', 'city', 'river'];
function balanceMix(current, changed, value) {
  const next = { ...current };
  value = clamp(Math.round(value), 0, 100);
  const rest = 100 - value;
  const others = MIX_KEYS.filter(k => k !== changed);
  const otherSum = others.reduce((sum, k) => sum + next[k], 0);
  next[changed] = value;
  if (otherSum <= 0) {
    const base = Math.floor(rest / others.length);
    let used = 0;
    others.forEach((k, i) => {
      if (i === others.length - 1) next[k] = rest - used;
      else { next[k] = base; used += base; }
    });
  } else {
    let used = 0;
    others.forEach((k, i) => {
      if (i === others.length - 1) next[k] = rest - used;
      else {
        next[k] = Math.min(rest - used, Math.round(rest * next[k] / otherSum));
        used += next[k];
      }
    });
  }
  return next;
}
function mapQuery({ seed, mix, complex, drive }) {
  const q = new URLSearchParams(location.search);
  q.set('seed', String(seed));
  q.delete('startS');
  if (drive) q.set('drive', '1');
  else q.delete('drive');
  const def = mix.mountain === 50 && mix.coast === 22 && mix.city === 16 && mix.river === 12;
  if (def) q.delete('mix');
  else q.set('mix', [mix.mountain, mix.coast, mix.city, mix.river].join(','));
  if (complex === 50) q.delete('complex');
  else q.set('complex', String(complex));
  q.set('season', season);
  q.set('time', String(timeOfDay));
  q.set('weather', weatherName);
  return q;
}
function mapUrl(q) {
  const url = new URL(location.href);
  url.search = q.toString().replace(/%2C/g, ',');
  return url;
}
function assignMapQuery(q) {
  location.assign(mapUrl(q).href);
}
function drawMapStrip() {
  const canvas = document.getElementById('mpMap');
  if (!canvas) return;
  const cssW = canvas.clientWidth || 640;
  const cssH = 96;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const span = 8000, step = 40, n = span / step;
  const colors = { mountain: '#8ea4b8', coast: '#2f9ec4', city: '#e2a15a', river: '#4d6fd0' };
  const kinds = { mountain: 0, coast: 0, city: 0, river: 0 };
  const ys = [];
  for (let i = 0; i < n; i++) {
    const s = i * step + step * 0.5;
    const kind = terrainKind(s);
    kinds[kind]++;
    ys.push(roadYAt(s));
    ctx.fillStyle = colors[kind];
    ctx.fillRect(i * cssW / n, 0, cssW / n + 1, cssH);
  }
  let minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxY - minY < 1) { minY -= 1; maxY += 1; }
  ctx.beginPath();
  ys.forEach((y, i) => {
    const x = (i + 0.5) * cssW / n;
    const py = cssH - 12 - (y - minY) / (maxY - minY) * (cssH - 24);
    if (i === 0) ctx.moveTo(x, py);
    else ctx.lineTo(x, py);
  });
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = 2;
  ctx.stroke();
  const rounded = MIX_KEYS.map(k => Math.round(kinds[k] / n * 100));
  const drift = 100 - rounded.reduce((a, b) => a + b, 0);
  let biggest = 0;
  rounded.forEach((v, i) => { if (v > rounded[biggest]) biggest = i; });
  rounded[biggest] += drift;
  const labels = { mountain: '산', coast: '해안', city: '도시', river: '강' };
  const stats = document.getElementById('mpStats');
  if (stats) stats.textContent = '앞 8km · ' + MIX_KEYS.map((k, i) => labels[k] + ' ' + rounded[i] + '%').join(' · ');
}
function setupMapPicker() {
  const card = document.getElementById('mapPick');
  if (!card) return;
  document.documentElement.classList.add('map-preview');
  card.hidden = false;
  const seedEl = document.getElementById('mpSeed');
  if (seedEl) seedEl.textContent = String(WORLD_SEED);
  const sliderId = { mountain: 'mpMountain', coast: 'mpCoast', city: 'mpCity', river: 'mpRiver' };
  const outId = { mountain: 'mpMountainOut', coast: 'mpCoastOut', city: 'mpCityOut', river: 'mpRiverOut' };
  const readMix = () => {
    const mix = {};
    for (const k of MIX_KEYS) mix[k] = +document.getElementById(sliderId[k]).value;
    return mix;
  };
  const showMix = (mix, complex, skipKey) => {
    for (const k of MIX_KEYS) {
      if (k !== skipKey) document.getElementById(sliderId[k]).value = mix[k];
      document.getElementById(outId[k]).textContent = mix[k] + '%';
    }
    if (skipKey !== 'complex') document.getElementById('mpComplex').value = complex;
    document.getElementById('mpComplexOut').textContent = String(complex);
  };
  const reloadSame = () => {
    const mix = readMix();
    const complex = clamp(Math.round(+document.getElementById('mpComplex').value), 0, 100);
    const same = MIX_KEYS.every(k => mix[k] === MIX[k]) && complex === COMPLEX;
    if (same) return;
    assignMapQuery(mapQuery({ seed: WORLD_SEED, mix, complex, drive: false }));
  };
  showMix(MIX, COMPLEX);
  drawMapStrip();
  renderer.domElement.style.touchAction = 'none';
  const mapCanvas = document.getElementById('mpMap');
  const seekStrip = e => {
    const rect = mapCanvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    previewS = clamp((e.clientX - rect.left) / rect.width, 0, 1) * PREVIEW_SPAN;
  };
  mapCanvas.addEventListener('pointerdown', e => {
    e.stopPropagation();
    mapCanvas.setPointerCapture(e.pointerId);
    seekStrip(e);
  });
  mapCanvas.addEventListener('pointermove', e => { if (mapCanvas.hasPointerCapture(e.pointerId)) seekStrip(e); });
  for (const k of MIX_KEYS) {
    const el = document.getElementById(sliderId[k]);
    el.addEventListener('input', () => showMix(balanceMix(readMix(), k, +el.value), +document.getElementById('mpComplex').value, k));
    el.addEventListener('change', reloadSame);
  }
  const complexEl = document.getElementById('mpComplex');
  complexEl.addEventListener('input', () => { document.getElementById('mpComplexOut').textContent = complexEl.value; });
  complexEl.addEventListener('change', reloadSame);
  document.getElementById('mpReroll').onclick = () => {
    let seed = Math.floor(Math.random() * 1000000);
    if (seed === WORLD_SEED) seed = (seed + 1) % 1000000;
    const complex = clamp(Math.round(+complexEl.value), 0, 100);
    assignMapQuery(mapQuery({ seed, mix: readMix(), complex, drive: false }));
  };
  document.getElementById('mpDrive').onclick = () => {
    const complex = clamp(Math.round(+complexEl.value), 0, 100);
    const q = mapQuery({ seed: WORLD_SEED, mix: readMix(), complex, drive: true });
    history.replaceState(null, '', mapUrl(q));
    mapPreview = false;
    document.documentElement.classList.remove('map-preview');
    card.hidden = true;
    if (isTouch) {
      for (const id of ['tcJoyBase', 'tcHandbrake', 'tcGas', 'tcBrake']) {
        const el = document.getElementById(id);
        if (el) el.removeAttribute('aria-hidden');
      }
    }
    previewS = DEBUG_START_S;
    previewYaw = 0;
    previewPitch = -Math.atan2(PREVIEW_UP - 1.6, PREVIEW_BACK + PREVIEW_LOOK);
    const back = sampleAt(DEBUG_START_S);
    car.pos.set(back.x, 0, back.z);
    car.yaw = back.h;
    car.y = back.y + 0.02;
    car.s = DEBUG_START_S;
    car.vx = car.vz = car.vF = car.vR = 0;
    carGroup.position.set(car.pos.x, car.y, car.pos.z);
    carGroup.rotation.y = car.yaw;
    carGroup.updateMatrixWorld(true);
    renderer.domElement.style.touchAction = '';
    snapNext = true;
    updateCamera(0.016, true);
  };
}

/* ---------------- 부트 ---------------- */
const DEBUG_START_S = Number(RUN.get('startS')) || 6; // TEMP-TEST
if (mapPreview) genTo(8000);
else genTo(DEBUG_START_S + 720);
ensureSegments();
const r0 = sampleAt(DEBUG_START_S);
car.pos.set(r0.x, 0, r0.z);
car.yaw = r0.h;
car.y = r0.y + 0.02;
car.s = DEBUG_START_S;
carGroup.position.set(car.pos.x, car.y, car.pos.z);
carGroup.rotation.y = car.yaw;
carGroup.updateMatrixWorld(true);
if (mapPreview) {
  setupMapPicker();
  updatePreviewCamera();
} else {
  applyCamMode();
  updateCamera(0.016, true);
}
updateHUD();
window.__camDebug = {
  setShot(i, t) { cinematic = true; cinemaShot = -1; cinemaElapsed = i * 16 + (t || 2); updateCinemaCamera(0.016); }
};
frame();
window.__booted = true;
