// ============================================================================
// カクテル3Dビジュアル化エンジン — ステップ1＋4＋5
// 「半透明の色つき液体が入った器を、マウスでぐるぐる回して眺める」
//   ＋ ステップ4：周囲の環境を映り込ませる（環境マップ）
//   ＋ ステップ5：ハイライトをふわっと光らせる（bloom 後処理）
//
// Three.js の基本要素は次の6つ。まずこの全体像をつかむと読みやすい：
//   1. Renderer  … 3D空間を計算して画面(canvas)に絵を描く「描画装置」
//   2. Scene     … 物・光・カメラを全部入れる「3D空間（箱）」
//   3. Camera    … その空間を「どこから・どう見るか」という視点
//   4. Mesh      … 実際に見える物体。形(Geometry)＋材質(Material)で作る
//   5. Light     … 光源。半透明な物は光がないと立体的に見えない
//   6. ループ    … 毎フレーム描き直して、操作やアニメを反映し続ける仕組み
// ============================================================================

import * as THREE from 'three';
// OrbitControls はマウスでカメラを回す/ズームする補助ツール。
// Three.js 本体ではなく examples フォルダに入っているので、ここから読み込む。
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
// RoomEnvironment = コードだけで「室内スタジオ風」の風景を作るクラス。
// HDRI画像ファイルを用意しなくても、これを環境マップにすれば映り込みが出せる。
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
// ↓ 後処理(ポストプロセス)用。描画した絵に効果を重ねがけする仕組み。
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import './style.css';

// ----------------------------------------------------------------------------
// ★ 液体の見た目の設定（将来ここに color-engine の出力を流し込む）★
//   色は 0〜255 の rgb で持っておき、Three.js 用に 0〜1 へ変換して使う。
//   この2つの定数を書き換えるだけで液体の色と透け具合が変わる。
// ----------------------------------------------------------------------------
const LIQUID_COLOR = { r: 200, g: 50, b: 110 }; // マゼンタ系
// 透明度。小さいほど透けるが、その分だけ後ろの色が混ざって液体の色は薄くなる。
// 値が大きいほど不透明で色が濃く出る（後ろの格子は透けにくくなる）。
const LIQUID_OPACITY = 0.65; // 0=完全に透明 / 1=不透明

// ----------------------------------------------------------------------------
// ★ 背景色（暫定・ステップ7で本格的に作り込む）★
//   bloom は「暗い中で明るい部分がふわっと光る」効果。背景が明るいと画面全体が
//   明るすぎて bloom が白飛びし、プリセットの差も見えなくなる。そこで bloom が
//   きれいに映える暗い背景にしている。最終的な背景（ボケ・グラデ等）はステップ7で
//   作るので、ここは仮の値。1か所変えるだけで背景色を差し替えられる。
// ----------------------------------------------------------------------------
const BG_COLOR = 0x14141a; // 暗い紺グレー（bloom が映える暫定背景）

// ----------------------------------------------------------------------------
// ★ 全体の明るさ（露出）★
//   環境マップ＋ライトが強いと、液体やグラスのハイライトが 255（純白）に振り切れ、
//   色が飛んで真っ白になる。写真のカメラと同じ「露出」を下げる発想で、明るい所を
//   なめらかに圧縮するのがトーンマッピング。EXPOSURE を下げるほど全体が暗くなる。
//   （1.0=標準 / 0.5前後=暗め。ここを変えるだけで画面全体の明るさを調整できる）
// ----------------------------------------------------------------------------
const EXPOSURE = 0.6;

// ----------------------------------------------------------------------------
// ★ bloom（光のにじみ）プリセット切り替え ★
//   bloom は明るい部分をふわっと光らせる効果。効かせすぎると白飛びする。
//   下の BLOOM_PRESET を 1 / 2 / 3 に変えるだけで強さが切り替わる。
//     1 = 控えめ / 2 = 標準 / 3 = 華やか
//   ・strength  … 光らせる強さ（大きいほど派手）
//   ・radius    … にじみの広がり半径
//   ・threshold … この明るさを超えた部分だけ光る（小さいほど広く光る）
// ----------------------------------------------------------------------------
const BLOOM_PRESET = 2; // ← ここを 1 / 2 / 3 に変えて見比べる
const BLOOM_PRESETS = {
  1: { strength: 0.25, radius: 0.4, threshold: 0.6 }, // 控えめ
  2: { strength: 0.45, radius: 0.5, threshold: 0.45 }, // 標準
  3: { strength: 0.75, radius: 0.6, threshold: 0.3 }, // 華やか
} as const;
const bloom = BLOOM_PRESETS[BLOOM_PRESET];

