# 引き継ぎ書 — visual-engine（2026-06-08 時点）

次のセッションはまずこのファイルを読んでください。直近の作業内容・本番環境・確定事項・次にやることをまとめています。

---

## 1. いまどこまで終わっているか

`visual-engine`（Three.js + Vite + vanilla-ts、Vercelデプロイ）の進捗：

| 機能 | 状態 |
|---|---|
| 3D液体ビューアー（脚付きマティーニグラス・環境マップ・bloom・背景・被写界深度DOF） | ✅ 完了 |
| インタラクティブ液体UI（色相・濃さ・濁りの3軸リアルタイム操作、濁り＝SSS近似） | ✅ 完了 |
| 2液混合ビューアー（mixer） | ✅ 完了（※色計算は簡略版） |
| **材料図鑑（material-viewer）= Supabase DB接続 → 3D液体 + 味覚レーダー** | ✅ **完了・本番稼働確認済み** |

直近のこのセッションでやったのは、いちばん下の **材料図鑑** の実装〜本番公開〜微修正です。

---

## 2. 本番（Vercel + Supabase）環境

- Vercelプロジェクト名：**digital-cocktail**
- 公開URL
  - `https://digital-cocktail.vercel.app/` … 2液 mixer（ルート）
  - `https://digital-cocktail.vercel.app/single.html` … 1液ビューアー
  - `https://digital-cocktail.vercel.app/material-viewer.html` … **材料図鑑（今回のもの）**
- Supabase Project URL：`https://bfdvqydmraqzviesjdcr.supabase.co`（材料 70件、`ingredients` テーブル）

### 環境変数（ハマりポイント・重要）
- ローカルは `visual-engine/.env.local`（**gitignore済み・コミット禁止**）に実キーを置く。
- `.env.local.example` はプレースホルダのみコミット済み。
- `VITE_*` 変数は **ビルド時にコードへ焼き込まれる**。そのため **Vercel側の Environment Variables にも登録が必須**。
  - `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` の2つ。
  - 未登録だと本番で `createClient('','')` が `supabaseUrl is required` 例外を投げ、**画面が真っ黒（UIすら出ない）**になる。← このセッションで実際に踏んで解決済み。
  - **変数を追加・変更したら必ず Redeploy**（既存ビルドには反映されない）。
  - 機密変数は Development 環境には登録不可（Production + Preview でOK）。
  - **service_role キーは絶対に置かない**（anon キーだけ。anon はフロント露出OK、RLSでSELECTのみ）。

---

## 3. 今回追加・変更したファイル

```
visual-engine/
├ material-viewer.html              ← 新エントリのHTML
├ vite.config.ts                    ← material エントリを1つ追加（既存2つは無改変）
├ .env.local.example                ← プレースホルダ（コミット可）
├ .gitignore                        ← .env 系を除外追加
└ src/
   ├ material-viewer.ts             ← 図鑑UI本体（カテゴリ絞り込み＋情報パネル＋味覚レーダー）
   └ db/
      ├ supabase-client.ts          ← Supabase接続を1か所に隔離
      ├ ingredients.ts              ← 型定義＋取得関数（色列＋味7軸列）
      └ db-to-visual.ts             ← ★DB(知覚HSL)→3D(物理3軸)変換の純粋関数
```

関連コミット：`019afe8`（図鑑一式）/ `33048bc`（アコーディオン初期状態を閉に）。すべて origin/main にpush済み。

---

## 4. 触ってはいけない確定事項

- **`src/db/db-to-visual.ts` の設計は確定。今後変更しない。**
  - `density` は `is_transparent` と無関係に常に「彩度×暗さ」で算出（`SAT_WEIGHT=0.6` / `DARK_WEIGHT=0.4`、`DENSITY_MIN=0.08` / `MAX=1.0`）。ジン（彩度0/明度100）は自動的に最小になる。
  - `is_transparent` は **turbidity のみ**を制御（true→0 / false→DB値 / null(固体)→0）。
  - ※当初「is_transparent=true→density最小固定」だったが、70件中67件がtrueで赤ワイン等まで薄く潰れるバグがあり、青野さんの設計修正で上記に確定した経緯がある。
- **`src/scene/cocktail-scene.ts` は無改変**（3D描画の唯一の出どころ。`setLiquidAppearance(rgb, density, turbidity)` 経由で液体の見た目を反映する）。
- **既存エントリ `index.html`（2液mixer）/ `single.html`（1液）は無改変**で並存させる。

### 開発の進め方ルール（プロジェクト共通）
- 設計はチャット側（青野さん）が決める。Claude Code は実装＋調査を担当。
- **確定事項は勝手に変えない。確定事項どうしが既存コードと矛盾したら、実装を止めて報告する。**

---

## 5. 次にやること（次セッションの議題）

ロードマップ上、見栄え系（環境マップ・bloom・グラス造形・背景DOF）はすでに完了済み。残りの有力候補：

1. **【有力】ステップ2：色エンジン接続**
   現在 mixer の色計算は簡略版 `src/mixer/mix-color.ts`。これを **完成済みの `color-engine`（`cocktail.ts` の `mixCocktail`＝加水→pH変色→ランベルト・ベール減法混色→SHAKE補正の4レイヤー）** の出力に差し替える。新規ロジックは不要で、配線が中心。
2. ステップ8：SHAKE濁り・SSS（濁りSSS近似は一部実装済み）。
3. ステップ9：氷・泡などの小物。

### 新しい方向の可能性
今回 **材料マスタDB接続** が入ったので、「**DBから材料を2つ選んで混ぜる（図鑑 × mixer の連携）**」という方向も考えられる。

→ **次セッションの冒頭で、まず青野さんと「次に何をやるか」の方向性を決めること。** 上記はあくまで候補。

---

## 6. 検証まわりの注意（既知の制約）

- このアプリは rAF で毎フレーム描画し続けるため、Claude側の `preview_screenshot` や WebGL canvasの `readPixels` はタイムアウトしがち。
- 数値検証は `preview_eval` でDOM状態や変換出力を読む／2D canvas（レーダー）は `getImageData` で確認、という代替手段を使う。
- 見た目の最終確認は青野さんがローカル／本番で Ctrl+Shift+R（ハードリロード）で実施。

詳細な開発履歴は自動メモリ `project_visual_engine_roadmap.md` 側に蓄積されている。
