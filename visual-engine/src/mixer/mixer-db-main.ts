// ============================================================================
// mixer-db-main — DB材料選択式の2液混合ビューアー（新エントリ mixer-db.html から読む）
//   ----------------------------------------------------------------------------
//   ◆このエントリの役割（開発(2)）
//     「2つの液体を “材料DB” から選んで混合する」ビューアー。各液体の色は手動UI
//     （HSVピッカー）ではなく、材料マスタDBから材料を選んで決める＝純粋DB選択式。
//     既存の手動式2液 mixer（/ = index.html）は本質モデルとして別に温存している
//     （こちらは1文字も触らない）。
//
//   ◆画面（既存 mixer の2タブ構成を踏襲）
//     ・設定タブ：レシピ設定ボックス（作り方＋各材料の量）＋ 液体1/2ブロック
//                （左=小グラスプレビュー／右=カテゴリ＋材料のプルダウン2段）
//     ・結果タブ：マティーニグラス（リッチ表示）＋ 混合結果の数値パネル
//
//   ◆データの流れ（手動式の onChange の置き換え）
//     材料を選ぶ → fetchIngredientBySlug(slug) → rowToLiquidParams(row) で
//     LiquidParams(HSV)＋appearance(rgb系) を作り、スロット配列に格納
//     → recompute() が「小グラス＝素の色」「結果＝mixTwoLiquids の混合色」を再描画。
//
//   ◆無改変の原則
//     mix-color.ts / db-to-visual.ts / ingredients.ts / cocktail-scene.ts /
//     material-viewer / 既存 mixer は触らない。橋渡しは db-to-liquidparams.ts に隔離。
//
//   ◆(3) N液化への備え
//     スロットは配列（slots[]）で持ち、UI生成も map ベース。ただし今回は長さ2固定で、
//     混色は mixTwoLiquids(liquids[0], liquids[1], t, w) の2液のまま。
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
  type LiquidParams,
} from './mix-color';
// 結果ビューの3Dは「1液プログラムと完全に同じ」共有モジュールで構築する。
import { buildCocktailScene, CAMERA_TARGET } from '../scene/cocktail-scene';
// 結果の数値表示も1液プログラムと同じパネルを使う（readonly＝固定表示）。
import { createLiquidUI, type LiquidUIHandle } from '../liquid-ui';
// DB取得（無改変で流用）。
import {
  fetchIngredientBySlug,
  fetchIngredientSlugs,
  type IngredientOption,
} from '../db/ingredients';
// DBの材料 → mixer の混色入力(LiquidParams) への橋渡し（新エントリ専用ヘルパー）。
import { rowToLiquidParams, type RowLiquid } from './db-to-liquidparams';

// ----------------------------------------------------------------------------
// ★ 調整用の定数（ここだけ触れば挙動が変わる）★
// ----------------------------------------------------------------------------
// 小グラスの形状パターン。1=ショット / 2=タンブラー / 3=ロック。
const SMALL_GLASS_STYLE: 1 | 2 | 3 = 1;
// 小グラスをリッチ表示にするか。false=簡易（軽い）。
const SMALL_GLASS_RICH = false;
// グラスにどれだけ注ぐか（0〜1）。0.8＝8分目。
const LIQUID_FILL = 0.8;
// スロット数（液体の本数）。今回は2固定。(3) でここを増やす想定。
const SLOT_COUNT = 2;

// 加水率 w（mixTwoLiquids の希釈引数）。総量の60%加水を「水の占有割合」で換算：
//   水量 = total*0.60、全体 = total*1.60 → w = 0.60 / 1.60 = 0.375（MAX_DILUTION=0.8 以内）。
//   シェイク・ステアとも現状は同値（将来差をつける余地としてUIには両方出す）。
const WATER_RATIO = 0.375;

// 量プルダウンの選択肢（単位ごと）。1 tsp = 5 ml。
const ML_AMOUNTS = [0, 10, 20, 30, 40, 50, 60];
const TSP_AMOUNTS = [0, 1, 2, 3, 4, 5];

// 空グラス（液体なし）の見た目。density 0＝吸光ゼロ＝透明。
const EMPTY_RGB = { r: 255, g: 255, b: 255 };

// カテゴリの「すべて」を表す内部値（実カテゴリ名と衝突しない番兵）。
const CATEGORY_ALL = '__all__';

