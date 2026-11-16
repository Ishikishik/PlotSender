// パンタグラフのタブの一番下: 格子の写真から補正データを作ってサーバーへ送る。
// 計算(calibrate.js)と OpenCV.js は重いので、送るボタンを押したときに初めて読み込む。
// 送るには QR のトークンが要る(AI 生成と同じく 1 回で使い切り)。

const calInput = document.querySelector("#cal-input");
const calSend = document.querySelector("#cal-send");
const calStatus = document.querySelector("#cal-status");
const calCurrent = document.querySelector("#cal-current");
const calLog = document.querySelector("#cal-log");
const calDebug = document.querySelector("#cal-debug");

let calRunning = false;
let calScriptPromise = null;
// 機械が今使っている補正データの番号(QR の URL に入っている。"0" はファームに入っている表)。
// 「補正ありで描いた」ときは、サーバーの最新ではなく、この表に残りのずれを足す
const calBase = new URLSearchParams(location.search).get("base");

function updateCalButton() {
  calSend.disabled = calRunning || !calInput.files[0] || tokenKind !== "qr" || !latestToken;
  if (!calRunning && calInput.files[0] && tokenKind !== "qr") {
    calStatus.textContent = "送るには、機械の画面の QR を読み取って開き直してください。";
  }
}

function loadCalibrateScript() {
  if (calScriptPromise) return calScriptPromise;
  calScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "./js/calibrate.js";
    script.onload = resolve;
    script.onerror = () => { calScriptPromise = null; reject(new Error("calibrate.js を読み込めませんでした")); };
    document.head.appendChild(script);
  });
  return calScriptPromise;
}

// 機械が今使っている補正データ(QR の番号で探す)
async function fetchMachineCorrection() {
  if (!calBase) throw new Error("機械が使っている補正データがわかりません。機械の画面の QR を読み取って開き直してください");
  const url = calBase === "0" ? "./correction_default.json" : `/api/correction?id=${encodeURIComponent(calBase)}`;
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) {
    throw new Error(`機械が使っている補正データ(番号 ${calBase})がサーバーにありません。` +
                    "「Cal grid raw」で描いて「補正なしで描いた」で作り直してください");
  }
  return r.json();
}

async function showCurrentCorrection() {
  try {
    const c = await fetchMachineCorrection();
    calCurrent.textContent = `${c.version || "不明"}(番号 ${calBase})`;
  } catch {
    calCurrent.textContent = calBase ? `番号 ${calBase}(サーバーにありません)` : "不明(機械の QR から開くとわかります)";
  }
}

// 写真ファイルを、向きを直した状態で読み込む
function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("写真を読み込めませんでした"));
    img.src = URL.createObjectURL(file);
  });
}

async function sendCalibration() {
  const file = calInput.files[0];
  if (calRunning || !file) return;
  const update = document.querySelector('input[name="cal-mode"]:checked').value === "update";
  calRunning = true;
  updateCalButton();
  calLog.textContent = "";
  calDebug.hidden = true;
  let rgba = null, result = null;
  try {
    calStatus.textContent = "計算の準備をしています…(初回は数秒かかります)";
    await Promise.all([loadOpenCv(), loadCalibrateScript()]);
    const current = update ? await fetchMachineCorrection() : null;
    const img = await loadImage(file);
    calStatus.textContent = "写真から格子を読み取っています…";
    await new Promise(r => setTimeout(r, 30));   // 表示を更新してから重い計算をする

    rgba = cv.imread(img);
    URL.revokeObjectURL(img.src);
    const longSide = Math.max(rgba.cols, rgba.rows);
    if (longSide > 4096) {           // 大きすぎる写真は縮める(精度は 4000 px あれば足りる)
      const scaled = new cv.Mat(), k = 4096 / longSide;
      cv.resize(rgba, scaled, new cv.Size(Math.round(rgba.cols * k), Math.round(rgba.rows * k)), 0, 0, cv.INTER_AREA);
      rgba.delete();
      rgba = scaled;
    }
    result = makeCorrection(cv, rgba, { update, current, onLog: s => { calLog.textContent += s + "\n"; } });
    cv.imshow(calDebug, result.debug);
    calDebug.hidden = false;

    calStatus.textContent = "サーバーへ送っています…";
    const response = await fetch("/api/correction", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: latestToken, table: result.table, base: update ? calBase : "" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `送信に失敗しました(HTTP ${response.status})`);
    calStatus.textContent = `補正データを保存しました(${body.version}、番号 ${body.id})。` +
      "パンタグラフの Setting のタブを開くと読み込みます。次に「補正ありで描いた」で送るときは、機械の QR を読み直してください。";
    useUpQrToken();
  } catch (error) {
    console.error(error);
    calStatus.textContent = `できませんでした: ${error.message || error}`;
  } finally {
    if (rgba) rgba.delete();
    if (result) result.debug.delete();
    calRunning = false;
    updateCalButton();
  }
}

calInput.addEventListener("change", () => { calStatus.textContent = ""; updateCalButton(); });
calSend.addEventListener("click", sendCalibration);
updateCalButton();
showCurrentCorrection();
