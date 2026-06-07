// ============================================================================
// mixer-db-main — DB材料選択式の N液混合ビューアー（新エントリ mixer-db.html から読む）
//   ----------------------------------------------------------------------------
//   ◆このエントリの役割（開発(2)→(3)）
//     「材料DBから材料を選んで混合する」ビューアー。各液体の色は手動UIではなく
//     材料マスタDBから材料を選んで決める＝純粋DB選択式。
//     開発(3) で 2液固定から「2〜5液の可変（N液）」に拡張した：
//       ・スロットを「材料を追加する」で1本ずつ増やせる（最大5・最小2）。
//       ・N本を一括加重平均（順序非依存）で混色する mixLiquids を使う。
//       ・小グラス3Dは表示中スロットぶんだけ動的に生成し、不要時は dispose する。
//     既存の手動式2液 mixer（/ = index.html）は本質モデルとして別に温存（無改変）。
//
//   ◆画面（既存 mixer の2タブ構成を踏襲）
//     ・設定タブ：レシピ設定ボックス（作り方＋各材料の量＋増減）＋ 液体ブロック群
//                （左=小グラスプレビュー／右=カテゴリ＋材料のプルダウン2段）
//     ・結果タブ：マティーニグラス（リッチ表示）＋ 混合結果の数値パネル
//
//   ◆無改変の原則
//     mix-color.ts の既存 mixTwoLiquids / db-to-visual.ts / ingredients.ts /
//     cocktail-scene.ts / material-viewer / 既存 mixer は触らない。N液混色は
//     mix-color.ts に新設した mixLiquids、橋渡しは db-to-liquidparams.ts に隔離。
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
  mixLiquids,
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

// スロット数（液体の本数）の範囲。初期=2、最小=2、最大=5。
const INITIAL_SLOTS = 2;
const MIN_SLOTS = 2;
const MAX_SLOTS = 5;

// 加水率 w（mixLiquids の希釈引数）。総量の60%加水を「水の占有割合」で換算：
//   水量 = total*0.60、全体 = total*1.60 → w = 0.60 / 1.60 = 0.375（本数非依存・MAX_DILUTION以内）。
//   シェイク・ステアとも現状は同値（将来差をつける余地としてUIには両方出す）。
const WATER_RATIO = 0.375;

// 量プルダウンの選択肢（単位ごと）。1 tsp = 5 ml。
const ML_AMOUNTS = [0, 10, 20, 30, 40, 50, 60];
const TSP_AMOUNTS = [0, 1, 2, 3, 4, 5];

// 空グラス（液体なし）の見た目。density 0＝吸光ゼロ＝透明。
const EMPTY_RGB = { r: 255, g: 255, b: 255 };

// カテゴリの「すべて」を表す内部値（実カテゴリ名と衝突しない番兵）。
const CATEGORY_ALL = '__all__';

// mixLiquids に渡すダミー（未選択スロット用）。重み0なので色は寄与しない。
const PLACEHOLDER_LIQUID: LiquidParams = {
  hue: 0,
  sat: 0,
  val: 1,
  density: 0,
  turbidity: 0,
};

// ----------------------------------------------------------------------------
// 状態
// ----------------------------------------------------------------------------
// スロット1本ぶんの論理状態（タブ切替で3Dを破棄しても保持する）。
interface SlotState {
  category: string; // 選択中カテゴリ（CATEGORY_ALL か実カテゴリ名）
  slug: string | null; // 選択中材料の slug（null=未選択）
  name: string; // 表示名
  unit: 'ml' | 'tsp'; // 量の単位
  amount: number; // 量の数値（unit 基準）
  liquid: LiquidParams | null; // 混色入力（HSV）。null=未選択
  appearance: RowLiquid['appearance'] | null; // 小グラス用の素の見た目。null=未選択
}

// スロット（論理状態＋DOM参照＋3Dビュー）。3Dビュー(view/canvas)はタブ表示中のみ存在。
interface Slot {
  state: SlotState;
  // --- DOM（常設。タブ切替でも残す）---
  block: HTMLElement; // 液体ブロック（折りたたみ）
  setBlockTitle: (t: string) => void; // 液体N の番号更新用
  canvasHolder: HTMLElement; // 小グラス canvas の置き場（中身は動的生成）
  catSel: HTMLSelectElement; // カテゴリ
  matSel: HTMLSelectElement; // 材料
  recipeRow: HTMLElement; // レシピ設定内の材料行
  rtitle: HTMLElement; // 「材料N」見出し（番号更新用）
  nameSpan: HTMLElement; // 名前表示
  unitSel: HTMLSelectElement; // 単位
  amountSel: HTMLSelectElement; // 量
  delBtn: HTMLButtonElement; // 削除ボタン
  // --- 3D（タブ表示中だけ生成。非表示や削除で dispose）---
  view: GlassView | null;
  canvas: HTMLCanvasElement | null;
  blockOpen: boolean; // ブロックが開いているか（開いた瞬間にリサイズするため）
}

