// ベクター化の結果(ピクセル座標)を、ペンプロッター用の mm 座標に変換する。
//
// 出力の形式(1 本のストローク = ペンを 1 回下ろす分):
//   {
//     "unit": "mm",
//     "origin": "paper-bottom-left",
//     "paper": { "width": 91, "height": 55 },
//     "strokes": [ [ [x0, y0, cx1, cy1, cx2, cy2, x1, y1], ... ], ... ]
//   }
// 原点は紙の左下、x は右、y は上。紙を置く位置は ESP32 の PlotterConfig.h で足す。

// 制御点の長さの上限(ベジェ 1 本の両端の距離に対する比)。
// 長い線と短い線のつなぎ目で、制御点が飛び出す形を防ぐ。
const HANDLE_MAX_RATIO = 0.5;
const LENGTH_SAMPLES = 16;   // 範囲と長さを求めるときの、ベジェ 1 本あたりの分割数

// 2 点の間を t で補間した点を返す。
function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

// 制御点が anchor から maxLength より離れていたら、同じ向きのまま近づける。
function limitHandle(anchor, handle, maxLength) {
  const length = Math.hypot(handle.x - anchor.x, handle.y - anchor.y);
  return length <= maxLength ? handle : lerpPoint(anchor, handle, length === 0 ? 0 : maxLength / length);
}

// ベジェ 1 本の制御点を、両端の距離に合わせて制限する。
function limitCurveHandles(curve) {
  const maxLength = Math.hypot(curve.p1.x - curve.p0.x, curve.p1.y - curve.p0.y) * HANDLE_MAX_RATIO;
  return {
    p0: curve.p0,
    c1: limitHandle(curve.p0, curve.c1, maxLength),
    c2: limitHandle(curve.p1, curve.c2, maxLength),
    p1: curve.p1
  };
}

// ベジェ曲線上の点を返す。
function cubicPoint(curve, t) {
  const u = 1 - t;
  const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
  return {
    x: a * curve.p0.x + b * curve.c1.x + c * curve.c2.x + d * curve.p1.x,
    y: a * curve.p0.y + b * curve.c1.y + c * curve.c2.y + d * curve.p1.y
  };
}

// ストロークを細かい点列にする。
function samplePath(path) {
  const points = [];
  for (const curve of path) {
    for (let i = 0; i <= LENGTH_SAMPLES; i++) points.push(cubicPoint(curve, i / LENGTH_SAMPLES));
  }
  return points;
}

// 点列の長さを返す。
function polylineLength(points) {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

// drawOrder の順に、向きをそろえたベジェ曲線の配列を作る。
function orderedPaths(result) {
  const paths = [];
  for (const command of result.drawOrder) {
    const stroke = strokeForCommand(result, command);
    if (!stroke || stroke.center.length === 0) continue;
    const curves = stroke.center.map(limitCurveHandles);
    paths.push(command.reverse
      ? curves.slice().reverse().map(c => ({ p0: c.p1, c1: c.c2, c2: c.c1, p1: c.p0 }))
      : curves);
  }
  return paths;
}

// 点列の範囲を返す。
function pointBounds(pointLists) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const points of pointLists) {
    for (const p of points) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    }
  }
  return { minX, maxX, minY, maxY };
}

const roundMm = value => Math.round(value * 1000) / 1000;

// 結果全体を紙に収まる mm 座標へ変換する。
// options: { paperWidth, paperHeight, minStrokeMm }(単位はすべて mm)
// 戻り値: { data: 保存する JSON の中身, stats: 画面に出す集計 }
function normalizeForPlotter(result, options) {
  const { paperWidth, paperHeight, minStrokeMm } = options;
  const paths = orderedPaths(result);
  const sampled = paths.map(samplePath);
  const bounds = pointBounds(sampled);
  const drawWidth = bounds.maxX - bounds.minX;
  const drawHeight = bounds.maxY - bounds.minY;
  const scale = Math.min(paperWidth / drawWidth, paperHeight / drawHeight);

  // 紙の中央に置く。画像は y が下向きなので反転する
  const offsetX = (paperWidth - drawWidth * scale) / 2;
  const offsetY = (paperHeight - drawHeight * scale) / 2;
  const toMm = p => [
    roundMm(offsetX + (p.x - bounds.minX) * scale),
    roundMm(offsetY + (bounds.maxY - p.y) * scale)
  ];

  const strokes = [];
  let removed = 0;
  let drawMm = 0;
  for (let i = 0; i < paths.length; i++) {
    const lengthMm = polylineLength(sampled[i]) * scale;
    if (lengthMm < minStrokeMm) {
      removed++;
      continue;
    }
    drawMm += lengthMm;
    strokes.push(paths[i].map(c => [...toMm(c.p0), ...toMm(c.c1), ...toMm(c.c2), ...toMm(c.p1)]));
  }

  return {
    data: {
      unit: "mm",
      origin: "paper-bottom-left",
      paper: { width: paperWidth, height: paperHeight },
      strokes
    },
    stats: {
      scale,
      width: drawWidth * scale,
      height: drawHeight * scale,
      strokes: strokes.length,
      removed,
      drawMm
    }
  };
}
