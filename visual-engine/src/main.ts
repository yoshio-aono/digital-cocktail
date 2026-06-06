// ============================================================================
// カクテル3Dビジュアル化エンジン — ステップ1＋3＋4＋5＋6＋7
// 「半透明の色つき液体が入ったグラスを、マウスでぐるぐる回して眺める」
//   ＋ ステップ4：周囲の環境を映り込ませる（環境マップ）
//   ＋ ステップ5：ハイライトをふわっと光らせる（bloom 後処理）
//   ＋ ステップ6：円柱だった器を、脚付きのマティーニグラスに作り替え（LatheGeometry）
//   ＋ ステップ7：背景を作り込み、被写界深度(DOF)でグラスを主役として浮き立たせる
//
// Three.js の基本要素は次の6つ。まずこの全体像をつかむと読みやすい：
//   1. Renderer  … 3D空間を計算して画面(canvas)に絵を描く「描画装置」
//   2. Scene     … 物・光・カメラを全部入れる「3D空間（箱）」
//   3. Camera    … その空間を「どこから・どう見るか」という視点
//   4. Mesh      … 実際に見える物体。形(Geometry)＋材質(Material)で作る
//   5. Light     … 光源。半透明な物は光がないと立体的に見えない
//   6. ループ    … 毎フレーム描き直して、操作やアニメを反映し続ける仕組み
// ============================================================================

import * as THREE from 'three';
// OrbitControls はマウスでカメラを回す/ズームする補助ツール。
// Three.js 本体ではなく examples フォルダに入っているので、ここから読み込む。
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// RoomEnvironment = コードだけで「室内スタジオ風」の風景を作るクラス。
// HDRI画像ファイルを用意しなくても、これを環境マップにすれば映り込みが出せる。
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
// ↓ 後処理(ポストプロセス)用。描画した絵に効果を重ねがけする仕組み。
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
// BokehPass = 被写界深度(DOF)の後処理。手前にピント、奥をぼかしてグラスを際立たせる。
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import './style.css';
// 液体の色・濃さを手で操作するUI（HTML+CSS+canvasの自作パネル）。
// 値が変わるたびに setLiquidAppearance() を呼んで3Dへ反映する。
import { createLiquidUI } from './liquid-ui';

// ----------------------------------------------------------------------------
// ★ スマホ判定（軽い判定：画面幅のみ）★ — モバイル品質プリセットの土台
//   768px以下をモバイル扱いにする。起動時に1回だけ評価される定数。
//   注意：PCでウィンドウを狭めても発火するが、検証は実機メインなので今回はこれで十分。
//   この IS_MOBILE が true のときだけ、後述の「品質を一段落とす」設定が選ばれる。
//   ※処理は分岐させない。各定数の右辺を三項演算子で「値だけ」切り替える方針。
// ----------------------------------------------------------------------------
const IS_MOBILE = window.innerWidth <= 768;
// 確認用ログ（実機/エミュレーションで IS_MOBILE と解像度上限が効いているか目視する）。
// 不要になったらこの1行は削除してよい。
console.log('IS_MOBILE:', IS_MOBILE);

// ----------------------------------------------------------------------------
// ★ 液体の見た目の設定（将来ここに color-engine の出力を流し込む）★
//   色は 0〜255 の rgb で持っておき、Three.js 用に 0〜1 へ変換して使う。
//   この2つの定数を書き換えるだけで液体の色と透け具合が変わる。
// ----------------------------------------------------------------------------
const LIQUID_COLOR = { r: 200, g: 50, b: 110 }; // マゼンタ系
// 透明度。小さいほど透けるが、その分だけ後ろの色が混ざって液体の色は薄くなる。
// 値が大きいほど不透明で色が濃く出る（後ろの格子は透けにくくなる）。
const LIQUID_OPACITY = 0.9; // 0=完全に透明 / 1=不透明

// ----------------------------------------------------------------------------
// ★ 液面の高さ（どこまで注ぐか）★
//   ボウル内側の「底」から「リム（飲み口）」までを 0〜1 で表す。
//   0.8 = 8分目。1.0 に近づけるほど表面張力ぎりぎりまで注いだ見た目になる。
// ----------------------------------------------------------------------------
const LIQUID_FILL = 0.8;

// ----------------------------------------------------------------------------
// ★ 背景プリセット切り替え ★ — ステップ7
//   背景は canvas で1枚の絵を描き、それを scene.background に貼る方式。
//   下の BACKGROUND_PRESET を 1 / 2 / 3 に変えるだけで雰囲気が切り替わる。
//     1 = 暗めの単色グラデーション（スタジオ背景。グラスとbloomが最も引き立つ）
//     2 = バーカウンター風（暖色オレンジ/琥珀のボケ光を控えめに散らす）
//     3 = 寒色のムード（青〜紫のボケ光。クール/モダン）
//   ※グリッド（透け確認用の格子）は廃止。3パターンとも表示しない。
// ----------------------------------------------------------------------------
const BACKGROUND_PRESET = 1; // ← ここを 1 / 2 / 3 に変えて見比べる

// 背景グラデーションの上端・下端の色。
// ※注意：このシーンは EXPOSURE=0.35＋ACESトーンマッピングで全体をかなり暗く
//   落としているため、背景もそのカーブで強く暗くなる。そのまま暗い色を入れると
//   画面では真っ黒に潰れてグラデーションが見えない。そこで「画面で暗いグレーに
//   見える」ように、ソースの色はあえて明るめ(中間グレー寄り)に作ってある。
const BG_TOP_COLOR = '#070709'; // 上：ほぼ黒（ピンライトのムード優先でさらに暗く）
const BG_BOTTOM_COLOR = '#131318'; // 下：ごくわずかに明るい（暗い縦グラデ）

// ----------------------------------------------------------------------------
// ★ 被写界深度(DOF) ★ — ステップ7
//   手前のグラスにピントを合わせ、背景をぼかしてグラスを主役に見せる後処理。
//   ・USE_DOF      … DOF を使うか（false にすると全面くっきり）
//   ・DOF_PRESET   … ぼけ具合 1=控えめ / 2=標準 / 3=強め
//   ・FOCUS_DISTANCE … ピントが合う距離（カメラ〜グラスの距離に合わせる）
//     カメラ位置(0,1.7,8.5)から注視点(0,1.35,0)までは約8.5なので 8.5 を基準に。
//   ・aperture … 絞り。大きいほど被写界深度が浅く（背景が強くボケる）
//   ・maxblur  … ボケの最大の強さ（大きすぎると背景が溶ける）
// ----------------------------------------------------------------------------
const USE_DOF = true; // ← false で DOF オフ（背景パターンだけ見たいとき）
const DOF_PRESET = 1; // ← 1 / 2 / 3 で強さ切替
const FOCUS_DISTANCE = 8.5; // ピントの合う距離（カメラ〜グラス）
const DOF_PRESETS = {
  1: { aperture: 0.0001, maxblur: 0.006 }, // 控えめ
  2: { aperture: 0.0002, maxblur: 0.01 }, // 標準
  3: { aperture: 0.0004, maxblur: 0.016 }, // 強め
} as const;
const dof = DOF_PRESETS[DOF_PRESET];
// ★モバイル品質プリセット(2)：DOF（被写界深度）のボケ量を弱める★
//   maxblur を下げるとボケが軽くなり負荷も下がる（DOF自体はオフにしない）。
//   PCは現行プリセット値(dof.maxblur)をそのまま使う＝従来と1ビットも変わらない。
//   スマホは固定で軽いボケ量(0.003)にして負荷を抑える。
const DOF_MAXBLUR = IS_MOBILE ? 0.003 : dof.maxblur;

// ----------------------------------------------------------------------------
// ★ 全体の明るさ（露出）★
//   環境マップ＋ライトが強いと、液体やグラスのハイライトが 255（純白）に振り切れ、
//   色が飛んで真っ白になる。写真のカメラと同じ「露出」を下げる発想で、明るい所を
//   なめらかに圧縮するのがトーンマッピング。EXPOSURE を下げるほど全体が暗くなる。
//   （1.0=標準 / 0.5前後=暗め。ここを変えるだけで画面全体の明るさを調整できる）
// ----------------------------------------------------------------------------
const EXPOSURE = 0.7;

