import { defineConfig } from 'vite';

// ----------------------------------------------------------------------------
// Vite 設定 — 複数HTMLエントリ
//   ルート（index.html）＝2液混合ビューアー(mixer)。1液ビューアーは single.html。
//     ・dev:  http://localhost:5173/            … 2液 mixer
//             http://localhost:5173/single.html … 1液ビューアー
//     ・build: 両方の HTML がそれぞれ別ページとしてビルドされる
//   入力パスはプロジェクトルート（このファイルの場所）からの相対で指定する。
//   ※Vercel ではルート(/)＝index.html がそのまま mixer になる（リライト不要）。
// ----------------------------------------------------------------------------
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html', // ルート＝2液 mixer
        single: 'single.html', // 1液ビューアー（旧 index.html）
      },
    },
  },
});
