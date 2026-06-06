import { defineConfig } from 'vite';

// ----------------------------------------------------------------------------
// Vite 設定 — 複数HTMLエントリ
//   既存の index.html（カクテル3D本体）に加えて、mixer.html（2液混合ビューアー）を
//   独立したエントリとして追加する。これにより：
//     ・dev:  http://localhost:5173/         … 既存の本体
//             http://localhost:5173/mixer.html … 2液混合ビューアー
//     ・build: 両方の HTML がそれぞれ別ページとしてビルドされる
//   入力パスはプロジェクトルート（このファイルの場所）からの相対で指定する。
// ----------------------------------------------------------------------------
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html', // 既存の本体（無改変）
        mixer: 'mixer.html', // 2液混合ビューアー（新規）
      },
    },
  },
});