// ----------------------------------------------------------------------------
// ★ 最大ピクセル比（描画解像度の上限）★ — スマホでの計算量コントロール
//   実際に計算するピクセル数 ＝ (CSS幅×CSS高さ) × pixelRatio²。
//   スマホは devicePixelRatio が 2〜3 と高く、そのまま使うと実ピクセルが激増して重い
//   （iPhone等は DPR3＝9倍）。ここで上限を付けると、高精細端末でも描画解像度を抑えられる。
//   ・2  … 画質と負荷のバランス（推奨）。DPR3端末で実ピクセルは約0.44倍に減る
//   ・1.5… さらに軽く（負荷重視）。見た目は少しだけ甘くなる
//   ・Infinity … 上限なし（常に端末のDPRそのまま＝最高画質・最重）
//   renderer と composer(後処理) の両方に同じ値を効かせる。
//
//   ★モバイル品質プリセット(1)：解像度上限を一段下げる★
//   スマホ(IS_MOBILE)では 1.5 に下げて描画ピクセル数を減らし負荷を軽くする。
//   PC(IS_MOBILE===false)は従来どおり 2＝デグレなし。
const MAX_PIXEL_RATIO = IS_MOBILE ? 1.5 : 2;
// 端末のDPRと上限の小さい方を採用（高DPR端末だけ頭打ちになる）。
const PIXEL_RATIO = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);

// ----------------------------------------------------------------------------
// ★ bloom（光のにじみ）プリセット切り替え ★
//   bloom は明るい部分をふわっと光らせる効果。効かせすぎると白飛びする。
//   下の BLOOM_PRESET を 1 / 2 / 3 に変えるだけで強さが切り替わる。
//     1 = 控えめ / 2 = 標準 / 3 = 華やか
//   ・strength  … 光らせる強さ（大きいほど派手）
//   ・radius    … にじみの広がり半径
//   ・threshold … この明るさを超えた部分だけ光る（小さいほど広く光る）
// ----------------------------------------------------------------------------
const BLOOM_PRESET = 1; // ← ここを 1 / 2 / 3 に変えて見比べる
const BLOOM_PRESETS = {
  1: { strength: 0.15, radius: 0.4, threshold: 2.2 }, // 控えめ（閾値↑：濁った液面の“面の明るさ”は光らせず、グラスの鋭いハイライトだけ拾う）
  2: { strength: 0.45, radius: 0.5, threshold: 0.45 }, // 標準
  3: { strength: 0.75, radius: 0.6, threshold: 0.3 }, // 華やか
} as const;
const bloom = BLOOM_PRESETS[BLOOM_PRESET];
// ★モバイル品質プリセット(3)：bloom（光のにじみ）の強さを少し弱める★
//   strength を下げると発光処理が軽くなる。PCは現行プリセット値(bloom.strength)
//   をそのまま使う＝従来と完全に同一。スマホは固定で控えめ(0.10)にする。
const BLOOM_STRENGTH = IS_MOBILE ? 0.1 : bloom.strength;

// ----------------------------------------------------------------------------
// ★ 液体の縦グラデ（吸光度）★ — ステップ3
//   実際の飲み物は「底ほど濃く・液面ほど薄く」見える。これは光が液体を通る距離が
//   長いほど色素に吸収されて濃く見えるため（ランベルト・ベールの法則）。ここでは
//   厳密な光路長は計算せず、「液体メッシュの高さ(Y)が低いほど濃く」する高さベースの
//   近似で表現する。実装は既存マテリアルの onBeforeCompile に最小限のコードを差し込む
//   方式（ShaderMaterial に置き換えないので、環境マップ/透明/bloom との相性はそのまま）。
//     ・USE_GRADIENT     … グラデを使うか（false で従来どおり一様な色）
//     ・GRADIENT_PRESET  … 濃さの強さ 1=控えめ / 2=標準 / 3=強め
//       density … 底をどれだけ濃く（暗く・不透明に）するかの強さ
// ----------------------------------------------------------------------------
const USE_GRADIENT = true; // ← false でグラデなし（比較用）
const GRADIENT_PRESET = 2; // ← 1 / 2 / 3 で濃さ切替
const GRADIENT_PRESETS = {
  1: { density: 0.6 }, // 控えめ
  2: { density: 1.0 }, // 標準
  3: { density: 1.6 }, // 強め
} as const;
const gradient = GRADIENT_PRESETS[GRADIENT_PRESET];

