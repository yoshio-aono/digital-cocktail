// ============================================================================
// カクテル3Dビジュアル化エンジン（1液プログラム）— エントリ
//   3D表示の「見た目に関わる全条件」（ライト・グラス/液体マテリアル・机・影・背景・
//   環境マップ・bloom・DOF・露出）は src/scene/cocktail-scene.ts に集約した共有
//   モジュールが構築する。main.ts はそれを呼び出し、ここでしか必要ない
//   「操作(OrbitControls)・UI(液体スライダー)・スマホパネル・描画ループ」だけを担う。
//
//   ★3D表示条件を調整したいときは main.ts ではなく cocktail-scene.ts を編集する。
//     同じモジュールを mixer の結果ビューも使うため、両者の見た目が常に一致する。
// ============================================================================

import * as THREE from 'three';
// OrbitControls はマウスでカメラを回す/ズームする補助ツール（操作はエントリ固有）。
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
// 液体の色・濃さを手で操作するUI（HTML+CSS+canvasの自作パネル）。
import { createLiquidUI } from './liquid-ui';
// 3Dシーン一式を構築する共有モジュール（見た目の全条件はこの中）。
import {
  buildCocktailScene,
  CAMERA_TARGET,
  INITIAL_LIQUID_RGB,
  INITIAL_DENSITY,
} from './scene/cocktail-scene';

// ----------------------------------------------------------------------------
// ★ スマホ判定（軽い判定：画面幅のみ）★ — スマホパネルのカメラ寄せに使う。
//   ※描画品質の IS_MOBILE 切替（解像度/bloom/DOF）は共有モジュール側に同じ判定がある。
// ----------------------------------------------------------------------------
const IS_MOBILE = window.innerWidth <= 768;
console.log('IS_MOBILE:', IS_MOBILE);

// ----------------------------------------------------------------------------
// 3Dシーンを構築（renderer/scene/camera/ライト/マテリアル/机/影/背景/bloom/DOF）。
//   canvas を渡さないので three が内部 canvas を作る → それを body に追加する。
// ----------------------------------------------------------------------------
const sc = buildCocktailScene();
const { renderer, camera, composer, setLiquidAppearance, resize } = sc;
document.body.appendChild(renderer.domElement);

// ----------------------------------------------------------------------------
// 液体の初期値を1回だけ流し込む（現状の見た目を維持する値）。
// ----------------------------------------------------------------------------
const INITIAL_RGB = { ...INITIAL_LIQUID_RGB };
const INITIAL_TURBIDITY = 0;
setLiquidAppearance(INITIAL_RGB, INITIAL_DENSITY, INITIAL_TURBIDITY);

// ============================================================================
// OrbitControls（マウス操作）— エントリ固有
//   ドラッグで回転、ホイールでズーム。注視点は共有モジュールの CAMERA_TARGET に合わせる。
// ============================================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);

// ============================================================================
// ★ スマホでパネルを開いたときのカメラ調整 ★ — スマホ表示のときだけ
//   スマホでパネルを開くと右側が隠れるので、開いている間だけカメラを動かし・ズーム・
//   描画を左へ寄せて、グラス全体を左の空きスペースに収める。PCでは何もしない。
// ----------------------------------------------------------------------------
const PANEL_CAM_POS = new THREE.Vector3(0, 5.5, 7.0); // 開いた時のカメラ座標
const PANEL_VIEW_ZOOM = 0.9; // ズーム率（1=標準）
const PANEL_VIEW_SHIFT = 0.26; // 左へずらす割合（画面幅比）

let isPanelOpen = false; // パネルが今開いているか（リサイズ時の再適用に使う）
// 「開く直前」のカメラ座標とズームを覚えておき、閉じたら元に戻す入れ物。
const savedCam = { pos: camera.position.clone(), zoom: camera.zoom };

function applyPanelView(open: boolean): void {
  isPanelOpen = open;
  if (!IS_MOBILE) return; // スマホのときだけ効かせる
  const w = window.innerWidth;
  const h = window.innerHeight;
  const alreadyShifted = camera.view !== null && camera.view.enabled;
  if (open) {
    if (!alreadyShifted) {
      savedCam.pos.copy(camera.position);
      savedCam.zoom = camera.zoom;
    }
    camera.position.copy(PANEL_CAM_POS);
    camera.zoom = PANEL_VIEW_ZOOM;
    camera.setViewOffset(w, h, w * PANEL_VIEW_SHIFT, 0, w, h);
  } else {
    camera.clearViewOffset();
    camera.position.copy(savedCam.pos);
    camera.zoom = savedCam.zoom;
    camera.updateProjectionMatrix();
  }
}

// --- 操作UIを起動 -----------------------------------------------------------
//   UIは値を集めるだけで、3Dへの反映は onChange → setLiquidAppearance に任せる。
createLiquidUI({
  initialRGB: INITIAL_RGB,
  initialDensity: INITIAL_DENSITY,
  initialTurbidity: INITIAL_TURBIDITY,
  onChange: (rgb, density, turbidity) =>
    setLiquidAppearance(rgb, density, turbidity),
  onToggle: (open) => applyPanelView(open),
});

// ============================================================================
// アニメーションループ
//   毎フレーム描き直して、操作やアニメを反映し続ける。後処理を入れているので
//   renderer.render ではなく composer.render() を呼ぶ。
// ============================================================================
function animate() {
  requestAnimationFrame(animate);
  controls.update(); // マウス操作と慣性(damping)を反映
  composer.render(); // RenderPass→Bloom→(DOF)→Output
}
animate();

// ============================================================================
// ウィンドウリサイズ対応
//   画面サイズが変わったら、カメラ比率・描画サイズ・後処理バッファを追従させる。
// ============================================================================
window.addEventListener('resize', () => {
  resize(window.innerWidth, window.innerHeight);
  // パネルを開いている間のビュー寄せはピクセル基準なので、サイズ変更時に再計算。
  if (IS_MOBILE && isPanelOpen) applyPanelView(true);
});
