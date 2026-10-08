// style.css + main.js 를 template.html 에 인라인하여
// 단일 실행 파일 index.html 을 만드는 아주 작은 빌드 스크립트
import { readFileSync, writeFileSync } from 'fs';

let html = readFileSync(new URL('./template.html', import.meta.url), 'utf8');
html = html.replace('/*__CSS__*/', () => readFileSync(new URL('./style.css', import.meta.url), 'utf8'));
let js = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const license = readFileSync(new URL('./vendor/LICENSE.txt', import.meta.url), 'utf8');
const terrain = readFileSync(new URL('./vendor/three.terrain.js', import.meta.url), 'utf8')
  .replace('import * as e from "three";', 'const e = THREE;')
  .replace(/export \{[^}]+\};/, 'return { Terrain: r, TerrainNS: t, createSeededRandom: g };');
js = js.replace("import Terrain, { TerrainNS, createSeededRandom } from './vendor/three.terrain.js';",
  () => '/*\n' + license + '\n*/\nconst { Terrain, TerrainNS, createSeededRandom } = (() => {\n' + terrain + '\n})();');
const engine = readFileSync(new URL('./assets/sounds/engine-loop-1-normalized.wav', import.meta.url)).toString('base64');
js = js.replace("const ENGINE_AUDIO = './assets/sounds/engine-loop-1-normalized.wav';", () => "const ENGINE_AUDIO = 'data:audio/wav;base64," + engine + "';");
const jazz = readFileSync(new URL('./assets/sounds/backbay-lounge.mp3', import.meta.url)).toString('base64');
js = js.replace("const JAZZ_AUDIO = './assets/sounds/backbay-lounge.mp3';", () => "const JAZZ_AUDIO = 'data:audio/mpeg;base64," + jazz + "';");
const bossa = readFileSync(new URL('./assets/sounds/bossa-antigua.mp3', import.meta.url)).toString('base64');
js = js.replace("const BOSSA_AUDIO = './assets/sounds/bossa-antigua.mp3';", () => "const BOSSA_AUDIO = 'data:audio/mpeg;base64," + bossa + "';");
html = html.replace('//__JS__', () => js);
writeFileSync(new URL('./index.html', import.meta.url), html);
console.log('index.html 생성 완료:', html.length, 'bytes');
