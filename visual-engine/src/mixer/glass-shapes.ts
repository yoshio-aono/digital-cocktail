// ============================================================================
// グラスの形状定義（輪郭線 profile）— mixer 専用
//   グラスは「回転対称」なので、縦断面の輪郭を 2D 点列 Vector2(半径, 高さ) で定義し、
//   LatheGeometry で軸まわりに回して立体化する（既存 main.ts と同じ考え方）。
//
//   ◆ここで扱う2種類のグラス：
//     1. マティーニグラス（結果タブ用・大）… 既存 main.ts の GLASS_PROFILE を複製。
//        ※指示により既存 main.ts は無改変。デグレ防止のため共有せずここへコピーする。
//     2. 小グラス（液体1/2用）… 新規モデリング。SMALL_GLASS_STYLES でパラメトリックに
//        2〜3パターン切替できるようにする（青野さんが見比べて選ぶ）。
// ============================================================================

import * as THREE from 'three';

// グラス1つぶんの形状一式。LatheGeometry に渡す輪郭と、液体を作るための基準点。
export interface GlassShape {
  // グラス本体の輪郭（下→外側を上へ→リム→内側を下って閉じる）。
  profile: THREE.Vector2[];
  // ボウル（カップ）内側の底。液体プロファイルの起点。
  innerBottom: THREE.Vector2;
  // ボウル（カップ）内側のリム（飲み口）。液体プロファイルの上限。
  innerRim: THREE.Vector2;
  // カメラの初期位置と注視点（形状ごとに見やすい画角が違うので持たせる）。
  cameraPos: [number, number, number];
  cameraTarget: [number, number, number];
}

// ----------------------------------------------------------------------------
// ★ マティーニグラス（結果タブ・大）★
//   既存 main.ts の GLASS_PROFILE / BOWL_INNER_* をそのまま複製した値。
//   （既存を import せず複製する理由：main.ts を一切改変しないため＝デグレ厳禁）
// ----------------------------------------------------------------------------
const MARTINI_PROFILE: THREE.Vector2[] = [
  new THREE.Vector2(0.0, 0.0), //  1 台座の中心（底）
  new THREE.Vector2(0.72, 0.0), //  2 台座の外周
  new THREE.Vector2(0.7, 0.2), //  3 台座のふち（厚み）
  new THREE.Vector2(0.12, 0.2), //  4 台座からステムへ立ち上げ
  new THREE.Vector2(0.09, 0.24), //  5 ステム下端
  new THREE.Vector2(0.085, 1.436), //  6 ステム上端
  new THREE.Vector2(0.1, 1.516), //  7 ボウルの付け根
  new THREE.Vector2(0.887, 2.698), //  8 直線のV字でリムへ（外側）
  new THREE.Vector2(0.907, 2.758), //  9 リム（飲み口）外側＝最大幅
  new THREE.Vector2(0.857, 2.738), // 10 リム内側
  new THREE.Vector2(0.06, 1.566), // 11 ボウル内側の底へ
  new THREE.Vector2(0.0, 1.566), // 12 内側の底を中心で閉じる
];

export const MARTINI_SHAPE: GlassShape = {
  profile: MARTINI_PROFILE,
  innerBottom: new THREE.Vector2(0.06, 1.566), // 点11と一致
  innerRim: new THREE.Vector2(0.857, 2.738), // 点10と一致
  // 既存 main.ts の値（アイレベル側面ビュー）に合わせる。
  cameraPos: [0, 1.7, 8.5],
  cameraTarget: [0, 1.35, 0],
};

// ----------------------------------------------------------------------------
// ★ 小グラス（液体1/2用）★ — 新規モデリング、パラメトリック生成
//   脚なしのカップ型（ショット〜タンブラー系）を、少ないパラメータから自動生成する。
//   下記 SMALL_GLASS_STYLES に「寸法のセット」を3つ用意し、定数で切り替える。
//
//   パラメータの意味（単位は3D空間の長さ。マティーニと同じ尺度）：
//     baseR      … 底の半径
//     topR       … リム（飲み口）の半径。baseR より大きいと上開き、小さいとすぼまり
//     height     … グラスの高さ（底から飲み口まで）
//     wall       … 側面の厚み（外側と内側の半径差）
//     baseThick  … 底の厚み（重底ガラス感。大きいほどどっしり）
// ----------------------------------------------------------------------------
export interface SmallGlassSpec {
  baseR: number;
  topR: number;
  height: number;
  wall: number;
  baseThick: number;
}

