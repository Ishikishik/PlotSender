// 文字(SVG)をペンプロッターの線にする。
//
// SVG の一部を読んで、紙(PAPER_OPTIONS、mm)の上の線(3 次ベジェ)にする。1 単位 = 1 mm として書く。
//   <svg viewBox="0 0 91 55"> … 名刺の大きさなら 91×55 mm。紙の真ん中に置く(紙に入らなければ縮める)
//   <text x y font-size font-family writing-mode letter-spacing text-anchor transform> と <tspan x y dx dy>
//     文字は ShujiDB(書き順付きの中心線)で、書き順どおりに描く。x, y は横書きなら文字の基準線(左下)、
//     縦書き(writing-mode="vertical-rl")なら 1 文字目の上の真ん中
//   <line> <rect> <circle> <ellipse> <polyline> <polygon> <path> … 線として描く(fill は使わない)
// 描く順番は、SVG に書いた順番(文字は書き順どおり。線の向きも変えない)。
//
// 字の線は機械が SD カードのフォント(/fonts/klee.fnt。tools/make_font.py で ShujiDB から作る)から読んで描く。
// ページは「どの字を、どう置くか(字の座標 → 機械の座標の 2×3 の行列)」だけを送る(BEZ3。firm/src/jobs/SdPlot.h)。
// 字の線のデータはフォント由来なので、公開のページには置かない。ページにあるのは字の一覧(public/fonts/<名前>-chars.txt)だけで、
// プレビューの字はブラウザの文字で描く目安
// font-family にフォントの名前を書く(初期値 klee)

const TEXT_FONTS = ["klee"];          // フォント(番号は機械の STROKE_FONT_FILES と同じ順)
const TEXT_DEFAULT_FONT = "klee";
const TEXT_ASCENT = 0.88;             // 横書きで、基準線から字の枠の上までの高さ(字の大きさに対する割合)
const TEXT_SAMPLE_MM = 0.3;           // 図形(path など)を折れ線にする間隔 [mm]
const TEXT_SVG_SAMPLE = `<svg viewBox="0 0 91 55">
  <rect x="2" y="2" width="87" height="51" />
  <text x="8" y="20" font-size="9">山田 太郎</text>
  <line x1="8" y1="23" x2="55" y2="23" />
  <text x="8" y="30" font-size="3.5">ペンプロッター研究会</text>
  <text x="8" y="44" font-size="3">〒100-0001 東京都千代田区</text>
  <text x="82" y="8" font-size="5" writing-mode="vertical-rl">和の心</text>
</svg>`;

const textFonts = {};
// フォントの字の一覧を読む(1 回だけ) → { em, has: Set }
function loadTextFont(name) {
  if (!textFonts[name]) {
    textFonts[name] = fetch(`./fonts/${name}-chars.txt`).then(r => {
      if (!r.ok) throw new Error(`フォント ${name} の字の一覧を読めませんでした`);
      return r.text();
    }).then(t => ({ em: 109, has: new Set(t) })).catch(e => { delete textFonts[name]; throw e; });
  }
  return textFonts[name];
}

// 2×3 の行列 [a, b, c, d, e, f](x' = a x + c y + e、y' = b x + d y + f)。mul(A, B) は B のあとに A
const matMul = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3],
  A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
const matApply = (M, x, y) => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];

// 半角(英数字・記号)は幅を狭くする
const isHalfWidth = ch => ch.charCodeAt(0) < 0x2000 || (ch >= "｡" && ch <= "ﾟ");
// 縦書きで右上へ寄せる文字と、90° 回す文字
const VERTICAL_SHIFT = "、。，．";
const VERTICAL_ROTATE = "ー－-「」（）()―〜～…";