// ----------------------------------------------------------------------------
// ★ 背景テクスチャを作る関数 ★ — ステップ7
//   canvas(2D描画)に1枚の絵を描き、それを Three.js のテクスチャにして
//   scene.background に貼る。重い光源を増やさず「描いた絵」で雰囲気を出す軽い方式。
//   ・共通：暗い縦グラデーション（上が暗く、下がほんのり明るいスタジオ背景）
//   ・preset 2/3：その上に「ぼかした円（ボケ光）」を数個重ねる。
//     ボケ光＝中心が明るく外へ向かって透明になる円（radial gradient）。
// ----------------------------------------------------------------------------
function makeBackgroundTexture(preset: number): THREE.Texture {
  const W = 1024;
  const H = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // 共通の縦グラデーション（上＝暗め → 下＝ほんのり明るい）。
  // ソース色は明るめだが、トーンマッピングで画面では暗いグレーに落ちる（上の注意参照）。
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, BG_TOP_COLOR); // 上：暗め
  grad.addColorStop(1, BG_BOTTOM_COLOR); // 下：ほんのり明るい
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // ボケ光を1つ描くヘルパー。(中心x, 中心y, 半径, "r,g,b", 中心の不透明度)
  const drawBokeh = (
    x: number,
    y: number,
    r: number,
    color: string,
    alpha: number,
  ) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${color}, ${alpha})`); // 中心は明るい
    g.addColorStop(1, `rgba(${color}, 0)`); // 外周は完全に透明
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // ボケ光の配置リスト（固定値にして毎回同じ絵になるようにする）。
  // 各要素 = [x, y, 半径, "r,g,b", 中心の不透明度]。
  if (preset === 2) {
    // パターン2：暖色（オレンジ/琥珀）のバー照明風。
    // 中心の不透明度は高めだが、トーンマッピングで画面では落ち着いた光になる。
    const lights: [number, number, number, string, number][] = [
      [200, 250, 220, '255,150,60', 0.7],
      [780, 180, 180, '255,180,90', 0.55],
      [520, 520, 260, '255,120,40', 0.45],
      [880, 640, 160, '255,170,80', 0.5],
      [120, 700, 200, '255,140,60', 0.4],
    ];
    for (const [x, y, r, c, a] of lights) drawBokeh(x, y, r, c, a);
  } else if (preset === 3) {
    // パターン3：寒色（青〜紫）のクール/モダンなムード。
    // 中心の不透明度は高めだが、トーンマッピングで画面では落ち着いた光になる。
    const lights: [number, number, number, string, number][] = [
      [220, 240, 230, '80,120,255', 0.68],
      [800, 200, 190, '150,90,255', 0.55],
      [500, 540, 260, '70,140,255', 0.45],
      [860, 660, 170, '120,110,255', 0.5],
      [140, 720, 210, '90,120,255', 0.4],
    ];
    for (const [x, y, r, c, a] of lights) drawBokeh(x, y, r, c, a);
  }
  // preset === 1 はグラデーションのみ（最もシンプルなスタジオ背景）。

  // canvas を Three.js のテクスチャに変換。sRGBで描いた絵なので色空間を合わせる。
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

// ----------------------------------------------------------------------------
// ★ 木目テクスチャを作る関数 ★ — 木の机用
//   背景と同じく canvas に「絵」を描いて Three.js のテクスチャにする方式。
//   外部の画像ファイルを使わず、コードだけで木目を生成する（依存を増やさない）。
//   作り方：茶色のベース → 「横方向(左右)」に伸びる細い帯を sin＋擬似乱数で明暗を
//   つけて何本も描く（横向きの木目の縞）→ 板の継ぎ目の暗い横線を数本入れる。
//   これを机のplaneにUVマッピングすると、カメラから見て木目が横向きに走る。
//   ※明暗のコントラストは控えめにして「穏やかな木目」にしている。
// ----------------------------------------------------------------------------
function makeWoodTexture(): THREE.Texture {
  const W = 512;
  const H = 512;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // ベースの茶色で塗りつぶす
  ctx.fillStyle = '#6a4428';
  ctx.fillRect(0, 0, W, H);

  // 木目の縞：高さ1pxの「横帯」を、明暗を変えながら縦方向に積み上げて全面を描く。
  //   → 帯が左右に伸びるので、木目が横向きに見える。
  const base = [120, 76, 44]; // 木の基準色(RGB)
  for (let y = 0; y < H; y++) {
    // 複数の sin を重ねてゆるやかな縞模様を作る（縦位置 y で変化）
    const grain =
      Math.sin(y * 0.15) * 0.5 +
      Math.sin(y * 0.37 + 1.3) * 0.3 +
      Math.sin(y * 0.91) * 0.2;
    // 擬似乱数（細かいザラつき）。0〜1 の範囲に収める
    const n = Math.abs(Math.sin(y * 12.9898) * 43758.5453) % 1;
    // 明るさ係数。さらに穏やかに、振れ幅をごく小さく（おおむね 0.92〜1.08）
    const shade = 0.97 + 0.07 * grain + (n - 0.5) * 0.04;
    const r = Math.min(255, Math.floor(base[0] * shade));
    const g = Math.min(255, Math.floor(base[1] * shade));
    const b = Math.min(255, Math.floor(base[2] * shade));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(0, y, W, 1);
  }

  // 板の継ぎ目（暗い横線）を数本入れて「板を並べた机」に見せる。
  //   穏やかにするため線は細め・薄め。
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
  // タイル状に繰り返して机全体に敷き詰める（穏やかに見せるため繰り返しは控えめ）
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}

// ----------------------------------------------------------------------------
// ★ マティーニグラスの輪郭線（profile）★ — ステップ6
//   マティーニグラスは「回転対称」（中心軸まわりにくるっと回した形）なので、
//   縦の断面の輪郭を 2D の点列で定義し、LatheGeometry で軸まわりに回して立体化する。
//   各点は Vector2(x, y) ＝ (中心軸からの半径, 高さ)。下から上へ、最後に内側を下って閉じる。
//
//   ◆下から上へ：台座(フット) → 脚(ステム) → V字のボウル(外側) → リム(飲み口)
//   ◆リムから内側を下る：ボウルの内側 → 内側の底（ここに液体がたまる）
//   ※点の数値を書き換えるだけで形を微調整できる（開きを広く/狭く、ステムを長く 等）。
// ----------------------------------------------------------------------------
const GLASS_PROFILE = [
  new THREE.Vector2(0.0, 0.0), //  1 台座の中心（底）
  new THREE.Vector2(0.72, 0.0), //  2 台座の外周（底）※台座半径0.72＝ボウル最大幅の基準
  new THREE.Vector2(0.7, 0.2), //  3 台座のふち（厚み 0.1→0.2＝さらに厚く・重底ガラス風）
  new THREE.Vector2(0.12, 0.2), //  4 台座からステムへドーム状に立ち上げる
  new THREE.Vector2(0.09, 0.24), //  5 ステム下端
  new THREE.Vector2(0.085, 1.436), //  6 ステム上端
  new THREE.Vector2(0.1, 1.516), //  7 ボウルの付け根（外側・小さなふくらみ）
  new THREE.Vector2(0.887, 2.698), //  8 直線のV字でリムへ（外側）
  new THREE.Vector2(0.907, 2.758), //  9 リム（飲み口）外側＝最大幅0.907
  new THREE.Vector2(0.857, 2.738), // 10 リム内側（ここから内側を下りていく）
  new THREE.Vector2(0.06, 1.566), // 11 ボウル内側の底へ
  new THREE.Vector2(0.0, 1.566), // 12 内側の底を中心で閉じる
];

// 液体の輪郭線は、ボウル内側の「底」と「リム」をなぞって作る。
// グラスの内側と同じ傾きに沿わせ、上面（液面）は LIQUID_FILL の高さで水平に閉じる。
const BOWL_INNER_BOTTOM = new THREE.Vector2(0.06, 1.566); // ボウル内側の底（GLASS_PROFILE の点11と一致）
const BOWL_INNER_RIM = new THREE.Vector2(0.857, 2.738); // ボウル内側のリム（点10と一致）
// 底→リムを LIQUID_FILL(0〜1) で内分した位置が、注いだ液面の高さと半径になる。
const fillY =
  BOWL_INNER_BOTTOM.y + (BOWL_INNER_RIM.y - BOWL_INNER_BOTTOM.y) * LIQUID_FILL;
const fillR =
  BOWL_INNER_BOTTOM.x + (BOWL_INNER_RIM.x - BOWL_INNER_BOTTOM.x) * LIQUID_FILL;
// 液体はガラス内面と同じ面に置くと z-fighting（面の重なりチラつき）が出るので、
// ほんの少し(×0.97)内側に縮めて重なりを避ける。
const LIQUID_INSET = 0.97;
const LIQUID_PROFILE = [
  new THREE.Vector2(0.0, BOWL_INNER_BOTTOM.y), // 液体の底の中心
  new THREE.Vector2(BOWL_INNER_BOTTOM.x * LIQUID_INSET, BOWL_INNER_BOTTOM.y), // 底の外周
  new THREE.Vector2(fillR * LIQUID_INSET, fillY), // ボウル内側に沿って液面の縁へ
  new THREE.Vector2(0.0, fillY), // 液面を中心で水平に閉じる
];

// ============================================================================
// 1. Renderer（描画装置）
//    計算結果を canvas に描く。antialias で輪郭のギザギザを滑らかにする。
// ============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight); // 画面サイズに合わせる
renderer.setPixelRatio(PIXEL_RATIO); // 高精細ディスプレイ対応（上限 MAX_PIXEL_RATIO 付き）
// トーンマッピング：明るい部分(ハイライト)を純白に飛ばさず、なめらかに圧縮する。
// ACESFilmic は映画やゲームで定番の自然な見え方。これで液体やグラスの強い反射が
// 255 に張り付くのを防ぎ、色が残る。EXPOSURE で全体の明るさを最終調整する。
//（後処理 OutputPass がこの設定を読んでトーンマッピングを適用してくれる）
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.body.appendChild(renderer.domElement); // 生成した canvas を画面に追加

// ============================================================================
// 2. Scene（3D空間）
//    これから作る器・液体・光・カメラを、すべてこの中に add していく。
// ============================================================================
const scene = new THREE.Scene();
// 背景：ステップ7で作った背景テクスチャを貼る（BACKGROUND_PRESET で切替）。
// scene.background に普通のテクスチャを入れると、カメラを回しても画面の後ろに
// 貼りついたままの「書き割り（スタジオ背景）」として表示される。
scene.background = makeBackgroundTexture(BACKGROUND_PRESET);

// ============================================================================
// 2.5 環境マップ（映り込み）— ステップ4
//   ガラスや液体の表面に「周囲の風景」を映り込ませると一気に本物らしくなる。
//   手順：
//     (1) RoomEnvironment で室内スタジオ風の風景シーンをコードで生成
//     (2) PMREMGenerator で、その風景を「反射に使える専用テクスチャ」に変換
//     (3) scene.environment に入れると、シーン内の全マテリアルの反射・環境光に効く
//   ※ scene.background は別物（上の背景テクスチャ）。environment は映り込み専用で、
//     背景の見た目には影響しない。
// ============================================================================
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const environmentScene = new RoomEnvironment(); // 室内スタジオ風の風景
const envMap = pmremGenerator.fromScene(environmentScene).texture; // 反射用テクスチャに変換
scene.environment = envMap; // 全マテリアルに映り込み＆環境光として適用
// 後始末：変換が終われば、元の風景シーンと変換器はもう不要なので解放する
//（envMap テクスチャはこの先も使うので解放しない）。
environmentScene.dispose();
pmremGenerator.dispose();

// ============================================================================
// 3. Camera（視点）
//    PerspectiveCamera = 遠近感のあるカメラ（遠い物が小さく見える）。
//    引数: (画角°, アスペクト比, 描画する最短距離, 最長距離)
// ============================================================================
const camera = new THREE.PerspectiveCamera(
  45, // 画角(fov)。人の視野に近い自然な値
  window.innerWidth / window.innerHeight, // 横/縦の比。歪み防止に画面比を渡す
  0.1, // これより近い物は描かない
  100, // これより遠い物は描かない
);
// カメラの位置。参考画像のように「ほぼ真横（目線の高さ）」から見ると、
// ボウルの口が細い楕円になり、V字がシャープに見える。
// 見下ろすと口が大きく開いて液面が目立つので、高さを抑えて水平寄りにする。
camera.position.set(0, 1.7, 8.5);

// ============================================================================
// 4. Light（光源） — ピンスポット中心の暗めライティング（参考画像のムード）
//    「暗い空間に、上から絞ったスポットライト(ピンライト)でグラスだけを照らす」構成。
//    周囲を照らす光(環境光・半球光・方向光)を大きく絞って全体を暗くし、主役の光は
//    上からの SpotLight に任せる。これでグラスだけが闇に浮かび上がる。
// ============================================================================
// ★ ピンライトの強さ（明るすぎたら下げる／暗ければ上げる）★
//   SpotLight は物理的な明るさ単位なので、距離減衰のぶん大きめの値が必要。
const PIN_LIGHT_INTENSITY = 400;

// 環境光：ごく弱く。完全な黒つぶれを防ぐ最低限だけ残す。さらに暗く。
const ambientLight = new THREE.AmbientLight(0xffffff, 0.0); // 色, 強さ
scene.add(ambientLight);

// 方向光：正面からのごく弱いフィル光（ステムや台座が真っ黒に潰れない程度）。さらに暗く。
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.0);
directionalLight.position.set(2, 4, 6); // 手前やや上から
scene.add(directionalLight);

// 半球光：全体の最低限の起こし光。暗さを優先してさらに弱める。
const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x222222, 0.0);
scene.add(hemisphereLight);

// ★ ピンスポット（上からの主役の光）★
//   SpotLight(色, 強さ, 届く距離, 円錐の半角, ふちのぼかし, 距離減衰)。
//   ・angle 小 = 絞った細いスポット ／ penumbra 大 = ふちが柔らかい
//   ・decay=2 で物理的に自然な距離減衰。そのぶん intensity は大きめにする。
const spotLight = new THREE.SpotLight(
  0xffffff,
  PIN_LIGHT_INTENSITY,
  0, // 距離0＝届く範囲の打ち切りなし
  0.12, // 円錐の半角(ラジアン)。小さいほど細いスポット → さらに狭く絞った
  0.4, // penumbra：ふちのぼかし(0=くっきり 〜 1=ふんわり)
  2, // decay：距離による減衰(2=物理的に自然)
);
// 光源を狙い先より手前(z=+0.75)に置くと、光の軸は「手前→奥下」方向に傾く。
// 傾き量は元(z差1.5)の半分(z差0.75)。鉛直からの傾きは約6°。
spotLight.position.set(0, 9, 0.75); // グラスの真上やや手前から
spotLight.target.position.set(0, 1.9, 0); // グラスのボウル付近を狙う
scene.add(spotLight);
scene.add(spotLight.target); // target も scene に入れないと向きが反映されない

// ★ ステム用スポット（復活）★
//   ・光源：ステムの一番下の右側から → 右(+X)・低い位置(y≈0.24)。
//   ・狙い：ステムの「上から1/4」の高さの左側外端。ステム y=0.24〜1.436 → 1.436-1.196/4≈1.137。
//     その高さのステム半径≈0.086 なので左外端 = (-0.086, 1.137)。右下→左上へ斜めに横切る。
//   ・angle 0.04＝一番細い／intensity＝一番強い。
const STEM_LIGHT_INTENSITY = 800; // 一番強く（眩しすぎたら下げる）
const stemSpot = new THREE.SpotLight(
  0xffffff,
  STEM_LIGHT_INTENSITY,
  0, // 距離0＝打ち切りなし
  0.04, // 円錐の半角(ラジアン)。0.06より小さい＝一番細いスポット
  0.2, // penumbra：ふちのぼかし（細く鋭いビームなので小さめ）
  2, // decay：物理的な距離減衰
);
stemSpot.position.set(3, 0.24, 0); // ステム最下の右側から
stemSpot.target.position.set(-0.086, 1.137, 0); // ステム上から1/4・左側の外端を狙う
scene.add(stemSpot);
scene.add(stemSpot.target); // target も scene に入れないと向きが反映されない

// ============================================================================
// 5. Mesh（物体） — マティーニグラスと液体
//    Mesh = Geometry（形）＋ Material（材質・見え方）。
//    ステップ6：形は LatheGeometry（上で定義した輪郭線を軸まわりに回した立体）。
// ============================================================================

// --- マティーニグラス -----------------------------------------------------
// LatheGeometry(輪郭線の点列, 円周の分割数)。分割数を増やすほど滑らかな回転体になる。
const glassGeometry = new THREE.LatheGeometry(GLASS_PROFILE, 64);

// 部位ごとに表面のザラつき(roughness)を変えるためのテクスチャ（roughnessMap）。
//   グラスは1つの回転体＋1マテリアルなので、形を分割せずに「高さ方向のグラデ画像」で
//   部位ごとの粗さを切り替える。最終 roughness = material.roughness(1.0) × このテクスチャの明るさ。
//   3段構成：
//   ・底（台座）  ＝灰 #4d4d4d(0.3倍)→ 0.30
//   ・ステム      ＝白 #ffffff(1.0倍)→ 1.00（完全マット・最大）
//   ・ボウル      ＝暗灰 #262626(0.15倍)→ 0.15（クリアなまま）
//   LatheGeometry の縦方向UV(v)は輪郭点の番号に比例（点0=底→v0、点11=最上→v1）。
//   底=点0〜3(v≈0〜0.30)／ステム=点4〜5(v≈0.32〜0.50)／ボウル=点6以降(v>0.50)。
//   CanvasTexture は既定で上下反転(flipY=true)＝画像の「下」が v0(底)。画像の縦位置 p(上0→下1)
//   は p=1-v。よって 下=底、中=ステム、上=ボウル の順に塗る。
function makeGlassRoughnessMap(): THREE.Texture {
  const W = 8;
  const H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, 0, H); // 上(p0,row0)→下(p1,rowH)
  grad.addColorStop(0.0, '#262626'); // 上＝ボウル：暗灰(0.15倍→0.15)
  grad.addColorStop(0.48, '#262626'); // v>0.50 はボウル
  grad.addColorStop(0.52, '#ffffff'); // v≈0.50：ステム(白→1.0)へ切替
  grad.addColorStop(0.67, '#ffffff'); // ステムの白を維持
  grad.addColorStop(0.71, '#4d4d4d'); // v≈0.30：底(灰0.3倍→0.3)へ切替
  grad.addColorStop(1.0, '#4d4d4d'); // 下＝底：灰
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  const tex = new THREE.CanvasTexture(canvas);
  // 色ではなくデータ（粗さ係数）なので sRGB 変換はしない（既定の NoColorSpace のまま）。
  return tex;
}

// 器のマテリアル（ステップ1〜5の透明感をそのまま引き継ぐ）。
// ※当初は transmission（物理的な光の透過）でガラスらしさを出していたが、
//   transmission は「ガラスの向こうの背景」を取り込む特殊描画のため、
//   内側の液体（ふつうの半透明オブジェクト）が背景で上書きされ、液体の色が
//   抜けてしまう。そこで transmission は使わず、ただの薄い半透明シェルにする。
//   こうすると普通のアルファ合成になり、器越しでも液体の色がそのまま透ける。
const glassMaterial = new THREE.MeshPhysicalMaterial({
  // うっすら寒色（青み）を付けてクリスタルガラスらしさを出す。真っ白(0xffffff)だと
  // 反射が白っぽく濁って見えるため、ごく薄い水色にして透明感を演出。
  color: 0xb4cfff,
  transparent: true, // 透明処理を有効化
  // 器の白い膜を薄くして、中の液体（マゼンタ）の色がより強く透けるようにする。
  opacity: 0.05, // 0.08 → 0.05 に下げた（液体色を強調）
  // 物理的な光の透過。1.0＝完全に透過する本物のガラス。背景や奥の物が屈折して見える。
  transmission: 0.95,
  // 屈折率。ガラス=1.5前後、クリスタル/鉛ガラスは高め。1.6 で屈折が強めに出る。
  ior: 1.6,
  // 透過光が器の厚みを通る間にどれだけ吸収・着色されるか。距離が短いほど色が濃くつく。
  attenuationDistance: 4,
  // 透過光に付く色。淡い青にして、ガラス越しにほんのり青みが見えるようにする。
  attenuationColor: new THREE.Color(0xbcd6ff),
  // 表面のザラつき。0に近いほど鏡のようにツルッとして、映り込み・ハイライトが
  // くっきり鋭くなる＝「ぴかぴか感」。ここは「最大値」で、下の roughnessMap で部位ごとに
  // 下げる。ステム＝1.0（最大・完全マット）／底＝1.0×0.3＝0.3／ボウル＝1.0×0.15＝0.15。
  roughness: 1.0,
  // 部位ごとに粗さを変えるマップ（底・ステムだけザラつかせる）。値は roughness に掛け算。
  roughnessMap: makeGlassRoughnessMap(),
  metalness: 0.0, // 金属ではないので0
  // 環境マップ（映り込み）の強さ。白っぽさをさらに抑えるため 0.7 → 0.2 に下げた。
  envMapIntensity: 0.2,
  // ガラスの上に張った透明なニス層のような「クリアコート」。本体の透明度(opacity 0.05)
  // とは別レイヤーで、表面に鋭い反射ハイライトを足せる。
  clearcoat: 0.3, // クリアコートの強さ（0〜1）。白反射を抑えるため 0.5 → 0.3 に下げた
  clearcoatRoughness: 0.03, // コート表面のザラつき。低いほど反射がシャープ
  // LatheGeometry は輪郭を回しただけの「片面ポリゴン」になりがちなので、
  // 両面描画にして内側の面も見えるようにする（中の液体越しに器の内壁が見える）。
  side: THREE.DoubleSide,
  // 器も深度書き込みを切る。これがないと、先に描かれた器の面が深度を書き込み、
  // その奥にある液体が「奥だから」と判定されて捨てられ、色が消えることがある。
  depthWrite: false,
});
const glass = new THREE.Mesh(glassGeometry, glassMaterial);
scene.add(glass);

// --- 液体（ボウルの内側の形に合わせた別の回転体）-------------------------
const liquidGeometry = new THREE.LatheGeometry(LIQUID_PROFILE, 64);

const liquidMaterial = new THREE.MeshPhysicalMaterial({
  // 0〜255 の定数を Three.js 用の 0〜1 に変換して色を設定
  color: new THREE.Color(
    LIQUID_COLOR.r / 255,
    LIQUID_COLOR.g / 255,
    LIQUID_COLOR.b / 255,
  ),
  transparent: true,
  opacity: LIQUID_OPACITY, // ★冒頭の定数で透け具合を制御（小さいほど透ける）
  roughness: 0.02, // 液面のザラつき。0に近いほどツルッと鏡面（液面をなめらかに）
  metalness: 0.0,
  envMapIntensity: 0.3, // 液面への映り込みの強さ（白飛び防止で控えめに）
  // 物理的な光の透過を有効化。背景や奥が液体越しに屈折して見える本物の液体。
  transmission: 0.98,
  // 透過光が液中を進む間に吸収されて残る色（マゼンタ）。これを入れないと無色になる。
  attenuationColor: new THREE.Color(
    LIQUID_COLOR.r / 255,
    LIQUID_COLOR.g / 255,
    LIQUID_COLOR.b / 255,
  ),
  // 色がどれだけの距離で吸収されるか。小さいほど濃い。色を強く出すため 6→2 に短縮。
  attenuationDistance: 2,
  // 透過計算で「光が液中を通る距離」の目安。大きいほど吸収が効いて色が濃くなる（4→6）。
  thickness: 6,
  // 両面描画。これがないと外向きの面だけ描かれ、下から器の中を見上げたとき
  // 液体の内側（背面）が素通しになって色が消える。両面にすると全方向で色が出る。
  side: THREE.DoubleSide,
  // 深度バッファへの書き込みを切る。透明な面どうしが「奥にある」と判定されて
  // 互いに描画を捨て合うのを防ぎ、手前と奥の面をすべて重ねて描けるようにする
  // （透明オブジェクトの定番設定。これがないと見る角度で面が欠ける）。
  depthWrite: false,
});
// --- 縦グラデ（吸光度）の差し込み — ステップ3 -----------------------------
//   液体の高さ範囲（底のY〜液面のY）を、メッシュのバウンディングボックスから取得する。
//   computeBoundingBox() で geometry.boundingBox.min/max が計算される。
liquidGeometry.computeBoundingBox();
const LIQUID_BOTTOM_Y = liquidGeometry.boundingBox!.min.y; // 液体の最下点（V字の先端側）
const LIQUID_TOP_Y = liquidGeometry.boundingBox!.max.y; // 液面の高さ

if (USE_GRADIENT) {
  // onBeforeCompile：マテリアルがシェーダーにコンパイルされる直前に呼ばれ、
  //   生成済みのシェーダー文字列(shader.vertexShader / fragmentShader)に
  //   自前のコードを差し込める。ShaderMaterial に置き換えず最小限の拡張で済む。
  liquidMaterial.onBeforeCompile = (shader) => {
    // (1) 高さ範囲と濃さを uniform（シェーダーに渡す定数）として追加する
    shader.uniforms.uLiquidBottom = { value: LIQUID_BOTTOM_Y };
    shader.uniforms.uLiquidTop = { value: LIQUID_TOP_Y };
    shader.uniforms.uDensity = { value: gradient.density };

    // (2) 頂点シェーダー：各頂点のローカルY座標をフラグメントへ渡す（varying）
    shader.vertexShader =
      'varying float vLocalY;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vLocalY = position.y;',
    );

    // (3) フラグメントシェーダー：高さから「濃さ係数」を作り、色と不透明度に反映する。
    //   color_fragment の直後（diffuseColor が確定した所）に差し込むのが安全。
    shader.fragmentShader =
      'varying float vLocalY;\nuniform float uLiquidBottom;\nuniform float uLiquidTop;\nuniform float uDensity;\n' +
      shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      // t: 0=液面（上・薄い） → 1=底（下・濃い）
      float t = clamp((uLiquidTop - vLocalY) / max(uLiquidTop - uLiquidBottom, 0.0001), 0.0, 1.0);
      // ランベルト・ベール風：深いほど指数的に濃く（暗く）なる
      float absorb = 1.0 - exp(-uDensity * t * 1.5);
      diffuseColor.rgb *= (1.0 - absorb * 0.6); // 底ほど色を暗く濃く
      diffuseColor.a = mix(diffuseColor.a, min(diffuseColor.a + 0.3, 1.0), absorb); // 底ほど不透明に
      `,
    );
  };
  liquidMaterial.transparent = true; // 念のため透明処理を有効化
}

