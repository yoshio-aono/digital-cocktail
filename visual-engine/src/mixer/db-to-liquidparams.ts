// ============================================================================
// db-to-liquidparams — 「DBの材料1件(IngredientRow)」→「mixer の混色入力(LiquidParams)」
//   ----------------------------------------------------------------------------
//   ◆このヘルパーが必要な理由（STEP2a で確定した橋渡し）
//     ・mixer の混色エンジン mix-color.ts の mixTwoLiquids は、色を HSV
//       （LiquidParams = {hue, sat, val, density, turbidity}）で受け取る。
//     ・一方 DB の材料は色を HSL（hue 0〜360 / saturation 0〜100 / lightness 0〜100）で
//       持つ。確定済み変換 db-to-visual.ts の hslToLiquidAppearance は rgb/density/turbidity
//       を返すが、HSV（特に sat/val）は返さない。
//     ・そこで「色3軸は row の H,S,L を直読みして HSL→HSV 変換」「density/turbidity は
//       確定済み hslToLiquidAppearance から借りる」というハイブリッドで LiquidParams を作る。
//
//   ◆無改変の原則
//     ・mix-color.ts も db-to-visual.ts も触らない。橋渡しはこの新エントリ専用ファイルに閉じる。
//     ・純粋関数（同じ row なら必ず同じ出力。DBアクセスや副作用なし）。
//
//   ◆HSL→HSV 変換の式（色相 h は両者共通なので不変）
//       sl, l を 0〜1 にしたとき
//         v  = l + sl * min(l, 1 - l)      … HSVの明度
//         sv = v === 0 ? 0 : 2 * (1 - l/v) … HSVの彩度
//     ※row.saturation / row.lightness は HSL基準(0〜100)。HSVと混同しないこと。
// ============================================================================

import type { IngredientRow } from '../db/ingredients';
import { hslToLiquidAppearance, type LiquidAppearance } from '../db/db-to-visual';
import type { LiquidParams } from './mix-color';

// 橋渡しの戻り値。
//   ・liquid     … mixTwoLiquids に渡す HSV ベースの混色入力。
//   ・appearance … 小グラスで「混合前の素の色」をそのまま見せるための rgb/density/turbidity
//                  （確定済み db-to-visual の出力。HSV往復を経ない元の見た目）。
export interface RowLiquid {
  liquid: LiquidParams;
  appearance: LiquidAppearance;
}

// DBの1行 → { liquid(HSV), appearance(rgb系) }。
export function rowToLiquidParams(row: IngredientRow): RowLiquid {
  // 色相は HSL/HSV 共通でそのまま。彩度・明度は HSL(0〜100) を 0〜1 にしてから HSV へ。
  const h = row.hue ?? 0;
  const sl = (row.saturation ?? 0) / 100; // HSL の彩度 0〜1
  const l = (row.lightness ?? 100) / 100; // HSL の明度 0〜1

  // HSL → HSV（色相 h は不変）。
  const v = l + sl * Math.min(l, 1 - l); // HSV 明度
  const sv = v === 0 ? 0 : 2 * (1 - l / v); // HSV 彩度

  // density / turbidity は確定済みロジックから借りる（二重定義を避ける）。
  const appearance = hslToLiquidAppearance(row);

  const liquid: LiquidParams = {
    hue: h,
    sat: sv,
    val: v,
    density: appearance.density,
    turbidity: appearance.turbidity,
  };

  return { liquid, appearance };
}