// 起動時に取得する全件リスト（slug/name_ja/category）。
let allItems: IngredientOption[] = [];
// 作り方（''=未選択 / 'shake' / 'stir'）。
let method: '' | 'shake' | 'stir' = '';
// スロット配列（可変長 2〜5）。
const slots: Slot[] = [];

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

// 折りたたみブロック（見出しクリックで開閉。初期は閉じる）。
//   番号付け替えのため setTitle を返す（液体1→液体2 などの再ラベル用）。
function makeBlock(
  title: string,
  body: HTMLElement,
  onToggle?: (open: boolean) => void,
): { block: HTMLElement; setTitle: (t: string) => void } {
  const block = el('div', 'block');
  const header = el('button', 'block-header');
  header.type = 'button';
  let open = false;
  let label = title;
  body.style.display = 'none';
  const render = () => {
    header.textContent = (open ? '▼ ' : '▶ ') + label;
  };
  render();
  header.addEventListener('click', () => {
    open = !open;
    body.style.display = open ? '' : 'none';
    render();
    onToggle?.(open);
  });
  block.append(header, body);
  return {
    block,
    setTitle: (t: string) => {
      label = t;
      render();
    },
  };
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
// スタイル
// ----------------------------------------------------------------------------
function injectStyle(): void {
  const style = el('style');
  style.textContent = `
    :root { color-scheme: dark; }
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
    .liquid-body { display: flex; gap: 14px; align-items: stretch; }
    .glass-col { flex: 1 1 0; min-width: 0; display: flex; }
    .small-glass { flex: 1; width: 100%; min-height: 240px; display: block; border-radius: 8px; background: #15151b; }
    .select-col { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; justify-content: center; }
    .select-col label { font-size: 13px; color: #b7b7c6; display: block; margin-bottom: 4px; }
    .db-select { width: 100%; padding: 9px 10px; border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.2); background: rgba(10,10,14,0.6);
      color: #e8e8ee; font-family: inherit; font-size: 15px; }
    .recipe-row { margin: 10px 0; }
    .recipe-row > label { font-size: 14px; color: #b7b7c6; display: block; margin-bottom: 6px; }
    .slot-recipe { border-top: 1px solid #2a2a33; margin-top: 12px; padding-top: 12px; }
    .slot-title { display: flex; align-items: center; gap: 8px; font-size: 15px; color: #cfcfe0; margin-bottom: 6px; }
    .slot-name { color: #fff; font-weight: 600; }
    .slot-name.empty { color: #7a7a88; font-weight: 400; }
    .del-btn { margin-left: auto; padding: 4px 10px; border-radius: 8px; border: 1px solid #5a3a3a;
      background: transparent; color: #ff9a9a; font-size: 13px; cursor: pointer; }
    .del-btn:hover { background: #3a2424; }
    .amount-row { display: flex; gap: 8px; margin-top: 8px; }
    .amount-row .unit-sel { flex: 0 0 90px; }
    .amount-row .amount-sel { flex: 1 1 0; }
    .add-btn { width: 100%; margin-top: 14px; padding: 11px; border-radius: 8px;
      border: 1px dashed rgba(109,168,255,0.5); background: rgba(109,168,255,0.08);
      color: #9fc3ff; font-size: 15px; cursor: pointer; }
    .add-btn:hover { background: rgba(109,168,255,0.16); }
    .recipe-status { margin-top: 10px; font-size: 12px; color: #b9b9c6; min-height: 1em; }
    #tab-result { position: relative; }
    #result-canvas { width: 100vw; height: calc(100vh - 52px); display: block; }
  `;
  document.head.append(style);
}

// ----------------------------------------------------------------------------
// 画面の骨組み
// ----------------------------------------------------------------------------
injectStyle();

// --- タブバー ---
const tabbar = el('div');
tabbar.id = 'tabbar';
const btnSettings = el('button');
btnSettings.textContent = '設定';
const btnResult = el('button');
btnResult.textContent = '結果';
tabbar.append(btnSettings, btnResult);

// --- 設定パネル ---
const settingsPanel = el('div', 'panel');
settingsPanel.id = 'tab-settings';

// レシピ設定ボックス（最上段）。中身：作り方 → 材料行群 → 追加ボタン → ステータス。
const recipeBody = el('div', 'block-body');

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

// 材料行（材料N＋量）の入れ物。スロット増減でここに行を出し入れする。
const slotRecipeContainer = el('div');

// 状態表示（読み込み中・エラー用）。
const recipeStatus = el('div', 'recipe-status');

recipeBody.append(methodRow, slotRecipeContainer, recipeStatus);
const recipeBlock = makeBlock('レシピ設定', recipeBody);

// 液体ブロック群の入れ物。スロット増減でここにブロックを出し入れする。
const liquidBlocksContainer = el('div');

// 「材料を追加する」ボタン。レシピ設定の折りたたみに埋もれて見つけにくいので、
// 設定パネル直下（液体ブロックの下）に常時表示で置く。
const addBtn = el('button', 'add-btn');
addBtn.type = 'button';
addBtn.textContent = '＋ 材料を追加する';
addBtn.addEventListener('click', () => addSlot());

settingsPanel.append(recipeBlock.block, liquidBlocksContainer, addBtn);

// --- 結果パネル ---
const resultPanel = el('div', 'panel');
resultPanel.id = 'tab-result';
const resultCanvas = el('canvas');
resultCanvas.id = 'result-canvas';
resultPanel.append(resultCanvas);

document.body.append(tabbar, settingsPanel, resultPanel);

// --- 小グラスの形状（全スロット共通）---
const smallSpec = SMALL_GLASS_STYLES[SMALL_GLASS_STYLE];
const smallShape: GlassShape = buildSmallGlassShape(smallSpec);
const smallLiquid: THREE.Vector2[] = buildLiquidProfile(smallShape, LIQUID_FILL);

// ----------------------------------------------------------------------------
// 結果ビュー：1液プログラムと「全く同じ」3D。共有モジュールで構築する（1つだけ）。
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

// 結果ビューで「混合結果」パネルを開いたときのカメラ調整（mixer-main と同一）。
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
// スロット1本ぶんの DOM＋状態を作る（3Dビューは作らない＝後で動的生成）。
//   ※ block の onToggle / delBtn のクリックは slot を参照するが、いずれも後で呼ばれる
//     ので、slot 定義より前に閉じ込めても実行時には slot が確定している。
// ----------------------------------------------------------------------------
function buildSlot(): Slot {
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

  // --- 液体ブロック本体（左:小グラスの置き場 / 右:プルダウン）---
  const body = el('div', 'block-body liquid-body');
  const canvasHolder = el('div', 'glass-col');
  body.append(canvasHolder, selectCol);

  const { block, setTitle } = makeBlock('液体', body, (open) => {
    slot.blockOpen = open;
    if (open && slot.view) {
      slot.view.resize();
      slot.view.renderOnce();
    }
  });

  // --- レシピ設定内の材料行（材料N＋名前＋削除＋量2段）---
  const recipeRow = el('div', 'recipe-row slot-recipe');
  const titleLine = el('div', 'slot-title');
  const rtitle = el('span', 'rtitle');
  rtitle.textContent = '材料';
  const nameSpan = el('span', 'slot-name empty');
  nameSpan.textContent = '選択されていません';
  const delBtn = el('button', 'del-btn');
  delBtn.type = 'button';
  delBtn.textContent = '削除';
  delBtn.addEventListener('click', () => removeSlot(slot));
  titleLine.append(rtitle, nameSpan, delBtn);

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
  recipeRow.append(titleLine, amountRow);

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
    block,
    setBlockTitle: setTitle,
    canvasHolder,
    catSel,
    matSel,
    recipeRow,
    rtitle,
    nameSpan,
    unitSel,
    amountSel,
    delBtn,
    view: null,
    canvas: null,
    blockOpen: false,
  };
  return slot;
}

