/*
 * library.js — 線画をペンプロッター用のベジェストロークに変換するアルゴリズム一式
 *
 * 元: Byomato/test/opencv/index.html（Brush stroke vectorizer）
 * 処理の流れは runPipeline() を見ると一通り分かる。
 *
 *   二値化 → 小さなゴミ除去 → 距離変換（線の太さ）→ 細線化 → 端点接続
 *   → 線分割 → 短い線の除去 → ベジェ化 → 塗りつぶし抽出 → 描画順
 *
 * 計測: createTimer() で作ったタイマーの timer.time("名前", () => 処理) で囲むと
 *       その処理の時間（ms）が記録され、画面の「処理時間」に出る。
 *       入れ子にしてもよい（内側は字下げして表示される）。
 *
 * OpenCV.js（グローバル変数 cv）が読み込まれている前提。
 */

/* ------------------------------------------------------------------ */
/* 設定値（画面のチューニング欄はここから自動で作られる）                */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = {
  binaryThreshold: 236,
  minComponentArea: 18,
  endpointMaxDist: 30,
  endpointMinCos: 0.58,
  endpointMinSupport: 0.035,
  endpointMaxWidthRatio: 3.2,
  minSegmentPoints: 10,
  minSegmentLength: 10,
  junctionContinueMinScore: 0.15,
  segmentTurnMinScore: -0.35,
  bezierEpsilon: 2.8,
  widthSmoothRadius: 4,
  emulatorStepPx: 1.2,
  fillEnabled: true,
  fillMinArea: 100,
  fillMinMaxWidth: 12,
  fillMinDensity: 0.20,
  fillHatchSpacing: 4,
  fillMaxHatchWidth: 6,
  fillMinRunLength: 5,
  delicateFillMaxArea: 2400,
  delicateFillMaxBox: 90,
  delicateFillHatchSpacing: 3,
  delicateFillMaxHatchWidth: 1.6,
  fillEdgeSafety: 0.65,
  fillHoleSafety: 1.25,
  delicateFillMinPoints: 3,
  delicateFillMinLength: 2,
  delicateWhiteGuard: 1.8,
  delicateWidthScale: 0.72,
  delicateMinPaintWidth: 0.65
};

// 画面に出す説明。group ごとにまとめて表示する。
const SETTING_INFO = {
  binaryThreshold:          { group: "前処理",   label: "二値化のしきい値（これより暗い画素を線とみなす）", min: 0, max: 255, step: 1 },
  minComponentArea:         { group: "前処理",   label: "これより小さい黒の塊はゴミとして消す（px²）", min: 0, step: 1 },
  endpointMaxDist:          { group: "端点接続", label: "途切れた線をつなぐ最大距離（px）", min: 0, step: 1 },
  endpointMinCos:           { group: "端点接続", label: "つなぐときの向きの一致度（cos, 1=一直線）", min: -1, max: 1, step: 0.01 },
  endpointMinSupport:       { group: "端点接続", label: "つなぐ区間に元の黒がどれだけ必要か（0〜1）", min: 0, max: 1, step: 0.005 },
  endpointMaxWidthRatio:    { group: "端点接続", label: "太さがこの倍率以上違う端点はつながない", min: 1, step: 0.1 },
  minSegmentPoints:         { group: "線分割",   label: "線とみなす最小の点数", min: 1, step: 1 },
  minSegmentLength:         { group: "線分割",   label: "線とみなす最小の長さ（px）", min: 0, step: 1 },
  junctionContinueMinScore: { group: "線分割",   label: "分岐点でまっすぐ進み続ける最小スコア", min: -1, max: 1, step: 0.05 },
  segmentTurnMinScore:      { group: "線分割",   label: "これより急に曲がったら線を切る", min: -1, max: 1, step: 0.05 },
  bezierEpsilon:            { group: "ベジェ化", label: "点の間引き量（RDPの許容誤差 px, 大きいほど粗い）", min: 0.1, step: 0.1 },
  widthSmoothRadius:        { group: "ベジェ化", label: "太さをならす範囲（点数）", min: 0, step: 1 },
  emulatorStepPx:           { group: "プレビュー", label: "プロッタ再現の刻み（px, 小さいほど精密で遅い）", min: 0.2, step: 0.1 },
  fillEnabled:              { group: "塗りつぶし", label: "塗りつぶし処理を行う" },
  fillMinArea:              { group: "塗りつぶし", label: "塗り候補の最小面積（px²）", min: 0, step: 10 },
  fillMinMaxWidth:          { group: "塗りつぶし", label: "塗り候補の最小の最大太さ（px）", min: 0, step: 1 },
  fillMinDensity:           { group: "塗りつぶし", label: "外接矩形に対する黒の割合の下限", min: 0, max: 1, step: 0.01 },
  fillHatchSpacing:         { group: "塗りつぶし", label: "ハッチングの間隔（px）", min: 1, step: 1 },
  fillMaxHatchWidth:        { group: "塗りつぶし", label: "ハッチングの線幅の上限（px）", min: 0.1, step: 0.1 },
  fillMinRunLength:         { group: "塗りつぶし", label: "ハッチング1本の最小の長さ（px）", min: 1, step: 1 },
  fillEdgeSafety:           { group: "塗りつぶし", label: "縁からの安全距離（px）", min: 0, step: 0.05 },
  fillHoleSafety:           { group: "塗りつぶし", label: "細かい塗りでの穴からの追加安全距離（px）", min: 0, step: 0.05 },
  delicateFillMaxArea:      { group: "細かい塗り", label: "細かい塗りとみなす最大面積（px²）", min: 0, step: 50 },
  delicateFillMaxBox:       { group: "細かい塗り", label: "細かい塗りとみなす最大の外接矩形の辺（px）", min: 0, step: 1 },
  delicateFillHatchSpacing: { group: "細かい塗り", label: "細かい塗りのハッチング間隔（px）", min: 1, step: 1 },
  delicateFillMaxHatchWidth:{ group: "細かい塗り", label: "細かい塗りのハッチング線幅の上限（px）", min: 0.1, step: 0.1 },
  delicateFillMinPoints:    { group: "細かい塗り", label: "細かい塗りの線の最小点数", min: 1, step: 1 },
  delicateFillMinLength:    { group: "細かい塗り", label: "細かい塗りの線の最小長さ（px）", min: 0, step: 1 },
  delicateWhiteGuard:       { group: "細かい塗り", label: "白を守るために線幅から引く量（px）", min: 0, step: 0.1 },
  delicateWidthScale:       { group: "細かい塗り", label: "細かい塗りの線幅の倍率", min: 0, max: 2, step: 0.01 },
  delicateMinPaintWidth:    { group: "細かい塗り", label: "細かい塗りの最小線幅（px）", min: 0.1, step: 0.05 }
};