// mixTwoLiquids に渡すダミー（未選択スロット用）。寄与は比率0で消えるので色は無害。
const PLACEHOLDER_LIQUID: LiquidParams = {
  hue: 0,
  sat: 0,
  val: 1,
  density: 0,
  turbidity: 0,
};

// ----------------------------------------------------------------------------
// 状態：スロット（液体）配列＋作り方
// ----------------------------------------------------------------------------
interface SlotState {
  category: string; // 選択中カテゴリ（CATEGORY_ALL か実カテゴリ名）
  slug: string | null; // 選択中材料の slug（null=未選択）
  name: string; // 表示名
  unit: 'ml' | 'tsp'; // 量の単位
  amount: number; // 量の数値（unit 基準）
  liquid: LiquidParams | null; // 混色入力（HSV）。null=未選択
  appearance: RowLiquid['appearance'] | null; // 小グラス用の素の見た目。null=未選択
}

// 起動時に取得する全件リスト（slug/name_ja/category）。
let allItems: IngredientOption[] = [];
// 作り方（''=未選択 / 'shake' / 'stir'）。
let method: '' | 'shake' | 'stir' = '';

// ----------------------------------------------------------------------------
// 小さなDOMヘルパー
// ----------------------------------------------------------------------------
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

// プルダウンを作る。options=[{value,label}]。onChange(値) を値変更時に呼ぶ。
function makeSelect(
  options: { value: string; label: string }[],
  onChange: (value: string) => void,
  className = 'db-select',
): HTMLSelectElement {
  const sel = el('select', className);
  setSelectOptions(sel, options);
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

// プルダウンの選択肢を入れ替える（任意で選択値を指定）。
function setSelectOptions(
  sel: HTMLSelectElement,
  options: { value: string; label: string }[],
  selected?: string,
): void {
  sel.innerHTML = '';
  for (const o of options) {
    const opt = el('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  if (selected !== undefined) sel.value = selected;
}

// 折りたたみ可能なブロック（見出しクリックで開閉。初期は閉じる）。
function makeCollapsible(
  title: string,
  body: HTMLElement,
  onToggle?: (open: boolean) => void,
): HTMLElement {
  const block = el('div', 'block');
  const header = el('button', 'block-header');
  header.type = 'button';
  let open = false;
  body.style.display = 'none';
  header.textContent = '▶ ' + title;
  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? '' : 'none';
    header.textContent = (open ? '▼ ' : '▶ ') + title;
    onToggle?.(open);
  });
  block.append(header, body);
  return block;
}

// 全件リストから category を distinct する（最初に出た順を保つ）。
function distinctCategories(items: IngredientOption[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const it of items) {
    if (it.category && !seen.has(it.category)) {
      seen.add(it.category);
      result.push(it.category);
    }
  }
  return result;
}

// 指定カテゴリで材料を絞る（CATEGORY_ALL のときは全件）。
function itemsInCategory(category: string): IngredientOption[] {
  if (category === CATEGORY_ALL) return allItems;
  return allItems.filter((it) => it.category === category);
}

// ----------------------------------------------------------------------------
// スタイル（mixer-main の流儀を踏襲。タブバー＋折りたたみブロック＋プルダウン）
// ----------------------------------------------------------------------------
function injectStyle(): void {
  const style = el('style');
  style.textContent = `
    :root { color-scheme: dark; }
    /* 共有 style.css が html,body に height:100%/overflow:hidden を掛けているので、
       mixer 同様スクロールできるよう上書きする（この <style> が後勝ち）。 */
    html, body { height: auto; overflow: visible; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #0e0e12; color: #e7e7ee; }
    #tabbar { position: sticky; top: 0; z-index: 10; display: flex; background: #16161c; border-bottom: 1px solid #2a2a33; }
    #tabbar button { flex: 1; padding: 14px; background: transparent; border: none; color: #9a9aa8; font-size: 17px; cursor: pointer; }
    #tabbar button.active { color: #fff; border-bottom: 2px solid #6da8ff; background: #1d1d25; }
    .panel { display: none; }
    .panel.active { display: block; }
    #tab-settings { padding: 12px 12px 48px; max-width: 560px; margin: 0 auto; }
    .block { border: 1px solid #2a2a33; border-radius: 10px; margin-bottom: 14px; overflow: hidden; }
    .block-header { width: 100%; text-align: left; padding: 12px 14px; background: #1a1a21; border: none; color: #cfcfe0; font-size: 16px; cursor: pointer; }
    .block-body { padding: 12px 14px; }
    /* 液体ブロック本体＝左:グラスプレビュー / 右:材料プルダウン(2段) */
    .liquid-body { display: flex; gap: 14px; align-items: stretch; }
    .glass-col { flex: 1 1 0; min-width: 0; display: flex; }
    .small-glass { flex: 1; width: 100%; min-height: 240px; display: block; border-radius: 8px; background: #15151b; }
    .select-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; justify-content: center; }
    .select-col label { font-size: 13px; color: #b7b7c6; display: block; margin-bottom: 4px; }
    /* プルダウン共通（ダークテーマ・指で押しやすい高さ） */
    .db-select { width: 100%; padding: 9px 10px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.2); background: rgba(10,10,14,0.6);
      color: #e8e8ee; font-family: inherit; font-size: 15px; }
    /* レシピ設定の行 */
    .recipe-row { margin: 10px 0; }
    .recipe-row > label { font-size: 14px; color: #b7b7c6; display: block; margin-bottom: 6px; }
    .slot-recipe { border-top: 1px solid #2a2a33; margin-top: 12px; padding-top: 12px; }
    .slot-title { font-size: 15px; color: #cfcfe0; margin-bottom: 6px; }
    .slot-name { color: #fff; font-weight: 600; }
    .slot-name.empty { color: #7a7a88; font-weight: 400; }
    .amount-row { display: flex; gap: 8px; margin-top: 8px; }
    .amount-row .unit-sel { flex: 0 0 90px; }
    .amount-row .amount-sel { flex: 1 1 0; }
    .recipe-status { margin-top: 10px; font-size: 12px; color: #b9b9c6; min-height: 1em; }
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

// ============================================================================
// スロット（液体）一式を配列で保持する。DOM参照もここに束ねる。
// ============================================================================
interface Slot {
  state: SlotState;
  canvas: HTMLCanvasElement;
  view: GlassView;
  catSel: HTMLSelectElement; // カテゴリ（液体ブロック内）
  matSel: HTMLSelectElement; // 材料（液体ブロック内）
  nameSpan: HTMLElement; // 名前表示（レシピ設定内）
  unitSel: HTMLSelectElement; // 単位（レシピ設定内）
  amountSel: HTMLSelectElement; // 量（レシピ設定内）
  block: HTMLElement; // 液体ブロック（開閉時リサイズ用）
}

const slots: Slot[] = [];

// --- 小グラスの形状（全スロット共通）---
const smallSpec = SMALL_GLASS_STYLES[SMALL_GLASS_STYLE];
const smallShape: GlassShape = buildSmallGlassShape(smallSpec);
const smallLiquid: THREE.Vector2[] = buildLiquidProfile(smallShape, LIQUID_FILL);

// --- レシピ設定ボックス（最上段）---
const recipeBody = el('div', 'block-body');

// (1) 作り方プルダウン。
const methodRow = el('div', 'recipe-row');
const methodLabel = el('label');
methodLabel.textContent = '作り方';
const methodSel = makeSelect(
  [
    { value: '', label: '選択してください' },
    { value: 'shake', label: 'シェイク' },
    { value: 'stir', label: 'ステア' },
  ],
  (v) => {
    method = v as '' | 'shake' | 'stir';
    recompute();
  },
);
methodRow.append(methodLabel, methodSel);
recipeBody.append(methodRow);

// レシピ設定内の状態表示（読み込み中・エラー用）。
const recipeStatus = el('div', 'recipe-status');

// ============================================================================
// スロットを SLOT_COUNT 本ぶん生成（配列・map ベース）。
//   各スロット＝「液体ブロック（小グラス＋カテゴリ/材料プルダウン）」＋
//              「レシピ設定内の材料行（名前＋量2段）」。
// ============================================================================
function buildSlot(index: number): Slot {
  // --- 小グラス canvas ＋ GlassView（interactive：ドラッグで回せる）---
  const canvas = el('canvas', 'small-glass');
  const view = new GlassView({
    canvas,
    shape: smallShape,
    liquidProfile: smallLiquid,
    rich: SMALL_GLASS_RICH,
    interactive: true,
  });

  // --- 液体ブロック右カラム：カテゴリ＋材料プルダウン ---
  const selectCol = el('div', 'select-col');
  const catWrap = el('div');
  const catLabel = el('label');
  catLabel.textContent = 'カテゴリ';
  const catSel = makeSelect([{ value: CATEGORY_ALL, label: 'すべて' }], (v) => {
    slot.state.category = v;
    rebuildMaterialSelect(slot);
  });
  catWrap.append(catLabel, catSel);

  const matWrap = el('div');
  const matLabel = el('label');
  matLabel.textContent = '材料';
  const matSel = makeSelect([{ value: '', label: '（材料を選択）' }], (v) => {
    void pickMaterial(slot, v);
  });
  matWrap.append(matLabel, matSel);
  selectCol.append(catWrap, matWrap);

  // --- 液体ブロック本体（左:小グラス / 右:プルダウン）---
  const body = el('div', 'block-body liquid-body');
  const glassCol = el('div', 'glass-col');
  glassCol.append(canvas);
  body.append(glassCol, selectCol);

  const block = makeCollapsible(`液体${index + 1}`, body, (open) => {
    if (open) {
      view.resize();
      view.renderOnce();
    }
  });

  // --- レシピ設定内の材料行（名前＋量2段）---
  const slotRecipe = el('div', 'recipe-row slot-recipe');
  const slotTitle = el('div', 'slot-title');
  slotTitle.textContent = `材料${index + 1}`;
  const nameSpan = el('span', 'slot-name empty');
  nameSpan.textContent = '選択されていません';
  slotTitle.append(' ', nameSpan);

  const amountRow = el('div', 'amount-row');
  const unitSel = makeSelect(
    [
      { value: 'ml', label: 'ml' },
      { value: 'tsp', label: 'tsp' },
    ],
    (v) => {
      slot.state.unit = v as 'ml' | 'tsp';
      rebuildAmountSelect(slot);
      recompute();
    },
    'db-select unit-sel',
  );
  const amountSel = makeSelect(
    ML_AMOUNTS.map((n) => ({ value: String(n), label: String(n) })),
    (v) => {
      slot.state.amount = Number(v);
      recompute();
    },
    'db-select amount-sel',
  );
  amountRow.append(unitSel, amountSel);
  slotRecipe.append(slotTitle, amountRow);
  recipeBody.append(slotRecipe);

  const slot: Slot = {
    state: {
      category: CATEGORY_ALL,
      slug: null,
      name: '選択されていません',
      unit: 'ml',
      amount: 0,
      liquid: null,
      appearance: null,
    },
    canvas,
    view,
    catSel,
    matSel,
    nameSpan,
    unitSel,
    amountSel,
    block,
  };
  return slot;
}

for (let i = 0; i < SLOT_COUNT; i++) {
  slots.push(buildSlot(i));
}

// レシピ設定の最後にステータスを置く。
recipeBody.append(recipeStatus);
const recipePanel = makeCollapsible('レシピ設定', recipeBody);

// 並び順：レシピ設定 → 液体1 → 液体2。
settingsPanel.append(recipePanel, ...slots.map((s) => s.block));

// --- 結果パネル -------------------------------------------------------------
const resultPanel = el('div', 'panel');
resultPanel.id = 'tab-result';
const resultCanvas = el('canvas');
resultCanvas.id = 'result-canvas';
resultPanel.append(resultCanvas);

document.body.append(tabbar, settingsPanel, resultPanel);

// ----------------------------------------------------------------------------
// 結果ビュー：1液プログラムと「全く同じ」3D。共有モジュールで構築する。
// ----------------------------------------------------------------------------
const resultSc = buildCocktailScene(resultCanvas);
resultCanvas.style.width = '';
resultCanvas.style.height = '';

const resultControls = new OrbitControls(
  resultSc.camera,
  resultSc.renderer.domElement,
);
resultControls.enableDamping = true;
resultControls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);

let resultRAF = 0;
function resultStart(): void {
  if (resultRAF) return;
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
// 結果ビューで「混合結果」パネルを開いたときのカメラ調整（mixer-main と同一）。
// ----------------------------------------------------------------------------
const IS_MOBILE = window.innerWidth <= 768;
const PANEL_CAM_POS = new THREE.Vector3(0, 5.5, 7.0);
const PANEL_VIEW_ZOOM = 0.9;
const PANEL_VIEW_SHIFT = 0.26;

let isResultPanelOpen = false;
const savedResultCam = {
  pos: resultSc.camera.position.clone(),
  zoom: resultSc.camera.zoom,
};

function applyResultPanelView(open: boolean): void {
  isResultPanelOpen = open;
  if (!IS_MOBILE) return;
  const cam = resultSc.camera;
  const w = resultCanvas.clientWidth;
  const h = resultCanvas.clientHeight;
  const alreadyShifted = cam.view !== null && cam.view.enabled;
  if (open) {
    if (w === 0 || h === 0) return;
    if (!alreadyShifted) {
      savedResultCam.pos.copy(cam.position);
      savedResultCam.zoom = cam.zoom;
    }
    cam.position.copy(PANEL_CAM_POS);
    cam.zoom = PANEL_VIEW_ZOOM;
    cam.setViewOffset(w, h, w * PANEL_VIEW_SHIFT, 0, w, h);
  } else {
    cam.clearViewOffset();
    cam.position.copy(savedResultCam.pos);
    cam.zoom = savedResultCam.zoom;
    cam.updateProjectionMatrix();
  }
}

// 結果の数値表示パネル＝1液プログラムと同じUI（readonly＝混合結果で固定表示）。
const resultUI: LiquidUIHandle = createLiquidUI({
  initialRGB: { ...EMPTY_RGB },
  initialDensity: 0,
  initialTurbidity: 0,
  onChange: () => {},
  title: '混合結果',
  mount: resultPanel,
  readonly: true,
  fixedTop: '64px',
  onToggle: (open) => applyResultPanelView(open),
});

// ----------------------------------------------------------------------------
// 量（ml/tsp）→ ml 換算。未選択スロットや量0は 0ml（寄与なし）。
// ----------------------------------------------------------------------------
function volumeMl(slot: Slot): number {
  if (!slot.state.slug) return 0; // 材料未選択＝寄与なし
  const n = slot.state.amount;
  return slot.state.unit === 'tsp' ? n * 5 : n;
}

// ----------------------------------------------------------------------------
// 値が変わったときの再計算＆反映（手動式 onChange の置き換え）。
// ----------------------------------------------------------------------------
function recompute(): void {
  // --- 小グラス：各スロットの「素の色」をそのまま反映（未選択は空グラス）---
  for (const slot of slots) {
    if (slot.state.appearance) {
      const a = slot.state.appearance;
      slot.view.setAppearance(a.rgb, a.density, a.turbidity);
    } else {
      slot.view.setAppearance({ ...EMPTY_RGB }, 0, 0); // 空グラス
    }
  }
  if (settingsPanel.classList.contains('active')) {
    for (const slot of slots) slot.view.renderOnce();
  }

  // --- 結果：反映トリガーが揃っているか判定 ---
  //   ・材料が1つでも選ばれている、かつ
  //   ・総量 > 0（量0は寄与なし。total=0 の間は空グラス維持）、かつ
  //   ・作り方が選ばれている
  const vols = slots.map(volumeMl);
  const total = vols.reduce((s, v) => s + v, 0);
  const anySelected = slots.some((s) => s.state.slug !== null);
  const ready = anySelected && total > 0 && method !== '';

  if (!ready) {
    // 空グラスを維持（液体なし）。
    resultSc.setLiquidAppearance({ ...EMPTY_RGB }, 0, 0);
    resultUI.setValues({ ...EMPTY_RGB }, 0, 0);
    return;
  }

  // --- 混合（2液固定。未選択スロットはダミー＝比率0で寄与しない）---
  const t = total > 0 ? vols[1] / total : 0.5;
  const l0 = slots[0].state.liquid ?? PLACEHOLDER_LIQUID;
  const l1 = slots[1].state.liquid ?? PLACEHOLDER_LIQUID;
  const mixed = mixTwoLiquids(l0, l1, t, WATER_RATIO);
  const rgb = hsvToRgb(mixed.hue, mixed.sat, mixed.val);
  resultSc.setLiquidAppearance(rgb, mixed.density, mixed.turbidity);
  resultUI.setValues(rgb, mixed.density, mixed.turbidity);
}

// ----------------------------------------------------------------------------
// 材料プルダウン（液体ブロック内）を、今のカテゴリに合わせて作り直す。
//   先頭に「（材料を選択）＝未選択」を置く。カテゴリ変更時は選択をクリアする
//   （初期はデフォルト材料なし＝空グラスの方針に合わせる）。
// ----------------------------------------------------------------------------
function rebuildMaterialSelect(slot: Slot): void {
  const list = itemsInCategory(slot.state.category);
  const opts = [
    { value: '', label: '（材料を選択）' },
    ...list.map((it) => ({ value: it.slug, label: it.name_ja })),
  ];
  setSelectOptions(slot.matSel, opts, '');
  // カテゴリを切り替えたら材料は未選択に戻す（クリア）。
  void pickMaterial(slot, '');
}

// ----------------------------------------------------------------------------
// 量プルダウン（レシピ設定内）を単位に合わせて作り直す。先頭(0)を選択。
// ----------------------------------------------------------------------------
function rebuildAmountSelect(slot: Slot): void {
  const arr = slot.state.unit === 'tsp' ? TSP_AMOUNTS : ML_AMOUNTS;
  setSelectOptions(
    slot.amountSel,
    arr.map((n) => ({ value: String(n), label: String(n) })),
    '0',
  );
  slot.state.amount = 0;
}

// ----------------------------------------------------------------------------
// 材料を1つ選んだ（または未選択にした）ときの反映。
//   slug='' → スロットをクリア（空グラス）。それ以外 → DB取得 → 橋渡し → 格納 → 再描画。
// ----------------------------------------------------------------------------
async function pickMaterial(slot: Slot, slug: string): Promise<void> {
  if (!slug) {
    // クリア（未選択）。
    slot.state.slug = null;
    slot.state.name = '選択されていません';
    slot.state.liquid = null;
    slot.state.appearance = null;
    slot.nameSpan.textContent = '選択されていません';
    slot.nameSpan.classList.add('empty');
    recompute();
    return;
  }

  recipeStatus.textContent = '読み込み中…';
  const row = await fetchIngredientBySlug(slug);
  if (!row) {
    recipeStatus.textContent = `取得できませんでした: ${slug}`;
    return;
  }

  // 橋渡し：row → { liquid(HSV), appearance(rgb系) }。
  const { liquid, appearance } = rowToLiquidParams(row);
  slot.state.slug = slug;
  slot.state.name = row.name_ja;
  slot.state.liquid = liquid;
  slot.state.appearance = appearance;
  slot.nameSpan.textContent = row.name_ja;
  slot.nameSpan.classList.remove('empty');

  recipeStatus.textContent = '';
  recompute();
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
    resultStop();
    for (const slot of slots) {
      slot.view.resize();
      slot.view.start();
    }
  } else {
    for (const slot of slots) slot.view.stop();
    resultResize();
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
    for (const slot of slots) {
      slot.view.resize();
      slot.view.renderOnce();
    }
  } else {
    resultResize();
    if (IS_MOBILE && isResultPanelOpen) applyResultPanelView(true);
  }
});

// ----------------------------------------------------------------------------
// 起動：全件リストを取得 → カテゴリ/材料プルダウンを構築 → 初期描画（空グラス）。
// ----------------------------------------------------------------------------
async function init(): Promise<void> {
  recipeStatus.textContent = '材料一覧を読み込み中…';
  allItems = await fetchIngredientSlugs();

  if (allItems.length === 0) {
    recipeStatus.textContent =
      '材料一覧が取得できませんでした（.env.local のキー設定とネットワークを確認）。';
    return;
  }

  // 各スロットのカテゴリ／材料プルダウンを実データで構築（先頭=すべて / 未選択）。
  const cats = distinctCategories(allItems);
  const catOpts = [
    { value: CATEGORY_ALL, label: 'すべて' },
    ...cats.map((c) => ({ value: c, label: c })),
  ];
  for (const slot of slots) {
    setSelectOptions(slot.catSel, catOpts, CATEGORY_ALL);
    rebuildMaterialSelect(slot); // 「すべて」の材料一覧＋先頭=未選択
  }

  recipeStatus.textContent = '';
  recompute(); // 初期は空グラス（材料・量・作り方とも未選択）
}

// 初期表示：設定タブ。失敗してもアプリは動き続ける（空グラスのまま）。
showTab('settings');
recompute();
void init();
