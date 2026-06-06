// ============================================================================
// インタラクティブ液体UI（PC版）
//   画面の左上に小さなパネルを置き、液体の「色」と「濃さ」を手で操作する。
//   UIライブラリは使わず、HTML + CSS + canvas だけで作る（外部依存ゼロ）。
//
//   このファイルは「見た目を作って値を集める」だけの担当。
//   実際に3Dの液体へ反映するのは main.ts 側の setLiquidAppearance()。
//   ここでは値が変わるたびに onChange(rgb, density) を呼ぶだけにしてある。
//   → 将来 color-engine（mixCocktail）の出力をつなぐときは、この UI を外して
//     mixCocktail() の結果をそのまま setLiquidAppearance() に渡せばよい。
// ============================================================================

// UI を作るときに渡してもらう設定の型。
export interface LiquidUIOptions {
  // 起動時の色（0〜255）。マーカーの初期位置を決めるのに使う。
  initialRGB: { r: number; g: number; b: number };
  // 起動時の濃さ（0.0〜1.0）。スライダーの初期位置に使う。
  initialDensity: number;
  // 起動時の濁り（0.0〜1.0）。スライダーの初期位置に使う。
  initialTurbidity: number;
  // 色・濃さ・濁りのどれかが変わるたびに呼ばれるコールバック。ここで3Dへ反映する。
  onChange: (
    rgb: { r: number; g: number; b: number },
    density: number,
    turbidity: number,
  ) => void;
}

// --- 色変換ヘルパー ---------------------------------------------------------

// HSV（色相 h:0〜360 / 彩度 s:0〜1 / 明度 v:0〜1）→ RGB（各0〜255）
//   カラーピッカーは内部的に HSV で持つほうが直感的（色相バー＋四角）なので、
//   3Dに渡す直前に RGB へ変換する。
function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
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

// RGB（各0〜255）→ HSV。起動時に initialRGB をマーカー位置（h,s,v）へ戻すのに使う。
function rgbToHsv(
  r: number,
  g: number,
  b: number,
): { h: number; s: number; v: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  const v = max;
  return { h, s, v };
}

