// app.js — 画面まわり（アルゴリズム本体は library.js）

const STORAGE_KEY = "vectorizerTuner.settings";
const $ = id => document.getElementById(id);

const state = {
  cvReady: false,
  cvError: null,
  cvThenHooked: false,
  image: null,          // 読み込んだ HTMLImageElement
  imageName: "sample.png",
  settings: loadSettings(),
  result: null,
  guardMask: null,      // 白を守るためのマスク（描画順プレビューで使う）
  running: false,
  rerunQueued: false,
  history: [],
  lastRunSettings: null
};

/* ---------- 起動 ---------- */

// 同じフォルダの opencv.js を先に試し、無ければネットから読み込む
const OPENCV_SOURCES = ["opencv.js", "https://docs.opencv.org/4.10.0/opencv.js"];

function loadOpenCv(index = 0) {
  if (index >= OPENCV_SOURCES.length) {
    state.cvError = "OpenCV.js を読み込めませんでした（opencv.js が無く、ネットからも取得できません）";
    setStatus(state.cvError);
    return;
  }
  const script = document.createElement("script");
  script.src = OPENCV_SOURCES[index];
  script.async = true;
  script.onload = () => waitForOpenCv(Date.now());
  script.onerror = () => { script.remove(); loadOpenCv(index + 1); };
  document.body.appendChild(script);
}

// opencv.js は版によって「すぐ使える」「Promise を返す」「初期化を待つ」の違いがあるので、
// 使えるようになるまで定期的に確かめる。
function waitForOpenCv(startedAt) {
  if (state.cvReady) return;
  const c = window.cv;
  if (c && c.Mat) return markReady();
  if (c && typeof c.then === "function" && !state.cvThenHooked) {
    state.cvThenHooked = true;
    c.then(m => { if (m && m.Mat) { window.cv = m; markReady(); } });
  }
  if (Date.now() - startedAt > 60000) {
    state.cvError = "OpenCV.js の初期化が終わりませんでした";
    setStatus(state.cvError);
    return;
  }
  setTimeout(() => waitForOpenCv(startedAt), 100);
}

function markReady() {
  if (state.cvReady) return;
  state.cvReady = true;
  updateRunButton();
  setStatus(state.image ? `準備完了（${state.imageName}）` : "画像を読み込み中…");
}

loadOpenCv();
buildSettingsForm();
loadImageFromUrl("sample.png", "sample.png");

$("runButton").addEventListener("click", run);
$("downloadButton").addEventListener("click", downloadResult);
$("fileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (file) loadImageFromFile(file);
});
$("maxSize").addEventListener("change", scheduleAutoRun);
$("orderSlider").addEventListener("input", e => renderOrder(Number(e.target.value)));
$("copySettings").addEventListener("click", copySettings);
$("resetSettings").addEventListener("click", () => {
  state.settings = { ...DEFAULT_SETTINGS };
  saveSettings();
  buildSettingsForm();
  scheduleAutoRun();
});

// キャンバスをクリックすると横幅いっぱいに拡大
$("grid").addEventListener("click", e => {
  if (e.target.tagName === "CANVAS") e.target.closest("figure").classList.toggle("zoom");
});

// 画像のドラッグ＆ドロップ
document.addEventListener("dragover", e => { e.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", e => { if (e.target === document.documentElement || e.clientX === 0) document.body.classList.remove("dragging"); });
document.addEventListener("drop", e => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  const file = e.dataTransfer.files[0];
  if (file && file.type.startsWith("image/")) loadImageFromFile(file);
});

/* ---------- 画像 ---------- */

function loadImageFromFile(file) {
  loadImageFromUrl(URL.createObjectURL(file), file.name);
}

function loadImageFromUrl(url, name) {
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageName = name;
    drawSourcePreview();
    updateRunButton();
    const cvNote = state.cvReady ? "" : state.cvError ? `／${state.cvError}` : "／OpenCV.js を準備中…";
    setStatus(`${name}（${img.naturalWidth}×${img.naturalHeight}）を読み込みました${cvNote}`);
    scheduleAutoRun();
  };
  img.onerror = () => setStatus(`${name} を読み込めませんでした`);
  img.src = url;
}

// 「縮小 最大」に合わせて縮小したキャンバスを返す
function sourceCanvas() {
  const img = state.image;
  const max = Number($("maxSize").value);
  const scale = max > 0 ? Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight)) : 1;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";                       // 透過PNGの透明部分は白にする
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function drawSourcePreview() {
  const src = sourceCanvas();
  const out = $("canvasSrc");
  out.width = src.width;
  out.height = src.height;
  out.getContext("2d").drawImage(src, 0, 0);
}

/* ---------- 実行 ---------- */