const liquid = new THREE.Mesh(liquidGeometry, liquidMaterial);
// 液体の輪郭線はすでにボウル内側の高さ(y=1.45〜)で作っているので、位置調整は不要。
scene.add(liquid);

// ============================================================================
// ★★ 中継関数 setLiquidAppearance（最重要・将来の color-engine 接続点）★★
//   UI も、将来の mixCocktail() も、液体の見た目を変えたいときは「必ずこの関数だけ」
//   を呼ぶ。マテリアルを直接いじる場所を1か所に集約しておくと、
//   あとで color-engine をつなぐとき “ここを呼ぶだけ” で済む。
//
//   引数：
//     rgb       … { r, g, b } 各 0〜255（人にわかりやすい色の表現）
//     density   … 0.0〜1.0 の「濃さ」。0=薄い（色が淡い）/ 1=濃い（色が深い）
//     turbidity … 0.0〜1.0 の「濁り」。0=澄んだ透明 / 1=ミルクのように白く不透明
//                 （省略時は 0＝従来どおりの澄んだ液体。後方互換のためデフォルト値あり）
//
//   density → attenuationDistance への変換について：
//     attenuationDistance は「光が液中を進んで色が吸収されるまでの距離」。
//     小さいほど早く吸収される＝色が濃い。つまり density とは逆向きなので、
//     density=0 のとき遠く(MAX=薄い)、density=1 のとき近く(MIN=濃い) に線形変換する。
//
//   turbidity（濁り＝散乱）の近似について：
//     液体の見た目は物理的に「吸収」と「散乱」の2軸。今までは吸収だけ＝透き通ったまま
//     色がつくモデルだった。濁り（ミルク・カルーア・濁った果汁）は微粒子による散乱で、
//     向こうが透けず内側から白っぽくなる現象。フルSSSは重いので、ここでは
//     MeshPhysicalMaterial の3つのパラメータで近似する：
//       ・transmission を下げる … 向こうが透けなくなる（不透明化）
//       ・color を白方向へ寄せる … 散乱して戻る乳白色を diffuse で表現
//       ・roughness をやや上げる … つやを抑えてもったり見せる
//     なお attenuationColor（吸収色）は純色のまま残し、色相は保つ。
// ----------------------------------------------------------------------------
const ATTEN_MIN_DIST = 0.5; // density=1.0（最も濃い）のときの吸収距離
const ATTEN_MAX_DIST = 10.0; // density=0.0（最も薄い）のときの吸収距離

