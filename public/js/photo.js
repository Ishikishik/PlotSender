const imageInput = document.querySelector("#image-input");
const imagePreview = document.querySelector("#image-preview");
const imageStatus = document.querySelector("#image-status");

const sendToAiButton = document.querySelector("#send-to-ai");
const aiStatus = document.querySelector("#ai-status");
const aiPreview = document.querySelector("#ai-preview");
const connectEspButton = document.querySelector("#connect-esp");
const espStatus = document.querySelector("#esp-status");

let previewUrl = null;
let imageReady = false;
let sending = false;
let latestToken = null;   // ESP32 から最後に届いた6桁のトークン、または QR のトークン
let tokenKind = "serial"; // "serial"(Web Serial、1分ごと)か "qr"(QR、15分以内・1回だけ)
let aiPreviewUrl = null;

function updateSendButton() {
  sendToAiButton.disabled = sending || !imageReady || !latestToken;
}

function clearPreview() {
  imagePreview.hidden = true;
  imagePreview.removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

imageInput.addEventListener("change", () => {
  imageReady = false;
  updateSendButton();
  aiStatus.textContent = "";
  clearPreview();
  const file = imageInput.files[0];
  if (!file) {
    imageStatus.textContent = "";
    return;
  }
  imageStatus.textContent = "画像を読み込んでいます…";
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
});

imagePreview.addEventListener("load", () => {
  imagePreview.hidden = false;
  imageReady = true;
  updateSendButton();
  imageStatus.textContent = "";
});

imagePreview.addEventListener("error", () => {
  imageReady = false;
  updateSendButton();
  clearPreview();
  imageInput.value = "";
  imageStatus.textContent = "画像を読み込めませんでした。JPEGやPNGなど、別の画像を選んでください。";
});

// 送信する前に画像を縮小する設定。
// スマホの写真は数MBあるので、そのまま送ると会場の回線では時間がかかる。
// AI が出す線画は約100万画素なので、これ以上大きく送っても仕上がりは変わらない。
const UPLOAD_MAX_SIZE = 1536;       // 長辺がこれより大きければ縮小する（px）
const UPLOAD_JPEG_QUALITY = 0.85;
const UPLOAD_KEEP_BYTES = 500 * 1024;   // 小さくて軽い画像はそのまま送る

// 表示中の画像を縮小して JPEG にする。うまくいかなければ元のファイルを返す。
// <img> から描くので、写真の向き（EXIF）はブラウザが直した状態になる。
async function shrinkForUpload(file) {
  const width = imagePreview.naturalWidth;
  const height = imagePreview.naturalHeight;
  const scale = Math.min(1, UPLOAD_MAX_SIZE / Math.max(width, height));
  if (scale === 1 && file.size <= UPLOAD_KEEP_BYTES) return file;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";           // JPEG は透明を持てないので、透明部分は白にする
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(imagePreview, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", UPLOAD_JPEG_QUALITY));
    // 変換できなかったときと、かえって大きくなったときは元のまま送る
    return blob && blob.size < file.size ? blob : file;
  } catch (error) {
    console.error(error);
    return file;
  }
}

const formatMb = bytes => (bytes / 1024 / 1024).toFixed(1) + "MB";

// 選択した画像を自分のサーバーに送信する。
async function sendPhotoToAI() {
  const file = imageInput.files[0];
  if (sending || !imageReady || !file) return;

  sending = true;
  imageInput.disabled = true;
  updateSendButton();
  aiStatus.textContent = "画像を準備しています…";
  loadOpenCv().catch(() => {});   // AI を待つ間に OpenCV.js を読み込んでおく（失敗しても変換時にもう一度試す）

  try {
    const upload = await shrinkForUpload(file);
    const formData = new FormData();
    formData.append("image", upload, upload === file ? file.name : "photo.jpg");
    formData.append("token", latestToken);
    formData.append("token_kind", tokenKind);
    aiStatus.textContent = "AI で線画にしています…（数秒〜数十秒かかります）" +
      (upload === file ? "" : `［送信 ${formatMb(file.size)} → ${formatMb(upload.size)}］`);
    const sentAt = performance.now();
    const response = await fetch("/api/ai", {
      method: "POST",
      body: formData,
    });
    if (response.status === 401) {
      if (tokenKind === "qr") {
        const detail = await response.json().then((j) => j.error).catch(() => null);
        throw new Error(detail || "QR のトークンが使えませんでした。新しい QR を読み取ってください。");
      }
      throw new Error("トークンが一致しませんでした。ESP32 の接続と時刻を確認してください。");
    }
    if (!response.ok) {
      // サーバーが {"error": "..."} を返していれば、その内容を表示する。
      const detail = await response.json().then((j) => j.error).catch(() => null);
      throw new Error(`送信に失敗しました（HTTP ${response.status}）${detail ? "：" + detail : "。"}`);
    }
    // 返ってきた画像を「AI処理の結果」に表示する。
    if (aiPreviewUrl) URL.revokeObjectURL(aiPreviewUrl);
    const aiBlob = await response.blob();
    const timingText = describeTimings(performance.now() - sentAt, response.headers.get("X-AI-Timings"));
    aiPreviewUrl = URL.createObjectURL(aiBlob);
    aiPreview.src = aiPreviewUrl;
    aiPreview.hidden = false;
    aiStatus.textContent = "AI処理の結果を表示しました。" + timingText;
    if (tokenKind === "qr") useUpQrToken();
    vectorizeImage(aiBlob);   // 続けてプロッタ用データを作る（vectorize.js）
  } catch (error) {
    aiStatus.textContent = error instanceof TypeError
      ? "通信エラーで送信を確認できませんでした。"
      : error.message;
  } finally {
    sending = false;
    imageInput.disabled = false;
    updateSendButton();
  }
}

// かかった時間の内訳を文にする。totalMs はブラウザで測った全体、header はサーバーの X-AI-Timings(JSON)
function describeTimings(totalMs, header) {
  const sec = (ms) => (ms / 1000).toFixed(1) + " 秒";
  let t = {};
  try { t = JSON.parse(header || "{}"); } catch { /* 古いサーバーなど */ }
  console.log("AI timings [ms]", { total: Math.round(totalMs), ...t });
  const parts = [];
  if (t.queue != null) parts.push(`AI の起動・順番待ち ${sec(t.queue)}`);
  if (t.predict != null) parts.push(`AI の計算 ${sec(t.predict)}`);
  if (t.download != null) parts.push(`画像の取得 ${sec(t.download)}`);
  if (t.server != null) parts.push(`サーバー全体 ${sec(t.server)}`);
  return `（全体 ${sec(totalMs)}${parts.length ? "：" + parts.join("・") : ""}）`;
}

sendToAiButton.addEventListener("click", sendPhotoToAI);

// ESP32 と Web Serial で接続し、毎分届く "TOTP 123456" の行からトークンを保存する。
onSerialReceive((line) => {
  const m = line.match(/^TOTP (\d{6})$/);
  if (!m) return;
  latestToken = m[1];
  tokenKind = "serial";
  espStatus.textContent = "ESP32 接続中（トークン受信済み）";
  updateSendButton();
});

connectEspButton.addEventListener("click", async () => {
  try {
    await serialConnect(115200);
    espStatus.textContent = "ESP32 接続中（トークン待ち）";
    await serialSend("TOTP");   // 接続直後に今の分のトークンを要求する
  } catch (error) {
    espStatus.textContent = `接続できませんでした（${error.message}）`;
  }
});

// パンタグラフの画面の QR から来たとき(/T/123456 → /?mode=b&token=123456)は、そのトークンを使う。
// QR のトークンは 15 分以内に AI 生成 1 回だけ使える(使い切り)。
// サーバーが鍵からどの機械の QR かを判断して、そのタブ(?mode=)で開く。どの鍵にも合わなければ ?qr=invalid
const qrToken = new URLSearchParams(location.search).get("token");
if (new URLSearchParams(location.search).get("qr") === "invalid") {
  espStatus.textContent = "QR が正しくないか、15分の期限が切れています。新しい QR を読み取ってください。";
} else if (qrToken && /^\d{6}$/.test(qrToken)) {
  latestToken = qrToken;
  tokenKind = "qr";
  espStatus.textContent = "QR のトークンを使います（15分以内に AI 生成 1 回）";
  updateSendButton();
}

// 使い終わった QR のトークンを消す(URL からも消して、再読み込みで使おうとしないようにする)
function useUpQrToken() {
  latestToken = null;
  tokenKind = "serial";
  const mode = new URLSearchParams(location.search).get("mode") || "b";
  history.replaceState(null, "", location.pathname + "?mode=" + mode);
  espStatus.textContent = "QR のトークンを使いました。もう一度使うには、新しい QR を読み取ってください。";
  updateSendButton();
  if (typeof updateCalButton === "function") updateCalButton();   // 補正の送信ボタン(calibration-ui.js)
}
