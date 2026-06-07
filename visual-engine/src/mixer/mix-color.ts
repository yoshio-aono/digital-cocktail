// ============================================================================
// 簡略色エンジン（2液混合ロジック） — mixer 専用の暫定版
//   color-engine 本体（color-engine/）は別途スリム再設計予定。ここでは mixer の
//   検証用に「2つの液体パラメータを比率と希釈で混ぜる」最小限の純粋関数だけを置く。
//
//   ◆扱うパラメータ（液体1つぶん）：
//     hue       … 色相 0〜360°（色の角度。円周上の値なので単純平均は禁止＝下記参照）
//     sat       … 彩度 0〜1（色みの鮮やかさ。0=灰色、1=純色）
//     val       … 明度 0〜1（明るさ。0=黒、1=最も明るい）
//     density   … 濃さ 0〜1（色素の濃さ。大きいほど濃い）
//     turbidity … 濁り 0〜1（散乱の度合い。大きいほど白く濁って不透明）
//   ※1液プログラムと同じく「色」は HSV（色相・彩度・明度）で持つ。3Dの液体には
//     hsvToRgb で RGB に変換して渡す。
//
//   ◆この関数は「フロント非依存の純粋関数」。Three.js には一切触れない。
//     3Dへの反映は呼び出し側（mixer-main）が setAppearance() 経由で行う。
// ============================================================================

// 液体1つぶんのパラメータ。
export interface LiquidParams {
  hue: number; // 0〜360°
  sat: number; // 0〜1（彩度）
  val: number; // 0〜1（明度）
  density: number; // 0〜1
  turbidity: number; // 0〜1
}

// ----------------------------------------------------------------------------
// ★ 調整用の定数（まとめて先頭に置く。見比べてここだけ触れば挙動が変わる）★
// ----------------------------------------------------------------------------

// 希釈率の上限。水でいくら薄めても density/turbidity が 0（完全透明）までは
// 行かせない。1.0 にすると無色透明になってしまうので 0.8 で頭打ち。
export const MAX_DILUTION = 0.8;

// 濁りボーナス係数。混ぜる2液の色相差が大きいほど turbidity を加算する量の最大値。
//   色相差 0°  → 加算 0（似た色どうしは澄んだまま）
//   色相差 180°→ 加算 TURBIDITY_BONUS（補色どうしは濁る＝絵の具を混ぜた濁り）
// 実際のカクテル（2液系）はそこまで濁らないので、控えめな小さい値にしている。
export const TURBIDITY_BONUS = 0.12;

// ----------------------------------------------------------------------------
// 小さな数値ヘルパー
// ----------------------------------------------------------------------------

// 線形補間（lerp）。t=0 で a、t=1 で b。
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// 0〜1 にクランプ（はみ出した値を範囲内に丸める）。
function clamp01(x: number): number {
  return Math.min(Math.max(x, 0), 1);
}

// ----------------------------------------------------------------------------
// ★ 色相の「円の短弧補間」★
//   色相は 0〜360° の円周上の値。例えば 350° と 10° の中間は、単純平均だと
//   180°（真逆の色）になってしまうが、本当は円を短い側に回って 0°（=360°）が正しい。
//   そこで「2角の差を -180〜+180 の範囲（＝短い側の弧）に畳んでから」補間する。
// ----------------------------------------------------------------------------
function lerpHue(a: number, b: number, t: number): number {
  // (b - a) を -180〜+180 に正規化する。+540 して %360 し -180 することで、
  // 必ず「短い側の回り方」の符号付き差分になる。
  const diff = ((((b - a) % 360) + 540) % 360) - 180;
  // a から短い側へ t ぶん進め、最後に 0〜360 に収める。
  return (((a + diff * t) % 360) + 360) % 360;
}

// 2つの色相の「最短の角度差」を 0〜180 で返す（濁りボーナスの計算に使う）。
function hueDistance(a: number, b: number): number {
  return Math.abs(((((b - a) % 360) + 540) % 360) - 180);
}