// ============================================================================
// UI 本体を組み立てる関数。main.ts から1回だけ呼ぶ。
// ============================================================================
export function createLiquidUI(options: LiquidUIOptions): void {
  // 起動時の色を HSV に変換して、ピッカーの状態（state）の初期値にする。
  const initHsv = rgbToHsv(
    options.initialRGB.r,
    options.initialRGB.g,
    options.initialRGB.b,
  );

  // --- このUIが保持する状態 ---------------------------------------------
  const state = {
    h: initHsv.h, // 色相 0〜360
    s: initHsv.s, // 彩度 0〜1
    v: initHsv.v, // 明度 0〜1
    density: options.initialDensity, // 濃さ 0〜1
    turbidity: options.initialTurbidity, // 濁り 0〜1
  };

  // 各キャンバスの寸法（PC向けに見やすいサイズ）
  const SV_SIZE = 180; // 彩度×明度の正方形の一辺(px)
  const HUE_W = 180; // 色相バーの幅(px)
  const HUE_H = 16; // 色相バーの高さ(px)

  // ------------------------------------------------------------------
  // 1) パネルの外枠（半透明の黒い箱）
  // ------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText = [
    'position:fixed',
    'top:16px',
    'right:16px',
    'z-index:10', // 3Dキャンバスより手前に出す
    'padding:14px',
    'border-radius:12px',
    'background:rgba(20,20,26,0.82)', // 半透明の暗い背景
    'backdrop-filter:blur(6px)', // 背後をすりガラス風にぼかす
    'box-shadow:0 6px 24px rgba(0,0,0,0.45)',
    'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
    'color:#e8e8ee',
    'user-select:none', // ドラッグ時に文字が選択されないように
    'width:' + SV_SIZE + 'px',
  ].join(';');

  // タイトル
  const title = document.createElement('div');
  title.textContent = '液体カラー';
  title.style.cssText =
    'font-size:13px;font-weight:600;margin-bottom:10px;letter-spacing:0.04em;';
  panel.appendChild(title);

  // ------------------------------------------------------------------
  // 2) 彩度×明度の正方形（メインのカラーピッカー）
  //    横軸＝彩度(左0→右1) / 縦軸＝明度(上1→下0)
  // ------------------------------------------------------------------
  const svCanvas = document.createElement('canvas');
  svCanvas.width = SV_SIZE;
  svCanvas.height = SV_SIZE;
  svCanvas.style.cssText =
    'display:block;border-radius:8px;cursor:crosshair;touch-action:none;';
  panel.appendChild(svCanvas);
  const svCtx = svCanvas.getContext('2d')!;

  // ------------------------------------------------------------------
  // 3) 色相バー（虹色の横棒。クリック位置で色相を選ぶ）
  // ------------------------------------------------------------------
  const hueCanvas = document.createElement('canvas');
  hueCanvas.width = HUE_W;
  hueCanvas.height = HUE_H;
  hueCanvas.style.cssText =
    'display:block;margin-top:10px;border-radius:6px;cursor:pointer;touch-action:none;';
  panel.appendChild(hueCanvas);
  const hueCtx = hueCanvas.getContext('2d')!;

  // ------------------------------------------------------------------
  // 4) 濃さスライダー
  // ------------------------------------------------------------------
  const densityLabel = document.createElement('div');
  densityLabel.textContent = '濃さ（薄い ⇔ 濃い）';
  densityLabel.style.cssText = 'font-size:12px;margin:12px 0 4px;';
  panel.appendChild(densityLabel);

  const densitySlider = document.createElement('input');
  densitySlider.type = 'range';
  densitySlider.min = '0';
  densitySlider.max = '100';
  densitySlider.value = String(Math.round(state.density * 100));
  densitySlider.style.cssText = 'width:100%;cursor:pointer;';
  panel.appendChild(densitySlider);

  // ------------------------------------------------------------------
  // 4.5) 濁りスライダー（澄んだ ⇔ 乳白）
  //   0=透き通った透明 / 1=ミルクのように白く濁って不透明。
  // ------------------------------------------------------------------
  const turbidityLabel = document.createElement('div');
  turbidityLabel.textContent = '濁り（澄んだ ⇔ 乳白）';
  turbidityLabel.style.cssText = 'font-size:12px;margin:12px 0 4px;';
  panel.appendChild(turbidityLabel);

  const turbiditySlider = document.createElement('input');
  turbiditySlider.type = 'range';
  turbiditySlider.min = '0';
  turbiditySlider.max = '100';
  turbiditySlider.value = String(Math.round(state.turbidity * 100));
  turbiditySlider.style.cssText = 'width:100%;cursor:pointer;';
  panel.appendChild(turbiditySlider);

  // ------------------------------------------------------------------
  // 5) 現在値の表示（RGB / HSV / 濃さ）
  //    将来ここは mixCocktail() の出力に置き換わる、という確認用の窓。
  // ------------------------------------------------------------------
  const readout = document.createElement('div');
  readout.style.cssText =
    'font-size:11px;line-height:1.6;margin-top:10px;font-family:ui-monospace,monospace;color:#b9b9c6;';
  panel.appendChild(readout);

  document.body.appendChild(panel);

  // ------------------------------------------------------------------
  // 描画：彩度×明度の正方形を、現在の色相に合わせて塗り直す
  // ------------------------------------------------------------------
  function drawSV(): void {
    // (a) まず現在の色相のベタ塗り（彩度・明度MAXの純色）
    const pure = hsvToRgb(state.h, 1, 1);
    svCtx.fillStyle = `rgb(${pure.r},${pure.g},${pure.b})`;
    svCtx.fillRect(0, 0, SV_SIZE, SV_SIZE);

    // (b) 左→右で白から透明へ（左端を彩度0＝白っぽく）
    const whiteGrad = svCtx.createLinearGradient(0, 0, SV_SIZE, 0);
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)');
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)');
    svCtx.fillStyle = whiteGrad;
    svCtx.fillRect(0, 0, SV_SIZE, SV_SIZE);

    // (c) 上→下で透明から黒へ（下端を明度0＝黒く）
    const blackGrad = svCtx.createLinearGradient(0, 0, 0, SV_SIZE);
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)');
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)');
    svCtx.fillStyle = blackGrad;
    svCtx.fillRect(0, 0, SV_SIZE, SV_SIZE);

    // (d) 現在の選択位置に丸マーカーを描く
    const mx = state.s * SV_SIZE; // 彩度→X
    const my = (1 - state.v) * SV_SIZE; // 明度→Y（上が明るい）
    svCtx.beginPath();
    svCtx.arc(mx, my, 6, 0, Math.PI * 2);
    svCtx.strokeStyle = '#ffffff';
    svCtx.lineWidth = 2;
    svCtx.stroke();
    svCtx.beginPath();
    svCtx.arc(mx, my, 7, 0, Math.PI * 2);
    svCtx.strokeStyle = 'rgba(0,0,0,0.6)';
    svCtx.lineWidth = 1;
    svCtx.stroke();
  }

  // ------------------------------------------------------------------
  // 描画：色相バー（虹）＋ 現在の色相位置に縦線マーカー
  // ------------------------------------------------------------------
  function drawHue(): void {
    const grad = hueCtx.createLinearGradient(0, 0, HUE_W, 0);
    for (let i = 0; i <= 6; i++) {
      const c = hsvToRgb((i / 6) * 360, 1, 1);
      grad.addColorStop(i / 6, `rgb(${c.r},${c.g},${c.b})`);
    }
    hueCtx.fillStyle = grad;
    hueCtx.fillRect(0, 0, HUE_W, HUE_H);

    // 現在の色相位置に縦線マーカー
    const hx = (state.h / 360) * HUE_W;
    hueCtx.fillStyle = '#ffffff';
    hueCtx.fillRect(hx - 1.5, 0, 3, HUE_H);
    hueCtx.strokeStyle = 'rgba(0,0,0,0.6)';
    hueCtx.lineWidth = 1;
    hueCtx.strokeRect(hx - 1.5, 0, 3, HUE_H);
  }

  // ------------------------------------------------------------------
  // 現在値から RGB を作り、表示更新＋ onChange 通知＋ピッカー再描画をまとめて行う
  // ------------------------------------------------------------------
  function emit(): void {
    const rgb = hsvToRgb(state.h, state.s, state.v);
    // 値表示を更新
    readout.innerHTML =
      `RGB&nbsp;&nbsp;${rgb.r}, ${rgb.g}, ${rgb.b}<br>` +
      `HSV&nbsp;&nbsp;${Math.round(state.h)}°, ${Math.round(
        state.s * 100,
      )}%, ${Math.round(state.v * 100)}%<br>` +
      `濃さ&nbsp;&nbsp;${Math.round(state.density * 100)}%<br>` +
      `濁り&nbsp;&nbsp;${Math.round(state.turbidity * 100)}%`;
    // 3Dへ反映（main.ts の setLiquidAppearance が呼ばれる）
    options.onChange(rgb, state.density, state.turbidity);
    // ピッカーを描き直す（マーカー位置や色相が変わるため）
    drawSV();
    drawHue();
  }

  // ------------------------------------------------------------------
  // マウス操作：正方形（彩度×明度）
  //   押している間ドラッグで連続的に選べるようにする。
  // ------------------------------------------------------------------
  function pickSV(ev: PointerEvent): void {
    const rect = svCanvas.getBoundingClientRect();
    // canvas 内のローカル座標へ。0〜SV_SIZE にクランプ。
    const x = Math.min(Math.max(ev.clientX - rect.left, 0), SV_SIZE);
    const y = Math.min(Math.max(ev.clientY - rect.top, 0), SV_SIZE);
    state.s = x / SV_SIZE; // X→彩度
    state.v = 1 - y / SV_SIZE; // Y→明度（上が明るい）
    emit();
  }
  svCanvas.addEventListener('pointerdown', (ev) => {
    svCanvas.setPointerCapture(ev.pointerId); // 枠外へ出てもドラッグ追従
    pickSV(ev);
  });
  svCanvas.addEventListener('pointermove', (ev) => {
    // ボタンを押している間だけ反応（buttons のビット1=左ボタン）
    if (ev.buttons & 1) pickSV(ev);
  });

  // ------------------------------------------------------------------
  // マウス操作：色相バー
  // ------------------------------------------------------------------
  function pickHue(ev: PointerEvent): void {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - rect.left, 0), HUE_W);
    state.h = (x / HUE_W) * 360; // X→色相
    emit();
  }
  hueCanvas.addEventListener('pointerdown', (ev) => {
    hueCanvas.setPointerCapture(ev.pointerId);
    pickHue(ev);
  });
  hueCanvas.addEventListener('pointermove', (ev) => {
    if (ev.buttons & 1) pickHue(ev);
  });

  // ------------------------------------------------------------------
  // 濃さスライダー
  // ------------------------------------------------------------------
  densitySlider.addEventListener('input', () => {
    state.density = Number(densitySlider.value) / 100; // 0〜100 → 0〜1
    emit();
  });

  // ------------------------------------------------------------------
  // 濁りスライダー
  // ------------------------------------------------------------------
  turbiditySlider.addEventListener('input', () => {
    state.turbidity = Number(turbiditySlider.value) / 100; // 0〜100 → 0〜1
    emit();
  });

  // ------------------------------------------------------------------
  // ★重要：パネル上のマウス操作が OrbitControls（背後の3D）に伝わらないようにする。
  //   パネルの内側で起きた pointerdown / mousedown / wheel / touchstart を
  //   ここで止めて(stopPropagation)、カメラが一緒に回ったりズームしたりするのを防ぐ。
  // ------------------------------------------------------------------
  const swallow = (ev: Event) => ev.stopPropagation();
  ['pointerdown', 'mousedown', 'wheel', 'touchstart'].forEach((type) => {
    panel.addEventListener(type, swallow);
  });

  // 起動時に1回描画＋通知（初期色を3Dへ反映し、表示も埋める）
  emit();
}