async function run() {
  if (!state.cvReady || !state.image) return;
  if (state.running) { state.rerunQueued = true; return; }

  state.running = true;
  updateRunButton();
  setStatus("処理中…");
  await waitForPaint();

  const settings = { ...state.settings };
  const algo = createTimer();
  const render = createTimer();
  let output = null;

  try {
    const canvas = render.time("画像の読み込み", () => { drawSourcePreview(); return sourceCanvas(); });
    const src = render.time("cv.imread", () => cv.imread(canvas));

    output = runPipeline(src, settings, algo);
    const diffStats = render.time("プレビュー描画", () => renderAll(src, output, settings, render));
    src.delete();

    state.result = output.result;
    showSummary(output.result, diffStats);
    showTimes(algo, render);
    addHistory(algo, render, output.result, diffStats, settings);
    setupOrderSlider();
    $("downloadButton").disabled = false;
    setStatus(`${output.result.strokes.length} 本の線と ${output.result.fills.length} 個の塗り（アルゴリズム ${fmt(algo.total())}）`);
  } catch (error) {
    console.error(error);
    setStatus(`エラー: ${error.message || error}`);
    showTimes(algo, render);
  } finally {
    if (output) {
      // 描画順プレビュー用に二値画像だけ残す
      if (state.guardMask) state.guardMask.delete();
      state.guardMask = output.mats.cleaned.clone();
      deleteMats(output.mats);
    }
    state.running = false;
    updateRunButton();
    if (state.rerunQueued) { state.rerunQueued = false; run(); }
  }
}

function renderAll(src, output, settings, timer) {
  const { result, segments, mats } = output;
  const rows = src.rows;
  const cols = src.cols;
  const step = settings.emulatorStepPx;
  const t = timer.time;

  t("二値化/距離/細線/接続", () => {
    cv.imshow("canvasBin", mats.cleaned);
    const distShow = normalizeToShow(mats.dist);
    cv.imshow("canvasDist", distShow);
    distShow.delete();
    cv.imshow("canvasThin", mats.thin);
    cv.imshow("canvasConnect", mats.connected);
  });
  show("canvasSegments", t("線分割", () => drawSegments(rows, cols, segments)));
  show("canvasBezier", t("ベジェ中心線", () => drawBezierStrokes(rows, cols, result.strokes)));
  show("canvasWidth", t("太さつき再現", () => drawWidthPreview(rows, cols, result.strokes, mats.cleaned, step)));
  show("canvasFill", t("塗りつぶし候補", () => drawFillPreview(rows, cols, result.fills, step)));

  const plotted = t("プロッタ再現", () => drawPlotterMask(rows, cols, result.strokes, result.fills, mats.cleaned, step));
  show("canvasEmulator", maskToRgba(plotted));
  const diff = t("差分", () => drawDifference(mats.cleaned, plotted));
  show("canvasDiff", diff.mat);
  plotted.delete();
  return diff.stats;
}

function show(canvasId, mat) {
  cv.imshow(canvasId, mat);
  mat.delete();
}