// ----------------------------------------------------------------------------
// ★ 本体：2液混合 ★
//   入力：液体1, 液体2, 比率 t（0=液体1のみ / 1=液体2のみ）, 希釈率 w（0〜MAX_DILUTION）
//   出力：混合結果の { hue, density, turbidity }
//
//   手順（仕様書どおり・順序厳守）：
//     1. 色相＝円の短弧補間（lerpHue）
//     2. 彩度・明度・density・turbidity＝比率 t で線形補間（lerp）
//     3. 濁りボーナス＝色相差が大きいほど turbidity を加算
//     4. 希釈＝density と turbidity に ×(1 - w) を掛けて減衰（色相・彩度・明度は変えない）
// ----------------------------------------------------------------------------
export function mixTwoLiquids(
  l1: LiquidParams,
  l2: LiquidParams,
  t: number,
  w: number,
): LiquidParams {
  const ratio = clamp01(t); // 念のため 0〜1 に丸める

  // 1. 色相は短弧補間（単純平均は禁止）。
  const hue = lerpHue(l1.hue, l2.hue, ratio);

  // 2. 彩度・明度・濃さ・濁りは普通の線形補間。
  const sat = lerp(l1.sat, l2.sat, ratio);
  const val = lerp(l1.val, l2.val, ratio);
  let density = lerp(l1.density, l2.density, ratio);
  let turbidity = lerp(l1.turbidity, l2.turbidity, ratio);

  // 3. 濁りボーナス：2液の色相差（0〜180）に比例して turbidity を上乗せ。
  //    ただし「実際にどれだけ混ざったか」で効かせる。片方100%（ratio=0 or 1）では
  //    混ざっていないので濁らせない。中央(0.5)で最大になる放物線で減衰させる。
  //    （これが無いと ratio=0＝液体1のみでも色相差ぶんの濁りが乗ってしまう）
  const diff = hueDistance(l1.hue, l2.hue); // 0〜180
  const mixAmount = 4 * ratio * (1 - ratio); // ratio=0→0 / 0.5→1 / 1→0
  turbidity += TURBIDITY_BONUS * (diff / 180) * mixAmount;

  // 4. 水による希釈：density / turbidity を ×(1 - w) で減衰。色相・彩度・明度はそのまま。
  //    w は 0〜MAX_DILUTION に丸めてから使う（上限を超えて透明化させない）。
  const wc = Math.min(Math.max(w, 0), MAX_DILUTION);
  density *= 1 - wc;
  turbidity *= 1 - wc;

  return {
    hue,
    sat: clamp01(sat),
    val: clamp01(val),
    density: clamp01(density),
    turbidity: clamp01(turbidity),
  };
}