// ============================================================================
// 1. Renderer（描画装置）
//    計算結果を canvas に描く。antialias で輪郭のギザギザを滑らかにする。
// ============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight); // 画面サイズに合わせる
renderer.setPixelRatio(window.devicePixelRatio); // 高精細ディスプレイ対応
// トーンマッピング：明るい部分(ハイライト)を純白に飛ばさず、なめらかに圧縮する。
// ACESFilmic は映画やゲームで定番の自然な見え方。これで液体やグラスの強い反射が
// 255 に張り付くのを防ぎ、色が残る。EXPOSURE で全体の明るさを最終調整する。
//（後処理 OutputPass がこの設定を読んでトーンマッピングを適用してくれる）
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = EXPOSURE;
document.body.appendChild(renderer.domElement); // 生成した canvas を画面に追加

// ============================================================================
// 2. Scene（3D空間）
//    これから作る器・液体・光・カメラを、すべてこの中に add していく。
// ============================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(BG_COLOR); // 空間の背景色（先頭の BG_COLOR で制御。今は bloom が映える暗色）

// ============================================================================
// 2.5 環境マップ（映り込み）— ステップ4
//   ガラスや液体の表面に「周囲の風景」を映り込ませると一気に本物らしくなる。
//   手順：
//     (1) RoomEnvironment で室内スタジオ風の風景シーンをコードで生成
//     (2) PMREMGenerator で、その風景を「反射に使える専用テクスチャ」に変換
//     (3) scene.environment に入れると、シーン内の全マテリアルの反射・環境光に効く
//   ※ scene.background は変えない（＝映り込みだけ反映、背景はそのまま）。背景はステップ7で扱う。
// ============================================================================
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const environmentScene = new RoomEnvironment(); // 室内スタジオ風の風景
const envMap = pmremGenerator.fromScene(environmentScene).texture; // 反射用テクスチャに変換
scene.environment = envMap; // 全マテリアルに映り込み＆環境光として適用
// 後始末：変換が終われば、元の風景シーンと変換器はもう不要なので解放する
//（envMap テクスチャはこの先も使うので解放しない）。
environmentScene.dispose();
pmremGenerator.dispose();

// ============================================================================
// 3. Camera（視点）
//    PerspectiveCamera = 遠近感のあるカメラ（遠い物が小さく見える）。
//    引数: (画角°, アスペクト比, 描画する最短距離, 最長距離)
// ============================================================================
const camera = new THREE.PerspectiveCamera(
  45, // 画角(fov)。人の視野に近い自然な値
  window.innerWidth / window.innerHeight, // 横/縦の比。歪み防止に画面比を渡す
  0.1, // これより近い物は描かない
  100, // これより遠い物は描かない
);
// カメラの位置。器(高さ約3)が全部見えるよう、少し上・手前に引いて置く。
camera.position.set(0, 2, 6);

// ============================================================================
// 4. Light（光源） — 最低2種類
//    半透明マテリアルは光の当たり方で立体感が出るため、光は必須。
//    （環境マップも光源として効くが、陰影づけのため通常の光も併用する）
// ============================================================================
// 環境光：空間全体をムラなく柔らかく照らす（影の中も真っ暗にしない）
const ambientLight = new THREE.AmbientLight(0xffffff, 0.15); // 色, 強さ
scene.add(ambientLight);

// 方向光：太陽のように一方向から差す平行光。陰影=立体感を作る主役。
const directionalLight = new THREE.DirectionalLight(0xffffff, 0.4);
directionalLight.position.set(5, 8, 5); // どこから差すか（右上手前）
scene.add(directionalLight);