// 澄んだ状態（turbidity=0）の基準値。現行 liquidMaterial の実値に合わせる。
// turbidity=0 のとき必ずこの値に戻り、従来と同一の見た目になることを保証する。
const BASE_TRANSMISSION = 0.98; // 澄んだ時の透過（liquidMaterial の初期値と一致）
const BASE_ROUGHNESS = 0.02; // 澄んだ時の表面のなめらかさ（同上）
const BASE_SPECULAR_INTENSITY = 1.0; // 澄んだ時の鏡面反射の強さ（既定値）
const BASE_ENVMAP_INTENSITY = 0.3; // 澄んだ時の環境マップ映り込み（liquidMaterial と一致）
// 濁ったときの「白寄せの行き先」。純白(1.0)にすると面が明るくなりすぎて
// スポットライトで白飛び→bloom発光する。実際のミルクも真っ白ではなく少し
// グレーがかっているので 0.85 に抑え、面の最大明るさを頭打ちにする。
const MILK_WHITE = 0.85;
// 白寄せの「量」と「頭打ち位置」。濁り＝不透明化が主役で、色を白へ変えるのは
// ごく僅かでよい。WHITE_MAX=最大の寄せ量（小さいほど元の色が残る）、
// WHITE_SAT_T=この濁り値で白寄せが最大に達し、以降はそれ以上白くしない。
//   → スライダーを上げ続けても色は変わらず、不透明さ（透過↓）だけが進む。
const WHITE_MAX = 0.15;
const WHITE_SAT_T = 0.3;

