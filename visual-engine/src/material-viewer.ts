// ============================================================================
// material-viewer — 材料マスタDBの「材料図鑑」(1b)
//   ----------------------------------------------------------------------------
//   ◆このエントリの役割
//     DB の材料を「カテゴリで絞り込み → 材料を選ぶ → 3D液体＋説明カードで見る」図鑑。
//     (1a) では “プルダウン1つ” だけだったのを、(1b) で次の2点を足した：
//       1) カテゴリ選択（1段目）＋材料プルダウン（2段目）の2段絞り込み
//       2) 選択中の材料の情報パネル（name_ja / name_en / 分類 / description）
//     ※3D描画・HSL→3軸変換・DB取得は (1a) で完成済み。今回は UI 層だけの仕事。
//        変換(db-to-visual)・DB層(ingredients)・3D(cocktail-scene) は一切変更しない。
//
//   ◆処理の流れ（初心者向け）
//     起動時：fetchIngredientSlugs() で全件の (slug,name_ja,category) を取り、メモリ保持。
//       → そのリストから category を distinct してカテゴリ選択UIを動的に作る（DBが正）。
//     カテゴリを選ぶ：そのカテゴリの材料だけで2段目プルダウンを作り直し、先頭を自動選択。
//     材料を選ぶ：fetchIngredientBySlug(slug) → hslToLiquidAppearance(row)
//                 → setLiquidAppearance(...) で3D反映（(1a)と同じ）＋情報パネル更新。
// ============================================================================

// OrbitControls はマウスでカメラを回す/ズームする補助ツール（1液ビューアーと同じ）。
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import './style.css';
// 3Dシーン一式を構築する共有モジュール（見た目の全条件はこの中・無改変で流用）。
import {
  buildCocktailScene,
  CAMERA_TARGET,
  INITIAL_LIQUID_RGB,
  INITIAL_DENSITY,
} from './scene/cocktail-scene';
// DB取得（(1a)で実装済み・無改変で流用）と、HSL→3軸 変換（(1a)で確定・無改変）。
import {
  fetchIngredientBySlug,
  fetchIngredientSlugs,
  type IngredientOption,
  type IngredientRow,
} from './db/ingredients';
import { hslToLiquidAppearance } from './db/db-to-visual';

// ----------------------------------------------------------------------------
// 1) 3Dシーンを構築（renderer/scene/camera/ライト/マテリアル/机/影/背景/bloom/DOF）。
//    canvas を渡さないので three が内部 canvas を作る → それを body に追加する（main.ts と同じ）。
// ----------------------------------------------------------------------------
const sc = buildCocktailScene();
const { renderer, camera, composer, setLiquidAppearance, resize } = sc;
document.body.appendChild(renderer.domElement);

// 起動直後・DB取得が返るまでの “つなぎ” として、既定の見た目を一度流し込んでおく。
setLiquidAppearance({ ...INITIAL_LIQUID_RGB }, INITIAL_DENSITY, 0);

// ----------------------------------------------------------------------------
// 2) OrbitControls（マウス操作）— 1液ビューアーと同じ。注視点も共有の CAMERA_TARGET。
// ----------------------------------------------------------------------------
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);

// ----------------------------------------------------------------------------
// 3) アニメーションループ（後処理を入れているので composer.render を呼ぶ）。
// ----------------------------------------------------------------------------
function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  composer.render();
}
animate();

// ----------------------------------------------------------------------------
// 4) ウィンドウリサイズ対応（カメラ比率・描画サイズ・後処理バッファを追従）。
// ----------------------------------------------------------------------------
window.addEventListener('resize', () => {
  resize(window.innerWidth, window.innerHeight);
});

// ============================================================================
// 5) UI（図鑑）— ここからが (1b) の主役。すべて JS で生成して body に足す。
//    レイアウト：画面左上に「絞り込みパネル」（カテゴリ＋材料プルダウン）、
//                画面左下に「情報パネル」（説明カード）。3Dグラスは中央が主役なので
//                両パネルとも左端に寄せ、半透明にしてグラスを隠さないようにする。
// ============================================================================

// スマホ幅か（既存ビューアーと同じ基準）。パネル幅やフォントの微調整に使う。
const IS_MOBILE = window.innerWidth <= 768;

// カテゴリの「すべて」を表す内部値（実カテゴリ名と衝突しない番兵）。
const CATEGORY_ALL = '__all__';