const DIRS_8 = [
  [-1, -1], [0, -1], [1, -1],
  [-1,  0],          [1,  0],
  [-1,  1], [0,  1], [1,  1]
];

/* ------------------------------------------------------------------ */
/* 時間計測                                                            */
/* ------------------------------------------------------------------ */

/**
 * 処理時間を測るタイマーを作る。
 *
 *   const timer = createTimer();
 *   const bin = timer.time("二値化", () => toBinary(src, 236));
 *   timer.records  // [{ label, ms, depth }]
 *   timer.total()  // 一番外側の合計 ms
 */
function createTimer() {
  const records = [];
  let depth = 0;

  function time(label, fn) {
    const record = { label, ms: 0, depth };
    records.push(record);
    depth++;
    const start = performance.now();
    try {
      return fn();
    } finally {
      record.ms = performance.now() - start;
      depth--;
    }
  }

  // async 関数を測るとき用
  async function timeAsync(label, fn) {
    const record = { label, ms: 0, depth };
    records.push(record);
    depth++;
    const start = performance.now();
    try {
      return await fn();
    } finally {
      record.ms = performance.now() - start;
      depth--;
    }
  }

  function total() {
    return records.filter(r => r.depth === 0).reduce((sum, r) => sum + r.ms, 0);
  }

  return { records, time, timeAsync, total };
}

/**
 * 関数を何回も実行して平均時間を測る（細かいチューニング用）。
 *   benchmark(() => zhangSuenFast(bin), 5) → { avg, min, max, runs }
 * 戻り値が cv.Mat なら毎回 delete する。
 */
function benchmark(fn, runs = 5) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    const result = fn();
    times.push(performance.now() - start);
    if (result && typeof result.delete === "function") result.delete();
  }
  return {
    runs,
    avg: times.reduce((a, b) => a + b, 0) / runs,
    min: Math.min(...times),
    max: Math.max(...times)
  };
}

/* ------------------------------------------------------------------ */
/* パイプライン全体                                                     */
/* ------------------------------------------------------------------ */

/**
 * 画像（RGBA の cv.Mat）からストロークを作る。
 * 戻り値の mats は表示用の中間画像。使い終わったら deleteMats(mats) すること。
 */
function runPipeline(src, settings, timer = createTimer()) {
  const t = timer.time;

  const bin = t("二値化", () => toBinary(src, settings.binaryThreshold));
  const cleaned = t("小さな塊の除去", () => removeSmallComponents(bin, settings.minComponentArea));
  const dist = t("距離変換", () => distanceMap(cleaned));
  const thin = t("細線化", () => zhangSuenFast(cleaned));
  const connected = t("端点接続", () => connectEndpoints(thin, cleaned, dist, settings));
  const rawSegments = t("線分割", () => extractSegments(connected, settings));
  const segments = t("短い線の除去", () =>
    filterShortSegments(rawSegments, settings.minSegmentPoints, settings.minSegmentLength));
  const strokes = t("ベジェ化", () => buildBezierStrokes(segments, dist, settings));
  const fills = t("塗りつぶし抽出", () =>
    settings.fillEnabled ? extractFillRegions(cleaned, dist, settings) : []);
  const drawOrder = t("描画順", () => buildPlotterPlan(strokes, fills));

  const result = {
    image: { width: src.cols, height: src.rows },
    settings: { ...settings },
    whiteProtection: {
      mode: "clip-to-original-black-mask",
      rule: "do not draw where the original image is white"
    },
    strokes,
    fills,
    drawOrder
  };

  bin.delete();
  return {
    result,
    segments,
    mats: { cleaned, dist, thin, connected }
  };
}

function deleteMats(mats) {
  for (const mat of Object.values(mats)) {
    if (mat && !mat.isDeleted()) mat.delete();
  }
}

/* ------------------------------------------------------------------ */
/* 前処理                                                              */
/* ------------------------------------------------------------------ */

function toBinary(src, threshold) {
  const gray = new cv.Mat();
  const bin = new cv.Mat();

  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.threshold(gray, bin, threshold, 255, cv.THRESH_BINARY_INV);

  gray.delete();
  return bin;
}

function removeSmallComponents(bin, minArea) {
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const out = cv.Mat.zeros(bin.rows, bin.cols, cv.CV_8UC1);
  const count = cv.connectedComponentsWithStats(bin, labels, stats, centroids, 8, cv.CV_32S);
  const keep = new Array(count).fill(false);

  for (let label = 1; label < count; label++) {
    const area = stats.intPtr(label, cv.CC_STAT_AREA)[0];
    keep[label] = area >= minArea;
  }

  for (let y = 0; y < labels.rows; y++) {
    for (let x = 0; x < labels.cols; x++) {
      const label = labels.intPtr(y, x)[0];
      if (keep[label]) {
        out.ucharPtr(y, x)[0] = 255;
      }
    }
  }

  labels.delete();
  stats.delete();
  centroids.delete();
  return out;
}

function distanceMap(bin) {
  const dist = new cv.Mat();
  cv.distanceTransform(bin, dist, cv.DIST_L2, 5);
  return dist;
}

function normalizeToShow(src) {
  const dst = new cv.Mat();
  cv.normalize(src, dst, 0, 255, cv.NORM_MINMAX, cv.CV_8UC1);
  return dst;
}

/* ------------------------------------------------------------------ */
/* 細線化（Zhang-Suen）                                                 */
/* ------------------------------------------------------------------ */

