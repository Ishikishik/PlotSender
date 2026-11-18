// 作った絵をパンタグラフ(cutting_machine)の SD カードへ送る。
//
// 流れ: ページ → サーバー(/api/plots で預かる) → 機械が Wi-Fi で取りに来て SD の /plots/<番号>.bez に保存する。
// 機械は 30 秒ごとに確認するので、送ってから SD に入るまで少しかかる。
//
// .bez の BEZ2 形式(リトルエンディアン。firm/src/jobs/SdPlot.h と server/main.py の check_plot と同じ):
//   "BEZ2"(4)、線の数 u16、印 u8(bit0 = 星。星の絵は機械が古くなっても消さない)、名前のバイト数 u8、
//   作った時刻 u32(Unix 秒。機械は古いものから消す)、UUID 16 バイト(番号。機械のファイル名になる)、名前(UTF-8)、
//   線ごとに: 区間の数 u16、始点 int16 x, y、区間ごとに int16 × 6(制御点1、制御点2、終点)
//   印の bit1 が立っていれば、線のあとに塗り: 塗りの数 u16、塗りごとに 輪の数 u8、輪ごとに 点の数 u16、点 int16 x, y …
//     (閉じた輪。外側と穴。機械が外から内へ同心の輪で塗る。firm/src/jobs/Fill.h)
//   座標の単位は 0.01 mm。機械の座標(紙の左下が PAPER_X_MIN, PAPER_Y_MIN)
//
// 名前は同じでもよい(番号で区別する)。

const SD_PAPER_ORIGIN = { x: -70, y: 75 };   // firm/src/config/PlotterConfig.h の PAPER_X_MIN, PAPER_Y_MIN
// 機械では紙を 180° 回して描くのが標準(機械の前に立って見たときに、ページのプレビューと同じ向きになる)
const SD_ROTATE_180 = true;
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
let sdLastFlipped = null;   // 最後に送った絵で、描く向きを逆にした線の数(geometry.js がなければ null)

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

// 腕が届く範囲に絵を収める。紙(機械の座標で y 75〜150)の高さ全部が届く x の範囲を、機械の寸法で IK を解いて求め、
// 紙の左右に空ける幅(PAPER_OPTIONS.marginLeft / marginRight)にする。寸法は補正データ(/api/correction)の geom
// (なければ設計値)。補正の表のずれ(1 mm 前後)の分、REACH_SAFETY_MM だけ外側まで届くことを確かめる。
// 実際の機械では、手前の角(x -63, y 76)に届かず、絵が途中で止まった(設計値の計算では届くはずだった)
const REACH_SAFETY_MM = 1.5;
function reachRangeX(geom, height) {
  const ok = x => {
    for (let y = SD_PAPER_ORIGIN.y; y <= SD_PAPER_ORIGIN.y + height + 1e-6; y += 0.5) if (!PlotGeometry.ik(geom, x, y)) return false;
    return true;
  };
  const half = -SD_PAPER_ORIGIN.x;
  let xl = -half, xr = half;
  while (xl < 0 && !ok(xl - REACH_SAFETY_MM)) xl += 0.5;
  while (xr > 0 && !ok(xr + REACH_SAFETY_MM)) xr -= 0.5;
  return [xl, xr];
}
async function updateReachMargins() {
  if (typeof PlotGeometry === "undefined") return;
  let geom = PlotGeometry.DEFAULT_GEOM, source = "設計値";
  try {
    const response = await fetch("/api/correction", { cache: "no-store" });
    if (response.ok) {
      const table = await response.json();
      if (table.geom) { geom = { ...PlotGeometry.DEFAULT_GEOM, ...table.geom }; source = `補正データ No. ${table.id || "?"}`; }
    }
  } catch (error) {
    console.error(error);
  }
  const [xl, xr] = reachRangeX(geom, PAPER_OPTIONS.paperHeight);
  const half = PAPER_OPTIONS.paperWidth / 2;
  // 紙の座標の x → 機械の x: 180° 回すなら half - x、回さないなら x - half
  if (SD_ROTATE_180) { PAPER_OPTIONS.marginLeft = half - xr; PAPER_OPTIONS.marginRight = half + xl; }
  else { PAPER_OPTIONS.marginLeft = half + xl; PAPER_OPTIONS.marginRight = half - xr; }
  console.log(`腕が届く範囲(${source}): 機械の x ${xl} 〜 ${xr} mm → 紙の左 ${PAPER_OPTIONS.marginLeft} mm、右 ${PAPER_OPTIONS.marginRight} mm を空ける`);
}
updateReachMargins();