// スロットのカテゴリ／材料プルダウンを実データで埋める（init・追加時に使う）。
function populateSlotSelects(slot: Slot): void {
  if (allItems.length === 0) return;
  const cats = distinctCategories(allItems);
  const catOpts = [
    { value: CATEGORY_ALL, label: 'すべて' },
    ...cats.map((c) => ({ value: c, label: c })),
  ];
  setSelectOptions(slot.catSel, catOpts, slot.state.category);
  rebuildMaterialSelect(slot);
}

// ----------------------------------------------------------------------------
// 小グラス3Dの動的生成 / 破棄（論点E）
// ----------------------------------------------------------------------------
function createSlotView(slot: Slot): void {
  if (slot.view) return; // 二重生成防止
  const canvas = el('canvas', 'small-glass');
  slot.canvasHolder.innerHTML = '';
  slot.canvasHolder.appendChild(canvas);
  const view = new GlassView({
    canvas,
    shape: smallShape,
    liquidProfile: smallLiquid,
    rich: SMALL_GLASS_RICH,
    interactive: true,
  });
  slot.view = view;
  slot.canvas = canvas;
  applySlotAppearance(slot); // 今の状態を反映
  view.resize();
  view.start(); // interactive＝ドラッグで回せるよう描画ループを回す
}

