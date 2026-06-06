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
  //   第4引数 hsv は色相・彩度・明度（0〜360 / 0〜1 / 0〜1）。色を HSV のまま
  //   保持したい呼び出し側（mixer）が使う。RGB だけで足りる側は無視してよい。
  onChange: (
    rgb: { r: number; g: number; b: number },
    density: number,
    turbidity: number,
    hsv: { h: number; s: number; v: number },
  ) => void;
  // パネルを開いた/閉じたときに呼ばれるコールバック（任意）。
  //   open=true で開いた、false で閉じた。main.ts 側でスマホ時のカメラ寄せに使う。
  onToggle?: (open: boolean) => void;
  // パネルの見出し（任意）。省略時は「液体カラー」。
  title?: string;
  // パネルの追加先（任意）。省略時は document.body。
  //   ※mixer の結果タブのように「タブと一緒に表示/非表示したい」場合に、
  //     そのタブの要素を渡すと display:none の親と連動して隠れる。
  mount?: HTMLElement;
  // 読み取り専用モード（任意）。true のとき：
  //   ・ピッカー/スライダーの操作を一切受け付けない（値は外から setValues で流す）。
  //   ・onChange は呼ばない（3Dへの反映は呼び出し側が別経路で行う前提）。
  //   mixer の結果ビューのように「混合結果で固定表示」する用途に使う。
  readonly?: boolean;
  // 埋め込みモード（任意）。true のとき position:fixed の浮きパネルではなく、
  //   親要素の中に収まる静的パネル（幅は親に追従＝width:100%）になる。
  //   設定画面の右半分に組み込む用途に使う。
  embedded?: boolean;
  // 見出し（開閉ヘッダー）を出すか（任意・既定 true）。false で見出しと開閉を省き、
  //   中身を常に開いた状態で出す（外側で別の折りたたみを持つ埋め込み用途向け）。
  showHeader?: boolean;
}

