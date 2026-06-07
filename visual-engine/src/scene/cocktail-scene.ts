// ============================================================================
// cocktail-scene — カクテル3Dシーンの「見た目に関わる全条件」を構築する共有モジュール
//   1液プログラム(main.ts) と mixer の結果ビューが “完全に同じ” 3D表示になるよう、
//   ライト・グラス/液体マテリアル・木の机・接地影・背景・環境マップ・bloom・DOF・
//   露出など「3D表示にかかる全条件」をここ1か所に集約する。
//
//   ◆この方式の運用ルール：
//     今後 3D 表示条件を調整したいときは、main.ts ではなく “このファイル” を編集する。
//     main.ts も結果ビューも本モジュールを呼ぶだけなので、ここを変えれば両方に反映される。
//
//   ◆ここに含めないもの（各エントリ固有・interaction）：
//     OrbitControls の有無 / UI（スライダー・タブ）/ スマホパネル /
//     液体に流し込む色の出どころ（1液=手動UI、mixer=混合結果）。
//   これらは呼び出し側が、返り値の camera / renderer / setLiquidAppearance を使って実装する。
// ============================================================================

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ----------------------------------------------------------------------------
// スマホ判定（画面幅のみ）— 描画品質プリセットの土台（main.ts と同一）
// ----------------------------------------------------------------------------
const IS_MOBILE = window.innerWidth <= 768;

// ----------------------------------------------------------------------------
// 液体の初期値（main.ts と同一）。色は 0〜255。
// ----------------------------------------------------------------------------
const LIQUID_COLOR = { r: 200, g: 50, b: 110 }; // マゼンタ系
const LIQUID_OPACITY = 0.9;
// 液面の高さ（0〜1）。0.8＝8分目。
const LIQUID_FILL = 0.8;

// ----------------------------------------------------------------------------
// 背景プリセット（main.ts と同一）
// ----------------------------------------------------------------------------
const BACKGROUND_PRESET = 1;
const BG_TOP_COLOR = '#070709';
const BG_BOTTOM_COLOR = '#131318';

// ----------------------------------------------------------------------------
// 被写界深度(DOF)（main.ts と同一）
// ----------------------------------------------------------------------------
const USE_DOF = true;
const DOF_PRESET = 1;
const FOCUS_DISTANCE = 8.5;
const DOF_PRESETS = {
  1: { aperture: 0.0001, maxblur: 0.006 },
  2: { aperture: 0.0002, maxblur: 0.01 },
  3: { aperture: 0.0004, maxblur: 0.016 },
} as const;
const dof = DOF_PRESETS[DOF_PRESET];
const DOF_MAXBLUR = IS_MOBILE ? 0.003 : dof.maxblur;

// ----------------------------------------------------------------------------
// 露出（全体の明るさ）（main.ts と同一）
// ----------------------------------------------------------------------------
export const EXPOSURE = 0.7;

// ----------------------------------------------------------------------------
// 描画解像度の上限（main.ts と同一）
// ----------------------------------------------------------------------------
const MAX_PIXEL_RATIO = IS_MOBILE ? 1.5 : 2;
export const PIXEL_RATIO = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);

// ----------------------------------------------------------------------------
// bloom プリセット（main.ts と同一）
// ----------------------------------------------------------------------------
const BLOOM_PRESET = 1;
const BLOOM_PRESETS = {
  1: { strength: 0.15, radius: 0.4, threshold: 2.2 },
  2: { strength: 0.45, radius: 0.5, threshold: 0.45 },
  3: { strength: 0.75, radius: 0.6, threshold: 0.3 },
} as const;
const bloom = BLOOM_PRESETS[BLOOM_PRESET];
const BLOOM_STRENGTH = IS_MOBILE ? 0.1 : bloom.strength;

// ----------------------------------------------------------------------------
// 液体の縦グラデ（吸光度）（main.ts と同一）
// ----------------------------------------------------------------------------
const USE_GRADIENT = true;
const GRADIENT_PRESET = 2;
const GRADIENT_PRESETS = {
  1: { density: 0.6 },
  2: { density: 1.0 },
  3: { density: 1.6 },
} as const;
const gradient = GRADIENT_PRESETS[GRADIENT_PRESET];

// ----------------------------------------------------------------------------
// カメラの位置・注視点（main.ts と同一）。呼び出し側の OrbitControls もこれに合わせる。
// ----------------------------------------------------------------------------
export const CAMERA_POS: [number, number, number] = [0, 1.7, 8.5];
export const CAMERA_TARGET: [number, number, number] = [0, 1.35, 0];