// SVG の文字列 → { data: { paper, items, toPaper }, warnings: [] }
//   items: SVG の座標(1 単位 = 1 mm、y 下向き)の項目を書いた順に。{ segs: [[x0,y0,c1x,c1y,c2x,c2y,x1,y1], ...] }(線)
//          か { glyph: { font, ch, m } }(字。m は字の座標 → SVG の座標の行列)
//   toPaper: SVG の座標 → 紙の座標(左下が原点、y 上向き、mm)の行列
async function svgToPlotData(svgText, paper) {
  const warnings = [];
  // xmlns を書き忘れても SVG として読めるようにする(ないと、ただの XML になって計算できない)
  if (!/<svg[^>]*\sxmlns=/.test(svgText)) svgText = svgText.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  if (doc.querySelector("parsererror") || doc.documentElement.nodeName !== "svg") {
    throw new Error("SVG として読めませんでした(タグの閉じ忘れなど)");
  }
  // 計算のために、見えない所へ実際に置く(変換の行列や図形の長さを、ブラウザに計算させる)
  const svg = document.importNode(doc.documentElement, true);
  const vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  let [vx, vy, vw, vh] = vb.length === 4 && vb.every(Number.isFinite) ? vb : [0, 0, parseFloat(svg.getAttribute("width")) || paper.paperWidth, parseFloat(svg.getAttribute("height")) || paper.paperHeight];
  svg.setAttribute("width", vw);   // 1 単位 = 1 px にする(行列がそのまま mm になる)
  svg.setAttribute("height", vh);
  const holder = document.createElement("div");
  holder.style.cssText = "position:absolute;left:-100000px;top:0;visibility:hidden;";
  holder.appendChild(svg);
  document.body.appendChild(holder);

  const items = [];
  try {
    const rootInv = svg.getScreenCTM().inverse();
    const toRoot = el => rootInv.multiply(el.getScreenCTM());
    const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

    for (const el of svg.querySelectorAll("*")) {
      const tag = el.localName;
      if (el.closest("defs")) continue;
      if (tag === "text") {
        await addText(el, toRoot(el), items, warnings);
      } else if (["line", "rect", "circle", "ellipse", "polyline", "polygon", "path"].includes(tag)) {
        addShape(el, toRoot(el), apply, items);
      } else if (!["tspan", "g", "title", "desc", "defs", "style"].includes(tag)) {
        warnings.push(`<${tag}> は使えないので描きません`);
      }
    }
  } finally {
    holder.remove();
  }

  // 紙の真ん中(腕が届く範囲)に置く。入らなければ縮める
  const fitW = paper.paperWidth - (paper.marginLeft || 0) - (paper.marginRight || 0);
  const fitH = paper.paperHeight;
  const s = Math.min(1, fitW / vw, fitH / vh);
  if (s < 1) warnings.push(`紙に入らないので ${Math.round(s * 100)}% に縮めました`);
  const ox = (paper.marginLeft || 0) + (fitW - vw * s) / 2, oy = (fitH - vh * s) / 2;
  // 紙は左下が原点、y 上向き: X = ox + (x - vx) s、Y = H - (oy + (y - vy) s)
  const toPaper = [s, 0, 0, -s, ox - vx * s, paper.paperHeight - oy + vy * s];
  return {
    data: { paper: { width: paper.paperWidth, height: paper.paperHeight }, items, toPaper },
    warnings: [...new Set(warnings)],
  };
}

// 図形を TEXT_SAMPLE_MM ごとの点にして、直線の 3 次ベジェでつなぐ。大きく飛ぶ所(path の M など)はペンを上げる
function addShape(el, m, apply, items) {
  const len = el.getTotalLength();
  if (!(len > 0)) return;
  const n = Math.max(2, Math.ceil(len / TEXT_SAMPLE_MM));
  const step = len / n;
  let cur = [], prev = null;
  for (let i = 0; i <= n; i++) {
    const p = el.getPointAtLength(i * step);
    const q = apply(m, p.x, p.y);
    if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) > step * 3) {   // 次の部分(サブパス)へ飛んだ
      if (cur.length) items.push({ segs: cur });
      cur = [];
    } else if (prev) {
      cur.push([prev[0], prev[1], prev[0] + (q[0] - prev[0]) / 3, prev[1] + (q[1] - prev[1]) / 3,
                prev[0] + (q[0] - prev[0]) * 2 / 3, prev[1] + (q[1] - prev[1]) * 2 / 3, q[0], q[1]]);
    }
    prev = q;
  }
  if (cur.length) items.push({ segs: cur });
}