// 線の描く向きを選ぶ。線は逆向きに描いても同じ形なので、描き始めでモーターが止まりかけ(すぐに回る向きが変わる)に
// ならない向きを選ぶ。止まりかけの所から描き始めると、ペン先の摩擦で腕がガタの中で引っかかっては外れ、
// 最初の数 mm がジグザグになる(bt の試し描きで、向きが変わる所まで約 5mm の描き始めで出た。約 9mm では出なかった)
const ORIENT_CHECK_MM = 6;       // 描き始めからこの長さの中で、どちらかのモーターの向きが変わったら「悪い描き始め」
const ORIENT_STEP_MM = 0.25;     // 調べる点の間隔
const ORIENT_MAX_EXTRA_MM = 10;  // 逆向きにして移動が増えるのは、ここまでなら許す
const ORIENT_JOIN_MM = 0.5;      // 前後の線とこれより近い(機械がペンを上げずにつなぐ)線は向きを変えない

// 3 次ベジェの区間 c = [x0, y0, c1x, c1y, c2x, c2y, x1, y1] の t の点
function bezAt(c, t) {
  const u = 1 - t, a = u * u * u, b = 3 * u * u * t, d = 3 * u * t * t, e = t * t * t;
  return [a * c[0] + b * c[2] + d * c[4] + e * c[6], a * c[1] + b * c[3] + d * c[5] + e * c[7]];
}

// 線の描き始めから ORIENT_CHECK_MM の点(紙の座標)。reverse なら終わりから
function strokeHeadPoints(s, reverse) {
  const pts = [];
  let len = 0;
  const segs = reverse ? s.slice().reverse() : s;
  for (const c of segs) {
    const chord = Math.hypot(c[6] - c[0], c[7] - c[1]) + Math.hypot(c[2] - c[0], c[3] - c[1]) + Math.hypot(c[6] - c[4], c[7] - c[5]);
    const n = Math.max(2, Math.ceil(chord / ORIENT_STEP_MM));
    for (let i = pts.length === 0 ? 0 : 1; i <= n; i++) {
      const p = bezAt(c, reverse ? 1 - i / n : i / n);
      if (pts.length > 0) len += Math.hypot(p[0] - pts[pts.length - 1][0], p[1] - pts[pts.length - 1][1]);
      pts.push(p);
      if (len >= ORIENT_CHECK_MM) return pts;
    }
  }
  return pts;
}

// 点の列(機械の座標)の間に、どちらかのモーターの回る向きが変わるか
function motorReversesAlong(machinePts, geom) {
  const sign = [0, 0];
  let prev = null;
  for (const [x, y] of machinePts) {
    const th = PlotGeometry.ik(geom, x, y);
    if (!th) return false;   // 解けない所は機械が描かないので、判断しない
    if (prev) {
      for (let m = 0; m < 2; m++) {
        const d = th[m] - prev[m];
        if (Math.abs(d) < 1e-4) continue;
        const sg = Math.sign(d);
        if (sign[m] !== 0 && sg !== sign[m]) return true;
        sign[m] = sg;
      }
    }
    prev = th;
  }
  return false;
}

// strokes(紙の座標の区間の列の列)の向きをその場で選ぶ。toMachine(x, y) → [機械の x, y] → 逆向きにした数
function orientStrokesForMotors(strokes, toMachine, geom = PlotGeometry.DEFAULT_GEOM) {
  const bad = (s, reverse) => motorReversesAlong(strokeHeadPoints(s, reverse).map(([x, y]) => toMachine(x, y)), geom);
  const startOf = s => [s[0][0], s[0][1]];
  const endOf = s => [s[s.length - 1][6], s[s.length - 1][7]];
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let flipped = 0;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    if (!bad(s, false) || bad(s, true)) continue;
    const st = startOf(s), en = endOf(s);
    const prev = i > 0 ? endOf(strokes[i - 1]) : null;
    const next = i + 1 < strokes.length ? startOf(strokes[i + 1]) : null;
    if ((prev && dist(prev, st) < ORIENT_JOIN_MM) || (next && dist(en, next) < ORIENT_JOIN_MM)) continue;
    const before = (prev ? dist(prev, st) : 0) + (next ? dist(en, next) : 0);
    const after = (prev ? dist(prev, en) : 0) + (next ? dist(st, next) : 0);
    if (after - before > ORIENT_MAX_EXTRA_MM) continue;
    strokes[i] = s.slice().reverse().map(c => [c[6], c[7], c[4], c[5], c[2], c[3], c[0], c[1]]);
    flipped++;
  }
  return flipped;
}