// 液体の初期 RGB と density（main.ts の UI 初期値に使う）。
export const INITIAL_LIQUID_RGB = { ...LIQUID_COLOR };

// ----------------------------------------------------------------------------
// 背景テクスチャ（main.ts と同一）
// ----------------------------------------------------------------------------
function makeBackgroundTexture(preset: number): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BG_TOP_COLOR);
  grad.addColorStop(1, BG_BOTTOM_COLOR);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  const drawBokeh = (
    x: number,
    y: number,
    r: number,
    color: string,
    alpha: number,
  ) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${color}, ${alpha})`);
    g.addColorStop(1, `rgba(${color}, 0)`);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  if (preset === 2) {
    const lights: [number, number, number, string, number][] = [
      [200, 250, 220, '255,150,60', 0.7],
      [780, 180, 180, '255,180,90', 0.55],
      [520, 520, 260, '255,120,40', 0.45],
      [880, 640, 160, '255,170,80', 0.5],
      [120, 700, 200, '255,140,60', 0.4],
    ];
    for (const [x, y, r, c, a] of lights) drawBokeh(x, y, r, c, a);
  } else if (preset === 3) {
    const lights: [number, number, number, string, number][] = [
      [220, 240, 230, '80,120,255', 0.68],
      [800, 200, 190, '150,90,255', 0.55],
      [500, 540, 260, '70,140,255', 0.45],
      [860, 660, 170, '120,110,255', 0.5],
      [140, 720, 210, '90,120,255', 0.4],
    ];
    for (const [x, y, r, c, a] of lights) drawBokeh(x, y, r, c, a);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ----------------------------------------------------------------------------
// 木目テクスチャ（main.ts と同一）
// ----------------------------------------------------------------------------
function makeWoodTexture(): THREE.Texture {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  ctx.fillStyle = '#6a4428';
  ctx.fillRect(0, 0, W, H);

  const base = [120, 76, 44];
  for (let y = 0; y < H; y++) {
    const grain =
      Math.sin(y * 0.15) * 0.5 +
      Math.sin(y * 0.37 + 1.3) * 0.3 +
      Math.sin(y * 0.91) * 0.2;
    const n = Math.abs(Math.sin(y * 12.9898) * 43758.5453) % 1;
    const shade = 0.97 + 0.07 * grain + (n - 0.5) * 0.04;
    const r = Math.min(255, Math.floor(base[0] * shade));
    const g = Math.min(255, Math.floor(base[1] * shade));
    const b = Math.min(255, Math.floor(base[2] * shade));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, W, 1);
  }

  ctx.strokeStyle = 'rgba(30,18,8,0.18)';
  ctx.lineWidth = 1.5;
  for (const seam of [70, 175, 300, 420]) {
    ctx.beginPath();
    ctx.moveTo(0, seam);
    ctx.lineTo(W, seam);
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

// ----------------------------------------------------------------------------
// グラスのラフネスマップ（main.ts と同一）
// ----------------------------------------------------------------------------
function makeGlassRoughnessMap(): THREE.Texture {
  const W = 8;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0.0, '#262626');
  grad.addColorStop(0.48, '#262626');
  grad.addColorStop(0.52, '#ffffff');
  grad.addColorStop(0.67, '#ffffff');
  grad.addColorStop(0.71, '#4d4d4d');
  grad.addColorStop(1.0, '#4d4d4d');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(canvas);
  return tex;
}

// ----------------------------------------------------------------------------
// 接地影テクスチャ（main.ts と同一）
// ----------------------------------------------------------------------------
function makeShadowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.4, 'rgba(0,0,0,0.25)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

// ----------------------------------------------------------------------------
// マティーニグラスの輪郭線（main.ts と同一）
// ----------------------------------------------------------------------------
const GLASS_PROFILE = [
  new THREE.Vector2(0.0, 0.0),
  new THREE.Vector2(0.72, 0.0),
  new THREE.Vector2(0.7, 0.2),
  new THREE.Vector2(0.12, 0.2),
  new THREE.Vector2(0.09, 0.24),
  new THREE.Vector2(0.085, 1.436),
  new THREE.Vector2(0.1, 1.516),
  new THREE.Vector2(0.887, 2.698),
  new THREE.Vector2(0.907, 2.758),
  new THREE.Vector2(0.857, 2.738),
  new THREE.Vector2(0.06, 1.566),
  new THREE.Vector2(0.0, 1.566),
];

const BOWL_INNER_BOTTOM = new THREE.Vector2(0.06, 1.566);
const BOWL_INNER_RIM = new THREE.Vector2(0.857, 2.738);
const fillY =
  BOWL_INNER_BOTTOM.y + (BOWL_INNER_RIM.y - BOWL_INNER_BOTTOM.y) * LIQUID_FILL;
const fillR =
  BOWL_INNER_BOTTOM.x + (BOWL_INNER_RIM.x - BOWL_INNER_BOTTOM.x) * LIQUID_FILL;
const LIQUID_INSET = 0.97;
const LIQUID_PROFILE = [
  new THREE.Vector2(0.0, BOWL_INNER_BOTTOM.y),
  new THREE.Vector2(BOWL_INNER_BOTTOM.x * LIQUID_INSET, BOWL_INNER_BOTTOM.y),
  new THREE.Vector2(fillR * LIQUID_INSET, fillY),
  new THREE.Vector2(0.0, fillY),
];

// ----------------------------------------------------------------------------
// 液体パラメータ変換の定数（main.ts の setLiquidAppearance と同一）
// ----------------------------------------------------------------------------
const ATTEN_MIN_DIST = 0.5;
const ATTEN_MAX_DIST = 10.0;
const BASE_TRANSMISSION = 0.98;
const BASE_ROUGHNESS = 0.02;
const BASE_SPECULAR_INTENSITY = 1.0;
const BASE_ENVMAP_INTENSITY = 0.3;
const MILK_WHITE = 0.85;
const WHITE_MAX = 0.15;
const WHITE_SAT_T = 0.3;
// 液体の厚み（透過の光路長）の基準値。density に比例させて希釈を強く効かせる。
//   起動時の density(INITIAL_DENSITY) でちょうどこの値になるよう正規化するので既定は不変。
const BASE_THICKNESS = 6;

// 起動時の density（attenuationDistance=2 に一致する値）。main.ts と同一の逆算。
export const INITIAL_DENSITY =
  (ATTEN_MAX_DIST - 2) / (ATTEN_MAX_DIST - ATTEN_MIN_DIST);

// ============================================================================
// ★ 形状に依存しない「見た目レシピ」の共有ファクトリ ★
//   1液プログラム(buildCocktailScene) と mixer の小グラス(GlassView) の両方が
//   これらを呼ぶことで、ガラス／液体の材質・環境マップ・後処理を“完全に同じレシピ”に
//   そろえる（＝単一ソース。ここを変えれば両方に反映される）。
//   ※カメラ・ライト・背景・机・影など「座標やシーン構成に依存する条件」はグラス形状
//     ごとに違うので、ここには含めず各呼び出し側が組む。
// ============================================================================

// --- 環境マップ（RoomEnvironment をコード生成して映り込み/IBL に使う）---
export function createEnvMap(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  const environmentScene = new RoomEnvironment();
  const envMap = pmremGenerator.fromScene(environmentScene).texture;
  environmentScene.dispose();
  pmremGenerator.dispose();
  return envMap;
}

// --- リッチなガラス材質（透過＋IOR＋ラフネスマップ＋クリアコート。形状非依存）---
export function createRichGlassMaterial(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xb4cfff,
    transparent: true,
    opacity: 0.05,
    transmission: 0.95,
    ior: 1.6,
    attenuationDistance: 4,
    attenuationColor: new THREE.Color(0xbcd6ff),
    roughness: 1.0,
    roughnessMap: makeGlassRoughnessMap(),
    metalness: 0.0,
    envMapIntensity: 0.2,
    clearcoat: 0.3,
    clearcoatRoughness: 0.03,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

// --- リッチな液体材質（透過＋吸収色＋厚み＋縦グラデshader。形状非依存）---
//   縦グラデは渡された geometry の bounding box（上端/下端の y）を使うので、
//   マティーニでも小グラスでも同じロジックで効く。
export function createRichLiquidMaterial(
  geometry: THREE.BufferGeometry,
  useGradient: boolean,
  initialColor: { r: number; g: number; b: number } = LIQUID_COLOR,
): THREE.MeshPhysicalMaterial {
  const col = new THREE.Color(
    initialColor.r / 255,
    initialColor.g / 255,
    initialColor.b / 255,
  );
  const liquidMaterial = new THREE.MeshPhysicalMaterial({
    color: col,
    transparent: true,
    opacity: LIQUID_OPACITY,
    roughness: 0.02,
    metalness: 0.0,
    envMapIntensity: 0.3,
    transmission: 0.98,
    attenuationColor: col.clone(),
    attenuationDistance: 2,
    thickness: BASE_THICKNESS,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  if (useGradient) {
    geometry.computeBoundingBox();
    const bottomY = geometry.boundingBox!.min.y;
    const topY = geometry.boundingBox!.max.y;
    liquidMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uLiquidBottom = { value: bottomY };
      shader.uniforms.uLiquidTop = { value: topY };
      shader.uniforms.uDensity = { value: gradient.density };
      // ★ 縦グラデの吸光強度(uDensity)を setLiquidAppearance から動的に更新できるよう、
      //   uniform 参照と基準値を material に持たせておく（希釈で薄まるのを見た目に効かせる）。
      liquidMaterial.userData.gradientUniform = shader.uniforms.uDensity;
      liquidMaterial.userData.gradientBaseDensity = gradient.density;

      shader.vertexShader = 'varying float vLocalY;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\n  vLocalY = position.y;',
      );

      shader.fragmentShader =
        'varying float vLocalY;\nuniform float uLiquidBottom;\nuniform float uLiquidTop;\nuniform float uDensity;\n' +
        shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float t = clamp((uLiquidTop - vLocalY) / max(uLiquidTop - uLiquidBottom, 0.0001), 0.0, 1.0);
        float absorb = 1.0 - exp(-uDensity * t * 1.5);
        diffuseColor.rgb *= (1.0 - absorb * 0.6);
        diffuseColor.a = mix(diffuseColor.a, min(diffuseColor.a + 0.3, 1.0), absorb);
        `,
      );
    };
    liquidMaterial.transparent = true;
  }

  return liquidMaterial;
}