// ----------------------------------------------------------------------------
// ★ 本体：N液一括混合（最大5液）★  ※既存 mixTwoLiquids は無改変で残す。
//   開発(3) N液化で新設。逐次2液混色（reduce）だと混ぜる順序で結果が変わるため、
//   N本を「一括の加重平均」で混ぜる＝順序非依存にする。物理モデルには寄せず HSV幾何のまま。
//
//   入力：liquids（N本のパラメータ）, vols（各本の量。ml正規化済みの重み）, w（希釈率）
//   出力：混合結果の LiquidParams
//
//   手順：
//     1. 色相＝加重 circular mean。各色相を単位ベクトル(cosθ,sinθ)にし、量を重みに合成して
//        atan2 で平均色相を得る（円周上で正しく平均。単純平均の破綻を避ける）。
//     2. sat / val / density / turbidity＝量を重みとした加重平均（Σw·x / Σw）。
//     3. 濁りボーナス＝円周分散(1 - R)。R は合成ベクトル長を総重みで正規化した値(0〜1)で、
//        色相がまとまっていれば R≈1（分散0＝澄む）、バラけていれば R≈0（分散1＝濁る）。
//        単液（量が1本だけ）は R=1 で自動的にボーナス0になる＝特例分岐は不要。
//     4. 希釈＝density / turbidity に ×(1 - w) を掛ける（w は MAX_DILUTION で頭打ち）。
//
//   ※2液に縮約しても既存 mixTwoLiquids（短弧補間＋色相差×mixAmount）と完全一致はしないが、
//     N本でより自然・順序非依存になる。承知の上で採用（開発(3)の確定方針）。
// ----------------------------------------------------------------------------
export function mixLiquids(
  liquids: LiquidParams[],
  vols: number[],
  w: number,
): LiquidParams {
  // 総重み（負の量は0扱い）。
  let W = 0;
  for (const v of vols) W += Math.max(v, 0);

  // 重みが無い（全量0）＝空。呼び出し側で空グラス扱いにする前提の中立値を返す。
  if (W <= 0) {
    return { hue: 0, sat: 0, val: 1, density: 0, turbidity: 0 };
  }

  // 各軸を量で加重合計する。色相だけは単位ベクトルに分解して合成する。
  let sx = 0; // Σ w·cosθ
  let sy = 0; // Σ w·sinθ
  let sSat = 0;
  let sVal = 0;
  let sDen = 0;
  let sTur = 0;
  for (let i = 0; i < liquids.length; i++) {
    const wi = Math.max(vols[i] ?? 0, 0);
    if (wi <= 0) continue; // 量0のスロットは寄与なし
    const l = liquids[i];
    const rad = (l.hue * Math.PI) / 180;
    sx += wi * Math.cos(rad);
    sy += wi * Math.sin(rad);
    sSat += wi * l.sat;
    sVal += wi * l.val;
    sDen += wi * l.density;
    sTur += wi * l.turbidity;
  }

  // 1. 加重 circular mean で平均色相（0〜360 に正規化）。
  let hue = (Math.atan2(sy, sx) * 180) / Math.PI;
  hue = ((hue % 360) + 360) % 360;

  // 2. 残りの軸は単純な加重平均。
  const sat = sSat / W;
  const val = sVal / W;
  let density = sDen / W;
  let turbidity = sTur / W;

  // 3. 濁りボーナス＝円周分散(1 - R)。R は合成ベクトル長を総重みで正規化（0〜1）。
  //    色相がバラけているほど（1-R が大きいほど）turbidity を上乗せ。最大量は TURBIDITY_BONUS。
  const R = Math.sqrt(sx * sx + sy * sy) / W; // 0〜1
  const circularVariance = 1 - R; // 0〜1（単液なら R=1 で 0＝ボーナスなし）
  turbidity += TURBIDITY_BONUS * circularVariance;

  // 4. 水による希釈：density / turbidity を ×(1 - w) で減衰（w は MAX_DILUTION で頭打ち）。
  const wc = Math.min(Math.max(w, 0), MAX_DILUTION);
  density *= 1 - wc;
  turbidity *= 1 - wc;

  return {
    hue,
    sat: clamp01(sat),
    val: clamp01(val),
    density: clamp01(density),
    turbidity: clamp01(turbidity),
  };
}

// ----------------------------------------------------------------------------
// ★ HSV（色相・彩度・明度）→ RGB（0〜255）★
//   簡略色エンジンは色を HSV で持つが、3Dの液体マテリアルは RGB を欲しがる
//   （setAppearance(rgb, ...) に渡すため）。ここで HSV を RGB に変換する。
//   ※1液プログラム(liquid-ui.ts)の hsvToRgb と同じ式（彩度・明度も反映）。
// ----------------------------------------------------------------------------
export function hsvToRgb(
  hue: number,
  sat: number,
  val: number,
): { r: number; g: number; b: number } {
  const h = ((hue % 360) + 360) % 360; // 0〜360 に正規化
  const s = clamp01(sat);
  const v = clamp01(val);
  const c = v * s; // 彩度×明度＝色みの強さ
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c; // 全体の底上げ（明度ぶん）
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) {
    r = c;
    g = x;
  } else if (h < 120) {
    r = x;
    g = c;
  } else if (h < 180) {
    g = c;
    b = x;
  } else if (h < 240) {
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}
