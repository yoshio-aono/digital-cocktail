// ============================================================================
// GlassView — 1つの canvas に「グラス＋液体」を描く自己完結ビューア（mixer専用）
//   液体1/2の小グラスプレビューを担当する。
//
//   ◆方針（今回の改修）：
//     小グラスの「材質・環境マップ・後処理（bloom＋DOF）」は、1液プログラム＝結果
//     ビューと “完全に同じレシピ” にそろえる。そのため共有モジュール cocktail-scene の
//     ファクトリ（createEnvMap / createRichGlassMaterial / createRichLiquidMaterial /
//     makeSetLiquidAppearance / addPostProcessing）をそのまま使う＝単一ソース。
//
//     ただし「バー環境（木の机・バックバー写真・グラデ背景・接地影）」は入れない。
//     背景は透過のままパネルに溶け込ませる（指示：質感とライトのみ）。
//     ライト・カメラ・DOFの合焦距離は、ショットグラスの寸法に合わせて再調整する
//     （マティーニ用の座標はそのままでは小グラスに合わないため）。
//
//   ◆負荷管理：
//     ・小グラス（interactive:false）＝常時ループを回さない。renderOnce() で
//       1フレームだけ描いて止める。パラメータ変更時にもう一度 renderOnce()。
//     ・操作可（interactive:true）＝ start()/stop() で描画ループを開始/停止。
// ============================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import type { GlassShape } from './glass-shapes';
import {
  EXPOSURE,
  PIXEL_RATIO,
  createEnvMap,
  createRichGlassMaterial,
  createRichLiquidMaterial,
  makeSetLiquidAppearance,
  addPostProcessing,
} from '../scene/cocktail-scene';

// GlassView を作るときに渡す設定。
export interface GlassViewOptions {
  canvas: HTMLCanvasElement; // 描画先の canvas（HTML側で用意したもの）
  shape: GlassShape; // グラスの形状（小グラス）
  liquidProfile: THREE.Vector2[]; // 液体の輪郭（buildLiquidProfile の戻り値）
  rich?: boolean; // （旧API互換。現在は常にリッチレシピなので未使用）
  interactive: boolean; // true=操作可＆描画ループ / false=視点固定＆静止
}

// ----------------------------------------------------------------------------
// ★ 小グラス用ライティングの調整値（ここを触れば当たり方が変わる）★
//   1液プログラムは「環境/方向/半球＝0、スポット2灯が主役」。同じ思想で、ただし
//   小グラスの寸法に合わせて位置・狙いを“グラスの高さ基準”で自動算出する
//   （ショット/タンブラー/ロックのどれを選んでも破綻しないように相対指定）。
//   decay=2（距離の2乗で減衰）なので、グラスに近いぶん強度はマティーニより小さい。
// ----------------------------------------------------------------------------
// 上からの面光源（リム/液面のハイライト用）。
//   点光源のスポットだと、ツルツルなグラス表面に「点」が鏡映りして“細い縦スジ”の
//   鏡面ハイライトになってしまう。そこで面積を持つ RectAreaLight（面の光源）にして、
//   太く柔らかいハイライトにする。
//   ※RectAreaLight は MeshStandardMaterial / MeshPhysicalMaterial にのみ効き、
//     影は落とさない（このビューでは影は使わないので問題なし）。
//   ※強度はスポット(decay=2)とは別単位。distanceでは減衰しないので値の桁が違う。
const TOP_LIGHT_INTENSITY = 24; // 面光源の強さ（白飛びするなら下げる）
const TOP_LIGHT_WIDTH = 2.2; // 光る面の幅（グラス高さH基準の相対倍率）
const TOP_LIGHT_HEIGHT = 3.0; // 光る面の高さ（相対倍率）。縦長だと縦に伸びたハイライト
// 白いハイライトの左右位置。0=真正面中央。正の値で右へずらす（グラス高さ基準の相対値）。
//   ※色確認用の画像なので、中央のハイライトが色を隠さないよう少し右に寄せる。
const TOP_LIGHT_X_OFFSET = 1.2;