// 起動時に取得した全件リスト（slug/name_ja/category）をここに保持する。
let allItems: IngredientOption[] = [];
// 今選択中のカテゴリ（CATEGORY_ALL か 実カテゴリ名）。
let activeCategory: string = CATEGORY_ALL;

// 共通のパネル装飾（既存 liquid-ui のトーンに合わせた半透明の暗い箱）。
const PANEL_BG = 'rgba(20,20,26,0.82)';
const PANEL_SHADOW = '0 6px 24px rgba(0,0,0,0.45)';
const FONT_BASE = 'system-ui,-apple-system,"Segoe UI",sans-serif';

// --- 5-1) 絞り込みパネル（左上・カテゴリ＋材料プルダウン）-------------------
const filterPanel = document.createElement('div');
filterPanel.style.cssText = [
  'position:fixed',
  'top:16px',
  'left:16px',
  'z-index:10', // 3Dキャンバスより手前
  'padding:12px',
  'border-radius:12px',
  'background:' + PANEL_BG,
  'backdrop-filter:blur(6px)',
  'box-shadow:' + PANEL_SHADOW,
  'font-family:' + FONT_BASE,
  'color:#e8e8ee',
  'user-select:none',
  'width:' + (IS_MOBILE ? '60vw' : '260px'),
  'max-width:80vw',
].join(';');

// --- ヘッダー＝タイトル「材料選択」＝開閉ボタン ---
//   既存の液体UIパネルと同じ流儀で、クリックすると下の中身を開いたり閉じたりできる。
//   3Dグラスを見たいときに畳めるようにする（特にスマホでパネルが大きいとき便利）。
const filterHeader = document.createElement('div');
// flex で「タイトル文字」と「開閉キャレット(▼▶)」を左右に振り分ける。
filterHeader.style.cssText = [
  'display:flex',
  'align-items:center',
  'justify-content:space-between',
  'cursor:pointer', // クリックできることを示す
  'font-size:' + (IS_MOBILE ? 16 : 15) + 'px',
  'font-weight:600',
  'letter-spacing:0.04em',
].join(';');

const filterTitle = document.createElement('span');
filterTitle.textContent = '材料選択';
filterHeader.appendChild(filterTitle);

// 開閉状態を示すキャレット（▼=開いている / ▶=閉じている）。
const filterCaret = document.createElement('span');
filterCaret.style.cssText =
  'font-size:' + (IS_MOBILE ? 14 : 13) + 'px;margin-left:8px;opacity:0.8;';
filterHeader.appendChild(filterCaret);
filterPanel.appendChild(filterHeader);

// 中身（カテゴリ＋材料＋状態）をまとめる箱。ここの display を切り替えて開閉する。
const filterContent = document.createElement('div');
filterContent.style.cssText = 'margin-top:10px;';
filterPanel.appendChild(filterContent);

// カテゴリボタンを並べる箱（折り返し可）。
//   ※「カテゴリ」という見出しは自明なので置かない（1行ぶん節約）。
const catRow = document.createElement('div');
catRow.style.cssText =
  'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;';
filterContent.appendChild(catRow);

// 材料見出し
const matLabel = document.createElement('div');
matLabel.textContent = '材料';
matLabel.style.cssText =
  'font-size:' + (IS_MOBILE ? 14 : 13) + 'px;opacity:0.8;margin-bottom:6px;';
filterContent.appendChild(matLabel);

// 材料プルダウン（2段目）。中身はカテゴリ選択に応じて作り直す。
const matSelect = document.createElement('select');
matSelect.style.cssText = [
  'width:100%',
  'padding:8px 10px',
  'border-radius:8px',
  'border:1px solid rgba(255,255,255,0.2)',
  'background:rgba(10,10,14,0.6)',
  'color:#e8e8ee',
  'font-family:' + FONT_BASE,
  'font-size:' + (IS_MOBILE ? 15 : 14) + 'px',
].join(';');
filterContent.appendChild(matSelect);

// 小さな状態表示（読み込み中／エラーのヒント用。材料の生数値は出さない＝図鑑方針）。
const status = document.createElement('div');
status.style.cssText =
  'margin-top:8px;font-size:12px;color:#b9b9c6;font-family:ui-monospace,monospace;min-height:1em;';
filterContent.appendChild(status);