function setLiquidAppearance(
  rgb: { r: number; g: number; b: number },
  density: number,
  turbidity: number = 0,
): void {
  const d = Math.min(Math.max(density, 0), 1); // 0〜1 に念のためクランプ
  const t = Math.min(Math.max(turbidity, 0), 1); // 濁りも 0〜1 にクランプ

  // 純色（吸収色・色相のもと）。0〜255 → Three.js の 0〜1 へ。
  const pr = rgb.r / 255;
  const pg = rgb.g / 255;
  const pb = rgb.b / 255;

  // attenuationColor（吸収色）は純色のまま。濁っても色相は失わせない。
  liquidMaterial.attenuationColor.setRGB(pr, pg, pb);

  // density（0=薄い〜1=濃い）を距離（MAX=薄い〜MIN=濃い）へ線形に反転変換。
  liquidMaterial.attenuationDistance =
    ATTEN_MAX_DIST - (ATTEN_MAX_DIST - ATTEN_MIN_DIST) * d;

  // --- 濁り（散乱）のSSS近似 ---------------------------------------------
  // (1) 透過：濁るほど下げる。turbidity=0 で 0.98（従来）、=1 でほぼ0（透けない）。
  liquidMaterial.transmission = BASE_TRANSMISSION * (1.0 - t);

  // (2) 拡散色：濁るほど純色をほんの少し「ミルク白(MILK_WHITE)」へ寄せる。
  //   ただし白寄せ量は WHITE_SAT_T（=0.3）で頭打ちにし、それ以上濁らせても
  //   色は白くしない。これで「不透明にはなるが、元の色は残る（濁った果汁的）」
  //   挙動になり、濁り中盤以降に色が白へ飛ぶ不自然さを防ぐ。
  //   whiteAmt: 0 → WHITE_MAX(=0.15) まで、t=WHITE_SAT_T で最大に達してフラット。
  const whiteAmt = WHITE_MAX * Math.min(t / WHITE_SAT_T, 1);
  liquidMaterial.color.setRGB(
    pr + (MILK_WHITE - pr) * whiteAmt,
    pg + (MILK_WHITE - pg) * whiteAmt,
    pb + (MILK_WHITE - pb) * whiteAmt,
  );

  // (3) つや：澄んだ時はツルッと、濁ると大きくマットに。
  //   濁り＝微粒子による乱反射なので、表面のラフネスも濁りと強く連動させる。
  //   ここが甘いと「光は通さないのに表面だけ磨いたプラスチック」のように
  //   1点の強いハイライトが残る。そこで2つ手を打つ：
  //     ①最大ラフネスを 0.95 まで上げる（濁り最大でほぼ光沢を消す）
  //     ②直線連動ではなく ease-out 曲線にする：f(t)=1-(1-t)^2。
  //       序盤で一気に立ち上がり、後半はなだらかに収束する。
  //       → スライダー半分手前から素早くマット化し、強烈なハイライトを抑える。
  //   turbidity=0 で 0.02（従来）、=0.5 で約0.72、=1 で 0.95。
  const MAX_ROUGHNESS = 0.95;
  const ease = 1 - (1 - t) * (1 - t); // ease-out（早く立ち上がる）
  liquidMaterial.roughness =
    BASE_ROUGHNESS + (MAX_ROUGHNESS - BASE_ROUGHNESS) * ease;

  // (4) 反射の“強さ”：これがテカリの主因。ラフネスは「ハイライトの広がり」を
  //   決めるだけで、反射率が高いままだと“広いけど明るい”テカリが残る。
  //   濁った微粒子の液体は表面反射が弱まり拡散主体になるので、濁るほど
  //   ・specularIntensity（鏡面反射の強さ）
  //   ・envMapIntensity（環境マップの映り込みの強さ）
  //   を下げる。ease-out で序盤から素早く落とすと、半分手前のテカリが消える。
  liquidMaterial.specularIntensity =
    BASE_SPECULAR_INTENSITY * (1 - 0.9 * ease); // 1.0 → 0.1
  liquidMaterial.envMapIntensity =
    BASE_ENVMAP_INTENSITY * (1 - 0.85 * ease); // 0.3 → 約0.05

  // ★重要：ここでも material.needsUpdate = true は “あえて呼ばない”。
  //   color / attenuationColor / attenuationDistance / transmission / roughness は
  //   いずれもシェーダーの uniform なので、値を代入するだけで次の描画に自動反映される。
  //   透過機能(USE_TRANSMISSION)はマテリアル生成時 transmission=0.98(>0) で既にON。
  //   実行時に transmission を 0 にしても“切替フラグ”は変わらず透過量の uniform が
  //   0 になるだけなので、再コンパイルは不要。needsUpdate=true にすると逆に
  //   onBeforeCompile（縦グラデ）が毎フレーム再実行されて重く＆チラつくため避ける。
}

// --- 初期値を1回だけ流し込む（現状の見た目を維持する値） --------------------
//   INITIAL_DENSITY は「現在の attenuationDistance=2」に一致する density を逆算した値：
//     d = (MAX - 2) / (MAX - MIN) = (10 - 2) / (10 - 0.5) ≒ 0.842
const INITIAL_RGB = { r: LIQUID_COLOR.r, g: LIQUID_COLOR.g, b: LIQUID_COLOR.b };
const INITIAL_DENSITY =
  (ATTEN_MAX_DIST - 2) / (ATTEN_MAX_DIST - ATTEN_MIN_DIST);