function zhangSuenFast(src) {
  const rows = src.rows;
  const cols = src.cols;
  const size = rows * cols;
  const img = new Uint8Array(size);
  const marker = new Uint8Array(size);
  const srcData = src.data;

  for (let i = 0; i < size; i++) {
    img[i] = srcData[i] > 0 ? 1 : 0;
  }

  let changed = true;
  let safety = 0;

  while (changed && safety < 120) {
    changed = false;
    safety++;

    for (let iter = 0; iter < 2; iter++) {
      marker.fill(0);

      for (let y = 1; y < rows - 1; y++) {
        const row = y * cols;

        for (let x = 1; x < cols - 1; x++) {
          const i = row + x;
          if (img[i] !== 1) continue;

          const p2 = img[i - cols];
          const p3 = img[i - cols + 1];
          const p4 = img[i + 1];
          const p5 = img[i + cols + 1];
          const p6 = img[i + cols];
          const p7 = img[i + cols - 1];
          const p8 = img[i - 1];
          const p9 = img[i - cols - 1];
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;

          const a =
            (p2 === 0 && p3 === 1) +
            (p3 === 0 && p4 === 1) +
            (p4 === 0 && p5 === 1) +
            (p5 === 0 && p6 === 1) +
            (p6 === 0 && p7 === 1) +
            (p7 === 0 && p8 === 1) +
            (p8 === 0 && p9 === 1) +
            (p9 === 0 && p2 === 1);
          if (a !== 1) continue;

          if (iter === 0) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }

          marker[i] = 1;
        }
      }

      for (let i = 0; i < size; i++) {
        if (marker[i] === 1) {
          img[i] = 0;
          changed = true;
        }
      }
    }
  }

  const out = new cv.Mat(rows, cols, cv.CV_8UC1);
  for (let i = 0; i < size; i++) {
    out.data[i] = img[i] ? 255 : 0;
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 端点接続                                                            */
/* ------------------------------------------------------------------ */

function connectEndpoints(thin, bin, dist, settings) {
  const maxDist = settings.endpointMaxDist;
  const out = new cv.Mat();
  thin.copyTo(out);

  const endpoints = collectEndpoints(thin, dist);

  for (let i = 0; i < endpoints.length; i++) {
    if (endpoints[i].used) continue;

    const a = endpoints[i];
    let best = null;
    let bestScore = -Infinity;

    for (let j = i + 1; j < endpoints.length; j++) {
      if (endpoints[j].used) continue;

      const b = endpoints[j];
      const vxRaw = b.x - a.x;
      const vyRaw = b.y - a.y;
      const d = Math.hypot(vxRaw, vyRaw);
      if (d === 0 || d > maxDist) continue;

      // 端点の向き（dir は線の内側を向く）の逆向きが、相手の方を向いているか
      const vx = vxRaw / d;
      const vy = vyRaw / d;
      const ca = (-a.dir.x) * vx + (-a.dir.y) * vy;
      const cb = (-b.dir.x) * (-vx) + (-b.dir.y) * (-vy);
      const dirScore = Math.min(ca, cb);
      if (dirScore < settings.endpointMinCos) continue;

      const support = lineSupport(bin, a.x, a.y, b.x, b.y);
      if (support < settings.endpointMinSupport) continue;

      const widthRatio = Math.max(a.width, b.width) / Math.max(1, Math.min(a.width, b.width));
      if (widthRatio > settings.endpointMaxWidthRatio) continue;

      const score = dirScore * 2.0 + support * 1.2 - (d / maxDist) * 0.7 - (widthRatio - 1) * 0.25;
      if (score > bestScore) {
        bestScore = score;
        best = j;
      }
    }

    if (best !== null) {
      const b = endpoints[best];
      cv.line(out, new cv.Point(a.x, a.y), new cv.Point(b.x, b.y), new cv.Scalar(255), 1);
      a.used = true;
      b.used = true;
    }
  }

  return out;
}

function collectEndpoints(thin, dist) {
  const endpoints = [];

  for (let y = 1; y < thin.rows - 1; y++) {
    for (let x = 1; x < thin.cols - 1; x++) {
      if (!isWhite(thin, x, y)) continue;
      if (neighborsOf(thin, x, y).length !== 1) continue;

      const dir = estimateEndpointDirection(thin, x, y);
      if (dir === null) continue;

      endpoints.push({
        x,
        y,
        dir,
        width: localWidth(dist, x, y),
        used: false
      });
    }
  }

  return endpoints;
}

function estimateEndpointDirection(thin, x, y) {
  let sx = 0;
  let sy = 0;

  for (let yy = -5; yy <= 5; yy++) {
    for (let xx = -5; xx <= 5; xx++) {
      const nx = x + xx;
      const ny = y + yy;
      if (!inBounds(thin, nx, ny)) continue;
      if (!isWhite(thin, nx, ny)) continue;
      if (nx === x && ny === y) continue;

      sx += nx - x;
      sy += ny - y;
    }
  }

  const len = Math.hypot(sx, sy);
  if (len === 0) return null;
  return { x: sx / len, y: sy / len };
}

function lineSupport(bin, x0, y0, x1, y1) {
  const vx = x1 - x0;
  const vy = y1 - y0;
  const steps = Math.max(Math.abs(vx), Math.abs(vy));
  if (steps === 0) return 0;

  let hit = 0;
  let total = 0;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(x0 + vx * t);
    const y = Math.round(y0 + vy * t);

    for (let yy = -1; yy <= 1; yy++) {
      for (let xx = -1; xx <= 1; xx++) {
        const nx = x + xx;
        const ny = y + yy;
        if (!inBounds(bin, nx, ny)) continue;
        total++;
        if (isWhite(bin, nx, ny)) hit++;
      }
    }
  }

  return total === 0 ? 0 : hit / total;
}

/* ------------------------------------------------------------------ */
/* 線分割                                                              */
/* ------------------------------------------------------------------ */