// --- 液体の見た目を更新する中継関数を作る（color-engine 接続点）---
//   渡した液体材質をクロージャで束ね、rgb/density/turbidity を反映する関数を返す。
export function makeSetLiquidAppearance(
  liquidMaterial: THREE.MeshPhysicalMaterial,
): (
  rgb: { r: number; g: number; b: number },
  density: number,
  turbidity?: number,
) => void {
  return (rgb, density, turbidity = 0): void => {
    const d = Math.min(Math.max(density, 0), 1);
    const t = Math.min(Math.max(turbidity, 0), 1);
    const pr = rgb.r / 255;
    const pg = rgb.g / 255;
    const pb = rgb.b / 255;

    // ★ 希釈（density 低下）で「色み(tint)自体」も水へ近づける演出フェード。
    //   起動時 density(INITIAL_DENSITY) で 0＝既定の見た目は不変。density が下がるほど
    //   大きくなり、高希釈時だけ強く効くよう 2 乗カーブにする（中濃度はほぼ無変化）。
    const dilRaw = Math.max(0, 1 - d / INITIAL_DENSITY);
    const dilFade = dilRaw * dilRaw;

    // 吸収色を白へフェード＝透過に乗る色付きが減り、ほぼ無色透明の水に近づく。
    liquidMaterial.attenuationColor.setRGB(
      pr + (1 - pr) * dilFade,
      pg + (1 - pg) * dilFade,
      pb + (1 - pb) * dilFade,
    );
    liquidMaterial.attenuationDistance =
      ATTEN_MAX_DIST - (ATTEN_MAX_DIST - ATTEN_MIN_DIST) * d;

    // ★ 透過の光路長（厚み）も density に追従させる。透過が支配的なので、これが
    //   希釈（density低下）を最も強く見た目に効かせるレバー。起動時 density で
    //   BASE_THICKNESS のまま＝既定の見た目（1液プログラム含む）は不変。
    liquidMaterial.thickness = BASE_THICKNESS * (d / INITIAL_DENSITY);

    // ★ 縦グラデの吸光強度も density に追従させる（希釈＝density低下を見た目に効かせる）。
    //   起動時の density（INITIAL_DENSITY）で基準値そのままになるよう正規化するので、
    //   既定の見た目（1液プログラム含む）は不変。薄めたときだけ確実に透明寄りになる。
    const gradUniform = liquidMaterial.userData.gradientUniform as
      | { value: number }
      | undefined;
    if (gradUniform) {
      const base = (liquidMaterial.userData.gradientBaseDensity as number) ?? 1;
      gradUniform.value = base * (d / INITIAL_DENSITY);
    }

    liquidMaterial.transmission = BASE_TRANSMISSION * (1.0 - t);

    const whiteAmt = WHITE_MAX * Math.min(t / WHITE_SAT_T, 1);
    // まず濁り(turbidity)で乳白へ寄せ、さらに希釈フェードで白へ寄せる（＝水っぽさ）。
    const cr = pr + (MILK_WHITE - pr) * whiteAmt;
    const cg = pg + (MILK_WHITE - pg) * whiteAmt;
    const cb = pb + (MILK_WHITE - pb) * whiteAmt;
    liquidMaterial.color.setRGB(
      cr + (1 - cr) * dilFade,
      cg + (1 - cg) * dilFade,
      cb + (1 - cb) * dilFade,
    );

    const ease = 1 - (1 - t) * (1 - t);
    liquidMaterial.roughness = BASE_ROUGHNESS + (0.95 - BASE_ROUGHNESS) * ease;
    liquidMaterial.specularIntensity = BASE_SPECULAR_INTENSITY * (1 - 0.9 * ease);
    liquidMaterial.envMapIntensity = BASE_ENVMAP_INTENSITY * (1 - 0.85 * ease);
  };
}