// --- 開閉のしくみ ---
//   既定は開いた状態。ヘッダーをクリックするたびに開閉をトグルする。
let filterCollapsed = false;
function applyFilterCollapsed(): void {
  filterContent.style.display = filterCollapsed ? 'none' : 'block';
  filterCaret.textContent = filterCollapsed ? '▶' : '▼';
}
applyFilterCollapsed(); // 初期状態（開）を反映
filterHeader.addEventListener('click', () => {
  filterCollapsed = !filterCollapsed;
  applyFilterCollapsed();
});

document.body.appendChild(filterPanel);

// --- 5-2) 情報パネル（左下・説明カード）------------------------------------
// 共通：パネルの幅（情報カードと味覚情報ボックスをそろえる）。
const BOTTOM_PANEL_WIDTH = IS_MOBILE ? '80vw' : '320px';

// 画面左下に「情報カード」と「味覚情報ボックス」を縦に積むための入れ物。
//   これ自体を画面下に固定し、中の2つを縦並び（情報カードが上・味覚が下）にする。
//   ＝「カクテル情報ボックスの下に味覚情報ボックス」を実現する。
const bottomStack = document.createElement('div');
bottomStack.style.cssText = [
  'position:fixed',
  'left:16px',
  'bottom:16px',
  'z-index:10',
  'display:flex',
  'flex-direction:column',
  'gap:10px',
  'width:' + BOTTOM_PANEL_WIDTH,
  'max-width:86vw',
].join(';');

// --- 情報カード（旧 infoPanel。固定配置はやめ、stack の子にする）---
const infoPanel = document.createElement('div');
infoPanel.style.cssText = [
  'padding:14px 16px',
  'border-radius:12px',
  'background:' + PANEL_BG,
  'backdrop-filter:blur(6px)',
  'box-shadow:' + PANEL_SHADOW,
  'font-family:' + FONT_BASE,
  'color:#e8e8ee',
  'line-height:1.6',
].join(';');

// 名前（日本語・主役）
const infoNameJa = document.createElement('div');
infoNameJa.style.cssText =
  'font-size:' + (IS_MOBILE ? 20 : 22) + 'px;font-weight:700;';
infoPanel.appendChild(infoNameJa);

// 名前（英語・補助）
const infoNameEn = document.createElement('div');
infoNameEn.style.cssText =
  'font-size:' + (IS_MOBILE ? 12 : 13) + 'px;opacity:0.7;margin-top:2px;';
infoPanel.appendChild(infoNameEn);

// 分類ラベル（category / subcategory）。バッジ風に薄い枠で。
const infoCat = document.createElement('div');
infoCat.style.cssText =
  'font-size:12px;opacity:0.85;margin-top:8px;color:#c9c9d6;';
infoPanel.appendChild(infoCat);

// 説明文（description）。空のときは欄ごと隠す。
const infoDesc = document.createElement('div');
infoDesc.style.cssText =
  'font-size:' + (IS_MOBILE ? 13 : 14) + 'px;margin-top:10px;color:#dcdce4;';
infoPanel.appendChild(infoDesc);

bottomStack.appendChild(infoPanel);

// ============================================================================
// 味覚情報ボックス（開閉式）＋ レーダーチャート
//   五味（甘味・酸味・塩味・苦味・旨味）＋ 渋味・粘度 の7軸を、canvas で描く
//   レーダーチャートで表示する。各値は 0〜10（DBの味系列）。
//   ※外部ライブラリは使わず canvas 2D で自作（既存UIと同じ方針・依存ゼロ）。
// ============================================================================

// レーダーの7軸定義（DBの列キーと表示ラベル）。上(甘味)から時計回りに並べる。
const TASTE_AXES: { key: keyof IngredientRow; label: string }[] = [
  { key: 'sweetness', label: '甘味' },
  { key: 'sourness', label: '酸味' },
  { key: 'saltiness', label: '塩味' },
  { key: 'bitterness', label: '苦味' },
  { key: 'umami', label: '旨味' },
  { key: 'astringency', label: '渋味' },
  { key: 'viscosity', label: '粘度' },
];
const MAX_TASTE = 10; // 各味の最大値（DBは 0〜10）。スケールの基準。

const tasteBox = document.createElement('div');
tasteBox.style.cssText = [
  'padding:12px 16px',
  'border-radius:12px',
  'background:' + PANEL_BG,
  'backdrop-filter:blur(6px)',
  'box-shadow:' + PANEL_SHADOW,
  'font-family:' + FONT_BASE,
  'color:#e8e8ee',
].join(';');