function extractSegments(thin, settings) {
  const usedEdges = new Set();
  const segments = [];
  const endpoints = [];
  const junctions = [];

  for (let y = 1; y < thin.rows - 1; y++) {
    for (let x = 1; x < thin.cols - 1; x++) {
      if (!isWhite(thin, x, y)) continue;
      const ns = neighborsOf(thin, x, y);
      if (ns.length === 1) {
        endpoints.push({ x, y });
      } else if (ns.length > 2) {
        junctions.push({ x, y });
      }
    }
  }

  // まず端点・分岐点から辿り、残り（輪っかなど）を後から拾う
  const startPoints = endpoints.concat(junctions);

  for (const sp of startPoints) {
    for (const n of neighborsOf(thin, sp.x, sp.y)) {
      if (usedEdges.has(edgeKey(thin.cols, sp, n))) continue;
      segments.push(traceSegment(thin, sp, n, usedEdges, settings));
    }
  }

  for (let y = 1; y < thin.rows - 1; y++) {
    for (let x = 1; x < thin.cols - 1; x++) {
      if (!isWhite(thin, x, y)) continue;

      const p = { x, y };
      for (const n of neighborsOf(thin, x, y)) {
        if (usedEdges.has(edgeKey(thin.cols, p, n))) continue;
        segments.push(traceSegment(thin, p, n, usedEdges, settings));
      }
    }
  }

  return segments;
}

function traceSegment(thin, start, next, usedEdges, settings) {
  const points = [{ x: start.x, y: start.y }];
  let prev = start;
  let cur = next;

  while (true) {
    points.push({ x: cur.x, y: cur.y });
    usedEdges.add(edgeKey(thin.cols, prev, cur));

    const candidates = neighborsOf(thin, cur.x, cur.y).filter(p => {
      if (p.x === prev.x && p.y === prev.y) return false;
      return !usedEdges.has(edgeKey(thin.cols, cur, p));
    });

    if (candidates.length === 0) break;

    candidates.sort((a, b) => directionScore(prev, cur, b) - directionScore(prev, cur, a));
    const best = candidates[0];
    const bestScore = directionScore(prev, cur, best);
    const degree = neighborsOf(thin, cur.x, cur.y).length;

    if (degree > 2 && points.length > 2 && bestScore < settings.junctionContinueMinScore) break;
    if (bestScore < settings.segmentTurnMinScore) break;

    prev = cur;
    cur = best;
  }

  return points;
}

function filterShortSegments(segments, minPoints, minLength) {
  return segments.filter(points => points.length >= minPoints && pathLength(points) >= minLength);
}

/* ------------------------------------------------------------------ */
/* ベジェ化                                                            */
/* ------------------------------------------------------------------ */

function buildBezierStrokes(segments, dist, settings) {
  const strokes = [];

  for (let i = 0; i < segments.length; i++) {
    const samples = attachWidthSamples(segments[i], dist, settings.widthSmoothRadius);
    const simplified = simplifySamples(samples, settings.bezierEpsilon);
    if (simplified.length < 2) continue;

    const center = catmullRomToBezier2D(simplified);
    const width = catmullRomToBezier1D(simplified);
    if (center.length === 0 || width.length === 0) continue;

    strokes.push({
      id: i,
      pointCount: samples.length,
      center,
      width
    });
  }

  return strokes;
}

function attachWidthSamples(points, dist, smoothRadius) {
  const lengths = cumulativeLengths(points);
  const total = lengths[lengths.length - 1] || 1;
  const rawWidths = points.map(p => localWidth(dist, p.x, p.y));
  const widths = smoothValues(rawWidths, smoothRadius);

  return points.map((p, i) => ({
    x: p.x,
    y: p.y,
    t: lengths[i] / total,
    w: Math.max(1, widths[i])
  }));
}

function simplifySamples(samples, epsilon) {
  if (samples.length <= 2) return samples.slice();

  const keep = new Set([0, samples.length - 1]);
  rdpKeep(samples, 0, samples.length - 1, epsilon, keep);

  return Array.from(keep)
    .sort((a, b) => a - b)
    .map(i => samples[i]);
}

function rdpKeep(points, start, end, epsilon, keep) {
  let maxDist = -1;
  let index = -1;

  for (let i = start + 1; i < end; i++) {
    const d = pointLineDistance(points[i], points[start], points[end]);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }

  if (maxDist > epsilon && index !== -1) {
    keep.add(index);
    rdpKeep(points, start, index, epsilon, keep);
    rdpKeep(points, index, end, epsilon, keep);
  }
}

function catmullRomToBezier2D(points) {
  const curves = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    curves.push({
      p0: roundPoint(p1),
      c1: roundPoint({
        x: p1.x + (p2.x - p0.x) / 6,
        y: p1.y + (p2.y - p0.y) / 6
      }),
      c2: roundPoint({
        x: p2.x - (p3.x - p1.x) / 6,
        y: p2.y - (p3.y - p1.y) / 6
      }),
      p1: roundPoint(p2)
    });
  }

  return curves;
}

function catmullRomToBezier1D(points) {
  const curves = [];

  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    curves.push({
      t0: round(p1.t),
      w0: round(p1.w),
      c1: {
        t: round(p1.t + (p2.t - p0.t) / 6),
        w: round(p1.w + (p2.w - p0.w) / 6)
      },
      c2: {
        t: round(p2.t - (p3.t - p1.t) / 6),
        w: round(p2.w - (p3.w - p1.w) / 6)
      },
      t1: round(p2.t),
      w1: round(p2.w)
    });
  }

  return curves;
}

function lineStrokeToBezier(p0, p1, width) {
  const curve = {
    p0: roundPoint(p0),
    c1: roundPoint({ x: p0.x + (p1.x - p0.x) / 3, y: p0.y + (p1.y - p0.y) / 3 }),
    c2: roundPoint({ x: p0.x + (p1.x - p0.x) * 2 / 3, y: p0.y + (p1.y - p0.y) * 2 / 3 }),
    p1: roundPoint(p1)
  };

  const w = round(width);
  const widthCurve = {
    t0: 0,
    w0: w,
    c1: { t: 0.333, w },
    c2: { t: 0.667, w },
    t1: 1,
    w1: w
  };

  return { center: [curve], width: [widthCurve] };
}

/* ------------------------------------------------------------------ */
/* 塗りつぶし                                                          */
/* ------------------------------------------------------------------ */

