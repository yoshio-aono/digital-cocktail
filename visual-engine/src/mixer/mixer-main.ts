// ============================================================================
// mixer-main — 2液混合ビューアーのエントリ（ルート index.html から読み込まれる）
//   画面は2タブ：
//     ・設定タブ … 液体1/2の「左＝小グラス(静止)プレビュー／右＝1液プログラムと同じ
//                  色設定パネル(彩度×明度ピッカー＋色相バー＋濃さ/濁り)」、混合比率A、希釈B
//     ・結果タブ … マティーニグラス(操作可・リッチ)＋混合結果の色情報
//
//   ◆負荷管理（指示書 2-2）：
//     ・アクティブなタブの3Dだけ描く。結果タブから離れたら描画ループを止める。
//     ・小グラスは常時ループせず、値が変わったときに1フレームだけ描く。
//
//   ◆色は1液プログラムと同じく HSV（色相・彩度・明度）で保持し、混合エンジンも
//     彩度・明度を含めて補間する（hsvToRgb で3Dへ）。
// ============================================================================

import '../style.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GlassView } from './glass-view';
import type { GlassShape } from './glass-shapes';
import {
  SMALL_GLASS_STYLES,
  buildSmallGlassShape,
  buildLiquidProfile,
} from './glass-shapes';
import {
  mixTwoLiquids,
  hsvToRgb,
  MAX_DILUTION,
  type LiquidParams,
} from './mix-color';
// 結果ビューの3Dは「1液プログラムと完全に同じ」共有モジュールで構築する。
import { buildCocktailScene, CAMERA_TARGET } from '../scene/cocktail-scene';
// 結果の数値表示も1液プログラムと同じパネルを使う（readonly＝固定表示）。
import { createLiquidUI, type LiquidUIHandle } from '../liquid-ui';

// ----------------------------------------------------------------------------
// ★ 調整用の定数（ここだけ触れば挙動が変わる）★
// ----------------------------------------------------------------------------
// 小グラスの形状パターン。1=ショット / 2=タンブラー / 3=ロック（見比べて選ぶ）。
const SMALL_GLASS_STYLE: 1 | 2 | 3 = 1;
// 小グラスをリッチ表示にするか。false=簡易（軽い）。指示どおり既定は簡易。
const SMALL_GLASS_RICH = false;
// グラスにどれだけ注ぐか（0〜1）。0.8＝8分目。
const LIQUID_FILL = 0.8;

// ----------------------------------------------------------------------------
// 状態（2液のパラメータ＋混合比率＋希釈）。スライダーがこの値を書き換える。
// ----------------------------------------------------------------------------
// 色は HSV（hue 0〜360 / sat,val 0〜1）。彩度・明度は初期は最大(1)＝従来の見た目。
const liquid1: LiquidParams = {
  hue: 210,
  sat: 1,
  val: 1,
  density: 0.7,
  turbidity: 0,
}; // 青系
const liquid2: LiquidParams = {
  hue: 40,
  sat: 1,
  val: 1,
  density: 0.6,
  turbidity: 0,
}; // 黄橙系
let ratio = 0.5; // 比率A：0=液体1のみ / 1=液体2のみ
let dilution = 0.0; // 希釈B：0〜MAX_DILUTION

// ----------------------------------------------------------------------------
// 小さなDOMヘルパー（外部UIライブラリは使わない）
// ----------------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// ラベル付きスライダーを作る。値が変わるたび onInput(値) を呼ぶ。
function makeSlider(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  format: (v: number) => string,
  onInput: (v: number) => void,
): HTMLElement {
  const wrap = el('div', 'slider-row');
  const head = el('div', 'slider-head');
  const name = el('span');
  name.textContent = label;
  const val = el('span', 'slider-val');
  val.textContent = format(value);
  head.append(name, val);

  const input = el('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = format(v);
    onInput(v);
  });

  wrap.append(head, input);
  return wrap;
}