// normalizeForPlotter の data(紙の左下が原点、mm)を BEZ2 にする → Uint8Array
// keepDirection: 線の向きを変えない(文字は書き順と書く向きを守る。svgtext.js)
function encodeBez2(data, { name, starred, uuid = uuidBytes(), createdAt = Math.floor(Date.now() / 1000), keepDirection = false }) {
  const q = (v) => {
    const r = Math.round(v * 100);
    if (r < -32768 || r > 32767) throw new Error("座標が範囲外です");
    return r;
  };
  const strokes = data.strokes.filter(s => s.length > 0);
  // 紙の左下が原点の座標 → 機械の座標。180° 回すときは、紙の中心を軸に回す
  const W = data.paper.width, H = data.paper.height;
  const mx = (x) => (SD_ROTATE_180 ? W - x : x) + SD_PAPER_ORIGIN.x;
  const my = (y) => (SD_ROTATE_180 ? H - y : y) + SD_PAPER_ORIGIN.y;
  sdLastFlipped = null;
  if (typeof PlotGeometry !== "undefined" && !keepDirection) {
    sdLastFlipped = orientStrokesForMotors(strokes, (x, y) => [mx(x), my(y)]);
    console.log(`線の向き: ${sdLastFlipped} 本を逆向きにしました(描き始めがモーターの止まりかけにならないように)`);
  }
  // 塗り: 輪は 255 個まで、点は 1 輪 65535 個まで。機械は 1 つの塗りで 4000 点・32 輪までしか使わない
  const fills = (data.fills || []).map(rings => rings.slice(0, 32).filter(r => r.length >= 6))
    .filter(rings => rings.length > 0).slice(0, 65535);
  if (strokes.length > 65535) throw new Error("線が多すぎます");
  const nb = nameBytes(name);
  let size = 28 + nb.length;
  for (const s of strokes) {
    if (s.length > 65535) throw new Error("線が長すぎます");
    size += 6 + 12 * s.length;
  }
  if (fills.length > 0) {
    size += 2;
    for (const rings of fills) {
      size += 1;
      for (const r of rings) size += 2 + 2 * r.length;   // r は [x0, y0, x1, y1, …]
    }
  }
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x42, 0x45, 0x5a, 0x32], 0);   // "BEZ2"
  v.setUint16(4, strokes.length, true);
  v.setUint8(6, (starred ? 1 : 0) | (fills.length > 0 ? 2 : 0));
  v.setUint8(7, nb.length);
  v.setUint32(8, createdAt, true);
  u8.set(uuid, 12);
  u8.set(nb, 28);
  let o = 28 + nb.length;
  const X = (x) => q(mx(x));
  const Y = (y) => q(my(y));
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
  if (fills.length > 0) {
    v.setUint16(o, fills.length, true);
    o += 2;
    for (const rings of fills) {
      v.setUint8(o, rings.length);
      o += 1;
      for (const r of rings) {
        v.setUint16(o, r.length / 2, true);
        o += 2;
        for (let k = 0; k < r.length; k += 2) {
          v.setInt16(o, X(r[k]), true);
          v.setInt16(o + 2, Y(r[k + 1]), true);
          o += 4;
        }
      }
    }
  }
  if (o !== size) throw new Error("BEZ2 の大きさが合いません");
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
  // 送った結果(送りました/送れませんでした)は、名前を変えるまで残す
  if (sdSending || sendPlotStatus.dataset.keep === "1") return;
  if (ready && !plotSendToken()) {
    sendPlotStatus.textContent = "送るには ESP32 と接続するか、機械の QR を読み取ってください";
  } else if (ready && !plotNameInput.value.trim()) {
    sendPlotStatus.textContent = "名前を入れてください";
  } else {
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
    sendPlotStatus.textContent = SHOW_DETAILS
      ? `送りました（${(bez.length / 1024).toFixed(1)} KB${starred ? "・★" : ""}` +
        `${sdLastFlipped === null ? "" : `・向きを変えた線 ${sdLastFlipped} 本`}）。` +
        `機械が Wi-Fi で取りに来ると SD に入ります（30 秒ほど）。機械の待ち: ${body.waiting} 枚`
      : "送りました。30 秒ほどで機械に届きます。";
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