function extractFillRegions(bin, dist, settings) {
  const labels = new cv.Mat();
  const stats = new cv.Mat();
  const centroids = new cv.Mat();
  const count = cv.connectedComponentsWithStats(bin, labels, stats, centroids, 8, cv.CV_32S);
  const fills = [];

  for (let label = 1; label < count; label++) {
    const area = stats.intPtr(label, cv.CC_STAT_AREA)[0];
    const left = stats.intPtr(label, cv.CC_STAT_LEFT)[0];
    const top = stats.intPtr(label, cv.CC_STAT_TOP)[0];
    const width = stats.intPtr(label, cv.CC_STAT_WIDTH)[0];
    const height = stats.intPtr(label, cv.CC_STAT_HEIGHT)[0];
    const density = area / Math.max(1, width * height);

    if (area < settings.fillMinArea || density < settings.fillMinDensity) continue;

    const metrics = componentWidthMetrics(labels, dist, label, left, top, width, height);
    if (metrics.maxWidth < settings.fillMinMaxWidth) continue;

    const delicate = isDelicateFill(area, width, height, metrics, settings);
    const mask = componentMask(labels, label);
    const contours = contourBeziersForMask(mask, settings.bezierEpsilon);
    const fillStrokes = delicate
      ? skeletonFillComponent(mask, dist, settings)
      : hatchFillComponent(labels, dist, label, left, top, width, height, metrics.avgWidth, delicate, settings);

    if (contours.length > 0 && fillStrokes.length > 0) {
      fills.push({
        id: label,
        mode: delicate ? "skeleton-brush" : "hatch",
        area,
        bbox: { x: left, y: top, width, height },
        density: round(density),
        avgWidth: round(metrics.avgWidth),
        maxWidth: round(metrics.maxWidth),
        delicate,
        mustPreserveWhite: delicate,
        whiteGuardPx: delicate ? settings.delicateWhiteGuard : settings.fillEdgeSafety,
        contours,
        fillStrokes
      });
    }

    mask.delete();
  }

  labels.delete();
  stats.delete();
  centroids.delete();
  return fills;
}

function isDelicateFill(area, width, height, metrics, settings) {
  const compactSmallArea = area <= settings.delicateFillMaxArea;
  const compactBox = Math.max(width, height) <= settings.delicateFillMaxBox;
  const hasFineWhiteDetailRisk = metrics.maxWidth <= settings.fillMinMaxWidth * 2.2;
  return compactSmallArea && compactBox && hasFineWhiteDetailRisk;
}

function componentWidthMetrics(labels, dist, label, left, top, width, height) {
  let sum = 0;
  let count = 0;
  let maxWidth = 0;

  for (let y = top; y < top + height; y++) {
    for (let x = left; x < left + width; x++) {
      if (labels.intPtr(y, x)[0] !== label) continue;

      const w = localWidth(dist, x, y);
      sum += w;
      maxWidth = Math.max(maxWidth, w);
      count++;
    }
  }

  return { avgWidth: count === 0 ? 0 : sum / count, maxWidth };
}

function componentMask(labels, label) {
  const mask = cv.Mat.zeros(labels.rows, labels.cols, cv.CV_8UC1);

  for (let y = 0; y < labels.rows; y++) {
    for (let x = 0; x < labels.cols; x++) {
      if (labels.intPtr(y, x)[0] === label) {
        mask.ucharPtr(y, x)[0] = 255;
      }
    }
  }

  return mask;
}

function contourBeziersForMask(mask, epsilon) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const result = [];

  cv.findContours(mask, contours, hierarchy, cv.RETR_CCOMP, cv.CHAIN_APPROX_NONE);

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    if (contour.rows < 8) {
      contour.delete();
      continue;
    }

    const samples = [];
    for (let j = 0; j < contour.rows; j++) {
      const p = contour.intPtr(j, 0);
      samples.push({ x: p[0], y: p[1], t: j / Math.max(1, contour.rows - 1), w: 1 });
    }

    samples.push({ ...samples[0], t: 1 });
    const simplified = simplifySamples(samples, epsilon);
    const center = catmullRomToBezier2D(simplified);

    if (center.length > 0) {
      const h = hierarchy.intPtr(0, i);
      result.push({ role: h[3] < 0 ? "outer" : "hole", center });
    }

    contour.delete();
  }

  contours.delete();
  hierarchy.delete();
  return result;
}

function hatchFillComponent(labels, dist, label, left, top, width, height, avgWidth, delicate, settings) {
  const strokes = [];
  const hatchWidthLimit = delicate ? settings.delicateFillMaxHatchWidth : settings.fillMaxHatchWidth;
  const hatchWidth = Math.max(1, Math.min(hatchWidthLimit, avgWidth));
  const spacing = Math.max(1, delicate ? settings.delicateFillHatchSpacing : settings.fillHatchSpacing);
  const minRunLength = delicate
    ? Math.max(2, Math.floor(settings.fillMinRunLength * 0.6))
    : settings.fillMinRunLength;
  const safety = hatchWidth / 2 + settings.fillEdgeSafety + (delicate ? settings.fillHoleSafety : 0);

  for (let y = top; y < top + height; y += spacing) {
    let x = left;

    while (x < left + width) {
      while (x < left + width && !isSafeFillPixel(labels, dist, label, x, y, safety)) x++;
      const start = x;
      while (x < left + width && isSafeFillPixel(labels, dist, label, x, y, safety)) x++;
      const end = x - 1;

      if (end - start + 1 < minRunLength) continue;

      // 1行ごとに向きを反転してペンの移動を減らす
      const reverse = Math.floor((y - top) / spacing) % 2 === 1;
      const p0 = reverse ? { x: end, y } : { x: start, y };
      const p1 = reverse ? { x: start, y } : { x: end, y };
      strokes.push(lineStrokeToBezier(p0, p1, hatchWidth));
    }
  }

  return strokes;
}