const INITIAL_TURBIDITY = 0; // 起動時は澄んだ透明（従来の見た目）
setLiquidAppearance(INITIAL_RGB, INITIAL_DENSITY, INITIAL_TURBIDITY);

// ----------------------------------------------------------------------------
// ★ スマホでパネルを開いたときのカメラ調整 ★ — スマホ表示のときだけ
//   スマホでパネルを開くと画面の右側が隠れてしまう。そこでパネルを開いている間だけ、
//   ①カメラの座標を動かし ②ズーム率を変え ③描画を左へ寄せて、グラス全体を
//   左の空きスペースに収め、液体の変化を見やすくする。
//
//   調整できる3つのパラメータ（ここの数値を変えるだけで見え方を詰められる）：
//     (1) PANEL_CAM_POS … パネルを開いた時の【カメラの座標(x,y,z)】。
//         z を大きくすると後ろに下がって全体が見える／y を上げると見下ろし気味になる。
//         OrbitControls が毎フレーム「グラスの方を向く」ので、座標を変えると角度も変わる。
//     (2) PANEL_VIEW_ZOOM … 【ズーム率】。1=標準 / 1未満で引き（小さく収まる）/ 1超で寄り。
//     (3) PANEL_VIEW_SHIFT … 画面幅に対して描画を左へずらす割合（大きいほど左へ寄る）。
//         setViewOffset（画面ピクセル基準）なので端末の縦横比に依存せず安定。
//   ※閉じたときは「開く直前のカメラ状態」へ戻すので、ユーザーが回していた向きは保持される。
//   ※PC（IS_MOBILE===false）では何もしない＝従来と完全に同じ。
// ----------------------------------------------------------------------------
// (1) パネルを開いた時のカメラ座標。
//   高さ(y)を大きく上げ、距離(z)を少し詰めることで「斜め上から見下ろす」視点にする。
//   注視点はグラス(controls.target=(0,1.35,0))なので、カメラを高くするほど見下ろし角が強くなる。
//   現状(0,6.5,7.0)＝水平から約36°見下ろす角度（ボウルの中の液面が見える俯瞰ぎみのビュー）。
//   もっと見下ろしたいなら y を上げる／z を小さくする。水平寄りにしたいなら y を下げる。
const PANEL_CAM_POS = new THREE.Vector3(0, 6.5, 7.0);
// (2) ズーム率（1=標準 / 小さいほど引き）。
const PANEL_VIEW_ZOOM = 0.85;
// (3) 左へずらす割合（画面幅に対する比率）。
const PANEL_VIEW_SHIFT = 0.24;

let isPanelOpen = false; // パネルが今開いているか（リサイズ時の再適用に使う）
// 「開く直前」のカメラ座標とズームを覚えておき、閉じたら元に戻す入れ物。
//   初期値は起動時（=規定）のカメラ状態。
const savedCam = { pos: camera.position.clone(), zoom: camera.zoom };

// open=true でパネルを開いたときのビュー（座標移動＋ズーム＋左寄せ）、false で元へ戻す。
function applyPanelView(open: boolean): void {
  isPanelOpen = open;
  if (!IS_MOBILE) return; // ★スマホのときだけ効かせる（PCは何もしない）
  const w = window.innerWidth;
  const h = window.innerHeight;
  // 今パネルビューが効いているか（view.enabled が true なら既に寄せ状態）。
  const alreadyShifted = camera.view !== null && camera.view.enabled;
  if (open) {
    // まだ通常ビューのときだけ、現在のカメラ状態を保存（閉じた時に戻すため）。
    // リサイズ等で開いたまま再適用されたときに、寄せ後の座標で上書きしないようにする。
    if (!alreadyShifted) {
      savedCam.pos.copy(camera.position);
      savedCam.zoom = camera.zoom;
    }
    camera.position.copy(PANEL_CAM_POS); // ①カメラ座標を移動（角度・距離が変わる）
    camera.zoom = PANEL_VIEW_ZOOM; // ②ズーム率を適用
    // ③横オフセットを正にして描画を左へずらす（グラスが左の空きスペースへ寄る）。
    //   setViewOffset の中で updateProjectionMatrix が呼ばれ zoom もここで反映される。
    camera.setViewOffset(w, h, w * PANEL_VIEW_SHIFT, 0, w, h);
  } else {
    camera.clearViewOffset(); // 左寄せを解除（中央に戻す）
    camera.position.copy(savedCam.pos); // 開く前のカメラ座標へ戻す
    camera.zoom = savedCam.zoom; // 開く前のズームへ戻す
    camera.updateProjectionMatrix(); // 変更を確定
  }
}

// --- 操作UIを起動 -----------------------------------------------------------
//   UIは値を集めるだけで、3Dへの反映は onChange → setLiquidAppearance に任せる。
//   将来 color-engine をつなぐときは、この UI の代わりに mixCocktail() の出力を
//   setLiquidAppearance() に渡せばよい（接続点が1か所に集約されている）。
createLiquidUI({
  initialRGB: INITIAL_RGB,
  initialDensity: INITIAL_DENSITY,
  initialTurbidity: INITIAL_TURBIDITY,
  onChange: (rgb, density, turbidity) =>
    setLiquidAppearance(rgb, density, turbidity),
  // パネルの開閉に合わせてスマホ時のカメラ寄せを切り替える。
  onToggle: (open) => applyPanelView(open),
});

// ============================================================================
// 5.5 木の机（グラスを乗せる板）
//   「木の机の上にグラスが乗っている」という設定にするため、グラスの足元(y=0)に
//   水平な板（plane）を1枚敷く。木目は外部画像を使わず、makeWoodTexture() で
//   canvas に手続き的に描いたテクスチャを map（UVマッピング）して表現する。
// ============================================================================
const woodTexture = makeWoodTexture();
// PlaneGeometry は初期状態で「画面に正対する縦の板」なので、X軸まわりに -90°
// 回して水平（床）にする。
//   ・幅(左右)=40 …… 画面の左右いっぱいに机を広げる
//   ・奥行(前後)=6.3 … 中心(z=0)にグラスがあるので、手前 z=+3.15／奥 z=-3.15 まで。
//     グラス(z=0)がちょうど奥行き方向の中心（半分の位置）になる。
const woodGeometry = new THREE.PlaneGeometry(40, 6.3);
// ★机は MeshLambertMaterial を使う（重要）。
//   MeshStandardMaterial だと scene.environment（スタジオ環境マップ）の一様な
//   起こし光＋白い鏡面反射を机が拾ってしまい、diffuse色をどれだけ暗くしても
//   机が真っ暗にならなかった（環境マップの反射フロアが残る）。
//   Lambert は環境マップの一様照射を受けず「ライト（ピンスポット）だけ」で照らされる
//   ので、光が当たらない所は真っ黒になり、グラスの下だけ木が浮かぶ参考画像の見え方になる。
const woodMaterial = new THREE.MeshLambertMaterial({
  map: woodTexture, // 木目テクスチャを色として貼る
  // color は map に掛かる乗数。Lambert は白い鏡面反射フロアが無いので、ここを
  // 暗くすると机全体が素直に暗くなる（＝木の画像を思いっきり暗くできる）。
  color: 0xb07a4e,
});
const woodPlane = new THREE.Mesh(woodGeometry, woodMaterial);
woodPlane.rotation.x = -Math.PI / 2; // 水平に倒す
woodPlane.position.y = -0.015; // グラス台座(y=0)のわずか下。重なり(z-fighting)を防ぐ
scene.add(woodPlane);

