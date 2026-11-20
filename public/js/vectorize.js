// AI が返した線画を、ペンプロッター用のストローク（ベジェ曲線）に変換して表示する。
// アルゴリズム本体は library.js（test/vectorizer で調整したもの。設定は DEFAULT_SETTINGS の初期値）。
// OpenCV.js は 10MB あるので、最初に変換するときに初めて読み込む。

const plotPreview = document.querySelector("#plot-preview");
const plotStatus = document.querySelector("#plot-status");
const downloadPlotButton = document.querySelector("#download-plot");
// 紙の設定は固定。cutting_machine(パンタグラフ)の描ける範囲 140 × 75 mm に合わせる
// (firm/src/config/PlotterConfig.h の PAPER_X_MIN〜MAX、PAPER_Y_MIN〜MAX)。この長さより短い線は描かない
// marginLeft / marginRight: 紙の左右で、腕が届かない所を空ける幅 [mm]。機械の寸法(補正データ)から sdsend.js の
// updateReachMargins が計算して書き換える(読めるまでは 3 mm ずつ)。届かない点があると、機械はそこを飛ばして描く
const PAPER_OPTIONS = { paperWidth: 140, paperHeight: 75, minStrokeMm: 0.4, marginLeft: 3, marginRight: 3 };
// 前の線の終わりから次の線の始まりまでがこの距離以内で、間が元の画像の黒なら、ペンを上げずにつなぐ [mm]
// (交点で分かれた線どうし。library.js の markJoins)。ページの URL に ?join=2 のように付けると、その値で試せる
const JOIN_MAX_MM = (v => Number.isFinite(v) && v >= 0 ? v : 1.5)(parseFloat(new URLSearchParams(location.search).get("join")));
const paperStatus = document.querySelector("#paper-status");

const VECTORIZE_MAX_SIZE = 1024;
// ペンの線の太さ [mm]。プレビューはこの太さで描く(元の画像の線の太さではなく、実際に紙に出る太さ)。
// これの 2 倍より太い黒い所は、線 1 本では埋まらないので塗りにする
const PEN_WIDTH_MM = 0.3;   // これより大きい画像は縮小してから処理する
let openCvPromise = null;
let plotterResult = null;          // 最後に作ったストロークのデータ（ESP32 へ送るときに使う）

function loadOpenCv() {
  if (openCvPromise) return openCvPromise;
  openCvPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./js/opencv.js";
    script.async = true;
    script.onerror = () => {
      openCvPromise = null;
      reject(new Error("OpenCV.js を読み込めませんでした"));
    };
    script.onload = () => {
      // 版によって準備完了の知らせ方が違うので、使えるようになるまで確かめる
      const started = Date.now();
      let hooked = false;
      (function check() {
        const c = window.cv;
        if (c && c.Mat) return resolve();
        if (c && typeof c.then === "function" && !hooked) {
          hooked = true;
          c.then(m => { if (m && m.Mat) { window.cv = m; resolve(); } });
        }
        if (Date.now() - started > 60000) {
          openCvPromise = null;
          return reject(new Error("OpenCV.js の初期化が終わりませんでした"));
        }
        setTimeout(check, 100);
      })();
    };
    document.head.appendChild(script);
  });
  return openCvPromise;
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像を読み込めませんでした")); };
    img.src = url;
  });
}