function skeletonFillComponent(mask, dist, settings) {
  const thin = zhangSuenFast(mask);
  const rawSegments = extractSegments(thin, settings);
  const segments = filterShortSegments(rawSegments, settings.delicateFillMinPoints, settings.delicateFillMinLength);
  const strokes = buildBezierStrokes(segments, dist, {
    ...settings,
    bezierEpsilon: Math.max(1.0, settings.bezierEpsilon * 0.55),
    widthSmoothRadius: Math.max(1, Math.floor(settings.widthSmoothRadius * 0.5))
  });
  protectWhiteInDelicateStrokes(strokes, settings);

  thin.delete();
  return strokes;
}

function protectWhiteInDelicateStrokes(strokes, settings) {
  for (const stroke of strokes) {
    for (const curve of stroke.width) {
      curve.w0 = protectedWidth(curve.w0, settings);
      curve.w1 = protectedWidth(curve.w1, settings);
      curve.c1.w = protectedWidth(curve.c1.w, settings);
      curve.c2.w = protectedWidth(curve.c2.w, settings);
    }
  }
}

function protectedWidth(width, settings) {
  const guarded = Math.max(
    settings.delicateMinPaintWidth,
    (width - settings.delicateWhiteGuard * 2) * settings.delicateWidthScale
  );
  return round(Math.min(width, guarded));
}

function isSafeFillPixel(labels, dist, label, x, y, safety) {
  if (labels.intPtr(y, x)[0] !== label) return false;
  return dist.floatPtr(y, x)[0] >= safety;
}

/* ------------------------------------------------------------------ */
/* 描画順                                                              */
/* ------------------------------------------------------------------ */

function fillDrawingStrokes(fill) {
  return fill.fillStrokes || fill.hatchStrokes || [];
}

function buildPlotterPlan(strokes, fills) {
  const items = [];

  for (let i = 0; i < strokes.length; i++) {
    const metrics = strokeMetrics(strokes[i]);
    items.push({
      type: "stroke",
      strokeId: strokes[i].id,
      strokeIndex: i,
      group: strokeOrderGroup(metrics),
      start: metrics.start,
      end: metrics.end,
      length: metrics.length,
      avgWidth: metrics.avgWidth
    });
  }

  for (let fillIndex = 0; fillIndex < fills.length; fillIndex++) {
    const fill = fills[fillIndex];
    const fillStrokes = fillDrawingStrokes(fill);

    for (let strokeIndex = 0; strokeIndex < fillStrokes.length; strokeIndex++) {
      const metrics = strokeMetrics(fillStrokes[strokeIndex]);
      items.push({
        type: "fillStroke",
        fillId: fill.id,
        fillIndex,
        strokeIndex,
        group: fill.delicate ? "delicate" : "fill",
        start: metrics.start,
        end: metrics.end,
        length: metrics.length,
        avgWidth: metrics.avgWidth,
        mode: fill.mode
      });
    }
  }

  // 太く長い骨格 → 塗り → 中くらいの線 → 細かいもの の順に描く
  const groups = ["structure", "fill", "detail", "delicate"];
  const ordered = [];

  for (const group of groups) {
    ordered.push(...nearestNeighborOrder(items.filter(item => item.group === group)));
  }

  return ordered.map((item, order) => ({
    order,
    type: item.type,
    group: item.group,
    reverse: item.reverse,
    strokeId: item.strokeId,
    strokeIndex: item.strokeIndex,
    fillId: item.fillId,
    fillIndex: item.fillIndex,
    mode: item.mode
  }));
}

function strokeOrderGroup(metrics) {
  if (metrics.length >= 90 || metrics.avgWidth >= 7) return "structure";
  if (metrics.length <= 32 || metrics.avgWidth <= 2.2) return "delicate";
  return "detail";
}

function nearestNeighborOrder(items) {
  const remaining = items.slice();
  const ordered = [];
  let pen = null;

  remaining.sort((a, b) => b.length - a.length);

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestReverse = false;
    let bestScore = Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      const forwardDistance = pen === null ? 0 : distance(pen, item.start);
      const reverseDistance = pen === null ? 0 : distance(pen, item.end);
      const distanceScore = Math.min(forwardDistance, reverseDistance);
      const lengthBias = Math.min(40, item.length) * 0.02;
      const score = distanceScore - lengthBias;

      if (score < bestScore) {
        bestScore = score;
        bestIndex = i;
        bestReverse = reverseDistance < forwardDistance;
      }
    }

    const next = remaining.splice(bestIndex, 1)[0];
    next.reverse = bestReverse;
    ordered.push(next);
    pen = bestReverse ? next.start : next.end;
  }

  return ordered;
}

function strokeForCommand(result, command) {
  if (command.type === "stroke") {
    return result.strokes[command.strokeIndex] || null;
  }
  if (command.type === "fillStroke") {
    const fill = result.fills[command.fillIndex];
    if (!fill) return null;
    return fillDrawingStrokes(fill)[command.strokeIndex] || null;
  }
  return null;
}

function strokeMetrics(stroke) {
  const start = stroke.center.length > 0 ? stroke.center[0].p0 : { x: 0, y: 0 };
  const end = stroke.center.length > 0 ? stroke.center[stroke.center.length - 1].p1 : start;
  let length = 0;
  let widthSum = 0;
  let widthCount = 0;

  for (const curve of stroke.center) {
    length += estimateCubicLength(curve, 8);
  }

  for (const curve of stroke.width || []) {
    widthSum += curve.w0 + curve.w1;
    widthCount += 2;
  }

  return { start, end, length, avgWidth: widthCount === 0 ? 1 : widthSum / widthCount };
}

/** ペンを上げて移動する距離の合計（描画順の良し悪しの目安） */
function penUpTravel(result) {
  let pen = null;
  let travel = 0;
  for (const command of result.drawOrder) {
    const stroke = strokeForCommand(result, command);
    if (!stroke) continue;
    const m = strokeMetrics(stroke);
    const start = command.reverse ? m.end : m.start;
    const end = command.reverse ? m.start : m.end;
    if (pen) travel += distance(pen, start);
    pen = end;
  }
  return travel;
}