// --- 後処理（bloom ＋ 任意で DOF ＋ Output）を composer に追加する ---
//   RenderPass は呼び出し側で先に追加しておくこと（順序：Render→Bloom→DOF→Output）。
//   focus（DOF の合焦距離）はカメラ距離が違うので引数で渡す（既定はマティーニ用）。
export function addPostProcessing(
  composer: EffectComposer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  width: number,
  height: number,
  opts: { useDof?: boolean; focus?: number } = {},
): { bloomPass: UnrealBloomPass; bokehPass: BokehPass | null } {
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    BLOOM_STRENGTH,
    bloom.radius,
    bloom.threshold,
  );
  composer.addPass(bloomPass);

  let bokehPass: BokehPass | null = null;
  if (opts.useDof ?? USE_DOF) {
    bokehPass = new BokehPass(scene, camera, {
      focus: opts.focus ?? FOCUS_DISTANCE,
      aperture: dof.aperture,
      maxblur: DOF_MAXBLUR,
    });
    composer.addPass(bokehPass);
  }

  composer.addPass(new OutputPass());
  return { bloomPass, bokehPass };
}

// ----------------------------------------------------------------------------
// シーン一式の返り値の型
// ----------------------------------------------------------------------------
export interface CocktailScene {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  composer: EffectComposer;
  bloomPass: UnrealBloomPass;
  bokehPass: BokehPass | null;
  liquidMaterial: THREE.MeshPhysicalMaterial;
  // 液体の見た目を更新する中継関数（color-engine 接続点）。
  setLiquidAppearance: (
    rgb: { r: number; g: number; b: number },
    density: number,
    turbidity?: number,
  ) => void;
  // 描画サイズ更新。updateStyle=false にすると canvas の CSS サイズを触らない
  // （mixer のように CSS で canvas サイズを制御している場合に使う）。
  resize: (w: number, h: number, updateStyle?: boolean) => void;
}

