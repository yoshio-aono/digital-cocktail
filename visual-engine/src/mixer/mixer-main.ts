// ============================================================================
// mixer-main — 2液混合ビューアーのエントリ（mixer.html から読み込まれる）
//   画面は2タブ：
//     ・設定タブ … 液体1/2の小グラス(静止)＋3軸スライダー、混合比率A、希釈B
//     ・結果タブ … マティーニグラス(操作可・リッチ)＋混合結果の色情報
//
//   ◆負荷管理（指示書 2-2）：
//     ・アクティブなタブの3Dだけ描く。結果タブから離れたら描画ループを止める。
//     ・小グラスは常時ループせず、値が変わったときに1フレームだけ描く。
//
//   ◆既存 visual-engine 本体(main.ts)は無改変。3Dは GlassView に複製済み。
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
  hueToRgb,
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
const SMALL_GLASS_STYLE: 1 | 2 | 3 = 2;
// 小グラスをリッチ表示にするか。false=簡易（軽い）。指示どおり既定は簡易。
const SMALL_GLASS_RICH = false;
// グラスにどれだけ注ぐか（0〜1）。0.8＝8分目。
const LIQUID_FILL = 0.8;

// ----------------------------------------------------------------------------
// 状態（2液のパラメータ＋混合比率＋希釈）。スライダーがこの値を書き換える。
// ----------------------------------------------------------------------------
const liquid1: LiquidParams = { hue: 210, density: 0.7, turbidity: 0.1 }; // 青系
const liquid2: LiquidParams = { hue: 40, density: 0.6, turbidity: 0.1 }; // 黄橙系
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
function makeCollapsible(
  title: string,
  body: HTMLElement,
): HTMLElement {
  const block = el('div', 'block');
  const header = el('button', 'block-header');
  header.type = 'button';
  header.textContent = '▼ ' + title;
  let open = true;
  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? '' : 'none';
    header.textContent = (open ? '▼ ' : '▶ ') + title;
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
    body { margin: 0; font-family: system-ui, sans-serif; background: #0e0e12; color: #e7e7ee; }
    #tabbar { position: sticky; top: 0; z-index: 10; display: flex; background: #16161c; border-bottom: 1px solid #2a2a33; }
    #tabbar button { flex: 1; padding: 14px; background: transparent; border: none; color: #9a9aa8; font-size: 15px; cursor: pointer; }
    #tabbar button.active { color: #fff; border-bottom: 2px solid #6da8ff; background: #1d1d25; }
    .panel { display: none; }
    .panel.active { display: block; }
    #tab-settings { padding: 12px; max-width: 520px; margin: 0 auto; }
    .block { border: 1px solid #2a2a33; border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
    .block-header { width: 100%; text-align: left; padding: 12px 14px; background: #1a1a21; border: none; color: #cfcfe0; font-size: 14px; cursor: pointer; }
    .block-body { padding: 12px 14px; }
    .small-glass { width: 100%; height: 170px; display: block; border-radius: 8px; background: #15151b; margin-bottom: 10px; }
    .slider-row { margin: 12px 0; }
    .slider-head { display: flex; justify-content: space-between; font-size: 13px; color: #b7b7c6; margin-bottom: 4px; }
    .slider-val { color: #fff; font-variant-numeric: tabular-nums; }
    input[type=range] { width: 100%; }
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

// 液体ブロックの本体（小グラス＋3スライダー）を組む共通関数。
function makeLiquidBody(
  canvas: HTMLCanvasElement,
  state: LiquidParams,
  onAnyChange: () => void,
): HTMLElement {
  const body = el('div', 'block-body');
  body.append(canvas);
  body.append(
    makeSlider('色相 (hue)', 0, 360, 1, state.hue, (v) => `${Math.round(v)}°`, (v) => {
      state.hue = v;
      onAnyChange();
    }),
  );
  body.append(
    makeSlider('濃さ (density)', 0, 1, 0.01, state.density, (v) => v.toFixed(2), (v) => {
      state.density = v;
      onAnyChange();
    }),
  );
  body.append(
    makeSlider('濁り (turbidity)', 0, 1, 0.01, state.turbidity, (v) => v.toFixed(2), (v) => {
      state.turbidity = v;
      onAnyChange();
    }),
  );
  return body;
}

const block1 = makeCollapsible('液体1', makeLiquidBody(canvas1, liquid1, () => onChange()));
const block2 = makeCollapsible('液体2', makeLiquidBody(canvas2, liquid2, () => onChange()));

// 混合比率A・希釈B（折りたたみ不要の素のスライダー）。
const mixBody = el('div', 'loose');
mixBody.append(
  makeSlider('混合比率 (液体1 ⇔ 液体2)', 0, 1, 0.01, ratio, (v) => v.toFixed(2), (v) => {
    ratio = v;
    onChange();
  }),
);
mixBody.append(
  makeSlider('希釈（水）', 0, MAX_DILUTION, 0.01, dilution, (v) => v.toFixed(2), (v) => {
    dilution = v;
    onChange();
  }),
);

settingsPanel.append(block1, block2, mixBody);

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

const view1 = new GlassView({
  canvas: canvas1,
  shape: smallShape,
  liquidProfile: smallLiquid,
  rich: SMALL_GLASS_RICH,
  interactive: false,
});
const view2 = new GlassView({
  canvas: canvas2,
  shape: smallShape,
  liquidProfile: smallLiquid,
  rich: SMALL_GLASS_RICH,
  interactive: false,
});

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

// 結果の数値表示パネル＝1液プログラムと同じUI（readonly＝混合結果で固定表示）。
//   resultPanel に載せるので、結果タブが非表示のときは一緒に隠れる。
//   操作は受け付けず、値は onChange から setValues で流し込む。
const resultUI: LiquidUIHandle = createLiquidUI({
  initialRGB: hueToRgb(liquid1.hue), // 仮の初期値（直後の onChange で上書き）
  initialDensity: liquid1.density,
  initialTurbidity: liquid1.turbidity,
  onChange: () => {}, // readonly なので呼ばれない
  title: '混合結果',
  mount: resultPanel,
  readonly: true,
});

// ----------------------------------------------------------------------------
// 値が変わったときの再計算＆反映
// ----------------------------------------------------------------------------
function onChange(): void {
  // 小グラス：各液体の素の色をそのまま反映（混合前）。
  view1.setAppearance(hueToRgb(liquid1.hue), liquid1.density, liquid1.turbidity);
  view2.setAppearance(hueToRgb(liquid2.hue), liquid2.density, liquid2.turbidity);
  // 設定タブが見えているときだけ小グラスを描き直す（静止グラスは手動描画）。
  if (settingsPanel.classList.contains('active')) {
    view1.renderOnce();
    view2.renderOnce();
  }

  // 結果：簡略色エンジンで2液を混ぜ、マティーニに反映（1液プログラムと同じ反映関数）。
  const mixed = mixTwoLiquids(liquid1, liquid2, ratio, dilution);
  const rgb = hueToRgb(mixed.hue);
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
    // 結果の常時ループを止める。小グラスは表示後にサイズを合わせて1回描く。
    resultStop();
    view1.resize();
    view2.resize();
    view1.renderOnce();
    view2.renderOnce();
  } else {
    // 結果タブ：canvas が見えてサイズが確定してからループ開始。
    resultResize();
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
  }
});

// ----------------------------------------------------------------------------
// 初期化：設定タブを表示し、初期値を反映して描画。
// ----------------------------------------------------------------------------
showTab('settings');
onChange();