function disposeSlotView(slot: Slot): void {
  if (!slot.view) return;
  slot.view.dispose(); // stop＋GPUリソース解放（renderer/geo/mat/texture/composer）
  slot.view = null;
  if (slot.canvas) {
    slot.canvas.remove();
    slot.canvas = null;
  }
  slot.canvasHolder.innerHTML = '';
}

// スロットの「素の色」を小グラスへ反映（ビューがあるときだけ）。
function applySlotAppearance(slot: Slot): void {
  if (!slot.view) return;
  if (slot.state.appearance) {
    const a = slot.state.appearance;
    slot.view.setAppearance(a.rgb, a.density, a.turbidity);
  } else {
    slot.view.setAppearance({ ...EMPTY_RGB }, 0, 0); // 空グラス
  }
}

// ----------------------------------------------------------------------------
// スロットの追加 / 削除（論点D）
// ----------------------------------------------------------------------------
function addSlot(): void {
  if (slots.length >= MAX_SLOTS) return;
  const slot = buildSlot();
  slots.push(slot);
  liquidBlocksContainer.appendChild(slot.block);
  slotRecipeContainer.appendChild(slot.recipeRow);
  populateSlotSelects(slot);
  // 設定タブ表示中なら、その場で3Dビューを生成する。
  if (settingsPanel.classList.contains('active')) createSlotView(slot);
  renumberSlots();
  updateSlotControls();
  recompute();
}

function removeSlot(slot: Slot): void {
  if (slots.length <= MIN_SLOTS) return;
  disposeSlotView(slot); // 3Dを確実に解放
  slot.block.remove();
  slot.recipeRow.remove();
  const idx = slots.indexOf(slot);
  if (idx >= 0) slots.splice(idx, 1);
  renumberSlots();
  updateSlotControls();
  recompute();
}

// 「液体N」「材料N」の番号を現在の並び順で振り直す。
function renumberSlots(): void {
  slots.forEach((s, i) => {
    s.setBlockTitle(`液体${i + 1}`);
    s.rtitle.textContent = `材料${i + 1}`;
  });
}

// 追加ボタン（最大5で隠す）・削除ボタン（最小2で隠す）の表示制御。
function updateSlotControls(): void {
  addBtn.style.display = slots.length >= MAX_SLOTS ? 'none' : '';
  const canDelete = slots.length > MIN_SLOTS;
  for (const s of slots) s.delBtn.style.display = canDelete ? '' : 'none';
}

// ----------------------------------------------------------------------------
// 量（ml/tsp）→ ml 換算。未選択スロットや量0は 0ml（寄与なし）。
// ----------------------------------------------------------------------------
function volumeMl(slot: Slot): number {
  if (!slot.state.slug) return 0;
  const n = slot.state.amount;
  return slot.state.unit === 'tsp' ? n * 5 : n;
}