// 半球光：上(空色)と下(地色)から全方向を均等に照らす光。
// これがないと方向光は上からだけなので、下から見上げたとき液体の面が影になって
// 暗くくすみ、色が灰色っぽく見えてしまう。全方向を照らすことで、どの角度でも
// 液体の色がはっきり出るようにする。
const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 0.2);
scene.add(hemisphereLight);

// ============================================================================
// 5. Mesh（物体） — 器と液体
//    Mesh = Geometry（形）＋ Material（材質・見え方）。
// ============================================================================

// --- 器（グラス）---------------------------------------------------------
// CylinderGeometry(上面半径, 底面半径, 高さ, 円周の分割数)。
// 分割数を多くすると角ばらず円柱が滑らかになる。
const glassGeometry = new THREE.CylinderGeometry(1.5, 1.5, 3, 64);

// 器のマテリアル。
// ※当初は transmission（物理的な光の透過）でガラスらしさを出していたが、
//   transmission は「ガラスの向こうの背景」を取り込む特殊描画のため、
//   内側の液体（ふつうの半透明オブジェクト）が背景で上書きされ、液体の色が
//   抜けてしまう。そこで transmission は使わず、ただの薄い半透明シェルにする。
//   こうすると普通のアルファ合成になり、器越しでも液体の色がそのまま透ける。
const glassMaterial = new THREE.MeshPhysicalMaterial({
  color: 0xffffff,
  transparent: true, // 透明処理を有効化
  opacity: 0.08, // うっすら存在が分かる程度（白い器が前にあると液体色が白っぽく濁るので薄め）
  roughness: 0.1, // 表面のザラつき。低いほどツルッとして映り込みがくっきり
  metalness: 0.0, // 金属ではないので0
  envMapIntensity: 0.3, // 環境マップ（映り込み）の強さ。大きいほど周囲がはっきり映る（白飛び防止で控えめに）
  side: THREE.DoubleSide, // 内側の面も描く（中の液体越しに器が見えるように）
  // 器も深度書き込みを切る。これがないと、下から見上げたとき先に描かれる器の底面が
  // 深度を書き込み、その奥にある液体が「奥だから」と判定されて捨てられ赤が消える。
  depthWrite: false,
});
const glass = new THREE.Mesh(glassGeometry, glassMaterial);
scene.add(glass);

// --- 液体 ---------------------------------------------------------------
// 器より少し細く・低くして、底に7〜8分目まで溜まっている見た目にする。
// 器の高さ3に対し、液体の高さ2.2 ≒ 約7.3分目。
const liquidGeometry = new THREE.CylinderGeometry(1.4, 1.4, 2.2, 64);

const liquidMaterial = new THREE.MeshPhysicalMaterial({
  // 0〜255 の定数を Three.js 用の 0〜1 に変換して色を設定
  color: new THREE.Color(
    LIQUID_COLOR.r / 255,
    LIQUID_COLOR.g / 255,
    LIQUID_COLOR.b / 255,
  ),
  transparent: true,
  opacity: LIQUID_OPACITY, // ★冒頭の定数で透け具合を制御（小さいほど透ける）
  roughness: 0.25, // 液面のザラつき。上げると白い鏡面ハイライトが弱まり液体色が出やすい
  metalness: 0.0,
  envMapIntensity: 0.3, // 液面への映り込みの強さ（白飛び防止で控えめに）
  // 両面描画。これがないと外向きの面だけ描かれ、下から器の中を見上げたとき
  // 液体の内側（背面）が素通しになって赤が消える。両面にすると全方向で色が出る。
  side: THREE.DoubleSide,
  // 深度バッファへの書き込みを切る。透明な面どうしが「奥にある」と判定されて
  // 互いに描画を捨て合うのを防ぎ、手前と奥の面をすべて重ねて描けるようにする
  // （透明オブジェクトの定番設定。これがないと見る角度で面が欠ける）。
  depthWrite: false,
  // ※ transmission（物理的な光の透過）は今は使わない。
  //   transmission を入れると透け具合をそちらが支配し、opacity が効かなくなるため、
  //   ここでは opacity による素直なアルファ透過で透明度を制御する。
});
const liquid = new THREE.Mesh(liquidGeometry, liquidMaterial);
// 液体を器の底側へ下げる。器の中心(y=0)から、
// 「器の半分(1.5) − 液体の半分(1.1) = 0.4」下げると底にぴったり着くが、
// それだと液体の底面と器の底面が同じ高さ(y=-1.5)で重なり、真下から見たとき
// z-fighting（どちらの面が手前か決まらずチラつく現象）が起きる。
// そこで 0.05 だけ浮かせて (y=-0.35) 底面どうしの重なりを避ける。
liquid.position.y = -0.35;
scene.add(liquid);