function summarizeResult(result) {
  const curveCount = result.strokes.reduce((sum, stroke) => sum + stroke.center.length, 0);
  const fillStrokeCount = result.fills.reduce((sum, fill) => sum + fillDrawingStrokes(fill).length, 0);
  const orderGroups = result.drawOrder.reduce((groups, item) => {
    groups[item.group] = (groups[item.group] || 0) + 1;
    return groups;
  }, {});

  return {
    image: result.image,
    strokes: result.strokes.length,
    bezierCurves: curveCount,
    fills: result.fills.length,
    fillStrokes: fillStrokeCount,
    drawCommands: result.drawOrder.length,
    penUpTravelPx: Math.round(penUpTravel(result)),
    orderGroups
  };
}

/* ------------------------------------------------------------------ */
/* プレビュー描画                                                       */
/* ------------------------------------------------------------------ */

function drawSegments(rows, cols, segments) {
  const out = new cv.Mat(rows, cols, cv.CV_8UC4);
  out.setTo(new cv.Scalar(255, 255, 255, 255));

  for (let i = 0; i < segments.length; i++) {
    const color = scalar(colorForIndex(i));
    const pts = segments[i];
    for (let j = 0; j < pts.length - 1; j++) {
      cv.line(out, point(pts[j]), point(pts[j + 1]), color, 1);
    }
  }

  return out;
}

function drawBezierStrokes(rows, cols, strokes) {
  const out = new cv.Mat(rows, cols, cv.CV_8UC4);
  out.setTo(new cv.Scalar(255, 255, 255, 255));

  for (let i = 0; i < strokes.length; i++) {
    const color = scalar(colorForIndex(i));
    for (const curve of strokes[i].center) {
      drawCubic(out, curve, color, 2);
    }
  }

  return out;
}

function drawWidthPreview(rows, cols, strokes, guardMask, stepPx) {
  const mask = cv.Mat.zeros(rows, cols, cv.CV_8UC1);
  for (const stroke of strokes) {
    drawVariableStroke(mask, stroke, new cv.Scalar(255), stepPx);
  }
  applyWhiteGuard(mask, guardMask);
  const out = maskToRgba(mask);
  mask.delete();
  return out;
}

function drawPlotterMask(rows, cols, strokes, fills, guardMask, stepPx) {
  const out = cv.Mat.zeros(rows, cols, cv.CV_8UC1);

  for (const stroke of strokes) {
    drawVariableStroke(out, stroke, new cv.Scalar(255), stepPx);
  }
  for (const fill of fills) {
    for (const stroke of fillDrawingStrokes(fill)) {
      drawVariableStroke(out, stroke, new cv.Scalar(255), stepPx);
    }
  }

  applyWhiteGuard(out, guardMask);
  return out;
}

function applyWhiteGuard(mask, guardMask) {
  if (!guardMask) return;
  cv.bitwise_and(mask, guardMask, mask);
}

function drawFillPreview(rows, cols, fills, stepPx) {
  const out = new cv.Mat(rows, cols, cv.CV_8UC4);
  out.setTo(new cv.Scalar(255, 255, 255, 255));

  for (let i = 0; i < fills.length; i++) {
    const color = scalar(colorForIndex(i + 50));
    const contourColor = fills[i].delicate
      ? new cv.Scalar(0, 80, 180, 255)
      : new cv.Scalar(20, 20, 20, 255);

    for (const stroke of fillDrawingStrokes(fills[i])) {
      drawVariableStroke(out, stroke, color, stepPx);
    }
    for (const contour of fills[i].contours) {
      for (const curve of contour.center) {
        drawCubic(out, curve, contour.role === "hole" ? new cv.Scalar(220, 40, 40, 255) : contourColor, 2);
      }
    }
  }

  return out;
}

/** 黒=一致, 赤=描けていない, 青=はみ出し */
function drawDifference(target, plotted) {
  const out = new cv.Mat(target.rows, target.cols, cv.CV_8UC4);
  const t = target.data;
  const p = plotted.data;
  const o = out.data;
  const stats = { match: 0, missing: 0, extra: 0, target: 0 };

  for (let i = 0; i < t.length; i++) {
    const goal = t[i] > 0;
    const got = p[i] > 0;
    let r = 255, g = 255, b = 255;
    if (goal) stats.target++;
    if (goal && got) { r = 0; g = 0; b = 0; stats.match++; }
    else if (goal && !got) { r = 230; g = 30; b = 30; stats.missing++; }
    else if (!goal && got) { r = 30; g = 80; b = 240; stats.extra++; }
    o[i * 4] = r;
    o[i * 4 + 1] = g;
    o[i * 4 + 2] = b;
    o[i * 4 + 3] = 255;
  }

  return { mat: out, stats };
}

/** 描画順プレビュー: step 本目まで黒、step 本目を赤で描く */
function drawOrderPreview(result, step, guardMask, stepPx) {
  const rows = result.image.height;
  const cols = result.image.width;
  const doneMask = cv.Mat.zeros(rows, cols, cv.CV_8UC1);
  const currentMask = cv.Mat.zeros(rows, cols, cv.CV_8UC1);
  const clampedStep = Math.max(0, Math.min(step, result.drawOrder.length));

  for (let i = 0; i < clampedStep; i++) {
    const stroke = strokeForCommand(result, result.drawOrder[i]);
    if (stroke) drawVariableStroke(doneMask, stroke, new cv.Scalar(255), stepPx);
  }

  let current = null;
  if (clampedStep < result.drawOrder.length) {
    const command = result.drawOrder[clampedStep];
    const stroke = strokeForCommand(result, command);
    if (stroke) {
      current = { stroke, reverse: command.reverse };
      drawVariableStroke(currentMask, stroke, new cv.Scalar(255), stepPx);
    }
  }

  applyWhiteGuard(doneMask, guardMask);
  applyWhiteGuard(currentMask, guardMask);

  const out = new cv.Mat(rows, cols, cv.CV_8UC4);
  const d = doneMask.data;
  const c = currentMask.data;
  const o = out.data;
  for (let i = 0; i < d.length; i++) {
    let r = 255, g = 255, b = 255;
    if (c[i] > 0) { r = 230; g = 30; b = 30; }
    else if (d[i] > 0) { r = 0; g = 0; b = 0; }
    o[i * 4] = r;
    o[i * 4 + 1] = g;
    o[i * 4 + 2] = b;
    o[i * 4 + 3] = 255;
  }

  if (current) {
    const m = strokeMetrics(current.stroke);
    const start = current.reverse ? m.end : m.start;
    const end = current.reverse ? m.start : m.end;
    cv.circle(out, point(start), 5, new cv.Scalar(20, 140, 40, 255), -1); // 緑=書き始め
    cv.circle(out, point(end), 5, new cv.Scalar(230, 30, 30, 255), 2);    // 赤丸=書き終わり
  }

  doneMask.delete();
  currentMask.delete();
  return out;
}