// 折りたたみ可能なブロック（見出しをクリックで本体を開閉）。
//   onToggle: 開閉のたびに呼ばれる（表示反映後に呼ぶので、開いた瞬間に中の canvas を
//   実寸でリサイズできる）。初期は閉じた状態。
function makeCollapsible(
  title: string,
  body: HTMLElement,
  onToggle?: (open: boolean) => void,
): HTMLElement {
  const block = el('div', 'block');
  const header = el('button', 'block-header');
  header.type = 'button';
  // 初期は閉じた状態（設定ビューに来たとき3ボックスとも畳んでおく）。
  let open = false;
  body.style.display = 'none';
  header.textContent = '▶ ' + title;
  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? '' : 'none';
    header.textContent = (open ? '▼ ' : '▶ ') + title;
    onToggle?.(open); // 表示反映後に通知（開いた瞬間に実寸が取れる）
  });
  block.append(header, body);
  return block;
}

// ----------------------------------------------------------------------------
// スタイル（最小限。タブバー＋2パネル＋スライダー）
// ----------------------------------------------------------------------------
function injectStyle(): void {
  const style = el('style');
  style.textContent = `
    :root { color-scheme: dark; }
    /* ★共有 style.css が html,body に height:100%; overflow:hidden を掛けている
       （1液プログラムの全画面3D用）。mixer はスクロールさせたいので、ここで上書きする。
       この <style> は style.css より後に読まれるので、同じ詳細度なら後勝ちで効く。 */
    html, body { height: auto; overflow: visible; }
    /* 設定タブの中身が縦に伸びたら、ページ全体（ドキュメント）が縦スクロールする。
       タブバーは position:sticky でスクロールしても上に残る。 */
    body { margin: 0; font-family: system-ui, sans-serif; background: #0e0e12; color: #e7e7ee; }
    #tabbar { position: sticky; top: 0; z-index: 10; display: flex; background: #16161c; border-bottom: 1px solid #2a2a33; }
    #tabbar button { flex: 1; padding: 14px; background: transparent; border: none; color: #9a9aa8; font-size: 17px; cursor: pointer; }
    #tabbar button.active { color: #fff; border-bottom: 2px solid #6da8ff; background: #1d1d25; }
    .panel { display: none; }
    .panel.active { display: block; }
    /* 開いたパネルで下が切れてもスクロールで届くよう、下端に余白を足す。 */
    #tab-settings { padding: 12px 12px 48px; max-width: 560px; margin: 0 auto; }
    .block { border: 1px solid #2a2a33; border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
    .block-header { width: 100%; text-align: left; padding: 12px 14px; background: #1a1a21; border: none; color: #cfcfe0; font-size: 16px; cursor: pointer; }
    .block-body { padding: 12px 14px; }
    /* 液体ブロック本体＝左:グラスプレビュー / 右:色設定パネル の2カラム */
    .liquid-body { display: flex; gap: 14px; align-items: stretch; }
    .glass-col { flex: 1 1 0; min-width: 0; display: flex; }
    .small-glass { flex: 1; width: 100%; min-height: 240px; display: block; border-radius: 8px; background: #15151b; }
    .slider-row { margin: 12px 0; }
    .slider-head { display: flex; justify-content: space-between; font-size: 15px; color: #b7b7c6; margin-bottom: 4px; }
    .slider-val { color: #fff; font-variant-numeric: tabular-nums; }
    /* スライダー（横トグル）。スマホで指で掴みやすいよう、つまみを大きくし、
       入力要素の高さを広げて縦方向の当たり判定を甘くする。
       ※WebKit(iOS/Chrome)はつまみを自前で描くため appearance:none が必要。
         そのぶんトラックとつまみを擬似要素で完全に指定する。 */
    input[type=range] {
      width: 100%;
      -webkit-appearance: none;
      appearance: none;
      height: 40px;            /* 当たり判定の縦幅（見た目より広め） */
      background: transparent;  /* トラックは下の擬似要素で描く */
      cursor: pointer;
      margin: 6px 0;
    }
    /* トラック（WebKit） */
    input[type=range]::-webkit-slider-runnable-track {
      height: 6px; border-radius: 3px; background: #3a3a46;
    }
    /* つまみ（WebKit）＝大きめの円。指で掴みやすいサイズ。 */
    input[type=range]::-webkit-slider-thumb {
      -webkit-appearance: none; appearance: none;
      width: 30px; height: 30px; border-radius: 50%;
      background: #6da8ff; border: 2px solid #cfe0ff;
      margin-top: -12px;       /* (track6 - thumb30)/2 で中央に乗せる */
      box-shadow: 0 1px 4px rgba(0,0,0,0.5);
    }
    /* トラック（Firefox） */
    input[type=range]::-moz-range-track {
      height: 6px; border-radius: 3px; background: #3a3a46;
    }
    /* つまみ（Firefox） */
    input[type=range]::-moz-range-thumb {
      width: 30px; height: 30px; border-radius: 50%;
      background: #6da8ff; border: 2px solid #cfe0ff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.5);
    }
    /* スライダー直下の数字表示（液体1:90% 液体2:10% / 希釈率;3.5倍）。
       視認性を高めるため赤っぽい文字色にする。 */
    .mix-readout { font-size: 15px; color: #ff7a7a; margin: -4px 0 2px; text-align: right; font-variant-numeric: tabular-nums; }
    .loose { padding: 4px 2px 0; }
    #tab-result { position: relative; }
    #result-canvas { width: 100vw; height: calc(100vh - 52px); display: block; }
  `;
  document.head.append(style);
}