// 味覚情報のヘッダー＝タイトル「味覚情報」＝開閉ボタン（情報パネルと同じ流儀）。
const tasteHeader = document.createElement('div');
tasteHeader.style.cssText = [
  'display:flex',
  'align-items:center',
  'justify-content:space-between',
  'cursor:pointer',
  'font-size:' + (IS_MOBILE ? 16 : 15) + 'px',
  'font-weight:600',
  'letter-spacing:0.04em',
].join(';');
const tasteTitle = document.createElement('span');
tasteTitle.textContent = '味覚情報';
tasteHeader.appendChild(tasteTitle);
const tasteCaret = document.createElement('span');
tasteCaret.style.cssText =
  'font-size:' + (IS_MOBILE ? 14 : 13) + 'px;margin-left:8px;opacity:0.8;';
tasteHeader.appendChild(tasteCaret);
tasteBox.appendChild(tasteHeader);

// 開閉する中身（レーダーチャートの canvas を入れる）。
const tasteContent = document.createElement('div');
tasteContent.style.cssText = 'margin-top:10px;';
tasteBox.appendChild(tasteContent);

// レーダー用 canvas。高解像度ディスプレイでも字がにじまないよう devicePixelRatio で拡大する。
const RADAR_SIZE = IS_MOBILE ? 240 : 280; // 表示上の一辺(px)
const radarCanvas = document.createElement('canvas');
const dpr = Math.min(window.devicePixelRatio || 1, 2);
radarCanvas.width = RADAR_SIZE * dpr;
radarCanvas.height = RADAR_SIZE * dpr;
radarCanvas.style.cssText =
  'display:block;margin:0 auto;width:' +
  RADAR_SIZE +
  'px;height:' +
  RADAR_SIZE +
  'px;';
tasteContent.appendChild(radarCanvas);
const radarCtx = radarCanvas.getContext('2d')!;
radarCtx.scale(dpr, dpr); // 以降は論理座標(0〜RADAR_SIZE)で描けばよい

// --- レーダーチャートを描く（row の味7軸を読む）---
//   引数 row が null のときは「データなし」表示にする（外枠だけ描く）。
function drawRadar(row: IngredientRow | null): void {
  const S = RADAR_SIZE;
  radarCtx.clearRect(0, 0, S, S);

  const cx = S / 2;
  const cy = S / 2 + 6; // ラベルぶん少し下げて中央寄せ
  const R = S * 0.32; // 一番外側の半径
  const N = TASTE_AXES.length; // 7
  const start = -Math.PI / 2; // 真上から開始
  // i番目の軸の角度（時計回り）。
  const angleOf = (i: number) => start + (i / N) * Math.PI * 2;

  // (a) グリッド（同心の七角形）を薄く描く。
  radarCtx.strokeStyle = 'rgba(255,255,255,0.18)';
  radarCtx.lineWidth = 1;
  for (const level of [0.25, 0.5, 0.75, 1.0]) {
    radarCtx.beginPath();
    for (let i = 0; i < N; i++) {
      const a = angleOf(i);
      const x = cx + Math.cos(a) * R * level;
      const y = cy + Math.sin(a) * R * level;
      if (i === 0) radarCtx.moveTo(x, y);
      else radarCtx.lineTo(x, y);
    }
    radarCtx.closePath();
    radarCtx.stroke();
  }

  // (b) 中心から各頂点への軸線。
  for (let i = 0; i < N; i++) {
    const a = angleOf(i);
    radarCtx.beginPath();
    radarCtx.moveTo(cx, cy);
    radarCtx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
    radarCtx.stroke();
  }

  // (c) 軸ラベル（甘味・酸味…）を各頂点の少し外側に。
  radarCtx.fillStyle = '#d8d8e2';
  radarCtx.font = (IS_MOBILE ? 12 : 12) + 'px ' + FONT_BASE;
  radarCtx.textAlign = 'center';
  radarCtx.textBaseline = 'middle';
  for (let i = 0; i < N; i++) {
    const a = angleOf(i);
    const lx = cx + Math.cos(a) * (R + 18);
    const ly = cy + Math.sin(a) * (R + 16);
    radarCtx.fillText(TASTE_AXES[i].label, lx, ly);
  }

  // データが無ければここで終了（外枠だけ表示）。
  if (!row) return;

  // (d) データの多角形。各味の値(0〜MAX_TASTE)を 0〜1 に正規化して頂点を作る。
  const points: [number, number][] = [];
  for (let i = 0; i < N; i++) {
    const raw = (row[TASTE_AXES[i].key] as number | null) ?? 0; // null は 0 扱い（固体等）
    const v = Math.min(Math.max(raw, 0), MAX_TASTE) / MAX_TASTE; // 0〜1
    const a = angleOf(i);
    points.push([cx + Math.cos(a) * R * v, cy + Math.sin(a) * R * v]);
  }

  // 塗り（半透明）＋ 輪郭。色はカクテルらしい赤系のアクセント。
  radarCtx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? radarCtx.moveTo(x, y) : radarCtx.lineTo(x, y)));
  radarCtx.closePath();
  radarCtx.fillStyle = 'rgba(255,99,132,0.35)';
  radarCtx.fill();
  radarCtx.strokeStyle = 'rgba(255,99,132,0.95)';
  radarCtx.lineWidth = 2;
  radarCtx.stroke();

  // (e) 各頂点に小さな点を打つ。
  radarCtx.fillStyle = 'rgba(255,99,132,1)';
  for (const [x, y] of points) {
    radarCtx.beginPath();
    radarCtx.arc(x, y, 2.5, 0, Math.PI * 2);
    radarCtx.fill();
  }
}