function maskToRgba(mask) {
  const out = new cv.Mat(mask.rows, mask.cols, cv.CV_8UC4);
  const m = mask.data;
  const o = out.data;
  for (let i = 0; i < m.length; i++) {
    const v = m[i] > 0 ? 0 : 255;
    o[i * 4] = v;
    o[i * 4 + 1] = v;
    o[i * 4 + 2] = v;
    o[i * 4 + 3] = 255;
  }
  return out;
}

function drawCubic(mat, curve, color, thickness) {
  let prev = evalCubicPoint(curve, 0);
  for (let i = 1; i <= 24; i++) {
    const next = evalCubicPoint(curve, i / 24);
    cv.line(mat, point(prev), point(next), color, thickness);
    prev = next;
  }
}

function drawVariableStroke(mat, stroke, color, stepPx = DEFAULT_SETTINGS.emulatorStepPx) {
  const count = Math.min(stroke.center.length, stroke.width.length);
  for (let i = 0; i < count; i++) {
    drawVariableCubic(mat, stroke.center[i], stroke.width[i], color, stepPx);
  }
}

function drawVariableCubic(mat, centerCurve, widthCurve, color, stepPx) {
  const length = estimateCubicLength(centerCurve, 14);
  const steps = Math.max(2, Math.ceil(length / stepPx));
  let prev = evalCubicPoint(centerCurve, 0);
  let prevW = evalWidthCurve(widthCurve, 0);

  cv.circle(mat, point(prev), Math.max(1, Math.round(prevW / 2)), color, -1);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cur = evalCubicPoint(centerCurve, t);
    const curW = evalWidthCurve(widthCurve, t);
    const thickness = Math.max(1, Math.round((prevW + curW) / 2));

    cv.line(mat, point(prev), point(cur), color, thickness);
    cv.circle(mat, point(cur), Math.max(1, Math.round(curW / 2)), color, -1);

    prev = cur;
    prevW = curW;
  }
}

/* ------------------------------------------------------------------ */
/* 小さな道具                                                          */
/* ------------------------------------------------------------------ */

function estimateCubicLength(curve, steps) {
  let prev = evalCubicPoint(curve, 0);
  let length = 0;
  for (let i = 1; i <= steps; i++) {
    const cur = evalCubicPoint(curve, i / steps);
    length += Math.hypot(cur.x - prev.x, cur.y - prev.y);
    prev = cur;
  }
  return length;
}

function evalCubicPoint(curve, t) {
  const u = 1 - t;
  return {
    x: u * u * u * curve.p0.x + 3 * u * u * t * curve.c1.x + 3 * u * t * t * curve.c2.x + t * t * t * curve.p1.x,
    y: u * u * u * curve.p0.y + 3 * u * u * t * curve.c1.y + 3 * u * t * t * curve.c2.y + t * t * t * curve.p1.y
  };
}

function evalWidthCurve(curve, t) {
  const u = 1 - t;
  return u * u * u * curve.w0 + 3 * u * u * t * curve.c1.w + 3 * u * t * t * curve.c2.w + t * t * t * curve.w1;
}

function neighborsOf(mat, x, y) {
  const out = [];
  for (const [dx, dy] of DIRS_8) {
    const nx = x + dx;
    const ny = y + dy;
    if (inBounds(mat, nx, ny) && isWhite(mat, nx, ny)) out.push({ x: nx, y: ny });
  }
  return out;
}

function directionScore(prev, cur, next) {
  let ax = cur.x - prev.x;
  let ay = cur.y - prev.y;
  let bx = next.x - cur.x;
  let by = next.y - cur.y;
  const al = Math.hypot(ax, ay);
  const bl = Math.hypot(bx, by);
  if (al === 0 || bl === 0) return -Infinity;
  ax /= al; ay /= al; bx /= bl; by /= bl;
  return ax * bx + ay * by;
}

function edgeKey(cols, a, b) {
  const ka = a.y * cols + a.x;
  const kb = b.y * cols + b.x;
  return ka < kb ? `${ka}-${kb}` : `${kb}-${ka}`;
}

function isWhite(mat, x, y) {
  return mat.ucharPtr(y, x)[0] > 0;
}

function inBounds(mat, x, y) {
  return x >= 0 && x < mat.cols && y >= 0 && y < mat.rows;
}

function localWidth(dist, x, y) {
  if (!inBounds(dist, x, y)) return 1;
  return dist.floatPtr(y, x)[0] * 2;
}

function cumulativeLengths(points) {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    lengths.push(lengths[i - 1] + Math.hypot(cur.x - prev.x, cur.y - prev.y));
  }
  return lengths;
}

function pathLength(points) {
  const lengths = cumulativeLengths(points);
  return lengths[lengths.length - 1] || 0;
}

function smoothValues(values, radius) {
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(values.length - 1, i + radius); j++) {
      sum += values[j];
      count++;
    }
    return sum / count;
  });
}

function pointLineDistance(p, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
  return Math.hypot(p.x - (a.x + vx * t), p.y - (a.y + vy * t));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function colorForIndex(i) {
  const hue = (i * 137.508) % 360;
  return hslToRgb(hue / 360, 0.70, 0.45);
}

function hslToRgb(h, s, l) {
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255)
  ];
}

function point(p) {
  return new cv.Point(Math.round(p.x), Math.round(p.y));
}

function scalar(rgb) {
  return new cv.Scalar(rgb[0], rgb[1], rgb[2], 255);
}

function roundPoint(p) {
  return { x: round(p.x), y: round(p.y) };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}