// ----------------------------------------------------------------------------
// 画面の組み立て
// ----------------------------------------------------------------------------
injectStyle();

// --- タブバー ---------------------------------------------------------------
const tabbar = el('div');
tabbar.id = 'tabbar';
const btnSettings = el('button');
btnSettings.textContent = '設定';
const btnResult = el('button');
btnResult.textContent = '結果';
tabbar.append(btnSettings, btnResult);

// --- 設定パネル -------------------------------------------------------------
const settingsPanel = el('div', 'panel');
settingsPanel.id = 'tab-settings';

// 小グラスの canvas（液体1/2）。GlassView にそのまま渡す。
const canvas1 = el('canvas', 'small-glass');
const canvas2 = el('canvas', 'small-glass');

// 色設定パネル（1液プログラムのUI）の差し込み先。実体はビュー生成後に組み込む。
const uiMount1 = el('div', 'ui-col');
const uiMount2 = el('div', 'ui-col');

// 液体ブロックの本体＝2カラム（左:グラスプレビュー / 右:色設定パネルの差し込み先）。
function makeLiquidBody(
  canvas: HTMLCanvasElement,
  uiMount: HTMLElement,
): HTMLElement {
  const body = el('div', 'block-body liquid-body');
  const glassCol = el('div', 'glass-col');
  glassCol.append(canvas);
  body.append(glassCol, uiMount);
  return body;
}

// 液体ブロックを開いた瞬間に小グラスを実寸でリサイズする処理。実体（view1/view2）は
//   後で生成するので、ここでは入れ物だけ用意し、生成後に代入する（下の onLiquidBlockOpen）。
let onLiquidBlockOpen: ((idx: 1 | 2) => void) | null = null;
const block1 = makeCollapsible(
  '液体1',
  makeLiquidBody(canvas1, uiMount1),
  (open) => {
    if (open) onLiquidBlockOpen?.(1);
  },
);
const block2 = makeCollapsible(
  '液体2',
  makeLiquidBody(canvas2, uiMount2),
  (open) => {
    if (open) onLiquidBlockOpen?.(2);
  },
);

// 混合比率A・希釈B＝「混合パラメータ」パネル（折りたたみブロック）。一番上に置く。
const mixBody = el('div', 'block-body');

// --- 混合比率スライダー＋その下の数字表示（液体1：XX% 液体2：YY%）---
//   内部の ratio は従来どおり「0=液体1だけ / 1=液体2だけ」。ただしスライダーは
//   左端(=0)を液体2の100%にしたいので、表示値 v と ratio を反転させる（ratio=1-v）。
const ratioReadout = el('div', 'mix-readout');
function updateRatioReadout(): void {
  // ratio=0で液体1だけ(100%)、ratio=1で液体2だけ(100%)。
  ratioReadout.textContent = `液体1：${Math.round((1 - ratio) * 100)}%　液体2：${Math.round(ratio * 100)}%`;
}
updateRatioReadout();
mixBody.append(
  // 左端＝液体2(100%)、右端＝液体1(100%)。スライダー値 v に対し ratio = 1 - v。
  //   右端の数値表示は不要なので format は空文字を返す（下の readout で割合を表示）。
  makeSlider('混合比率 (液体2 ⇔ 液体1)', 0, 1, 0.01, 1 - ratio, () => '', (v) => {
    ratio = 1 - v;
    updateRatioReadout();
    onChange();
  }),
  ratioReadout,
);