// 味覚情報の開閉。既定は開いた状態。ヘッダークリックでトグル。
let tasteCollapsed = false;
function applyTasteCollapsed(): void {
  tasteContent.style.display = tasteCollapsed ? 'none' : 'block';
  tasteCaret.textContent = tasteCollapsed ? '▶' : '▼';
}
applyTasteCollapsed();
tasteHeader.addEventListener('click', () => {
  tasteCollapsed = !tasteCollapsed;
  applyTasteCollapsed();
});

bottomStack.appendChild(tasteBox);
document.body.appendChild(bottomStack);

// 初期は外枠だけ描いておく（材料選択が来たら値入りで描き直す）。
drawRadar(null);

// パネル上の操作が背後の3D(OrbitControls)に漏れてカメラが動かないよう止める。
[filterPanel, bottomStack].forEach((panel) => {
  ['pointerdown', 'mousedown', 'wheel', 'touchstart'].forEach((type) => {
    panel.addEventListener(type, (ev) => ev.stopPropagation());
  });
});

// ----------------------------------------------------------------------------
// 6) リスト操作のヘルパー
// ----------------------------------------------------------------------------

// 全件リストから category を distinct する（最初に出てきた順を保つ）。
//   カテゴリ名はコードにハードコードせず、DBの値から動的に作る（DBが正）。
//   category が null の材料（万一あれば）は分類UIからは除外する（「すべて」には残る）。
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
// 7) カテゴリボタン群を作る（「すべて」＋ distinct した各カテゴリ）。
//    押すと activeCategory を切り替え、2段目プルダウンを作り直して先頭を自動選択する。
// ----------------------------------------------------------------------------
function makeCategoryButton(label: string, value: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.dataset.value = value; // どのカテゴリのボタンか（選択中ハイライト更新に使う）
  btn.style.cssText = [
    'padding:5px 10px',
    'border-radius:999px', // 丸いピル型
    'border:1px solid rgba(255,255,255,0.2)',
    'background:transparent',
    'color:#e8e8ee',
    'font-family:' + FONT_BASE,
    'font-size:' + (IS_MOBILE ? 13 : 12) + 'px',
    'cursor:pointer',
  ].join(';');
  btn.addEventListener('click', () => {
    activeCategory = value;
    updateCategoryHighlight();
    rebuildMaterialSelect(); // 2段目を作り直し、先頭を自動選択＋3D/情報も更新
  });
  return btn;
}

// 選択中カテゴリのボタンだけ目立たせる（アクティブ表示）。
function updateCategoryHighlight(): void {
  const btns = catRow.querySelectorAll('button');
  btns.forEach((b) => {
    const el = b as HTMLButtonElement;
    const isActive = el.dataset.value === activeCategory;
    el.style.background = isActive ? '#e8e8ee' : 'transparent';
    el.style.color = isActive ? '#16161c' : '#e8e8ee';
    el.style.fontWeight = isActive ? '700' : '400';
  });
}

function buildCategoryButtons(): void {
  catRow.innerHTML = '';
  // 先頭に「すべて」（全70件に戻せる選択肢）。
  catRow.appendChild(makeCategoryButton('すべて', CATEGORY_ALL));
  for (const cat of distinctCategories(allItems)) {
    catRow.appendChild(makeCategoryButton(cat, cat));
  }
  updateCategoryHighlight();
}