// 3パターンの寸法プリセット（青野さんが見比べて選ぶ）。
//   1 = ショット（細く背が低い・厚底）
//   2 = タンブラー（中口径・背が高い）
//   3 = ロック（口広・背が低い・どっしり）
export const SMALL_GLASS_STYLES: Record<1 | 2 | 3, SmallGlassSpec> = {
  1: { baseR: 0.42, topR: 0.5, height: 1.1, wall: 0.06, baseThick: 0.16 }, // ショット
  2: { baseR: 0.5, topR: 0.56, height: 1.7, wall: 0.05, baseThick: 0.12 }, // タンブラー
  3: { baseR: 0.66, topR: 0.74, height: 0.95, wall: 0.07, baseThick: 0.18 }, // ロック
};

// 寸法セットから、グラス輪郭・内側基準点・カメラを組み立てる。
//   輪郭の回り方（既存マティーニと同じ）：
//     底中心 → 底外周 → 外側を上へ → リム外 → リム内 → 内側を下へ → 内底外周 → 内底中心
export function buildSmallGlassShape(spec: SmallGlassSpec): GlassShape {
  const { baseR, topR, height, wall, baseThick } = spec;

  // 内側の半径は外側から壁の厚みを引いた値。
  const innerBaseR = Math.max(baseR - wall, 0.02);
  const innerTopR = Math.max(topR - wall, 0.02);
  // 内側の底の高さ＝底の厚みぶん上。ここに液体がたまる。
  const innerBottomY = baseThick;

  const profile: THREE.Vector2[] = [
    new THREE.Vector2(0.0, 0.0), // 底の中心
    new THREE.Vector2(baseR, 0.0), // 底の外周
    new THREE.Vector2(topR, height), // 外側の壁を上へ（リム外）
    new THREE.Vector2(innerTopR, height), // リムの上面を内側へ渡る
    new THREE.Vector2(innerBaseR, innerBottomY), // 内側の壁を下へ
    new THREE.Vector2(0.0, innerBottomY), // 内側の底を中心で閉じる
  ];

  // カメラ：グラスの高さに応じて、やや上から見下ろし気味の固定アングル。
  //   小グラスは視点固定・静止なので、ここで決めた1アングルだけ使う。
  //   ★少しだけ見下ろし：カメラを高めに上げつつ注視点をリム寄りに上げると、
  //     グラス上部の液面がほんの少し覗く程度の俯角になる。
  const cy = height * 0.5; // グラスの中ほど（高さの基準）
  const dist = height * 2.0 + 1.0; // 高いグラスほど少し引く（さらに寄り＝ズームイン）
  return {
    profile,
    innerBottom: new THREE.Vector2(innerBaseR, innerBottomY),
    innerRim: new THREE.Vector2(innerTopR, height),
    // カメラを高めに上げ、注視点はグラス中ほど。適度な俯角で液面の楕円が見え、
    // グラスが画面中央に程よい大きさで収まる初期アングル。
    cameraPos: [0, cy + height * 1.05, dist],
    cameraTarget: [0, height * 0.55, 0],
  };
}

// ----------------------------------------------------------------------------
// ★ 液体の輪郭を作る ★（グラス共通）
//   グラス内側の「底」と「リム」を結ぶ線を、注ぎ量 fill(0〜1) で内分した高さで
//   水平に閉じる。z-fighting（面の重なりチラつき）を避けるため、ほんの少し
//   内側（×inset）に縮める。既存 main.ts の LIQUID_PROFILE と同じ作り方。
// ----------------------------------------------------------------------------
export function buildLiquidProfile(
  shape: GlassShape,
  fill: number,
  inset = 0.97,
): THREE.Vector2[] {
  const b = shape.innerBottom;
  const r = shape.innerRim;
  const fillY = b.y + (r.y - b.y) * fill; // 液面の高さ
  const fillR = b.x + (r.x - b.x) * fill; // 液面の縁の半径
  return [
    new THREE.Vector2(0.0, b.y), // 液体の底の中心
    new THREE.Vector2(b.x * inset, b.y), // 底の外周
    new THREE.Vector2(fillR * inset, fillY), // 内側に沿って液面の縁へ
    new THREE.Vector2(0.0, fillY), // 液面を中心で水平に閉じる
  ];
}