// --- 希釈スライダー＋その下の数字表示（原液濃度；XX%）---
//   原液濃度＝元の液量／全体量＝(1-w)。w=0で100%、w=MAX_DILUTION(0.8)で20%（=5倍量）。
const dilutionReadout = el('div', 'mix-readout');
function updateDilutionReadout(): void {
  dilutionReadout.textContent = `原液濃度：${Math.round((1 - dilution) * 100)}%`;
}
updateDilutionReadout();
mixBody.append(
  // 右端の数値表示は不要なので format は空文字を返す（下の readout で原液濃度を表示）。
  makeSlider('希釈（水）', 0, MAX_DILUTION, 0.01, dilution, () => '', (v) => {
    dilution = v;
    updateDilutionReadout();
    onChange();
  }),
  dilutionReadout,
);

const mixPanel = makeCollapsible('混合パラメータ', mixBody);

// 並び順：混合パラメータ → 液体1 → 液体2。
settingsPanel.append(mixPanel, block1, block2);

// --- 結果パネル -------------------------------------------------------------
const resultPanel = el('div', 'panel');
resultPanel.id = 'tab-result';
const resultCanvas = el('canvas');
resultCanvas.id = 'result-canvas';
resultPanel.append(resultCanvas);

document.body.append(tabbar, settingsPanel, resultPanel);

// ----------------------------------------------------------------------------
// 小グラス2つ：視点固定・静止・（既定で）簡易マテリアル ＝ GlassView
// ----------------------------------------------------------------------------
const smallSpec = SMALL_GLASS_STYLES[SMALL_GLASS_STYLE];
const smallShape: GlassShape = buildSmallGlassShape(smallSpec);
const smallLiquid: THREE.Vector2[] = buildLiquidProfile(smallShape, LIQUID_FILL);

// interactive:true ＝ ドラッグでぐりぐり視点回転できる（OrbitControls＋描画ループ）。
//   負荷管理：設定タブが見えている間だけ start()、離れたら stop() する（下の showTab）。
const view1 = new GlassView({
  canvas: canvas1,
  shape: smallShape,
  liquidProfile: smallLiquid,
  rich: SMALL_GLASS_RICH,
  interactive: true,
});
const view2 = new GlassView({
  canvas: canvas2,
  shape: smallShape,
  liquidProfile: smallLiquid,
  rich: SMALL_GLASS_RICH,
  interactive: true,
});

// 液体ブロックを開いた瞬間に、表示された canvas の実寸でリサイズ＆再描画する。
//   （初期は閉じている＝canvas が 0px のままなので、開いた時に正しい縦横比へ直す）。
onLiquidBlockOpen = (idx: 1 | 2): void => {
  const v = idx === 1 ? view1 : view2;
  v.resize();
  v.renderOnce();
};

// ----------------------------------------------------------------------------
// 結果ビュー：1液プログラムと「全く同じ」3D。共有モジュールで構築する。
//   操作(OrbitControls)・描画ループはここ(mixer)が担う（main.ts と同じ役割分担）。
//   #result-canvas は CSS でサイズを決めるので、buildCocktailScene が付けた
//   インライン style を消し、resize は updateStyle=false で呼ぶ。
// ----------------------------------------------------------------------------
const resultSc = buildCocktailScene(resultCanvas);
resultCanvas.style.width = '';
resultCanvas.style.height = '';

const resultControls = new OrbitControls(resultSc.camera, resultSc.renderer.domElement);
resultControls.enableDamping = true;
resultControls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);