// ----------------------------------------------------------------------------
// ★ シーン構築の本体 ★
//   canvas を渡すとその canvas に描画する（mixer の結果 canvas 用）。
//   省略すると three が内部 canvas を作るので、呼び出し側で renderer.domElement を
//   body に append する（main.ts 用）。
// ----------------------------------------------------------------------------
export function buildCocktailScene(
  canvas?: HTMLCanvasElement,
): CocktailScene {
  // --- Renderer（main.ts と同一設定）---
  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(PIXEL_RATIO);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = EXPOSURE;

  // --- Scene + 背景 ---
  const scene = new THREE.Scene();
  scene.background = makeBackgroundTexture(BACKGROUND_PRESET);

  // --- 環境マップ（映り込み）--- ※共有ファクトリで生成（小グラスと同一レシピ）
  scene.environment = createEnvMap(renderer);

  // --- Camera ---
  const camera = new THREE.PerspectiveCamera(
    45,
    window.innerWidth / window.innerHeight,
    0.1,
    100,
  );
  camera.position.set(CAMERA_POS[0], CAMERA_POS[1], CAMERA_POS[2]);

  // --- ライト（main.ts と同一：環境/方向/半球は 0、2つの SpotLight が主役）---
  const PIN_LIGHT_INTENSITY = 400;
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.0);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.0);
  directionalLight.position.set(2, 4, 6);
  scene.add(directionalLight);
  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.0);
  scene.add(hemisphereLight);

  const spotLight = new THREE.SpotLight(
    0xffffff,
    PIN_LIGHT_INTENSITY,
    0,
    0.12,
    0.4,
    2,
  );
  spotLight.position.set(0, 9, 0.75);
  spotLight.target.position.set(0, 1.9, 0);
  scene.add(spotLight);
  scene.add(spotLight.target);

  const STEM_LIGHT_INTENSITY = 800;
  const stemSpot = new THREE.SpotLight(
    0xffffff,
    STEM_LIGHT_INTENSITY,
    0,
    0.04,
    0.2,
    2,
  );
  stemSpot.position.set(3, 0.24, 0);
  stemSpot.target.position.set(-0.086, 1.137, 0);
  scene.add(stemSpot);
  scene.add(stemSpot.target);

  // --- グラス本体 --- ※材質は共有ファクトリ（小グラスと同一レシピ）
  const glassGeometry = new THREE.LatheGeometry(GLASS_PROFILE, 64);
  const glassMaterial = createRichGlassMaterial();
  const glass = new THREE.Mesh(glassGeometry, glassMaterial);
  scene.add(glass);

  // --- 液体 --- ※材質＋縦グラデは共有ファクトリ（小グラスと同一レシピ）
  const liquidGeometry = new THREE.LatheGeometry(LIQUID_PROFILE, 64);
  const liquidMaterial = createRichLiquidMaterial(liquidGeometry, USE_GRADIENT);
  const liquid = new THREE.Mesh(liquidGeometry, liquidMaterial);
  scene.add(liquid);

  // --- 中継関数 setLiquidAppearance（共有ファクトリ。main.ts と同一ロジック）---
  const setLiquidAppearance = makeSetLiquidAppearance(liquidMaterial);

  // --- 木の机（main.ts と同一）---
  const woodTexture = makeWoodTexture();
  const woodGeometry = new THREE.PlaneGeometry(40, 6.3);
  const woodMaterial = new THREE.MeshLambertMaterial({
    map: woodTexture,
    color: 0xb07a4e,
  });
  const woodPlane = new THREE.Mesh(woodGeometry, woodMaterial);
  woodPlane.rotation.x = -Math.PI / 2;
  woodPlane.position.y = -0.015;
  scene.add(woodPlane);

  // --- 接地影（main.ts と同一）---
  const shadowMaterial = new THREE.MeshBasicMaterial({
    map: makeShadowTexture(),
    transparent: true,
    depthWrite: false,
  });
  const shadowPatch = new THREE.Mesh(
    new THREE.PlaneGeometry(3.2, 3.2),
    shadowMaterial,
  );
  shadowPatch.rotation.x = -Math.PI / 2;
  shadowPatch.position.set(0, -0.005, 0);
  scene.add(shadowPatch);

  // --- バックバー（実写背景）（main.ts と同一）---
  const backBarTexture = new THREE.TextureLoader().load('/backbar.jpg');
  backBarTexture.colorSpace = THREE.SRGBColorSpace;
  const BACKBAR_ASPECT = 1874 / 899;
  const BACKBAR_H = 15;
  const BACKBAR_W = BACKBAR_H * BACKBAR_ASPECT;
  const backBarGeometry = new THREE.PlaneGeometry(BACKBAR_W, BACKBAR_H);
  const backBarMaterial = new THREE.MeshBasicMaterial({
    map: backBarTexture,
    toneMapped: false,
  });
  const backBar = new THREE.Mesh(backBarGeometry, backBarMaterial);
  backBar.position.set(0, 0.5, -9);
  scene.add(backBar);

  // --- 後処理（bloom + DOF + Output）（共有ファクトリ。main.ts と同一）---
  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(PIXEL_RATIO);
  composer.addPass(new RenderPass(scene, camera));

  const { bloomPass, bokehPass } = addPostProcessing(
    composer,
    scene,
    camera,
    window.innerWidth,
    window.innerHeight,
    { useDof: USE_DOF, focus: FOCUS_DISTANCE },
  );

  // --- 描画サイズ更新 ---
  const resize = (w: number, h: number, updateStyle = true): void => {
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, updateStyle);
    composer.setSize(w, h);
    bloomPass.setSize(w, h);
    if (bokehPass) bokehPass.setSize(w, h);
  };

  return {
    renderer,
    scene,
    camera,
    composer,
    bloomPass,
    bokehPass,
    liquidMaterial,
    setLiquidAppearance,
    resize,
  };
}
