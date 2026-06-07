// ============================================================================
// db-to-visual — 「DBの色データ(知覚HSL)」→「visual-engineの3軸(物理寄り)」変換
//   ----------------------------------------------------------------------------
//   ◆この変換が必要な理由（初心者向け解説）
//     材料マスタDBは “人間の見た目の座標” で色を持っている：
//       hue(色相 0〜360) / saturation(彩度 0〜100) / lightness(明度 0〜100)
//       turbidity(濁り 0〜100) / is_transparent(向こうが透けるか)
//     一方 visual-engine の3D液体（cocktail-scene.ts の setLiquidAppearance）は
//     “物理寄りの座標” で受け取る：
//       rgb(0〜255) / density(濃さ＝吸収の強さ 0〜1) / turbidity(濁り＝散乱 0〜1)
//     この2つは別レイヤー。間をつなぐ「橋渡し」がこのファイルの役割。
//
//   ◆役割分担（★重要：ここが設計の肝）
//     density（濃さ＝吸光）と turbidity（濁り＝散乱）は “別の軸” で、別のものが決める：
//       ・density   … 色の濃さ。is_transparent とは無関係に、常に「彩度×暗さ」で算出する。
//                     ジン(彩度0/明度100)は式の結果が自然に最小になる＝特例分岐は要らない。
//       ・turbidity … 向こうが透けるか。これを is_transparent が制御する。
//                     色が濃くても透ける(赤ワイン)と、色が濃くて濁る(牛乳)を分ける軸。
//     これで次の3状態がきれいに表せる：
//       1) 無色透明（ジン）        … density 最小・turbidity 0
//       2) 有色透明（赤ワイン/カルーア/カンパリ）… density 高・turbidity 0（濃いが透ける）
//       3) 不透明 （牛乳/アブサン）  … density 中・turbidity 高
//     ※以前は「is_transparent=true なら density を最小固定」にしていたが、実データでは
//       色付きで透ける酒も is_transparent=true（67/70件が true）。そのため濃い酒まで
//       薄く潰れていた。density を is_transparent から切り離したのが今回の修正点。
//
//   ◆設計上の約束
//     ・この関数は (1a)(1b)(2)(3) すべてで使い回す「変更コストの高い」中核。
//       だから1ファイルに隔離し、画面側にインラインで散らさない。
//     ・厳密な物理式ではなく “軽い実装から始めて、スクショを見ながら係数を直す” 方針。
//       調整するつまみ（係数）は下の「名前付き定数」に全部出してある。
//     ・純粋関数（同じ入力なら必ず同じ出力。DBアクセスや副作用は持たない）。
// ============================================================================

import type { IngredientRow } from './ingredients';

// ----------------------------------------------------------------------------
// ★調整可能パラメータ（スクショを見ながらここを変える）★
//   mixer の MAX_DILUTION / TURBIDITY_BONUS と同じ流儀で、係数を冒頭に集約する。
// ----------------------------------------------------------------------------
const DENSITY_MIN = 0.08; // densityの下限。彩度0・明度100(=ジン等)がこの値になる＝薄く透き通る
const DENSITY_MAX = 1.0; // densityの上限（彩度MAX・明度0で到達）
const SAT_WEIGHT = 0.6; // density算出における「彩度の高さ」の重み
const DARK_WEIGHT = 0.4; // density算出における「明度の低さ(暗さ)」の重み
const TURBIDITY_SCALE = 1.0; // turbidity(0〜100→0〜1)に掛ける係数
// ※ SAT_WEIGHT + DARK_WEIGHT = 1.0 を保つこと（raw が 0〜1 に収まる前提のため）。

// 変換関数の出力の型（setLiquidAppearance にそのまま3引数で渡せる形）。
export interface LiquidAppearance {
  rgb: { r: number; g: number; b: number }; // 各 0〜255
  density: number; // 0〜1
  turbidity: number; // 0〜1
}