let resultRAF = 0; // 描画ループの requestAnimationFrame ハンドル（0=停止中）
function resultStart(): void {
  if (resultRAF) return; // 二重起動防止
  const loop = () => {
    resultRAF = requestAnimationFrame(loop);
    resultControls.update();
    resultSc.composer.render();
  };
  resultRAF = requestAnimationFrame(loop);
}
function resultStop(): void {
  if (!resultRAF) return;
  cancelAnimationFrame(resultRAF);
  resultRAF = 0;
}
function resultResize(): void {
  resultSc.resize(resultCanvas.clientWidth, resultCanvas.clientHeight, false);
}

// ----------------------------------------------------------------------------
// ★ 結果ビューで「混合結果」パネルを開いたときのカメラ調整 ★（1液 main.ts と同じ）
//   スマホでパネルを開くと右側がパネルで隠れるので、開いている間だけカメラを動かし・
//   ズーム・描画を左へ寄せて、グラス全体を左の空きスペースに収める。PCでは何もしない。
//   ※座標・ズーム・寄せ量は1液プログラム(main.ts)と同一値（同じマティーニシーンのため）。
// ----------------------------------------------------------------------------
const IS_MOBILE = window.innerWidth <= 768;
const PANEL_CAM_POS = new THREE.Vector3(0, 5.5, 7.0); // 開いた時のカメラ座標
const PANEL_VIEW_ZOOM = 0.9; // ズーム率（1=標準）
const PANEL_VIEW_SHIFT = 0.26; // 左へずらす割合（画面幅比）

let isResultPanelOpen = false; // 混合結果パネルが今開いているか（リサイズ時の再適用に使う）
// 「開く直前」のカメラ座標とズームを覚えておき、閉じたら元に戻す入れ物。
const savedResultCam = {
  pos: resultSc.camera.position.clone(),
  zoom: resultSc.camera.zoom,
};

function applyResultPanelView(open: boolean): void {
  isResultPanelOpen = open;
  if (!IS_MOBILE) return; // スマホのときだけ効かせる
  const cam = resultSc.camera;
  const w = resultCanvas.clientWidth;
  const h = resultCanvas.clientHeight;
  const alreadyShifted = cam.view !== null && cam.view.enabled;
  if (open) {
    if (w === 0 || h === 0) return; // 結果タブ非表示中（サイズ未確定）は何もしない
    if (!alreadyShifted) {
      savedResultCam.pos.copy(cam.position);
      savedResultCam.zoom = cam.zoom;
    }
    cam.position.copy(PANEL_CAM_POS);
    cam.zoom = PANEL_VIEW_ZOOM;
    // 描画を左へ寄せる（fullW/fullH はこの結果canvasの実寸を使う）。
    cam.setViewOffset(w, h, w * PANEL_VIEW_SHIFT, 0, w, h);
  } else {
    cam.clearViewOffset();
    cam.position.copy(savedResultCam.pos);
    cam.zoom = savedResultCam.zoom;
    cam.updateProjectionMatrix();
  }
}

// 結果の数値表示パネル＝1液プログラムと同じUI（readonly＝混合結果で固定表示）。
//   resultPanel に載せるので、結果タブが非表示のときは一緒に隠れる。
//   操作は受け付けず、値は onChange から setValues で流し込む。
const resultUI: LiquidUIHandle = createLiquidUI({
  initialRGB: hsvToRgb(liquid1.hue, liquid1.sat, liquid1.val), // 仮の初期値（直後の onChange で上書き）
  initialDensity: liquid1.density,
  initialTurbidity: liquid1.turbidity,
  onChange: () => {}, // readonly なので呼ばれない
  title: '混合結果',
  mount: resultPanel,
  readonly: true,
  // 上部のタブバー（sticky・高さ約47px）に重ならないよう、パネルを下げる。
  fixedTop: '64px',
  // パネル開閉でグラスをずらす（スマホ時のみ。1液 main.ts と同じ挙動）。
  onToggle: (open) => applyResultPanelView(open),
});