// --- 透け確認用の格子（GridHelper）-------------------------------------
// GridHelper(全体の大きさ, マス目の分割数, 中央線の色, 枠線の色) は
// Three.js 標準の「格子」。これを液体の後ろに立てておくと、
// 格子が液体越しに透けて見えるので、透明度(opacity)の変化が直感的に分かる。
const grid = new THREE.GridHelper(10, 10, 0x888888, 0x888888);
// GridHelper は初期状態では床のように水平に寝ている。
// X軸まわりに90度回して垂直に立たせ、器の後ろ(z=-4)に配置する。
grid.rotation.x = Math.PI / 2; // 90度（ラジアン）回転して縦向きに
grid.position.z = -4; // カメラから見て器の奥へ下げる
scene.add(grid);

// ============================================================================
// 6. OrbitControls（マウス操作）
//    ドラッグでカメラを回転、ホイールでズームできるようにする。
//    どの canvas 上のマウス操作を拾うか渡すため、第2引数に renderer.domElement。
// ============================================================================
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true; // 慣性をつけ、ドラッグを離しても滑らかに止まる
controls.target.set(0, 0, 0); // 器の中心を見つめながら回る

// ============================================================================
// 6.5 後処理（ポストプロセス）— ステップ5：bloom
//   通常は「renderer が描いた絵」をそのまま画面に出すが、後処理では
//   いったん絵を作ってから効果(bloom 等)を順番に重ねて、最後に画面へ出す。
//   その「流れ作業の管理役」が EffectComposer。pass を addPass した順に処理される。
//     1) RenderPass   … まず普通にシーンを描く（土台の絵）
//     2) UnrealBloomPass … 明るい部分を抽出してぼかし、元の絵に光として足す
//     3) OutputPass   … 最後に色空間(sRGB)へ正しく変換して画面へ出す
//        ※ EffectComposer を使うと renderer 直描画の色変換が効かなくなるため、
//          OutputPass で戻さないと色がくすむ。最新Three.jsでの定番の締め。
// ============================================================================
const composer = new EffectComposer(renderer);
composer.setPixelRatio(window.devicePixelRatio);
composer.addPass(new RenderPass(scene, camera)); // (1) 土台の絵

const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight), // 効果をかける解像度
  bloom.strength, // 強さ（プリセットから）
  bloom.radius, // にじみ半径
  bloom.threshold, // 光り始める明るさの閾値
);
composer.addPass(bloomPass); // (2) bloom
composer.addPass(new OutputPass()); // (3) 色を画面用に整えて出力

// ============================================================================
// アニメーションループ
//   requestAnimationFrame は「次の描画タイミングで関数を呼んで」とブラウザに依頼する仕組み。
//   毎フレーム呼び続けることで、操作やアニメを反映した最新の絵を描き続ける。
//   ※ 後処理を入れたので renderer.render ではなく composer.render() を呼ぶ。
// ============================================================================
function animate() {
  requestAnimationFrame(animate); // 次フレームでも自分を呼ぶ（ループ継続）
  controls.update(); // マウス操作と慣性(damping)を反映
  composer.render(); // RenderPass→Bloom→Output の順に処理して画面へ出す
}
animate();

// ============================================================================
// ウィンドウリサイズ対応
//   画面サイズが変わったら、カメラの比率と描画サイズを追従させる
//   （これをしないと画面比が崩れ、絵が縦横に伸びてしまう）。
//   後処理を入れたので composer と bloomPass のサイズも一緒に更新する。
// ============================================================================
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h; // 画面比を更新
  camera.updateProjectionMatrix(); // カメラ設定の変更を確定させる
  renderer.setSize(w, h); // 描画サイズを更新
  composer.setSize(w, h); // 後処理の作業バッファも同じサイズに
  bloomPass.setSize(w, h); // bloom の解像度も追従
});
