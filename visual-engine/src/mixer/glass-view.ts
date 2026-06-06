// ============================================================================
// GlassView — 1つの canvas に「グラス＋液体」を描く自己完結ビューア（mixer専用）
//   mixer では3Dを3つ同時に扱う：
//     ・小グラス（液体1）… 視点固定・静止・簡易マテリアル
//     ・小グラス（液体2）… 同上
//     ・結果のマティーニ … 操作可能(OrbitControls)・リッチ(環境マップ＋bloom＋透過)
//   それぞれ別の canvas／別の WebGL コンテキストを持たせ、負荷を独立管理する。
//
//   ◆負荷管理の肝（指示書 2-2）：
//     ・小グラス（interactive:false）＝常時ループを回さない。renderOnce() で
//       1フレームだけ描いて止める。パラメータ変更時にもう一度 renderOnce()。
//     ・結果（interactive:true）＝ start()/stop() で描画ループを開始/停止。
//       タブが非アクティブな間は stop() して rAF を止める。
//
//   ◆既存 main.ts は一切 import しない（デグレ厳禁のため資産は複製方針）。
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import type { GlassShape } from './glass-shapes';

// GlassView を作るときに渡す設定。
export interface GlassViewOptions {
  canvas: HTMLCanvasElement; // 描画先の canvas（HTML側で用意したもの）
  shape: GlassShape; // グラスの形状（マティーニ or 小グラス）
  liquidProfile: THREE.Vector2[]; // 液体の輪郭（buildLiquidProfile の戻り値）
  rich: boolean; // true=リッチ(環境マップ＋bloom＋透過) / false=簡易
  interactive: boolean; // true=操作可＆描画ループ / false=視点固定＆静止
}

// ----------------------------------------------------------------------------
// リッチ時の液体パラメータの基準値（既存 main.ts の setLiquidAppearance を複製）。
//   turbidity=0 のとき必ずこの値に戻り、澄んだ液体になることを保証する。
// ----------------------------------------------------------------------------
const ATTEN_MIN_DIST = 0.5; // density=1（最も濃い）ときの吸収距離
const ATTEN_MAX_DIST = 10.0; // density=0（最も薄い）ときの吸収距離
const BASE_TRANSMISSION = 0.98;
const BASE_ROUGHNESS = 0.02;
const BASE_SPECULAR_INTENSITY = 1.0;
const BASE_ENVMAP_INTENSITY = 0.3;
const MILK_WHITE = 0.85; // 濁りの白寄せの行き先（真っ白だと白飛びするので少し抑える）
const WHITE_MAX = 0.15; // 白寄せの最大量（小さいほど元の色が残る）
const WHITE_SAT_T = 0.3; // この濁り値で白寄せが頭打ち

const EXPOSURE = 0.7; // 露出（既存 main.ts と同じ）

export class GlassView {
  private canvas: HTMLCanvasElement;
  private rich: boolean;
  private interactive: boolean;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;

  private liquidMaterial: THREE.MeshPhysicalMaterial;

  private running = false; // 描画ループが回っているか
  private rafId = 0; // requestAnimationFrame のハンドル（stop 用）