// ----------------------------------------------------------------------------
// HSL → RGB 標準変換（このファイル内に独立実装）
//   ※ liquid-ui.ts の HSV→RGB は流用しない。HSV と HSL は別物（明度の定義が違う）で、
//     かつ DB→変換層が UI 層へ依存しないようにするため、ここに自前で持つ。
//
//   入力：h 色相 0〜360 / s 彩度 0〜100 / l 明度 0〜100
//   出力：{ r, g, b } 各 0〜255
//
//   〔考え方〕HSLは「色相の純色を、彩度で灰色へ寄せ、明度で白黒へ寄せた」モデル。
//     c = 色みの強さ（彩度と明度から決まる帯の幅）
//     x = 色相内での中間成分
//     m = 全体の底上げ（明度ぶんのオフセット）
// ----------------------------------------------------------------------------
export function hslToRgb(
  h: number,
  s: number,
  l: number,
): { r: number; g: number; b: number } {
  // 0〜100 で来る彩度・明度を 0〜1 へ。色相は 0〜360 のまま 6分割で扱う。
  const sn = Math.min(Math.max(s, 0), 100) / 100;
  const ln = Math.min(Math.max(l, 0), 100) / 100;
  // 色相は360で一周。負やはみ出しも安全に丸める。
  const hh = ((h % 360) + 360) % 360;

  const c = (1 - Math.abs(2 * ln - 1)) * sn; // 色みの強さ（明度0や1で0になる＝白黒）
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1)); // 色相内の中間成分
  const m = ln - c / 2; // 全体の底上げ

  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 60) {
    r = c;
    g = x;
  } else if (hh < 120) {
    r = x;
    g = c;
  } else if (hh < 180) {
    g = c;
    b = x;
  } else if (hh < 240) {
    g = x;
    b = c;
  } else if (hh < 300) {
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

// ----------------------------------------------------------------------------
// ★中心関数★ DBの1行 → 3D液体の見た目(3軸)
//   row（色系フィールド）を受け取り、{ rgb, density, turbidity } を返す純粋関数。
//   呼び出し側は setLiquidAppearance(out.rgb, out.density, out.turbidity) とするだけ。
//
//   〔軸ごとの決め方〕（上の「役割分担」の実装）
//     ・rgb      … 常に HSL→RGB で算出（is_transparent に関わらず）。
//     ・density  … 常に「彩度×暗さ」で算出（is_transparent に関わらず）。
//                  彩度が高く・明度が低いほど濃い。ジン(彩度0/明度100)は raw≈0 で
//                  自動的に DENSITY_MIN になる＝透明用の特例分岐は不要。
//     ・turbidity… is_transparent が制御する：
//                    true  → 0（向こうが透ける。色が濃くても散乱しない＝赤ワイン等）
//                    false → DBの turbidity 値を使う（牛乳・アブサンが白濁・不透明に）
//                    null  → 0（固体＝塩・ブラックペッパー等。液体として描く対象では
//                            ないが、確定方針(b)で全件プルダウンに出すため、落とさず
//                            濁らせもせず無害に扱う。各フィールドは ?? でガード済み）
// ----------------------------------------------------------------------------
export function hslToLiquidAppearance(row: IngredientRow): LiquidAppearance {
  // 色：HSL→RGB(0〜255)。is_transparent に関わらず常に算出。
  //   null ガード：色相0・彩度0・明度100（＝白）を既定にする。
  const rgb = hslToRgb(row.hue ?? 0, row.saturation ?? 0, row.lightness ?? 100);

  // density（濃さ＝吸光）は is_transparent から切り離し、常に「彩度×暗さ」で算出する。
  //   → ジン(彩度0/明度100)は raw≈0 で自動的に最小(DENSITY_MIN)になる＝特例分岐は不要。
  //   → 赤ワイン・カルーア(彩度高/明度低)はちゃんと濃い density になる。
  const sat01 = (row.saturation ?? 0) / 100; // 彩度の高さ 0〜1
  const dark01 = (100 - (row.lightness ?? 100)) / 100; // 明度の低さ(暗さ) 0〜1
  const raw = SAT_WEIGHT * sat01 + DARK_WEIGHT * dark01; // 0〜1
  let density = DENSITY_MIN + raw * (DENSITY_MAX - DENSITY_MIN); // DENSITY_MIN〜DENSITY_MAX

  // turbidity（濁り＝散乱＝向こうが見えるか）は is_transparent が制御する。
  //   ここが「色付きでも透ける(赤ワイン)」と「色付きで濁る(牛乳)」を分ける軸。
  let turbidity: number;
  if (row.is_transparent === true) {
    // 透ける：色が濃くても向こうは見える。散乱なし。
    turbidity = 0;
  } else if (row.is_transparent === false) {
    // 濁る：牛乳・アブサン。DBの turbidity 値を使う。
    turbidity = ((row.turbidity ?? 0) / 100) * TURBIDITY_SCALE;
  } else {
    // null（固体＝塩・ブラックペッパー等）：フォールバック。落とさない・濁らせない。
    turbidity = 0;
  }

  // 念のため最終ガード（係数調整で範囲外に出ても setLiquidAppearance 側でも clamp されるが、
  // ここでも 0〜1 に収めておくと意図が明確）。
  density = Math.min(Math.max(density, 0), 1);
  turbidity = Math.min(Math.max(turbidity, 0), 1);

  return { rgb, density, turbidity };
}