// ----------------------------------------------------------------------------
// 液体1/2の色設定パネル＝1液プログラムと同じ操作UI（埋め込み・見出しなし）。
//   設定ブロックの右カラム(uiMount)に組み込む。操作すると state(HSV+濃さ+濁り)を
//   書き換えて onChange() を呼び、小グラスと混合結果に反映する。
//   ※onChange は view/resultSc/resultUI を参照するので、それらの生成後に作る。
// ----------------------------------------------------------------------------
function makeLiquidUI(state: LiquidParams, mount: HTMLElement): void {
  createLiquidUI({
    initialRGB: hsvToRgb(state.hue, state.sat, state.val),
    initialDensity: state.density,
    initialTurbidity: state.turbidity,
    embedded: true, // 浮かせず右カラムに収める
    showHeader: false, // 見出しは外側の「液体1/2」ブロックが持つ
    onChange: (_rgb, density, turbidity, hsv) => {
      state.hue = hsv.h;
      state.sat = hsv.s;
      state.val = hsv.v;
      state.density = density;
      state.turbidity = turbidity;
      onChange();
    },
    mount,
  });
}
makeLiquidUI(liquid1, uiMount1);
makeLiquidUI(liquid2, uiMount2);

// ----------------------------------------------------------------------------
// 値が変わったときの再計算＆反映
// ----------------------------------------------------------------------------
function onChange(): void {
  // 小グラス：各液体の素の色をそのまま反映（混合前）。
  view1.setAppearance(
    hsvToRgb(liquid1.hue, liquid1.sat, liquid1.val),
    liquid1.density,
    liquid1.turbidity,
  );
  view2.setAppearance(
    hsvToRgb(liquid2.hue, liquid2.sat, liquid2.val),
    liquid2.density,
    liquid2.turbidity,
  );
  // 設定タブが見えているときだけ小グラスを描き直す（静止グラスは手動描画）。
  if (settingsPanel.classList.contains('active')) {
    view1.renderOnce();
    view2.renderOnce();
  }

  // 結果：簡略色エンジンで2液を混ぜ、マティーニに反映（1液プログラムと同じ反映関数）。
  const mixed = mixTwoLiquids(liquid1, liquid2, ratio, dilution);
  const rgb = hsvToRgb(mixed.hue, mixed.sat, mixed.val);
  resultSc.setLiquidAppearance(rgb, mixed.density, mixed.turbidity);
  // 数値表示も同じパネルに反映（固定表示なので setValues で値だけ流す）。
  resultUI.setValues(rgb, mixed.density, mixed.turbidity);
}

// ----------------------------------------------------------------------------
// タブ切替（負荷管理：見えているタブの3Dだけ動かす）
// ----------------------------------------------------------------------------
function showTab(tab: 'settings' | 'result'): void {
  const isSettings = tab === 'settings';
  settingsPanel.classList.toggle('active', isSettings);
  resultPanel.classList.toggle('active', !isSettings);
  btnSettings.classList.toggle('active', isSettings);
  btnResult.classList.toggle('active', !isSettings);

  if (isSettings) {
    // 結果の常時ループを止める。小グラスは表示後にサイズを合わせてループ開始
    //   （interactive＝ドラッグで回せるよう描画ループを回す）。
    resultStop();
    view1.resize();
    view2.resize();
    view1.start();
    view2.start();
  } else {
    // 設定タブを離れたら小グラスのループを止める（負荷管理）。
    view1.stop();
    view2.stop();
    // 結果タブ：canvas が見えてサイズが確定してからループ開始。
    resultResize();
    // パネルが開いた状態で結果タブに来たら、左寄せビューを（サイズ確定後に）再適用。
    if (IS_MOBILE && isResultPanelOpen) applyResultPanelView(true);
    resultStart();
  }
}

btnSettings.addEventListener('click', () => showTab('settings'));
btnResult.addEventListener('click', () => showTab('result'));

// ----------------------------------------------------------------------------
// リサイズ追従（表示中のビューだけ更新）
// ----------------------------------------------------------------------------
window.addEventListener('resize', () => {
  if (settingsPanel.classList.contains('active')) {
    view1.resize();
    view2.resize();
    view1.renderOnce();
    view2.renderOnce();
  } else {
    resultResize();
    // 開いている間の左寄せビューはピクセル基準なので、サイズ変更時に再計算。
    if (IS_MOBILE && isResultPanelOpen) applyResultPanelView(true);
  }
});

// ----------------------------------------------------------------------------
// 初期化：設定タブを表示し、初期値を反映して描画。
// ----------------------------------------------------------------------------
showTab('settings');
onChange();
