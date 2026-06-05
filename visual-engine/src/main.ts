// ============================================================================
// カクテル3Dビジュアル化エンジン — ステップ1＋4
// 「半透明の色つき液体が入った器を、マウスでぐるぐる回して眺める」
// ＋ 周囲の環境を映り込ませて（環境マップ）ガラスらしさ・リアルさを上げる。
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

// ============================================================================
// 1. Renderer（描画装置）
//    計算結果を canvas に描く。antialias で輪郭のギザギザを滑らかにする。
// ============================================================================
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight); // 画面サイズに合わせる
renderer.setPixelRatio(window.devicePixelRatio); // 高精細ディスプレイ対応
document.body.appendChild(renderer.domElement); // 生成した canvas を画面に追加

// ============================================================================
// 2. Scene（3D空間）
//    これから作る器・液体・光・カメラを、すべてこの中に add していく。
// ============================================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdfe2e8); // 空間の背景色（明るいグレー＝透明感が分かりやすい）

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
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6); // 色, 強さ
scene.add(ambientLight);

// 方向光：太陽のように一方向から差す平行光。陰影=立体感を作る主役。
const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
directionalLight.position.set(5, 8, 5); // どこから差すか（右上手前）
scene.add(directionalLight);

// 半球光：上(空色)と下(地色)から全方向を均等に照らす光。
// これがないと方向光は上からだけなので、下から見上げたとき液体の面が影になって
// 暗くくすみ、色が灰色っぽく見えてしまう。全方向を照らすことで、どの角度でも
// 液体の色がはっきり出るようにする。
const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xffffff, 1.0);
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
  opacity: 0.15, // うっすら存在が分かる程度（小さいほど器は目立たない）
  roughness: 0.1, // 表面のザラつき。低いほどツルッとして映り込みがくっきり
  metalness: 0.0, // 金属ではないので0
  envMapIntensity: 1.0, // 環境マップ（映り込み）の強さ。大きいほど周囲がはっきり映る
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
  roughness: 0.15, // 液面を少しなめらかに（映り込みも少し出る）
  metalness: 0.0,
  envMapIntensity: 1.0, // 液面への映り込みの強さ
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
// アニメーションループ
//   requestAnimationFrame は「次の描画タイミングで関数を呼んで」とブラウザに依頼する仕組み。
//   毎フレーム呼び続けることで、操作やアニメを反映した最新の絵を描き続ける。
// ============================================================================
function animate() {
  requestAnimationFrame(animate); // 次フレームでも自分を呼ぶ（ループ継続）
  controls.update(); // マウス操作と慣性(damping)を反映
  renderer.render(scene, camera); // Scene を Camera から見た絵として描画
}
animate();

// ============================================================================
// ウィンドウリサイズ対応
//   画面サイズが変わったら、カメラの比率と描画サイズを追従させる
//   （これをしないと画面比が崩れ、絵が縦横に伸びてしまう）。
// ============================================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight; // 画面比を更新
  camera.updateProjectionMatrix(); // カメラ設定の変更を確定させる
  renderer.setSize(window.innerWidth, window.innerHeight); // 描画サイズを更新
});