// createLiquidUI が返す操作ハンドル。
export interface LiquidUIHandle {
  // 外から表示値を流し込む（readonly 表示の更新に使う）。onChange は呼ばれない。
  setValues: (
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
export function createLiquidUI(options: LiquidUIOptions): LiquidUIHandle {
  // 読み取り専用フラグ（操作不可・onChange なし）。
  const READONLY = options.readonly === true;
  // 埋め込みフラグ（浮きパネルでなく親要素内に収める）。
  const EMBEDDED = options.embedded === true;
  // 見出し（開閉ヘッダー）を出すか。既定 true。
  const SHOW_HEADER = options.showHeader !== false;
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

  // スマホ画面かどうか（幅768px以下）。値の選択にだけ使い、処理は分岐させない。
  //   PC（IS_MOBILE===false）では従来とまったく同じ数値が入るようにしてある。
  const IS_MOBILE = window.innerWidth <= 768;

  // 各キャンバスの寸法。
  //   スマホでは描画画面を空けたいので、パネル幅（=この正方形の一辺）を少し小さくする。
  //   PCは従来通り180px。
  const SV_SIZE = IS_MOBILE ? 150 : 180; // 彩度×明度の正方形の一辺(px)＝パネル幅
  const HUE_W = SV_SIZE; // 色相バーの幅(px)＝パネル幅に合わせる
  const HUE_H = 16; // 色相バーの高さ(px)

  // 文字サイズ。スマホは小さい画面でも読めるよう、全体を少し大きめにする。
  //   PCは従来の値（13/12/11px）のまま。
  const FONT_HEADER = IS_MOBILE ? 15 : 13; // ヘッダー（タイトル）
  const FONT_CARET = IS_MOBILE ? 13 : 11; // 開閉キャレット（▼▶）
  const FONT_LABEL = IS_MOBILE ? 14 : 12; // スライダーのラベル
  const FONT_READOUT = IS_MOBILE ? 13 : 11; // 現在値の表示

  // ------------------------------------------------------------------
  // 1) パネルの外枠
  //   通常＝画面右上に浮く半透明の箱（position:fixed）。
  //   埋め込み（EMBEDDED）＝親要素の中に収まる静的な箱（幅は中身ぶん＝SV_SIZE）。
  // ------------------------------------------------------------------
  const panel = document.createElement('div');
  panel.style.cssText = (
    EMBEDDED
      ? [
          'font-family:system-ui,-apple-system,"Segoe UI",sans-serif',
          'color:#e8e8ee',
          'user-select:none',
          'width:' + SV_SIZE + 'px',
          'flex:0 0 auto', // 親が flex でも縮まないように
        ]
      : [
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
        ]
  ).join(';');

  // ------------------------------------------------------------------
  // タイトル＝開閉ヘッダー（蛇腹/アコーディオン）
  //   ヘッダーをタップ/クリックすると下の中身(content)を開いたり閉じたりできる。
  //   スマホでは初期状態を「閉じた」状態にして、3Dの描画をパネルが邪魔しないようにする。
  //   右端のキャレット（▼=開いている / ▶=閉じている）で今の状態がわかる。
  // ------------------------------------------------------------------
  const header = document.createElement('div');
  // flex で「タイトル文字」と「キャレット」を左右に振り分ける。
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'cursor:pointer', // クリックできることを示す
    'font-size:' + FONT_HEADER + 'px',
    'font-weight:600',
    'letter-spacing:0.04em',
  ].join(';');

  const title = document.createElement('span');
  title.textContent = options.title ?? '液体カラー';
  header.appendChild(title);

  // 開閉状態を示すキャレット（小さな三角）。
  const caret = document.createElement('span');
  caret.style.cssText =
    'font-size:' + FONT_CARET + 'px;margin-left:8px;opacity:0.8;';
  header.appendChild(caret);

  // SHOW_HEADER=false（埋め込みで外側に見出しがある）のときは見出しを出さない。
  if (SHOW_HEADER) panel.appendChild(header);

  // 中身（ピッカー・スライダー・数値表示）をまとめて入れる箱。
  // ここの display を切り替えるだけで蛇腹的に開閉できる。
  const content = document.createElement('div');
  // 見出しがあるときだけ上に余白を空ける。
  content.style.cssText = SHOW_HEADER ? 'margin-top:10px;' : '';
  panel.appendChild(content);

  // 開閉状態。スマホ幅(768px以下)では初期は閉じておく（描画を邪魔しないため）。
  //   見出しなし（SHOW_HEADER=false）のときは常に開いた状態とし、開閉はしない。
  let collapsed = SHOW_HEADER && window.innerWidth <= 768;
  // 現在の collapsed に合わせて、中身の表示とキャレットの向きを更新する。
  //   開閉が変わるたびに onToggle(open) も呼んで、main.ts 側へ状態を伝える。
  function applyCollapsed(): void {
    content.style.display = collapsed ? 'none' : 'block';
    caret.textContent = collapsed ? '▶' : '▼';
    // open = 開いているか（collapsed の反対）。スマホ時のカメラ寄せに使われる。
    options.onToggle?.(!collapsed);
  }
  if (SHOW_HEADER) {
    applyCollapsed(); // 初期状態を反映
    // ヘッダーのクリック/タップで開閉をトグルする。
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      applyCollapsed();
    });
  }

  // ------------------------------------------------------------------
  // 2) 彩度×明度の正方形（メインのカラーピッカー）
  //    横軸＝彩度(左0→右1) / 縦軸＝明度(上1→下0)
  // ------------------------------------------------------------------
  const svCanvas = document.createElement('canvas');
  svCanvas.width = SV_SIZE;
  svCanvas.height = SV_SIZE;
  svCanvas.style.cssText =
    'display:block;border-radius:8px;cursor:crosshair;touch-action:none;';
  content.appendChild(svCanvas);
  const svCtx = svCanvas.getContext('2d')!;

  // ------------------------------------------------------------------
  // 3) 色相バー（虹色の横棒。クリック位置で色相を選ぶ）
  // ------------------------------------------------------------------
  const hueCanvas = document.createElement('canvas');
  hueCanvas.width = HUE_W;
  hueCanvas.height = HUE_H;
  hueCanvas.style.cssText =
    'display:block;margin-top:10px;border-radius:6px;cursor:pointer;touch-action:none;';
  content.appendChild(hueCanvas);
  const hueCtx = hueCanvas.getContext('2d')!;

  // ------------------------------------------------------------------
  // 4) 濃さスライダー
  // ------------------------------------------------------------------
  const densityLabel = document.createElement('div');
  densityLabel.textContent = '濃さ（薄い ⇔ 濃い）';
  densityLabel.style.cssText =
    'font-size:' + FONT_LABEL + 'px;margin:12px 0 4px;';
  content.appendChild(densityLabel);

  const densitySlider = document.createElement('input');
  densitySlider.type = 'range';
  densitySlider.min = '0';
  densitySlider.max = '100';
  densitySlider.value = String(Math.round(state.density * 100));
  densitySlider.style.cssText = 'width:100%;cursor:pointer;';
  content.appendChild(densitySlider);

  // ------------------------------------------------------------------
  // 4.5) 濁りスライダー（澄んだ ⇔ 濁った）
  //   0=透き通った透明 / 1=ミルクのように白く濁って不透明。
  // ------------------------------------------------------------------
  const turbidityLabel = document.createElement('div');
  turbidityLabel.textContent = '濁り（澄んだ ⇔ 濁った）';
  turbidityLabel.style.cssText =
    'font-size:' + FONT_LABEL + 'px;margin:12px 0 4px;';
  content.appendChild(turbidityLabel);

  const turbiditySlider = document.createElement('input');
  turbiditySlider.type = 'range';
  turbiditySlider.min = '0';
  turbiditySlider.max = '100';
  turbiditySlider.value = String(Math.round(state.turbidity * 100));
  turbiditySlider.style.cssText = 'width:100%;cursor:pointer;';
  content.appendChild(turbiditySlider);

  // ------------------------------------------------------------------
  // 5) 現在値の表示（RGB / HSV / 濃さ）
  //    将来ここは mixCocktail() の出力に置き換わる、という確認用の窓。
  // ------------------------------------------------------------------
  const readout = document.createElement('div');
  readout.style.cssText =
    'font-size:' +
    FONT_READOUT +
    'px;line-height:1.6;margin-top:10px;font-family:ui-monospace,monospace;color:#b9b9c6;';
  content.appendChild(readout);

  (options.mount ?? document.body).appendChild(panel);

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
    //   端（彩度1・明度1＝右上角など）でも円が欠けないよう、中心を半径ぶん内側に
    //   クランプして必ず全体が見えるようにする（混合結果は常に彩度=明度=最大なので
    //   右上角に来る。クランプしないと円が画面外に切れて◎が見えなくなる）。
    const MARK_R = 7; // マーカー外円の半径
    const mx = Math.min(Math.max(state.s * SV_SIZE, MARK_R), SV_SIZE - MARK_R); // 彩度→X
    const my = Math.min(
      Math.max((1 - state.v) * SV_SIZE, MARK_R),
      SV_SIZE - MARK_R,
    ); // 明度→Y（上が明るい）
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
  // 表示だけ更新する（数値表示＋ピッカー再描画）。onChange は呼ばない。
  function render(): void {
    const rgb = hsvToRgb(state.h, state.s, state.v);
    readout.innerHTML =
      `RGB&nbsp;&nbsp;${rgb.r}, ${rgb.g}, ${rgb.b}<br>` +
      `HSV&nbsp;&nbsp;${Math.round(state.h)}°, ${Math.round(
        state.s * 100,
      )}%, ${Math.round(state.v * 100)}%<br>` +
      // 濃さ・濁りは視認性を上げるため赤系の文字色にする（この2行だけ）。
      `<span style="color:#ff7a7a">` +
      `濃さ&nbsp;&nbsp;${Math.round(state.density * 100)}%<br>` +
      `濁り&nbsp;&nbsp;${Math.round(state.turbidity * 100)}%` +
      `</span>`;
    // ピッカーを描き直す（マーカー位置や色相が変わるため）
    drawSV();
    drawHue();
  }

  // 表示更新＋ onChange 通知（ユーザー操作時に呼ぶ）。
  function emit(): void {
    render();
    const rgb = hsvToRgb(state.h, state.s, state.v);
    // 3Dへ反映（main.ts の setLiquidAppearance が呼ばれる）。
    //   第4引数で HSV も渡す（mixer が色を HSV のまま保持するため）。
    options.onChange(rgb, state.density, state.turbidity, {
      h: state.h,
      s: state.s,
      v: state.v,
    });
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
  if (!READONLY) {
    svCanvas.addEventListener('pointerdown', (ev) => {
      svCanvas.setPointerCapture(ev.pointerId); // 枠外へ出てもドラッグ追従
      pickSV(ev);
    });
    svCanvas.addEventListener('pointermove', (ev) => {
      // ボタンを押している間だけ反応（buttons のビット1=左ボタン）
      if (ev.buttons & 1) pickSV(ev);
    });
  }

  // ------------------------------------------------------------------
  // マウス操作：色相バー
  // ------------------------------------------------------------------
  function pickHue(ev: PointerEvent): void {
    const rect = hueCanvas.getBoundingClientRect();
    const x = Math.min(Math.max(ev.clientX - rect.left, 0), HUE_W);
    state.h = (x / HUE_W) * 360; // X→色相
    emit();
  }
  if (!READONLY) {
    hueCanvas.addEventListener('pointerdown', (ev) => {
      hueCanvas.setPointerCapture(ev.pointerId);
      pickHue(ev);
    });
    hueCanvas.addEventListener('pointermove', (ev) => {
      if (ev.buttons & 1) pickHue(ev);
    });
  }

  // ------------------------------------------------------------------
  // 濃さスライダー
  // ------------------------------------------------------------------
  if (!READONLY) {
    densitySlider.addEventListener('input', () => {
      state.density = Number(densitySlider.value) / 100; // 0〜100 → 0〜1
      emit();
    });
  }

  // ------------------------------------------------------------------
  // 濁りスライダー
  // ------------------------------------------------------------------
  if (!READONLY) {
    turbiditySlider.addEventListener('input', () => {
      state.turbidity = Number(turbiditySlider.value) / 100; // 0〜100 → 0〜1
      emit();
    });
  }

  // readonly のときは操作不可の見た目にする（スライダーは無効化＝固定、カーソルも標準に）。
  if (READONLY) {
    densitySlider.disabled = true;
    turbiditySlider.disabled = true;
    densitySlider.style.cursor = 'default';
    turbiditySlider.style.cursor = 'default';
    svCanvas.style.cursor = 'default';
    hueCanvas.style.cursor = 'default';
  }

  // ------------------------------------------------------------------
  // ★重要：パネル上のマウス操作が OrbitControls（背後の3D）に伝わらないようにする。
  //   パネルの内側で起きた pointerdown / mousedown / wheel / touchstart を
  //   ここで止めて(stopPropagation)、カメラが一緒に回ったりズームしたりするのを防ぐ。
  // ------------------------------------------------------------------
  const swallow = (ev: Event) => ev.stopPropagation();
  ['pointerdown', 'mousedown', 'wheel', 'touchstart'].forEach((type) => {
    panel.addEventListener(type, swallow);
  });

  // 起動時に1回描画。通常は通知も行うが、readonly は表示だけ（onChange を呼ばない）。
  if (READONLY) render();
  else emit();

  // 外から表示値を流し込むハンドルを返す（readonly 表示の更新に使う）。
  //   onChange は呼ばず、表示（数値＋ピッカー＋スライダー位置）だけを更新する。
  return {
    setValues: (rgb, density, turbidity) => {
      const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
      state.h = hsv.h;
      state.s = hsv.s;
      state.v = hsv.v;
      state.density = density;
      state.turbidity = turbidity;
      densitySlider.value = String(Math.round(density * 100));
      turbiditySlider.value = String(Math.round(turbidity * 100));
      render();
    },
  };
}
