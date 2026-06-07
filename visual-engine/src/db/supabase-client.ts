// ============================================================================
// Supabase クライアント — DB接続を「1か所だけ」に隔離するファイル
//   ・このシステムで Supabase につなぐ口は、必ずこのファイルが作る1個だけにする。
//     こうしておくと、接続設定（URL/キー/将来のオプション）を変えたいとき、
//     ここ1か所を直せば全画面に反映される（あちこちに createClient を散らさない）。
//   ・実際の「材料データを取ってくる関数」は db/ingredients.ts 側に置く。
//     このファイルは “つなぐだけ” の役割に専念する。
//
//   ◆環境変数について（Vite のしくみ）
//     接続に必要な URL とキーは、コードに直書きせず .env.local から読む。
//     Vite は「VITE_」で始まる変数だけを import.meta.env 経由でフロントへ渡す。
//     実キーは .env.local（gitignore 済み）に入れ、GitHub には上げない。
//     anon キーはフロントに出てOK（DB側のRLSでSELECTのみ許可されているため）。
// ============================================================================

import { createClient } from '@supabase/supabase-js';

// --- .env.local から接続情報を読み込む -------------------------------------
//   未設定（空文字）のまま起動されたときに、原因が分かるエラーを出したいので
//   ここで一度受け取って中身をチェックする。
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// --- 設定漏れの早期検知 -----------------------------------------------------
//   値が無いと createClient は一見成功するが、実際の取得時に意味不明なエラーに
//   なって原因が追いにくい。先にここで気づけるよう、分かりやすい文言で警告する。
//   （アプリは止めず警告だけ。値を入れて再起動すれば直る、と伝える。）
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.warn(
    '[supabase] 接続情報が未設定です。visual-engine/.env.local に ' +
      'VITE_SUPABASE_URL と VITE_SUPABASE_ANON_KEY を入れて、開発サーバを再起動してください。',
  );
}

// --- クライアント本体（このアプリで唯一の Supabase 接続口）-----------------
//   他のファイルはここから supabase を import して使う。
export const supabase = createClient(SUPABASE_URL ?? '', SUPABASE_ANON_KEY ?? '');