function waitForPaint() {
  return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

/* ---------- 処理時間の表示 ---------- */

function showTimes(algo, render) {
  const table = $("timeTable");
  table.innerHTML = "";
  appendTimeSection(table, "アルゴリズム", algo);
  appendTimeSection(table, "表示（プレビュー）", render);
  $("timeTotal").textContent = `合計 ${fmt(algo.total() + render.total())}`;
}

function appendTimeSection(table, title, timer) {
  const head = table.insertRow();
  head.innerHTML = `<td class="label"><b>${title}</b></td><td class="bar"></td><td class="ms"><b>${fmt(timer.total())}</b></td>`;
  const top = timer.records.filter(r => r.depth === 0);
  const max = Math.max(1, ...timer.records.map(r => r.ms));
  const slowest = top.reduce((a, b) => (b.ms > (a ? a.ms : -1) ? b : a), null);

  for (const r of timer.records) {
    const row = table.insertRow();
    if (r.depth > 0) row.className = "sub";
    if (r === slowest) row.classList.add("slowest");
    row.innerHTML =
      `<td class="label">${escapeHtml(r.label)}</td>` +
      `<td class="bar"><div class="barfill" style="width:${(r.ms / max) * 100}%"></div></td>` +
      `<td class="ms">${fmt(r.ms)}</td>`;
  }
}

function addHistory(algo, render, result, diffStats, settings) {
  const changes = state.lastRunSettings ? settingsDiff(state.lastRunSettings, settings) : [];
  state.lastRunSettings = { ...settings };
  state.history.unshift({
    at: new Date().toLocaleTimeString(),
    image: state.imageName,
    algoMs: algo.total(),
    renderMs: render.total(),
    strokes: result.strokes.length,
    coverage: coverage(diffStats),
    changes
  });
  state.history = state.history.slice(0, 15);

  $("history").innerHTML = state.history.map(h =>
    `<li>${h.at}  アルゴ ${fmt(h.algoMs)} / 表示 ${fmt(h.renderMs)}  線${h.strokes}  再現${h.coverage}` +
    (h.changes.length ? `<div class="diff">${escapeHtml(h.changes.join(", "))}</div>` : "") +
    `</li>`
  ).join("");
}

function settingsDiff(a, b) {
  return Object.keys(b).filter(k => a[k] !== b[k]).map(k => `${k}: ${a[k]}→${b[k]}`);
}

function coverage(stats) {
  return stats.target === 0 ? "-" : `${((stats.match / stats.target) * 100).toFixed(1)}%`;
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

/* ---------- 結果 ---------- */

function showSummary(result, diffStats) {
  const summary = summarizeResult(result);
  summary.diff = {
    再現率: coverage(diffStats),
    描けていないpx: diffStats.missing,
    はみ出しpx: diffStats.extra
  };
  $("summary").textContent = JSON.stringify(summary, null, 2);
}

function setupOrderSlider() {
  const slider = $("orderSlider");
  slider.max = state.result.drawOrder.length;
  slider.value = 0;
  slider.disabled = state.result.drawOrder.length === 0;
  renderOrder(0);
}

function renderOrder(step) {
  const result = state.result;
  if (!result) return;
  show("canvasOrder", drawOrderPreview(result, step, state.guardMask, state.settings.emulatorStepPx));

  const meta = $("orderMeta");
  const total = result.drawOrder.length;
  if (total === 0) { meta.textContent = "描画命令がありません"; return; }
  if (step >= total) { meta.textContent = `${step}/${total} 完了`; return; }
  const c = result.drawOrder[step];
  const id = c.type === "stroke" ? `stroke:${c.strokeId}` : `fill:${c.fillId}/${c.strokeIndex}`;
  meta.textContent = `${step}/${total}  ${c.group}  ${id}  ${c.reverse ? "reverse" : "forward"}  （緑=書き始め）`;
}

function downloadResult() {
  if (!state.result) return;
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "plotter-strokes.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- 設定フォーム ---------- */

function buildSettingsForm() {
  const form = $("settingsForm");
  form.innerHTML = "";
  const groups = {};

  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const info = SETTING_INFO[key] || { group: "その他", label: "" };
    if (!groups[info.group]) {
      const fs = document.createElement("fieldset");
      fs.innerHTML = `<legend>${info.group}</legend>`;
      form.appendChild(fs);
      groups[info.group] = fs;
    }
    groups[info.group].appendChild(settingRow(key, info));
  }
}

function settingRow(key, info) {
  const row = document.createElement("label");
  row.className = "setting";
  const def = DEFAULT_SETTINGS[key];
  const input = document.createElement("input");

  if (typeof def === "boolean") {
    input.type = "checkbox";
    input.checked = state.settings[key];
  } else {
    input.type = "number";
    input.value = state.settings[key];
    if (info.min !== undefined) input.min = info.min;
    if (info.max !== undefined) input.max = info.max;
    input.step = info.step ?? "any";
  }

  row.innerHTML = `<span class="name" title="初期値: ${def}">${key}</span>`;
  row.appendChild(input);
  const desc = document.createElement("span");
  desc.className = "desc";
  desc.textContent = `${info.label}（初期値 ${def}）`;
  row.appendChild(desc);
  markChanged(row, key);

  input.addEventListener("input", () => {
    if (typeof def === "boolean") {
      state.settings[key] = input.checked;
    } else {
      if (input.value === "" || Number.isNaN(input.valueAsNumber)) return;
      state.settings[key] = input.valueAsNumber;
    }
    markChanged(row, key);
    saveSettings();
    scheduleAutoRun();
  });
  return row;
}

function markChanged(row, key) {
  row.classList.toggle("changed", state.settings[key] !== DEFAULT_SETTINGS[key]);
}

async function copySettings() {
  const text = JSON.stringify(state.settings, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    setStatus("設定をクリップボードにコピーしました");
  } catch {
    console.log(text);
    setStatus("コピーできなかったので、コンソールに出力しました");
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof saved[key] === typeof DEFAULT_SETTINGS[key]) merged[key] = saved[key];
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings)); } catch { /* 保存できなくても動作は続ける */ }
}

let autoRunTimer = null;
function scheduleAutoRun() {
  if (!$("autoRun").checked) return;
  clearTimeout(autoRunTimer);
  autoRunTimer = setTimeout(run, 400);
}

/* ---------- その他 ---------- */

function updateRunButton() {
  $("runButton").disabled = !state.cvReady || !state.image || state.running;
  $("runButton").textContent = state.running ? "処理中…" : "実行";
}

function setStatus(text) {
  $("status").textContent = text;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