// ----------------------------------------------------------------------------
// 偽の影（接地影）：中心が濃く外へ透明になる「黒いぼかし円盤」を台座の真下に1枚敷く。
//   物理的な影ではないが、これだけで「机に置いてある」接地感が出る（負荷ほぼゼロ）。
//   ・放射状グラデを canvas で描いて CanvasTexture にし、平らな板に貼る。
//   ・黒なのでトーンマッピングの影響を受けない（黒は露出を変えても黒）。
//   ・透明＋depthWrite:false で机の上にそっと重ねる。
// ----------------------------------------------------------------------------
function makeShadowTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  g.addColorStop(0.0, 'rgba(0,0,0,0.55)'); // 中心の濃さ
  g.addColorStop(0.4, 'rgba(0,0,0,0.25)');
  g.addColorStop(1.0, 'rgba(0,0,0,0)'); // 外周は透明
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}
const shadowMaterial = new THREE.MeshBasicMaterial({
  map: makeShadowTexture(),
  transparent: true,
  depthWrite: false, // 床にめり込まない／重なりトラブル防止
});
// 円盤サイズは台座直径(約1.44)より少し大きめにして、足元からにじむ柔らかい影に。
const shadowPatch = new THREE.Mesh(
  new THREE.PlaneGeometry(3.2, 3.2),
  shadowMaterial,
);
shadowPatch.rotation.x = -Math.PI / 2; // 机と平行に寝かせる
shadowPatch.position.set(0, -0.005, 0); // 机(y=-0.015)のすぐ上・台座底(y=0)の下
scene.add(shadowPatch);

// ============================================================================
// 5.6 バックバー（背景の実写写真）
//   グラスの奥に縦のプレーンを立て、public/backbar.jpg（実写のバー/ラウンジ写真）を
//   テクスチャとして貼る。MeshBasicMaterial（自己発光・ライト非依存）なので暗い
//   シーンでもそのまま見え、奥に置くことで DOF（被写界深度）でほどよくボケて
//   "バーの背景"になる。
//   ・写真は元から暗め・ボケ気味なので、そのまま雰囲気のある背景になる。
//   ・写真は sRGB なので colorSpace を合わせる（合わせないと色がくすむ）。
// ============================================================================
const backBarTexture = new THREE.TextureLoader().load('/backbar.jpg');
backBarTexture.colorSpace = THREE.SRGBColorSpace;
// 写真のアスペクト比（1874:899 ≒ 2.085:1）を保ったままプレーンを作る。
//   カメラ(fov45°)から z=-9 の奥行までで「画面に見える縦範囲」は約14.5。プレーンを
//   それより大きくすると写真の上下（特に上のランプ）が画面外に切れてしまうので、
//   高さ=15 に抑えて写真全体（ランプ＋ソファ）が背景に収まるようにする。
//   幅 = 15 × 2.085 ≒ 31.3 で、画面幅(約25.8)も十分に覆う。
const BACKBAR_ASPECT = 1874 / 899;
const BACKBAR_H = 15;
const BACKBAR_W = BACKBAR_H * BACKBAR_ASPECT;
const backBarGeometry = new THREE.PlaneGeometry(BACKBAR_W, BACKBAR_H);
const backBarMaterial = new THREE.MeshBasicMaterial({
  map: backBarTexture, // 実写写真を貼る
  // ★重要：トーンマッピングを通さない。
  //   シーンは ACES＋EXPOSURE 0.35 で暗部を強く潰す設定なので、そのままだと
  //   元から暗い写真がさらに沈んで真っ黒な帯になってしまう。toneMapped=false に
  //   すると写真は元の明るさのまま表示され、ランプやソファが見える。
  toneMapped: false,
});
const backBar = new THREE.Mesh(backBarGeometry, backBarMaterial);
// グラス(z=0)よりかなり奥(z=-9)に立てる。机の奥端(z=-3.15)よりさらに後ろ。
//   y=0.5：写真をやや下げて、上の吊りランプが画面上端で切れずに収まるようにする。
//   （カメラfov45°・z=-9 では画面上端が world y≒8.1。写真上端のランプがそこを
//    超えないよう写真全体を少し下げる。）
backBar.position.set(0, 0.5, -9);
scene.add(backBar);

// ※ ステップ6まで置いていた透け確認用のグリッド（GridHelper）は、
//   ステップ7で背景を作り込んだので廃止した（背景の邪魔になるため）。

// ============================================================================
// 6. OrbitControls（マウス操作）
//    ドラッグでカメラを回転、ホイールでズームできるようにする。
//    どの canvas 上のマウス操作を拾うか渡すため、第2引数に renderer.domElement。
// ============================================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 慣性をつけ、ドラッグを離しても滑らかに止まる
// グラスは縦に背が高いので、中心(y=0)ではなくボウル寄り(y=1.4)を見つめながら回す。
controls.target.set(0, 1.35, 0);

// ============================================================================
// 6.5 後処理（ポストプロセス）— ステップ5：bloom ＋ ステップ7：DOF
//   通常は「renderer が描いた絵」をそのまま画面に出すが、後処理では
//   いったん絵を作ってから効果(bloom 等)を順番に重ねて、最後に画面へ出す。
//   その「流れ作業の管理役」が EffectComposer。pass を addPass した順に処理される。
//     1) RenderPass   … まず普通にシーンを描く（土台の絵）
//     2) UnrealBloomPass … 明るい部分を抽出してぼかし、元の絵に光として足す
//     3) BokehPass    … 奥行き(深度)を見て、ピント外（背景）をぼかす＝被写界深度
//     4) OutputPass   … 最後に色空間(sRGB)へ正しく変換して画面へ出す
//        ※ EffectComposer を使うと renderer 直描画の色変換が効かなくなるため、
//          OutputPass で戻さないと色がくすむ。最新Three.jsでの定番の締め。
// ============================================================================
const composer = new EffectComposer(renderer);
composer.setPixelRatio(PIXEL_RATIO); // renderer と同じ上限付きピクセル比
composer.addPass(new RenderPass(scene, camera)); // (1) 土台の絵

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), // 効果をかける解像度
  BLOOM_STRENGTH, // 強さ（PCはプリセット値／スマホは一段弱め）
  bloom.radius, // にじみ半径
  bloom.threshold, // 光り始める明るさの閾値
);
composer.addPass(bloomPass); // (2) bloom

// (3) DOF（被写界深度）。USE_DOF が true のときだけ追加する。
//   BokehPass はシーンの「深度（カメラからの距離）」を内部で測り、
//   FOCUS_DISTANCE から外れた所ほど強くぼかす。背景は一番奥なので大きくボケる。
//   あとでリサイズや無効化のため、外側スコープの変数に入れておく。
let bokehPass: BokehPass | null = null;
if (USE_DOF) {
  bokehPass = new BokehPass(scene, camera, {
    focus: FOCUS_DISTANCE, // ピントが合う距離（カメラ〜グラス＝約8.5）
    aperture: dof.aperture, // 絞り（大きいほど背景が強くボケる）
    maxblur: DOF_MAXBLUR, // ボケの最大の強さ（PCはプリセット値／スマホは一段弱め）
  });
  composer.addPass(bokehPass);
}

composer.addPass(new OutputPass()); // (4) 色を画面用に整えて出力

// ============================================================================
// アニメーションループ
//   requestAnimationFrame は「次の描画タイミングで関数を呼んで」とブラウザに依頼する仕組み。
//   毎フレーム呼び続けることで、操作やアニメを反映した最新の絵を描き続ける。
//   ※ 後処理を入れたので renderer.render ではなく composer.render() を呼ぶ。
// ============================================================================
function animate() {
  requestAnimationFrame(animate); // 次フレームでも自分を呼ぶ（ループ継続）
  controls.update(); // マウス操作と慣性(damping)を反映
  composer.render(); // RenderPass→Bloom→(DOF)→Output の順に処理して画面へ出す
}
animate();

// ============================================================================
// ウィンドウリサイズ対応
//   画面サイズが変わったら、カメラの比率と描画サイズを追従させる
//   （これをしないと画面比が崩れ、絵が縦横に伸びてしまう）。
//   後処理を入れたので composer・bloomPass・bokehPass のサイズも一緒に更新する。
// ============================================================================
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h; // 画面比を更新
  camera.updateProjectionMatrix(); // カメラ設定の変更を確定させる
  renderer.setSize(w, h); // 描画サイズを更新
  composer.setSize(w, h); // 後処理の作業バッファも同じサイズに
  bloomPass.setSize(w, h); // bloom の解像度も追従
  if (bokehPass) bokehPass.setSize(w, h); // DOF の作業バッファも追従
  // パネルを開いている間のビュー寄せはピクセル基準なので、サイズが変わったら
  // 新しい画面幅で計算し直す（回転や端末回転で崩れないように）。
  if (IS_MOBILE && isPanelOpen) applyPanelView(true);
});