function imageToCanvas(img) {
  const scale = Math.min(1, VECTORIZE_MAX_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";             // 透明部分は白（紙）として扱う
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function waitForPaint() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

// 機械で描いたときの見た目: 線はペンの太さで、塗りは範囲(外側と穴)を塗りつぶす → RGBA の cv.Mat
// (前は元の画像の線の太さで描いていたので、太い線や瞳が塗れているように見えたが、機械は細い線 1 本しか描かない)
function drawPenPreview(rows, cols, result, penPx) {
  const out = new cv.Mat(rows, cols, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255));
  const ink = new cv.Scalar(0, 0, 0, 255);
  const thickness = Math.max(1, Math.round(penPx));
  const toPoints = (curves) => {
    const pts = [];
    for (const c of curves) for (let i = 0; i < 6; i++) {
      const p = cubicPoint(c, i / 6);
      pts.push(Math.round(p.x), Math.round(p.y));
    }
    const last = curves[curves.length - 1].p1;
    pts.push(Math.round(last.x), Math.round(last.y));
    return pts;
  };
  // 塗り(偶奇規則: 穴は白のまま)
  for (const fill of result.fills || []) {
    const rings = new cv.MatVector();
    for (const contour of fill.contours || []) {
      if (contour.center.length === 0) continue;
      const m = cv.matFromArray(contour.center.length * 6 + 1, 1, cv.CV_32SC2, toPoints(contour.center));
      rings.push_back(m);
      m.delete();
    }
    if (rings.size() > 0) cv.fillPoly(out, rings, ink, cv.LINE_8);
    rings.delete();
  }
  // 線(塗りのハッチングは機械が描かないので除く)
  for (const stroke of result.strokes) {
    if (!stroke.center || stroke.center.length === 0) continue;
    const m = cv.matFromArray(stroke.center.length * 6 + 1, 1, cv.CV_32SC2, toPoints(stroke.center));
    const v = new cv.MatVector();
    v.push_back(m);
    cv.polylines(out, v, false, ink, thickness, cv.LINE_AA);
    v.delete();
    m.delete();
  }
  return out;
}

// photo.js から呼ばれる。AI の結果画像（Blob）を受け取ってベクター化する。
async function vectorizeImage(blob) {
  plotterResult = null;
  updatePaperSummary();
  plotPreview.hidden = true;

  try {
    plotStatus.textContent = "プロッタ用データを作成しています…";
    await loadOpenCv();
    const img = await blobToImage(blob);
    await waitForPaint();   // 重い処理の前に、表示を更新させる

    const settings = { ...DEFAULT_SETTINGS };
    const timer = createTimer();
    const src = cv.imread(imageToCanvas(img));
    // 紙の上での 1 px の大きさ(だいたい。絵は紙に収まる最大の大きさにする)から、ペンの太さを px にする
    const fitWidth = PAPER_OPTIONS.paperWidth - PAPER_OPTIONS.marginLeft - PAPER_OPTIONS.marginRight;
    const mmPerPx = Math.max(Math.min(fitWidth / src.cols, PAPER_OPTIONS.paperHeight / src.rows),
                             Math.min(fitWidth / src.rows, PAPER_OPTIONS.paperHeight / src.cols));
    const penPx = PEN_WIDTH_MM / mmPerPx;
    // 塗りにするのは、ペン 2 本分より太いところのうち、塊として大きいものだけ。
    // 線の交わる所や端の小さな太り(ペン 3.5 本分に届かない、または 4 本分四方より小さい)は線のままにする
    // (前はペン 2 本分で判定していて、交点ごとに小さな塗りが入り、線の途中に黒い点が並んだ)
    settings.fillCoreWidth = Math.max(3, Math.round(penPx * 2));
    settings.fillMinMaxWidth = Math.max(settings.fillCoreWidth + 2, Math.round(penPx * 3.5));
    settings.fillMinArea = Math.max(40, Math.round((penPx * 4) ** 2));
    // JOIN_MAX_MM 以内で、間が元の画像の黒なら、ペンを上げずにつなぐ(交点で分かれた線どうし)
    settings.joinMaxPx = Math.max(2, Math.round(JOIN_MAX_MM / mmPerPx));
    // 縦横 3 mm 以内の孤立した塊(口、鼻など)は、短くても線として残す。点は 0.5 mm の短い線で打つ
    settings.smallFeatureMaxPx = Math.round(3 / mmPerPx);
    settings.dotLengthPx = Math.max(2, Math.round(0.5 / mmPerPx));
    let output = null;

    try {
      output = runPipeline(src, settings, timer);
      const { result, mats } = output;

      // 実際にプロッタで描いたときの見た目を表示する(線はペンの太さ、塗りは機械が塗る範囲をそのまま黒く)
      const view = drawPenPreview(src.rows, src.cols, result, penPx);
      cv.imshow(plotPreview, view);
      view.delete();

      plotterResult = result;
      plotPreview.hidden = false;

      const summary = summarizeResult(result);
      plotStatus.textContent = !SHOW_DETAILS ? "" :
        `線 ${summary.strokes} 本・塗り ${summary.fills} 個・描画命令 ${summary.drawCommands} 件` +
        `（${(timer.total() / 1000).toFixed(1)} 秒）`;
      updatePaperSummary();
    } finally {
      src.delete();
      if (output) deleteMats(output.mats);
    }
  } catch (error) {
    console.error(error);
    plotStatus.textContent = `プロッタ用データを作れませんでした（${error.message || error}）`;
  }
}

// 紙に合わせた出力サイズと線の本数を表示し、保存ボタンの状態を更新する。
function updatePaperSummary() {
  const options = PAPER_OPTIONS;
  downloadPlotButton.disabled = !plotterResult;
  if (!plotterResult || !SHOW_DETAILS) {
    paperStatus.textContent = "";
  } else {
    const { stats } = normalizeForPlotter(plotterResult, options);
    paperStatus.textContent =
      `出力 ${stats.width.toFixed(1)} × ${stats.height.toFixed(1)} mm${stats.rotated ? "（紙を広く使うため 90° 回して置く）" : ""}・線 ${stats.strokes} 本・塗り ${stats.fills} 個（塗り方は機械が決める）・ペンを上げずにつなぐ所 ${stats.joined} か所` +
      `（短い線 ${stats.removed} 本を削除）・描く長さ ${(stats.drawMm / 1000).toFixed(2)} m`;
  }
}

downloadPlotButton.addEventListener("click", () => {
  if (!plotterResult) return;
  const { data } = normalizeForPlotter(plotterResult, PAPER_OPTIONS);
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "plotter-strokes.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
