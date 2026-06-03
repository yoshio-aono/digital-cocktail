# プロジェクト：デジタルカクテル「色エンジン」開発

## これは何
カクテルの材料を混ぜたときの色を計算する「色エンジン」をTypeScriptで作る。
最終的にはNext.js/Vercelのフロントに載せるが、まずは色エンジンの純粋ロジックを
Vite + vanilla-ts 環境で固める。

## リポジトリ構成（重要）
このリポジトリ（digital-cocktail）は、色エンジンと味エンジンを将来統合する
モノレポ的な構成にする。色と味はサブフォルダで分ける：
  digital-cocktail/
  ├── color-engine/   ← 今回作るのはここ
  └── taste-engine/   ← 将来作る（今は不要）
今回の作業はすべて color-engine/ の中で行うこと。
（Viteプロジェクトも color-engine/ の中に展開する）

## 確定済みの設計判断
- 言語：TypeScript。色エンジンはフロントに依存しない純粋関数群として作る
- 環境：Vite + vanilla-ts（Reactなし。ロジックを固めてから後でNext.jsへ移植）
- 処理フローの順序（重要・仕様書から一部変更あり）：
  1. 【前処理・物理】技法に応じて水の体積を追加（無色透明・pH7.0をitemsに加える）
  2. 【化学】薄まった状態で暫定pHを算出 → reactive材料のRGBをLUTで書き換え
  3. 【光学】ランベルト・ベールの法則で減法混色
  4. 【後処理・物理】SHAKE時のみ明度+10〜15%、opacityダウン
  ※加水は必ずpH確定の「前」に効かせる（薄まったpHで変色させるため）

## 数理モデル（仕様書より）
- ランベルト・ベール：RGB(0-1正規化)→吸光度 A = -log10(T) →
  A_total = Σ(A_n × 体積比率) → T = 10^(-A_total) → RGB
  ※T=0 で log が発散するので 0 は微小値（1/255 等）にクランプ必須
- pH：液量ベースの単純平均で全体pHを算出
- 加水率：STIR/BUILD 15-20%、SHAKE 20-25%

## 目指すファイル構成（color-engine/ 内）
color-engine/
└── src/
    ├── engine/
    │   ├── types.ts        … 材料・レシピの型定義
    │   ├── ingredients.ts  … 材料マスタ（最低3-4種：バタフライピー/レモン/ウォッカ/シロップ）
    │   └── optics.ts       … ランベルト・ベール混色
    └── main.ts             … 色を画面に並べる検証ビュー

## まず最初にやってほしいこと（ステップ0+1）
1. color-engine/ フォルダを作り、その中に
   `npm create vite@latest . -- --template vanilla-ts` で展開し npm install
2. types.ts に材料(rgb, opacity, pH, reactive_type)とレシピ(items, technique)の型を定義
3. ingredients.ts にテスト用材料を3-4種用意
4. optics.ts にランベルト・ベール混色のロジックを実装（pH・加水はまだ入れない）
5. main.ts でレシピを数件、計算結果の色をブラウザに並べて表示
6. この段階で「混ぜると減法混色らしく暗くなる」ことを目視確認できる状態にする

pHと加水（化学・物理レイヤー）はこのあと別ステップで追加するので、
まずは光学混色の核だけを動かすこと。