const numAttr = (el, name) => {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return null;
  const n = parseFloat(v.trim().split(/[\s,]+/)[0]);
  return Number.isFinite(n) ? n : null;
};

// <text> を 1 文字ずつ並べる
async function addText(textEl, m, items, warnings) {
  const M = [m.a, m.b, m.c, m.d, m.e, m.f];
  // 文字の流れを集める: [{ch, el}](tspan の x, y, dx, dy は、その tspan の最初の文字で反映する)
  const runs = [];
  const walk = (node, el) => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        for (const ch of child.textContent.replace(/[\r\n\t]+\s*/g, "")) runs.push({ ch, el });
      } else if (child.nodeType === Node.ELEMENT_NODE && child.localName === "tspan") {
        runs.push({ start: child });
        walk(child, child);
      }
    }
  };
  walk(textEl, textEl);

  const style = el => getComputedStyle(el);
  const sizeOf = el => parseFloat(style(el).fontSize) || 5;
  const vertical = /^(vertical|tb)/.test(style(textEl).writingMode || textEl.getAttribute("writing-mode") || "");
  const fontName = (() => {
    const f = (textEl.getAttribute("font-family") || style(textEl).fontFamily || "").toLowerCase().replace(/["']/g, "");
    return TEXT_FONTS.find(n => f.includes(n)) || TEXT_DEFAULT_FONT;
  })();
  const font = await loadTextFont(fontName);
  const fontIndex = TEXT_FONTS.indexOf(fontName);
  const em = font.em;

  // 行(x, y が指定されたところで切れる)ごとに並べてから、text-anchor でずらす
  let x = numAttr(textEl, "x") ?? 0, y = numAttr(textEl, "y") ?? 0;
  const lines = [];
  let line = { anchor: style(textEl).textAnchor || textEl.getAttribute("text-anchor") || "start", items: [], startX: x, startY: y };
  lines.push(line);
  for (const r of runs) {
    if (r.start) {
      const t = r.start;
      const nx = numAttr(t, "x"), ny = numAttr(t, "y");
      if (nx !== null || ny !== null) {
        if (nx !== null) x = nx;
        if (ny !== null) y = ny;
        line = { anchor: style(t).textAnchor || line.anchor, items: [], startX: x, startY: y };
        lines.push(line);
      }
      x += numAttr(t, "dx") ?? 0;
      y += numAttr(t, "dy") ?? 0;
      continue;
    }
    const size = sizeOf(r.el);
    const ls = parseFloat(style(r.el).letterSpacing) || 0;
    const half = isHalfWidth(r.ch);
    const adv = (r.ch === " " ? 0.4 : r.ch === "　" ? 1 : half ? 0.6 : 1) * size + ls;
    line.items.push({ ch: r.ch, x, y, size, half });
    if (vertical) y += adv; else x += adv;
    line.end = vertical ? y - ls : x - ls;
  }

  for (const ln of lines) {
    if (!ln.items.length) continue;
    const length = ln.end - (vertical ? ln.startY : ln.startX);
    const shift = ln.anchor === "middle" ? -length / 2 : ln.anchor === "end" ? -length : 0;
    for (const it of ln.items) {
      if (it.ch === " " || it.ch === "　") continue;
      if (!font.has.has(it.ch)) { warnings.push(`「${it.ch}」の字はないので空けました`); continue; }
      const k = it.size / em;
      // 字の枠(em × em)の左上の位置
      let left, top;
      if (vertical) { left = it.x - it.size / 2; top = it.y + shift; }
      else { left = it.x + shift - (it.half ? 0.2 * it.size : 0); top = it.y - TEXT_ASCENT * it.size; }
      const rot = vertical && VERTICAL_ROTATE.includes(it.ch);
      const vs = vertical && VERTICAL_SHIFT.includes(it.ch) ? 0.6 * em : 0;
      // 字の座標 → SVG の座標: (縦書きの伸ばし棒やかっこは 90° 回す) → 右上へ寄せる → 縮めて置く → <text> の変換
      let G = [k, 0, 0, k, left + vs * k, top - vs * k];
      if (rot) G = matMul(G, [0, 1, -1, 0, em, 0]);
      items.push({ glyph: { font: fontIndex, ch: it.ch, m: matMul(M, G) } });
    }
  }
}

// ---- ページ ----

const textSvgInput = document.querySelector("#text-svg");
const textPreview = document.querySelector("#text-preview");
const textWarn = document.querySelector("#text-warn");
const textNameInput = document.querySelector("#text-name");
const textSendButton = document.querySelector("#text-send");
const textStatus = document.querySelector("#text-status");
let textData = null;
let textBusy = false;

// 紙の上の線を、紙の絵(上がページの上)としてペンの太さで描く。字はブラウザの文字で描く(目安。機械は SD のフォントで描く)
function drawTextPreview(data) {
  const scale = 5;   // 1 mm = 5 px
  const W = PAPER_OPTIONS.paperWidth, H = PAPER_OPTIONS.paperHeight;
  textPreview.width = W * scale;
  textPreview.height = H * scale;
  const g = textPreview.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, W * scale, H * scale);
  // 腕が届かないので描かない左右の幅
  g.fillStyle = "#eee";
  g.fillRect(0, 0, (PAPER_OPTIONS.marginLeft || 0) * scale, H * scale);
  g.fillRect((W - (PAPER_OPTIONS.marginRight || 0)) * scale, 0, (PAPER_OPTIONS.marginRight || 0) * scale, H * scale);
  // SVG の座標 → キャンバスの座標
  const toCanvas = matMul([scale, 0, 0, -scale, 0, H * scale], data.toPaper);
  g.strokeStyle = g.fillStyle = "#1a2a8a";
  g.lineWidth = PEN_WIDTH_MM * scale;
  g.lineCap = g.lineJoin = "round";
  for (const item of data.items) {
    if (item.segs) {
      const pt = (x, y) => matApply(toCanvas, x, y);
      const st = item.segs;
      g.beginPath();
      g.moveTo(...pt(st[0][0], st[0][1]));
      for (const c of st) g.bezierCurveTo(...pt(c[2], c[3]), ...pt(c[4], c[5]), ...pt(c[6], c[7]));
      g.stroke();
    } else {
      const M = matMul(toCanvas, item.glyph.m);
      g.save();
      g.setTransform(M[0], M[1], M[2], M[3], M[4], M[5]);
      g.font = '96px Klee, "Klee One", "Hiragino Maru Gothic ProN", "Hiragino Sans", sans-serif';
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(item.glyph.ch, 54.5, 54.5);
      g.restore();
    }
  }
}