// ----------------------------------------------------------------------------
// 値が変わったときの再計算＆反映（N本一括）。
// ----------------------------------------------------------------------------
function recompute(): void {
  // --- 小グラス：各スロットの素の色（ビューがあるときだけ）---
  for (const slot of slots) applySlotAppearance(slot);
  if (settingsPanel.classList.contains('active')) {
    for (const slot of slots) slot.view?.renderOnce();
  }

  // --- 反映トリガー：材料1つ以上選択 ＆ 総量>0 ＆ 作り方選択 ---
  const vols = slots.map(volumeMl);
  const total = vols.reduce((s, v) => s + v, 0);
  const anySelected = slots.some((s) => s.state.slug !== null);
  const ready = anySelected && total > 0 && method !== '';

  if (!ready) {
    resultSc.setLiquidAppearance({ ...EMPTY_RGB }, 0, 0); // 空グラス維持
    resultUI.setValues({ ...EMPTY_RGB }, 0, 0);
    return;
  }

  // --- N本一括混合（順序非依存）。未選択スロットはダミー＝重み0で寄与しない ---
  const liquids = slots.map((s) => s.state.liquid ?? PLACEHOLDER_LIQUID);
  const mixed = mixLiquids(liquids, vols, WATER_RATIO);
  const rgb = hsvToRgb(mixed.hue, mixed.sat, mixed.val);
  resultSc.setLiquidAppearance(rgb, mixed.density, mixed.turbidity);
  resultUI.setValues(rgb, mixed.density, mixed.turbidity);
}

// ----------------------------------------------------------------------------
// 材料プルダウン（液体ブロック内）を、今のカテゴリに合わせて作り直す。
//   先頭に「（材料を選択）＝未選択」を置き、カテゴリ変更時は選択をクリアする。
// ----------------------------------------------------------------------------
function rebuildMaterialSelect(slot: Slot): void {
  const list = itemsInCategory(slot.state.category);
  const opts = [
    { value: '', label: '（材料を選択）' },
    ...list.map((it) => ({ value: it.slug, label: it.name_ja })),
  ];
  setSelectOptions(slot.matSel, opts, '');
  void pickMaterial(slot, ''); // カテゴリ切替で材料は未選択に戻す
}

// 量プルダウン（レシピ設定内）を単位に合わせて作り直す。先頭(0)を選択。
function rebuildAmountSelect(slot: Slot): void {
  const arr = slot.state.unit === 'tsp' ? TSP_AMOUNTS : ML_AMOUNTS;
  setSelectOptions(
    slot.amountSel,
    arr.map((n) => ({ value: String(n), label: String(n) })),
    '0',
  );
  slot.state.amount = 0;
}

// 材料を1つ選んだ（または未選択にした）ときの反映。
async function pickMaterial(slot: Slot, slug: string): Promise<void> {
  if (!slug) {
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
// タブ切替（負荷管理：見えているタブの3Dだけ動かす。非表示時は小グラスを dispose）。
// ----------------------------------------------------------------------------
function showTab(tab: 'settings' | 'result'): void {
  const isSettings = tab === 'settings';
  settingsPanel.classList.toggle('active', isSettings);
  resultPanel.classList.toggle('active', !isSettings);
  btnSettings.classList.toggle('active', isSettings);
  btnResult.classList.toggle('active', !isSettings);

  if (isSettings) {
    resultStop();
    // 小グラスを（表示中スロットぶんだけ）生成して回す。
    for (const slot of slots) createSlotView(slot);
    recompute();
  } else {
    // 設定タブを離れたら小グラスを確実に破棄（WebGLコンテキストを手放す）。
    for (const slot of slots) disposeSlotView(slot);
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
      slot.view?.resize();
      slot.view?.renderOnce();
    }
  } else {
    resultResize();
    if (IS_MOBILE && isResultPanelOpen) applyResultPanelView(true);
  }
});

// ----------------------------------------------------------------------------
// 起動：初期スロット(2本)を作る → 設定タブ表示 → DB取得して選択肢を埋める。
// ----------------------------------------------------------------------------
// 初期スロットを DOM に追加（ビューは showTab('settings') で生成）。
for (let i = 0; i < INITIAL_SLOTS; i++) {
  const slot = buildSlot();
  slots.push(slot);
  liquidBlocksContainer.appendChild(slot.block);
  slotRecipeContainer.appendChild(slot.recipeRow);
}
renumberSlots();
updateSlotControls();

async function init(): Promise<void> {
  recipeStatus.textContent = '材料一覧を読み込み中…';
  allItems = await fetchIngredientSlugs();

  if (allItems.length === 0) {
    recipeStatus.textContent =
      '材料一覧が取得できませんでした（.env.local のキー設定とネットワークを確認）。';
    return;
  }

  for (const slot of slots) populateSlotSelects(slot);
  recipeStatus.textContent = '';
  recompute();
}

// 初期表示：設定タブ。失敗してもアプリは動き続ける（空グラスのまま）。
showTab('settings');
recompute();
void init();
