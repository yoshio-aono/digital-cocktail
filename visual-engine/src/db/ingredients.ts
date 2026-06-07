// ============================================================================
// 材料データ取得層 — Supabase の ingredients テーブルから材料を読む関数群
//   ・DBへ「何を・どう問い合わせるか」をここにまとめる（接続そのものは
//     supabase-client.ts が担当。役割を分けておくと後で差し替えやすい）。
//   ・今回(1a)は最小2つだけ：1件取得 と 一覧（選択肢用）取得。
//     これらは今後 (1b)(2)(3) でもそのまま使い回す前提なので、きれいに隔離する。
// ============================================================================

import { supabase } from './supabase-client';

// ----------------------------------------------------------------------------
// 材料1件の型（DBの列に対応）
//   今回の主役は「色系」の列。味系(sweetness 等)は今回読まないので含めない。
//   ※ smallint 列(hue 等)は number、is_transparent は boolean だが、固体(塩)など
//     値が無い行もあるため null を許容する（DB側が nullable）。
// ----------------------------------------------------------------------------
export interface IngredientRow {
  slug: string; // 一意キー（表示対象の指定に使う）
  name_ja: string; // 表示名（日本語）
  name_en: string | null; // 表示名（英語）
  category: string | null; // 大分類（(1b)で使う。今回は取得だけ）
  subcategory: string | null; // 小分類（同上）
  description: string | null; // 説明（(1b)で使う）
  hue: number | null; // 色相 0〜360
  saturation: number | null; // 彩度 0〜100
  lightness: number | null; // 明度 0〜100
  turbidity: number | null; // 濁り 0〜100（0=透明, 100=不透明）
  is_transparent: boolean | null; // 透明フラグ（白と透明を分ける唯一の判定材料）
  color_source: string | null; // 色の出所（今回のロジックでは未使用）
  // --- 味系（味覚レーダー用。各 0〜10）---
  //   五味（甘味・酸味・苦味・塩味・旨味）＋ 渋味・粘度 の7軸。
  //   ※色とは別レイヤー。図鑑の味覚情報パネルで使う。固体等で値が無い行は null 許容。
  sweetness: number | null; // 甘味
  sourness: number | null; // 酸味
  bitterness: number | null; // 苦味
  saltiness: number | null; // 塩味
  umami: number | null; // 旨味
  astringency: number | null; // 渋味
  viscosity: number | null; // 粘度
}

// プルダウン（選択肢）用の軽量な型。一覧では色データまでは要らないので、
// 表示と取得に必要な最小限の列だけを持つ。
export interface IngredientOption {
  slug: string;
  name_ja: string;
  category: string | null;
}

// 上の型と取り違えないよう、SELECT する列名を1か所で定義しておく。
const INGREDIENT_COLUMNS =
  'slug,name_ja,name_en,category,subcategory,description,hue,saturation,lightness,turbidity,is_transparent,color_source,' +
  'sweetness,sourness,bitterness,saltiness,umami,astringency,viscosity';

// ----------------------------------------------------------------------------
// 1件取得（今回の主役）
//   slug を指定して、その材料1件の色データ込みの行を返す。
//   見つからない／エラー時は null を返す（呼び出し側で「未選択」と同じ扱いにできる）。
// ----------------------------------------------------------------------------
export async function fetchIngredientBySlug(
  slug: string,
): Promise<IngredientRow | null> {
  const { data, error } = await supabase
    .from('ingredients')
    .select(INGREDIENT_COLUMNS)
    .eq('slug', slug)
    .single(); // slug は一意なので1件だけ返るはず

  if (error) {
    console.error('[ingredients] fetchIngredientBySlug 失敗:', error.message);
    return null;
  }
  return data as unknown as IngredientRow;
}

// ----------------------------------------------------------------------------
// 一覧取得（プルダウンの選択肢用・軽量）
//   slug / name_ja / category だけを名前順で取得する。
//   エラー時は空配列を返す（画面側は「選択肢ゼロ」として描けばよい）。
// ----------------------------------------------------------------------------
export async function fetchIngredientSlugs(): Promise<IngredientOption[]> {
  const { data, error } = await supabase
    .from('ingredients')
    .select('slug,name_ja,category')
    .order('name_ja', { ascending: true });

  if (error) {
    console.error('[ingredients] fetchIngredientSlugs 失敗:', error.message);
    return [];
  }
  return (data ?? []) as unknown as IngredientOption[];
}