// 紙の上の項目を BEZ3 にする → Uint8Array(頭は encodeBez2 と同じ。sdsend.js)
//   線: 区間の数 u16、始点 int16 x, y、区間ごとに int16 × 6(0.01 mm、機械の座標)
//   字: 0xFFFF、フォントの番号 u8、文字コード u32、置き方 float32 × 6(字の座標 → 機械の座標 [mm])
function encodeBez3(data, { name, starred }) {
  const W = data.paper.width, H = data.paper.height;
  // 紙の座標 → 機械の座標(紙の中心で 180° 回す。encodeBez2 と同じ)
  const paperToMachine = SD_ROTATE_180 ? [-1, 0, 0, -1, W + SD_PAPER_ORIGIN.x, H + SD_PAPER_ORIGIN.y]
                                       : [1, 0, 0, 1, SD_PAPER_ORIGIN.x, SD_PAPER_ORIGIN.y];
  const toMachine = matMul(paperToMachine, data.toPaper);
  const q = v => {
    const r = Math.round(v * 100);
    if (r < -32768 || r > 32767) throw new Error("座標が範囲外です");
    return r;
  };
  const items = data.items.filter(it => it.glyph || it.segs.length > 0);
  if (items.length > 65535) throw new Error("線が多すぎます");
  const nb = nameBytes(name);
  let size = 28 + nb.length;
  for (const it of items) size += it.glyph ? 2 + 1 + 4 + 24 : 6 + 12 * it.segs.length;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x42, 0x45, 0x5a, 0x33], 0);   // "BEZ3"
  v.setUint16(4, items.length, true);
  v.setUint8(6, starred ? 1 : 0);
  v.setUint8(7, nb.length);
  v.setUint32(8, Math.floor(Date.now() / 1000), true);
  u8.set(uuidBytes(), 12);
  u8.set(nb, 28);
  let o = 28 + nb.length;
  for (const it of items) {
    if (it.glyph) {
      const m = matMul(toMachine, it.glyph.m);
      v.setUint16(o, 0xffff, true);
      v.setUint8(o + 2, it.glyph.font);
      v.setUint32(o + 3, it.glyph.ch.codePointAt(0), true);
      for (let i = 0; i < 6; i++) v.setFloat32(o + 7 + 4 * i, m[i], true);
      o += 31;
    } else {
      const st = it.segs;
      const p0 = matApply(toMachine, st[0][0], st[0][1]);
      v.setUint16(o, st.length, true);
      v.setInt16(o + 2, q(p0[0]), true);
      v.setInt16(o + 4, q(p0[1]), true);
      o += 6;
      for (const c of st) {
        for (let k = 2; k < 8; k += 2) {
          const p = matApply(toMachine, c[k], c[k + 1]);
          v.setInt16(o, q(p[0]), true);
          v.setInt16(o + 2, q(p[1]), true);
          o += 4;
        }
      }
    }
  }
  if (o !== size) throw new Error("BEZ3 の大きさが合いません");
  return u8;
}

