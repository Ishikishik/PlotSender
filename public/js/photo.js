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
let latestToken = null;   // ESP32 から最後に届いた6桁のトークン
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

// 選択した画像を自分のサーバーに送信する。
async function sendPhotoToAI() {
  const file = imageInput.files[0];
  if (sending || !imageReady || !file) return;

  const formData = new FormData();
  formData.append("image", file);
  formData.append("token", latestToken);

  sending = true;
  imageInput.disabled = true;
  updateSendButton();
  aiStatus.textContent = "写真を送信しています…";

  try {
    const response = await fetch("/api/ai", {
      method: "POST",
      body: formData,
    });
    if (response.status === 401) {
      throw new Error("トークンが一致しませんでした。ESP32 の接続と時刻を確認してください。");
    }
    if (!response.ok) {
      throw new Error(`送信に失敗しました（HTTP ${response.status}）。`);
    }
    // 返ってきた画像を「AI処理の結果」に表示する。
    if (aiPreviewUrl) URL.revokeObjectURL(aiPreviewUrl);
    aiPreviewUrl = URL.createObjectURL(await response.blob());
    aiPreview.src = aiPreviewUrl;
    aiPreview.hidden = false;
    aiStatus.textContent = "AI処理の結果を表示しました。";
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

sendToAiButton.addEventListener("click", sendPhotoToAI);

// ESP32 と Web Serial で接続し、毎分届く "TOTP 123456" の行からトークンを保存する。
onSerialReceive((line) => {
  const m = line.match(/^TOTP (\d{6})$/);
  if (!m) return;
  latestToken = m[1];
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
