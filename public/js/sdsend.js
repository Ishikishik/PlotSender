// 作った絵をパンタグラフ(cutting_machine)の SD カードへ送る。
//
// 流れ: ページ → サーバー(/api/plots で預かる) → 機械が Wi-Fi で取りに来て SD の /plots/<番号>.bez に保存する。
// 機械は 30 秒ごとに確認するので、送ってから SD に入るまで少しかかる。
//
// .bez の BEZ2 形式(リトルエンディアン。firm/src/jobs/SdPlot.h と server/main.py の check_plot と同じ):
//   "BEZ2"(4)、線の数 u16、印 u8(bit0 = 星。星の絵は機械が古くなっても消さない)、名前のバイト数 u8、
//   作った時刻 u32(Unix 秒。機械は古いものから消す)、UUID 16 バイト(番号。機械のファイル名になる)、名前(UTF-8)、
//   線ごとに: 区間の数 u16、始点 int16 x, y、区間ごとに int16 × 6(制御点1、制御点2、終点)
//   座標の単位は 0.01 mm。機械の座標(紙の左下が PAPER_X_MIN, PAPER_Y_MIN)
//
// 名前は同じでもよい(番号で区別する)。

const SD_PAPER_ORIGIN = { x: -70, y: 75 };   // firm/src/config/PlotterConfig.h の PAPER_X_MIN, PAPER_Y_MIN
const SD_NAME_MAX_CHARS = 40;
const SD_NAME_MAX_BYTES = 120;

const plotNameInput = document.querySelector("#plot-name");
const plotStarButton = document.querySelector("#plot-star");
const sendPlotButton = document.querySelector("#send-plot");
const sendPlotStatus = document.querySelector("#send-plot-status");

// QR から来たときは、そのトークンで保存も 1 回できる(AI 生成とは別に数える)。
// photo.js は AI 生成のあとで QR のトークンを消すので、ここで先に覚えておく
let sdQrToken = (typeof qrToken === "string" && /^\d{6}$/.test(qrToken)) ? qrToken : null;
let sdSending = false;

function uuidBytes() {
  const hex = (crypto.randomUUID ? crypto.randomUUID() : [...crypto.getRandomValues(new Uint8Array(16))]
    .map(b => b.toString(16).padStart(2, "0")).join("")).replace(/-/g, "");
  return Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)));
}

// 名前を UTF-8 にする。長すぎたら文字の切れ目で切る
function nameBytes(name) {
  let chars = [...name.trim()].slice(0, SD_NAME_MAX_CHARS);
  const enc = new TextEncoder();
  while (enc.encode(chars.join("")).length > SD_NAME_MAX_BYTES) chars.pop();
  return enc.encode(chars.join(""));
}

// normalizeForPlotter の data(紙の左下が原点、mm)を BEZ2 にする → Uint8Array
function encodeBez2(data, { name, starred, uuid = uuidBytes(), createdAt = Math.floor(Date.now() / 1000) }) {
  const q = (v) => {
    const r = Math.round(v * 100);
    if (r < -32768 || r > 32767) throw new Error("座標が範囲外です");
    return r;
  };
  const strokes = data.strokes.filter(s => s.length > 0);
  if (strokes.length > 65535) throw new Error("線が多すぎます");
  const nb = nameBytes(name);
  let size = 28 + nb.length;
  for (const s of strokes) {
    if (s.length > 65535) throw new Error("線が長すぎます");
    size += 6 + 12 * s.length;
  }
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x42, 0x45, 0x5a, 0x32], 0);   // "BEZ2"
  v.setUint16(4, strokes.length, true);
  v.setUint8(6, starred ? 1 : 0);
  v.setUint8(7, nb.length);
  v.setUint32(8, createdAt, true);
  u8.set(uuid, 12);
  u8.set(nb, 28);
  let o = 28 + nb.length;
  const X = (x) => q(x + SD_PAPER_ORIGIN.x);
  const Y = (y) => q(y + SD_PAPER_ORIGIN.y);
  for (const s of strokes) {
    v.setUint16(o, s.length, true);
    v.setInt16(o + 2, X(s[0][0]), true);
    v.setInt16(o + 4, Y(s[0][1]), true);
    o += 6;
    for (const c of s) {   // c = [始点 x, y, 制御点1 x, y, 制御点2 x, y, 終点 x, y]。始点は前の終点と同じ
      for (let k = 2; k < 8; k += 2) {
        v.setInt16(o, X(c[k]), true);
        v.setInt16(o + 2, Y(c[k + 1]), true);
        o += 4;
      }
    }
  }
  return u8;
}

function toBase64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// 送るのに使うトークン → { token, kind } か null
function plotSendToken() {
  if (typeof tokenKind !== "undefined" && tokenKind === "serial" && latestToken) return { token: latestToken, kind: "serial" };
  if (sdQrToken) return { token: sdQrToken, kind: "qr" };
  return null;
}

function updateSendPlotButton() {
  const ready = typeof plotterResult !== "undefined" && plotterResult;
  sendPlotButton.disabled = sdSending || !ready || !plotNameInput.value.trim() || !plotSendToken();
  if (!sdSending && ready && !plotSendToken()) {
    sendPlotStatus.textContent = "送るには ESP32 と接続するか、機械の QR を読み取ってください";
  } else if (!sdSending && ready && !plotNameInput.value.trim()) {
    sendPlotStatus.textContent = "名前を入れてください";
  } else if (!sdSending && sendPlotStatus.dataset.keep !== "1") {
    sendPlotStatus.textContent = "";
  }
}

plotStarButton.addEventListener("click", () => {
  const on = plotStarButton.getAttribute("aria-pressed") !== "true";
  plotStarButton.setAttribute("aria-pressed", String(on));
  plotStarButton.textContent = on ? "★" : "☆";
  plotStarButton.title = on ? "星あり: 機械で古くなっても消さない" : "星なし: 機械で古いものから消える";
});

plotNameInput.addEventListener("input", () => {
  sendPlotStatus.dataset.keep = "";
  updateSendPlotButton();
});

sendPlotButton.addEventListener("click", async () => {
  const auth = plotSendToken();
  if (!plotterResult || !auth) return;
  sdSending = true;
  updateSendPlotButton();
  sendPlotStatus.dataset.keep = "1";
  sendPlotStatus.textContent = "送っています…";
  try {
    const { data } = normalizeForPlotter(plotterResult, PAPER_OPTIONS);
    const starred = plotStarButton.getAttribute("aria-pressed") === "true";
    const bez = encodeBez2(data, { name: plotNameInput.value, starred });
    const response = await fetch("/api/plots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: auth.token, token_kind: auth.kind, data: toBase64(bez) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (auth.kind === "qr") sdQrToken = null;   // QR の保存は 1 回だけ
    sendPlotStatus.textContent = `送りました（${(bez.length / 1024).toFixed(1)} KB${starred ? "・★" : ""}）。` +
      `機械が Wi-Fi で取りに来ると SD に入ります（30 秒ほど）。機械の待ち: ${body.waiting} 枚`;
  } catch (error) {
    sendPlotStatus.textContent = `送れませんでした（${error.message}）`;
  } finally {
    sdSending = false;
    updateSendPlotButton();
  }
});

// 絵ができたときやトークンが届いたときにボタンの状態を変えるため、時々確かめる(vectorize.js と photo.js を変えずに済む)
setInterval(updateSendPlotButton, 1000);
updateSendPlotButton();