  constructor(opts: GlassViewOptions) {
    this.canvas = opts.canvas;
    this.rich = opts.rich;
    this.interactive = opts.interactive;

    // --- Renderer（この canvas 専用）------------------------------------
    //   簡易グラスは alpha:true で背景透過にし、パネルの背景に溶け込ませる。
    //   リッチ（結果）は暗い背景を敷いて bloom を引き立てる。
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: !this.rich,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;

    // --- Scene -----------------------------------------------------------
    this.scene = new THREE.Scene();
    this.scene.background = this.rich
      ? new THREE.Color(0x14141a) // リッチ：暗紺グレー（bloom 用）
      : null; // 簡易：透過

    // --- 環境マップ（リッチのみ）-----------------------------------------
    //   RoomEnvironment をコード生成し映り込みに使う（HDRIファイル不要）。
    if (this.rich) {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const envScene = new RoomEnvironment();
      this.scene.environment = pmrem.fromScene(envScene).texture;
      envScene.dispose();
      pmrem.dispose();
    }

    // --- Camera ----------------------------------------------------------
    const [cx, cy, cz] = opts.shape.cameraPos;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(cx, cy, cz);

    // --- ライト ----------------------------------------------------------
    //   半透明な液体は光がないと立体に見えない。半球光で全方向を起こしつつ、
    //   方向光でハイライトを作る（既存 main.ts の学びに準拠）。
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444455, 0.6);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 0.8);
    dir.position.set(3, 6, 5);
    this.scene.add(dir);

    // --- グラス本体 ------------------------------------------------------
    const glassGeo = new THREE.LatheGeometry(opts.shape.profile, 64);
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      roughness: 0.05,
      metalness: 0.0,
      transparent: true,
      opacity: 0.08, // 薄いガラス。透過は使わず（液体の色を抜かないため）
      envMapIntensity: this.rich ? 1.0 : 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.scene.add(new THREE.Mesh(glassGeo, glassMat));

    // --- 液体 ------------------------------------------------------------
    const liquidGeo = new THREE.LatheGeometry(opts.liquidProfile, 64);
    this.liquidMaterial = this.rich
      ? this.makeRichLiquidMaterial()
      : this.makeSimpleLiquidMaterial();
    this.scene.add(new THREE.Mesh(liquidGeo, this.liquidMaterial));

    // --- 操作＆後処理（リッチ＆操作可のときだけ）------------------------
    if (this.interactive) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      const [tx, ty, tz] = opts.shape.cameraTarget;
      this.controls.target.set(tx, ty, tz);
    }
    if (this.rich) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloomPass = new UnrealBloomPass(
        new THREE.Vector2(1, 1),
        0.15, // strength（控えめ。既存 BLOOM_PRESET=1 相当）
        0.4, // radius
        2.2, // threshold（面では光らせず鋭いハイライトだけ拾う）
      );
      this.composer.addPass(this.bloomPass);
      this.composer.addPass(new OutputPass());
    }

    // canvas の実サイズに合わせる（初回）。
    this.resize();
  }

  // --- 簡易な液体マテリアル（小グラス用）--------------------------------
  //   重い transmission を使わず、半透明の色つき面で表現する。
  //   density→opacity、turbidity→ラフネス＆白寄せ で大まかに見せる。
  private makeSimpleLiquidMaterial(): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.7,
      roughness: 0.2,
      metalness: 0.0,
      envMapIntensity: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  // --- リッチな液体マテリアル（結果マティーニ用）------------------------
  //   既存 main.ts の liquidMaterial を複製（透過＋吸収色＋両面＋depthWrite off）。
  private makeRichLiquidMaterial(): THREE.MeshPhysicalMaterial {
    return new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.9,
      roughness: BASE_ROUGHNESS,
      metalness: 0.0,
      envMapIntensity: BASE_ENVMAP_INTENSITY,
      transmission: BASE_TRANSMISSION,
      attenuationColor: new THREE.Color(0xffffff),
      attenuationDistance: 2,
      thickness: 6,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }

  // ----------------------------------------------------------------------
  // ★ 見た目を更新する中継メソッド（color-engine 接続点に相当）★
  //   rgb(0〜255), density(0〜1), turbidity(0〜1) を受け、リッチ/簡易どちらの
  //   マテリアルにも反映する。値を代入するだけで次の描画に反映される
  //   （needsUpdate は呼ばない＝再コンパイルを避ける。既存 main.ts の学び）。
  //   ※静止グラス（interactive:false）では、この後 renderOnce() を呼ぶ必要がある。
  // ----------------------------------------------------------------------
  setAppearance(
    rgb: { r: number; g: number; b: number },
    density: number,
    turbidity: number,
  ): void {
    const d = Math.min(Math.max(density, 0), 1);
    const t = Math.min(Math.max(turbidity, 0), 1);
    const pr = rgb.r / 255;
    const pg = rgb.g / 255;
    const pb = rgb.b / 255;
    const m = this.liquidMaterial;

    if (this.rich) {
      // --- リッチ：既存 setLiquidAppearance と同じロジック ---
      m.attenuationColor!.setRGB(pr, pg, pb); // 吸収色＝色相。濁っても色相は保つ
      m.attenuationDistance =
        ATTEN_MAX_DIST - (ATTEN_MAX_DIST - ATTEN_MIN_DIST) * d; // 濃いほど距離小

      m.transmission = BASE_TRANSMISSION * (1 - t); // 濁るほど不透明
      const whiteAmt = WHITE_MAX * Math.min(t / WHITE_SAT_T, 1); // 白寄せ（頭打ちあり）
      m.color.setRGB(
        pr + (MILK_WHITE - pr) * whiteAmt,
        pg + (MILK_WHITE - pg) * whiteAmt,
        pb + (MILK_WHITE - pb) * whiteAmt,
      );
      const ease = 1 - (1 - t) * (1 - t); // ease-out（早く立ち上がる）
      m.roughness = BASE_ROUGHNESS + (0.95 - BASE_ROUGHNESS) * ease;
      m.specularIntensity = BASE_SPECULAR_INTENSITY * (1 - 0.9 * ease);
      m.envMapIntensity = BASE_ENVMAP_INTENSITY * (1 - 0.85 * ease);
    } else {
      // --- 簡易：色＝純色を濁りで白寄せ、density→opacity、turbidity→roughness ---
      const whiteAmt = WHITE_MAX * Math.min(t / WHITE_SAT_T, 1);
      m.color.setRGB(
        pr + (MILK_WHITE - pr) * whiteAmt,
        pg + (MILK_WHITE - pg) * whiteAmt,
        pb + (MILK_WHITE - pb) * whiteAmt,
      );
      // 濃いほど不透明（0.45〜0.95）。濁りでもさらに不透明側へ。
      m.opacity = Math.min(0.45 + 0.5 * d + 0.3 * t, 0.97);
      m.roughness = 0.15 + 0.8 * (1 - (1 - t) * (1 - t)); // 濁るほどマット
    }
  }

  // ----------------------------------------------------------------------
  // 静止グラス用：1フレームだけ描いて止める。
  //   小グラスは常時ループを回さず、パラメータ変更時にこれを呼ぶだけにする。
  // ----------------------------------------------------------------------
  renderOnce(): void {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // ----------------------------------------------------------------------
  // 操作可グラス用：描画ループを開始/停止する。
  //   タブが見えている間だけ start()、隠れたら stop() で rAF を止める。
  // ----------------------------------------------------------------------
  start(): void {
    if (this.running) return; // 二重起動防止
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(loop);
      if (this.controls) this.controls.update(); // 慣性(damping)反映
      this.renderOnce();
    };
    loop();
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  // ----------------------------------------------------------------------
  // canvas の表示サイズ（CSSピクセル）に描画解像度を合わせる。
  //   タブ切替やウィンドウリサイズで canvas のサイズが変わったら呼ぶ。
  // ----------------------------------------------------------------------
  resize(): void {
    // clientWidth/Height は CSS 上の表示サイズ。0 のとき（非表示中）は何もしない。
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false); // false=canvasのCSSサイズは触らない
    if (this.composer) this.composer.setSize(w, h);
    if (this.bloomPass) this.bloomPass.setSize(w, h);
  }
}