// 背景色。後処理(EffectComposer)を通すと透過が失われ不透明になるため、
// パネルの小グラス枠の色(.small-glass の background = #15151b)に合わせて、
// canvas が枠にシームレスに溶け込むようにする（＝バー環境は入れない）。
// 透過の代わりに、この色が透過ガラスの“背後”にもなる。
const BG_COLOR = 0x262630;

export class GlassView {
  private canvas: HTMLCanvasElement;
  private interactive: boolean;

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls | null = null;
  private composer: EffectComposer;
  private bloomPass: UnrealBloomPass;
  private bokehPass: BokehPass | null;

  private liquidMaterial: THREE.MeshPhysicalMaterial;
  // 液体の見た目更新（共有ファクトリ＝結果ビューと同一ロジック）。
  private applyAppearance: (
    rgb: { r: number; g: number; b: number },
    density: number,
    turbidity?: number,
  ) => void;

  private running = false; // 描画ループが回っているか
  private rafId = 0; // requestAnimationFrame のハンドル（stop 用）

  constructor(opts: GlassViewOptions) {
    this.canvas = opts.canvas;
    this.interactive = opts.interactive;

    // --- Renderer（トーンマップ/露出は結果ビューと同一）---------------------
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
    });
    this.renderer.setPixelRatio(PIXEL_RATIO);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = EXPOSURE;

    // --- Scene（背景＝パネル枠色。後処理で透過が失われるため単色で溶け込ませる）--
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(BG_COLOR);

    // --- 環境マップ（映り込み/IBL）＝結果ビューと同一レシピ ------------------
    this.scene.environment = createEnvMap(this.renderer);

    // --- Camera（形状ごとの固定アングル）----------------------------------
    const [cx, cy, cz] = opts.shape.cameraPos;
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    this.camera.position.set(cx, cy, cz);
    const [tx, ty, tz] = opts.shape.cameraTarget;
    this.camera.lookAt(tx, ty, tz);
    // グラスを少し小さめに表示（zoom<1 で引いた見え方になる。90%程度）。
    this.camera.zoom = 0.9;
    this.camera.updateProjectionMatrix();

    // --- ライト（環境/方向/半球は使わず、スポット2灯。グラス高さ基準で自動配置）---
    //   H＝グラス上端（リム）の高さ、cyc＝グラス中心の高さ。これらを基準に、
    //   どの小グラス寸法でも同じ“当たり方”になるよう相対的に置く。
    const H = opts.shape.innerRim.y; // グラス上端の高さ
    const cyc = ty; // グラス中心の高さ（cameraTarget の y）
    // 上からの面光源：真上やや手前から、液面〜リムを狙う。面積を持つので
    //   ハイライトが太く柔らかくなる（点光源の細い縦スジを避ける）。
    //   RectAreaLight を使う前に、専用のシェーダーuniformsを一度初期化する必要がある。
    RectAreaLightUniformsLib.init();
    const topLight = new THREE.RectAreaLight(
      0xffffff,
      TOP_LIGHT_INTENSITY,
      H * TOP_LIGHT_WIDTH,
      H * TOP_LIGHT_HEIGHT,
    );
    topLight.position.set(H * TOP_LIGHT_X_OFFSET, H + 3.0, H * 0.8);
    // RectAreaLight は target を持たず、lookAt で向きを決める（面の法線が狙いを向く）。
    topLight.lookAt(0, cyc + H * 0.15, 0);
    this.scene.add(topLight);

    // ※横から当てるスポットライト（sideSpot）は廃止。あれはマティーニグラスで
    //   ステム（脚）の視認性を高めるためのギミックで、小グラスには不要。

    // --- グラス本体（材質＝共有ファクトリ）--------------------------------
    const glassGeo = new THREE.LatheGeometry(opts.shape.profile, 64);
    const glassMat = createRichGlassMaterial();
    this.scene.add(new THREE.Mesh(glassGeo, glassMat));

    // --- 液体（材質＋縦グラデ＝共有ファクトリ）----------------------------
    const liquidGeo = new THREE.LatheGeometry(opts.liquidProfile, 64);
    this.liquidMaterial = createRichLiquidMaterial(liquidGeo, true);
    this.applyAppearance = makeSetLiquidAppearance(this.liquidMaterial);
    this.scene.add(new THREE.Mesh(liquidGeo, this.liquidMaterial));

    // --- 操作（任意）------------------------------------------------------
    if (this.interactive) {
      this.controls = new OrbitControls(this.camera, this.canvas);
      this.controls.enableDamping = true;
      this.controls.target.set(tx, ty, tz);
    }

    // --- 後処理（bloom + DOF + Output）＝結果ビューと同一レシピ -------------
    //   DOF の合焦距離はカメラ→注視点の距離に合わせる（マティーニとは距離が違う）。
    const focus = Math.hypot(cx - tx, cy - ty, cz - tz);
    this.composer = new EffectComposer(this.renderer);
    this.composer.setPixelRatio(PIXEL_RATIO);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const post = addPostProcessing(
      this.composer,
      this.scene,
      this.camera,
      1,
      1,
      { useDof: true, focus },
    );
    this.bloomPass = post.bloomPass;
    this.bokehPass = post.bokehPass;

    // canvas の実サイズに合わせる（初回）。
    this.resize();
  }

  // ----------------------------------------------------------------------
  // ★ 見た目を更新する中継メソッド（color-engine 接続点に相当）★
  //   rgb(0〜255), density(0〜1), turbidity(0〜1) を受け、結果ビューと同一ロジックで
  //   液体材質に反映する。静止グラスでは、この後 renderOnce() を呼ぶ必要がある。
  // ----------------------------------------------------------------------
  setAppearance(
    rgb: { r: number; g: number; b: number },
    density: number,
    turbidity: number,
  ): void {
    this.applyAppearance(rgb, density, turbidity);
  }

  // ----------------------------------------------------------------------
  // 静止グラス用：1フレームだけ描いて止める。
  // ----------------------------------------------------------------------
  renderOnce(): void {
    this.composer.render();
  }

  // ----------------------------------------------------------------------
  // 操作可グラス用：描画ループを開始/停止する。
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
  // ★ 破棄（dispose）★ — 動的にスロットを増減する N液ビューアー用。
  //   このビューは1つの WebGLRenderer（＝1つの WebGLコンテキスト）を持つ。スロット削除や
  //   タブ非表示で不要になったら、確実に GPU リソースを解放してリーク／コンテキストロスを防ぐ。
  //   ・描画ループを止める
  //   ・シーン内の全 geometry / material を dispose
  //   ・環境マップ（IBLテクスチャ）を dispose
  //   ・後処理（EffectComposer のレンダーターゲット群）を dispose
  //   ・OrbitControls を dispose
  //   ・renderer を dispose し、WebGLコンテキストを明示的に手放す
  //   破棄後は再利用しない（呼び出し側で参照を捨て、必要なら作り直す）。
  // ----------------------------------------------------------------------
  dispose(): void {
    this.stop();

    // シーン内の Mesh の geometry / material をすべて解放する。
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else if (mat) mat.dispose();
    });

    // 環境マップ（createEnvMap が返したテクスチャ）を解放する。
    if (this.scene.environment) {
      this.scene.environment.dispose();
      this.scene.environment = null;
    }

    // 後処理パス群（レンダーターゲット）を解放する。
    this.composer.dispose();

    // マウス操作（あれば）を解放する。
    if (this.controls) {
      this.controls.dispose();
      this.controls = null;
    }

    // レンダラーを解放し、WebGLコンテキストを明示的に手放す
    //   （ブラウザのコンテキスト上限に達してロストするのを防ぐ）。
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  // ----------------------------------------------------------------------
  // canvas の表示サイズ（CSSピクセル）に描画解像度を合わせる。
  // ----------------------------------------------------------------------
  resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false); // false=canvasのCSSサイズは触らない
    this.composer.setSize(w, h);
    this.bloomPass.setSize(w, h);
    if (this.bokehPass) this.bokehPass.setSize(w, h);
  }
}