// ----------------------------------------------------------------------------
// 8) 2段目プルダウン（材料）を、今のカテゴリに合わせて作り直す。
//    作り直したら先頭の材料を自動選択して、3D＋情報パネルも更新する（親切寄りに）。
// ----------------------------------------------------------------------------
function rebuildMaterialSelect(preferredSlug?: string): void {
  const list = itemsInCategory(activeCategory);
  matSelect.innerHTML = '';
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item.slug;
    opt.textContent = item.name_ja;
    matSelect.appendChild(opt);
  }

  if (list.length === 0) {
    status.textContent = 'このカテゴリに材料がありません。';
    return;
  }

  // 初期選択：指定があってリスト内にあればそれ、無ければ先頭。
  const initial =
    preferredSlug && list.some((x) => x.slug === preferredSlug)
      ? preferredSlug
      : list[0].slug;
  matSelect.value = initial;
  void applyMaterial(initial);
}

// 材料プルダウンの選択変更 → 反映。
matSelect.addEventListener('change', () => {
  if (matSelect.value) void applyMaterial(matSelect.value);
});

// ----------------------------------------------------------------------------
// 9) 1材料を3D＋情報パネルへ反映する（(1a)の applyMaterial を図鑑用に拡張）。
//    DB取得 → 変換 → setLiquidAppearance（ここは(1a)と同じ）＋ 情報カード更新。
//    失敗・null時は画面を固めず、ステータスに理由を出す。
// ----------------------------------------------------------------------------
async function applyMaterial(slug: string): Promise<void> {
  status.textContent = '読み込み中…';
  const row = await fetchIngredientBySlug(slug);
  if (!row) {
    // 取得失敗 or 該当なし。3Dは直前の見た目のまま据え置き（固まらせない）。
    status.textContent = `取得できませんでした: ${slug}`;
    return;
  }

  // --- 3Dへ反映（(1a)と同一。変換・描画は変えない）---
  const out = hslToLiquidAppearance(row);
  setLiquidAppearance(out.rgb, out.density, out.turbidity);

  // --- 情報パネル更新（数値は出さない＝図鑑方針）---
  infoNameJa.textContent = row.name_ja;

  // 英語名（無ければ欄を空に）
  infoNameEn.textContent = row.name_en ?? '';
  infoNameEn.style.display = row.name_en ? 'block' : 'none';

  // 分類ラベル：category と subcategory を「・」でつなぐ（subcategoryは表示はするが絞り込みには使わない）。
  const catParts = [row.category, row.subcategory].filter(
    (x): x is string => !!x,
  );
  infoCat.textContent = catParts.join('　・　');
  infoCat.style.display = catParts.length > 0 ? 'block' : 'none';

  // 説明文：空/null のときは欄ごと隠してレイアウトが崩れないようにする。
  const desc = row.description?.trim();
  infoDesc.textContent = desc ?? '';
  infoDesc.style.display = desc ? 'block' : 'none';

  // --- 味覚レーダーを更新（五味＋渋味・粘度の7軸）---
  drawRadar(row);

  status.textContent = ''; // 成功したらヒントは消す
}

// ----------------------------------------------------------------------------
// 10) 起動：全件リストを取り → カテゴリUI構築 →「すべて」＋赤ワインで初期表示。
// ----------------------------------------------------------------------------
async function init(): Promise<void> {
  status.textContent = '材料一覧を読み込み中…';
  allItems = await fetchIngredientSlugs();

  if (allItems.length === 0) {
    // DB未接続 or 取得失敗。原因のヒントを出す（キー設定とネットワーク）。
    status.textContent =
      '材料一覧が取得できませんでした（.env.local のキー設定とネットワークを確認）。';
    return;
  }

  // カテゴリボタンを作る（「すべて」がアクティブな状態から開始）。
  activeCategory = CATEGORY_ALL;
  buildCategoryButtons();

  // 初期選択は分かりやすい「赤ワイン」を優先（無ければ先頭）。slug候補をいくつか当てる。
  const PREFERRED_INITIAL = ['red-wine', 'red_wine', 'wine-red'];
  const found = allItems.find((x) => PREFERRED_INITIAL.includes(x.slug));
  rebuildMaterialSelect(found ? found.slug : undefined);
}

// 起動。失敗してもアプリは動き続ける（3Dは既定の見た目のまま）。
void init();
