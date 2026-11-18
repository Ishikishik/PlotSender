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
// フォントは public/fonts/<名前>.json(tools/make_font.py で ShujiDB から作る)。font-family に名前を書く(初期値 klee)

const TEXT_FONTS = ["klee"];          // public/fonts にあるフォント
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
// フォントを読む(1 回だけ) → { em, glyphs }
function loadTextFont(name) {
  if (!textFonts[name]) {
    textFonts[name] = fetch(`./fonts/${name}.json`).then(r => {
      if (!r.ok) throw new Error(`フォント ${name} を読めませんでした`);
      return r.json();
    }).catch(e => { delete textFonts[name]; throw e; });
  }
  return textFonts[name];
}

// 半角(英数字・記号)は幅を狭くする
const isHalfWidth = ch => ch.charCodeAt(0) < 0x2000 || (ch >= "｡" && ch <= "ﾟ");
// 縦書きで右上へ寄せる文字と、90° 回す文字
const VERTICAL_SHIFT = "、。，．";
const VERTICAL_ROTATE = "ー－-「」（）()―〜～…";

// SVG の文字列 → { data: 紙の上の線(normalizeForPlotter の data と同じ形), warnings: [] }
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

  const strokes = [];   // SVG の座標(1 単位 = 1 mm、y 下向き)の線。画ごとに [[x0,y0,c1x,c1y,c2x,c2y,x1,y1], ...]
  try {
    const rootInv = svg.getScreenCTM().inverse();
    const toRoot = el => rootInv.multiply(el.getScreenCTM());
    const apply = (m, x, y) => [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];

    for (const el of svg.querySelectorAll("*")) {
      const tag = el.localName;
      if (el.closest("defs")) continue;
      if (tag === "text") {
        await addText(el, toRoot(el), apply, strokes, warnings);
      } else if (["line", "rect", "circle", "ellipse", "polyline", "polygon", "path"].includes(tag)) {
        addShape(el, toRoot(el), apply, strokes);
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
  const toPaper = (x, y) => [ox + (x - vx) * s, paper.paperHeight - (oy + (y - vy) * s)];   // 紙は左下が原点、y 上向き
  const paperStrokes = strokes.map(st => st.map(c => [...toPaper(c[0], c[1]), ...toPaper(c[2], c[3]), ...toPaper(c[4], c[5]), ...toPaper(c[6], c[7])]));
  return {
    data: { paper: { width: paper.paperWidth, height: paper.paperHeight }, strokes: paperStrokes, fills: [] },
    warnings: [...new Set(warnings)],
  };
}

// 図形を TEXT_SAMPLE_MM ごとの点にして、直線の 3 次ベジェでつなぐ。大きく飛ぶ所(path の M など)はペンを上げる
function addShape(el, m, apply, strokes) {
  const len = el.getTotalLength();
  if (!(len > 0)) return;
  const n = Math.max(2, Math.ceil(len / TEXT_SAMPLE_MM));
  const step = len / n;
  let cur = [], prev = null;
  for (let i = 0; i <= n; i++) {
    const p = el.getPointAtLength(i * step);
    const q = apply(m, p.x, p.y);
    if (prev && Math.hypot(q[0] - prev[0], q[1] - prev[1]) > step * 3) {   // 次の部分(サブパス)へ飛んだ
      if (cur.length) strokes.push(cur);
      cur = [];
    } else if (prev) {
      cur.push([prev[0], prev[1], prev[0] + (q[0] - prev[0]) / 3, prev[1] + (q[1] - prev[1]) / 3,
                prev[0] + (q[0] - prev[0]) * 2 / 3, prev[1] + (q[1] - prev[1]) * 2 / 3, q[0], q[1]]);
    }
    prev = q;
  }
  if (cur.length) strokes.push(cur);
}

const numAttr = (el, name) => {
  const v = el.getAttribute(name);
  if (v === null || v.trim() === "") return null;
  const n = parseFloat(v.trim().split(/[\s,]+/)[0]);
  return Number.isFinite(n) ? n : null;
};

// <text> を 1 文字ずつ並べる
async function addText(textEl, m, apply, strokes, warnings) {
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
  const em = font.em || 109;

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
      const strokesOf = font.glyphs[it.ch];
      if (!strokesOf) { warnings.push(`「${it.ch}」の字はないので空けました`); continue; }
      const k = it.size / em;
      // 字の枠(em × em)の左上の位置
      let left, top;
      if (vertical) { left = it.x - it.size / 2; top = it.y + shift; }
      else { left = it.x + shift - (it.half ? 0.2 * it.size : 0); top = it.y - TEXT_ASCENT * it.size; }
      const rot = vertical && VERTICAL_ROTATE.includes(it.ch);
      const vs = vertical && VERTICAL_SHIFT.includes(it.ch) ? 0.6 * em : 0;
      const pt = (gx, gy) => {
        if (rot) [gx, gy] = [em - gy, gx];   // 縦書きの伸ばし棒やかっこは 90° 回す
        return apply(m, left + (gx + vs) * k, top + (gy - vs) * k);
      };
      for (const st of strokesOf) {
        strokes.push(st.map(c => [...pt(c[0], c[1]), ...pt(c[2], c[3]), ...pt(c[4], c[5]), ...pt(c[6], c[7])]));
      }
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

// 紙の上の線を、紙の絵(上がページの上)としてペンの太さで描く
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
  g.strokeStyle = "#1a2a8a";
  g.lineWidth = PEN_WIDTH_MM * scale;
  g.lineCap = g.lineJoin = "round";
  const X = x => x * scale, Y = y => (H - y) * scale;
  for (const st of data.strokes) {
    g.beginPath();
    g.moveTo(X(st[0][0]), Y(st[0][1]));
    for (const c of st) g.bezierCurveTo(X(c[2]), Y(c[3]), X(c[4]), Y(c[5]), X(c[6]), Y(c[7]));
    g.stroke();
  }
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
  textSendButton.disabled = textBusy || !textData || !textData.strokes.length || !textNameInput.value.trim() || !plotSendToken();
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
    // 書き順と線の向きを守るので、向きは変えない(keepDirection)
    const bez = encodeBez2(textData, { name: textNameInput.value, starred: false, keepDirection: true });
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
