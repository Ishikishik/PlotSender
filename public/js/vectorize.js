// AI が返した線画を、ペンプロッター用のストローク（ベジェ曲線）に変換して表示する。
// アルゴリズム本体は library.js（test/vectorizer で調整したもの。設定は DEFAULT_SETTINGS の初期値）。
// OpenCV.js は 10MB あるので、最初に変換するときに初めて読み込む。

const plotPreview = document.querySelector("#plot-preview");
const plotStatus = document.querySelector("#plot-status");
const downloadPlotButton = document.querySelector("#download-plot");

const VECTORIZE_MAX_SIZE = 1024;   // これより大きい画像は縮小してから処理する
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

// photo.js から呼ばれる。AI の結果画像（Blob）を受け取ってベクター化する。
async function vectorizeImage(blob) {
  plotterResult = null;
  downloadPlotButton.disabled = true;
  plotPreview.hidden = true;

  try {
    plotStatus.textContent = "プロッタ用データを作成しています…";
    await loadOpenCv();
    const img = await blobToImage(blob);
    await waitForPaint();   // 重い処理の前に、表示を更新させる

    const settings = { ...DEFAULT_SETTINGS };
    const timer = createTimer();
    const src = cv.imread(imageToCanvas(img));
    let output = null;

    try {
      output = runPipeline(src, settings, timer);
      const { result, mats } = output;

      // 実際にプロッタで描いたときの見た目を表示する
      const plotted = drawPlotterMask(src.rows, src.cols, result.strokes, result.fills, mats.cleaned, settings.emulatorStepPx);
      const view = maskToRgba(plotted);
      cv.imshow(plotPreview, view);
      view.delete();
      plotted.delete();

      plotterResult = result;
      plotPreview.hidden = false;
      downloadPlotButton.disabled = false;

      const summary = summarizeResult(result);
      plotStatus.textContent =
        `線 ${summary.strokes} 本・塗り ${summary.fills} 個・描画命令 ${summary.drawCommands} 件` +
        `（${(timer.total() / 1000).toFixed(1)} 秒）`;
    } finally {
      src.delete();
      if (output) deleteMats(output.mats);
    }
  } catch (error) {
    console.error(error);
    plotStatus.textContent = `プロッタ用データを作れませんでした（${error.message || error}）`;
  }
}

downloadPlotButton.addEventListener("click", () => {
  if (!plotterResult) return;
  const blob = new Blob([JSON.stringify(plotterResult)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "plotter-strokes.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