async function updateTextPreview() {
  try {
    const { data, warnings } = await svgToPlotData(textSvgInput.value, PAPER_OPTIONS);
    textData = data;
    drawTextPreview(data);
    textWarn.textContent = warnings.join("。") + (warnings.length ? "。" : "");
  } catch (error) {
    textData = null;
    textWarn.textContent = error.message;
  }
  updateTextSendButton();
}

function updateTextSendButton() {
  textSendButton.disabled = textBusy || !textData || !textData.items.length || !textNameInput.value.trim() || !plotSendToken();
}

let textTimer = null;
textSvgInput.value = TEXT_SVG_SAMPLE;
textSvgInput.addEventListener("input", () => {
  clearTimeout(textTimer);
  textTimer = setTimeout(updateTextPreview, 400);   // 打ち終わってから描き直す
});
textNameInput.addEventListener("input", updateTextSendButton);
setInterval(updateTextSendButton, 1000);   // トークンが届いたときにボタンを有効にする
updateTextPreview();

textSendButton.addEventListener("click", async () => {
  const auth = plotSendToken();
  if (!textData || !auth) return;
  textBusy = true;
  updateTextSendButton();
  textStatus.textContent = "送っています…";
  try {
    const bez = encodeBez3(textData, { name: textNameInput.value, starred: false });
    const response = await fetch("/api/plots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: auth.token, token_kind: auth.kind, data: toBase64(bez) })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
    if (auth.kind === "qr") sdQrToken = null;
    textStatus.textContent = "送りました。30 秒ほどで機械に届きます。";
  } catch (error) {
    textStatus.textContent = `送れませんでした（${error.message}）`;
  } finally {
    textBusy = false;
    updateTextSendButton();
  }
});
