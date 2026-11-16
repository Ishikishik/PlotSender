// 補正シートの上に描いた格子の写真から、位置の補正テーブルを作る(パンタグラフ = cutting_machine 用)。
// cutting_machine/calibration/make_correction.py をブラウザ用に移したもの。数値の処理は同じ。
//
// 手順:
//   1. 4 つの ArUco マーカーから、写真 → 機械座標 [mm] の変換(ホモグラフィー)を求める
//   2. 写真を真上から見た画像(1mm = 10 ピクセル)に直し、青いペンの線だけを取り出す
//   3. 横線と縦線をたどり、格子の交点の位置を求める
//   4. 交点ごとに「実際に描かれた位置 - 指令した位置」のずれを求める
//   5. 表の点ごとに近くの交点で当てはめ(局所回帰)、5mm 間隔の表にする
// 新規(補正なしで描いた格子)と更新(補正ありで描いた格子。残りのずれを今の表に足す)がある。
// OpenCV.js(ArUco 入り)を使う。

(function (root) {
  // ---- 機械の設定(firm/src/config/PlotterConfig.h と同じ値) ----
  const CONFIG = { PAPER_X_MIN: -70, PAPER_X_MAX: 70, PAPER_Y_MIN: 75, PAPER_Y_MAX: 150, GRID_PITCH_MM: 10 };

  // ---- マーカーの角の位置 [mm](左上・右上・右下・左下)とはがきの範囲 ----
  // 0〜3: 印刷した補正シートのマーカー(calibration/calibration_sheet.json)
  // 10〜14: 天板に埋め込んだマーカー(calibration/plate_markers.json)。写っているものを全部使う
  const SHEET = {
    paper: { x_min: -70, x_max: 70, y_min: 75, y_max: 150 },
    sheet: { x_min: -75, x_max: 75, y_min: 60, y_max: 160 },
    markers: {
      0: [[-74, 159], [-66, 159], [-66, 151], [-74, 151]],
      1: [[66, 159], [74, 159], [74, 151], [66, 151]],
      2: [[66, 69], [74, 69], [74, 61], [66, 61]],
      3: [[-74, 69], [-66, 69], [-66, 61], [-74, 61]],
      10: [[-69.5, 56.0], [-57.5, 56.0], [-57.5, 44.0], [-69.5, 44.0]],
      11: [[57.5, 56.0], [69.5, 56.0], [69.5, 44.0], [57.5, 44.0]],
      12: [[-85.45, 140.2], [-77.05, 140.2], [-77.05, 131.8], [-85.45, 131.8]],
      13: [[77.05, 140.2], [85.45, 140.2], [85.45, 131.8], [77.05, 131.8]],
      14: [[-85.45, 94.2], [-77.05, 94.2], [-77.05, 85.8], [-85.45, 85.8]],
    },
  };

  const SCALE = 10;            // 真上から見た画像の 1mm あたりのピクセル数
  const POLY_DEGREE = 4;       // 往復のずれを見積もるときの多項式の次数
  const LOCAL_SIGMA_MM = 8;    // 表の各点の当てはめで、近くの交点に付ける重みの幅
  // 測った交点から離れた表の点(外挿)の扱い。近い交点までの距離が NEAR_MM までは普通に当てはめ、
  // FAR_MM までに「傾きを使わない(近くの交点の重み付き平均)」に移す。更新のときは、足す量も 0 へ弱める
  // (外挿した値を更新のたびに足していくと、測っていない場所の値がどんどん大きくなるため)
  const NEAR_MM = 6, FAR_MM = 20;
  const TABLE_STEP_MM = 5;     // 表の間隔
  const TRACK_STEP_MM = 0.5;   // 線をたどる間隔
  const TRACK_WINDOW_MM = 1.5; // 次の点を探す範囲
  const MAX_GAP_MM = 15;       // 線が途切れていても、たどり続ける長さ
  const RIGID_GAIN = 0.5;      // 更新のとき、全体の平行移動と回転を何割だけ足すか

  // ================================================================ 数値計算の道具
  // 最小二乗 A x = B(A は m 行 n 列、B は m 行 k 列。どちらも行の配列)。ハウスホルダー QR で解く
  function lstsq(A, B) {
    const m = A.length, n = A[0].length, k = B[0].length;
    const R = A.map(r => r.slice()), Q = B.map(r => r.slice());
    for (let j = 0; j < n && j < m; j++) {
      let norm = 0;
      for (let i = j; i < m; i++) norm += R[i][j] * R[i][j];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      const alpha = R[j][j] > 0 ? -norm : norm;
      const v = new Array(m).fill(0);
      v[j] = R[j][j] - alpha;
      for (let i = j + 1; i < m; i++) v[i] = R[i][j];
      let vv = 0;
      for (let i = j; i < m; i++) vv += v[i] * v[i];
      if (vv === 0) continue;
      for (let c = j; c < n; c++) {
        let s = 0;
        for (let i = j; i < m; i++) s += v[i] * R[i][c];
        s = 2 * s / vv;
        for (let i = j; i < m; i++) R[i][c] -= s * v[i];
      }
      for (let c = 0; c < k; c++) {
        let s = 0;
        for (let i = j; i < m; i++) s += v[i] * Q[i][c];
        s = 2 * s / vv;
        for (let i = j; i < m; i++) Q[i][c] -= s * v[i];
      }
    }
    let maxDiag = 0;
    for (let j = 0; j < Math.min(n, m); j++) maxDiag = Math.max(maxDiag, Math.abs(R[j][j]));
    const X = Array.from({ length: n }, () => new Array(k).fill(0));
    for (let c = 0; c < k; c++) {
      for (let j = Math.min(n, m) - 1; j >= 0; j--) {
        if (Math.abs(R[j][j]) <= 1e-12 * maxDiag) { X[j][c] = 0; continue; }   // 決まらない成分は 0
        let s = Q[j][c];
        for (let t = j + 1; t < n; t++) s -= R[j][t] * X[t][c];
        X[j][c] = s / R[j][j];
      }
    }
    return X;
  }
  const lstsq1 = (A, b) => lstsq(A, b.map(v => [v])).map(r => r[0]);

  // 多項式の当てはめ(np.polyfit 相当)。x は内部で -1〜1 に直して解く
  function polyfit(xs, ys, degree) {
    let lo = Infinity, hi = -Infinity;
    for (const x of xs) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
    const mid = (lo + hi) / 2, half = (hi - lo) / 2 || 1;
    const A = xs.map(x => { const s = (x - mid) / half; const r = []; for (let d = 0; d <= degree; d++) r.push(s ** d); return r; });
    return { mid, half, c: lstsq1(A, ys) };
  }
  function polyval(fit, x) {
    const s = (x - fit.mid) / fit.half;
    let v = 0;
    for (let d = fit.c.length - 1; d >= 0; d--) v = v * s + fit.c[d];
    return v;
  }
  // np.interp(xp は昇順、外は端の値)
  function interp(x, xp, fp) {
    const n = xp.length;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xp[mid] <= x) lo = mid; else hi = mid; }
    const d = xp[hi] - xp[lo];
    return d === 0 ? fp[hi] : fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / d;
  }
  function median(values) {
    const s = values.slice().sort((a, b) => a - b), n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const rms = a => Math.sqrt(mean(a.map(v => v * v)));

  function gridValues(start, stop, pitch, endLine = false) {
    const values = [];
    for (let v = start; v <= stop + 0.01; v += pitch) values.push(Math.round(v * 1e6) / 1e6);
    if (endLine && stop - values[values.length - 1] > 0.5) values.push(Math.round(stop * 1e6) / 1e6);
    return values;
  }

  // ================================================================ 1. マーカー → 機械座標
  function photoToMachine(cv, rgba, log) {
    const gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    const dictionary = cv.getPredefinedDictionary(cv.DICT_4X4_50);
    const params = new cv.aruco_DetectorParameters();
    const refine = new cv.aruco_RefineParameters(10, 3, true);
    const detector = new cv.aruco_ArucoDetector(dictionary, params, refine);
    const corners = new cv.MatVector(), ids = new cv.Mat(), rejected = new cv.MatVector();
    try {
      detector.detectMarkers(gray, corners, ids, rejected);
      const src = [], dst = [], found = [];
      for (let k = 0; k < ids.rows; k++) {
        const id = String(ids.data32S[k]);
        if (!SHEET.markers[id]) continue;
        found.push(id);
        const c = corners.get(k).data32F;
        for (let p = 0; p < 4; p++) { src.push([c[2 * p], c[2 * p + 1]]); dst.push(SHEET.markers[id][p]); }
      }
      if (found.length < 2) throw new Error(`使えるマーカーが ${found.length} 個しかない(天板のマーカーが全部写るように撮る)`);
      const srcMat = cv.matFromArray(src.length, 1, cv.CV_64FC2, src.flat());
      const dstMat = cv.matFromArray(dst.length, 1, cv.CV_64FC2, dst.flat());
      const hMat = cv.findHomography(srcMat, dstMat);
      const H = Array.from(hMat.data64F);
      srcMat.delete(); dstMat.delete(); hMat.delete();
      const err = src.map(([u, v], i) => {
        const w = H[6] * u + H[7] * v + H[8];
        return Math.hypot((H[0] * u + H[1] * v + H[2]) / w - dst[i][0], (H[3] * u + H[4] * v + H[5]) / w - dst[i][1]);
      });
      const e = rms(err);
      log(`マーカー: [${found.sort().join(", ")}] を検出。当てはまりの誤差 ${e.toFixed(2)} mm`);
      if (e > 0.5) log("  注意: 誤差が大きい。印刷の倍率か、マーカーの読み取りを確認する");
      return H;
    } finally {
      gray.delete(); corners.delete(); ids.delete(); rejected.delete();
      detector.delete(); refine.delete(); params.delete(); dictionary.delete();
    }
  }

  // 機械座標の area を真上から見た画像にする(RGB)
  function topView(cv, rgba, H, area) {
    const [x0, y0, x1, y1] = area;
    const P = [SCALE, 0, -x0 * SCALE, 0, -SCALE, y1 * SCALE, 0, 0, 1];
    const M = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      let s = 0;
      for (let t = 0; t < 3; t++) s += P[r * 3 + t] * H[t * 3 + c];
      M.push(s);
    }
    const rgb = new cv.Mat();
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    const top = new cv.Mat(), mMat = cv.matFromArray(3, 3, cv.CV_64F, M);
    cv.warpPerspective(rgb, top, mMat, new cv.Size(Math.round((x1 - x0) * SCALE), Math.round((y1 - y0) * SCALE)));
    rgb.delete(); mMat.delete();
    return top;
  }

  // ================================================================ 2. 青いペンの線
  function inkMask(cv, top) {
    const hsv = new cv.Mat();
    cv.cvtColor(top, hsv, cv.COLOR_RGB2HSV);
    const mask = new cv.Mat(top.rows, top.cols, cv.CV_8U);
    const d = hsv.data, m = mask.data;
    for (let i = 0, p = 0; i < m.length; i++, p += 3) {
      const h = d[p], s = d[p + 1], v = d[p + 2];
      m[i] = h > 95 && h < 140 && s > 30 && v > 30 && v < 235 ? 255 : 0;
    }
    hsv.delete();
    const k2 = cv.Mat.ones(2, 2, cv.CV_8U), k3 = cv.Mat.ones(3, 3, cv.CV_8U);
    const opened = new cv.Mat(), out = new cv.Mat();
    cv.morphologyEx(mask, opened, cv.MORPH_OPEN, k2);
    cv.dilate(opened, out, k3);
    mask.delete(); opened.delete(); k2.delete(); k3.delete();
    return out;
  }

  // ================================================================ 3. 線をたどる
  // マスク(幅 W、高さ H の 0/255)の 1 列(horizontal なら u = t の列)または 1 行を取り出す
  function lineOf(mask, horizontal, t) {
    if (horizontal) {
      const out = new Uint8Array(mask.h);
      for (let v = 0; v < mask.h; v++) out[v] = mask.d[v * mask.w + t];
      return out;
    }
    return mask.d.subarray(t * mask.w, (t + 1) * mask.w);
  }

  function runs(line, maxLen) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= line.length; i++) {
      const on = i < line.length && line[i] > 0;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        if (i - start <= maxLen) out.push((start + i - 1) / 2);
        start = -1;
      }
    }
    return out;
  }

  function trace(mask, horizontal, seedIndex, seedPos) {
    const length = horizontal ? mask.w : mask.h;
    const step = Math.max(1, Math.floor(TRACK_STEP_MM * SCALE));
    const window = TRACK_WINDOW_MM * SCALE;
    const maxMiss = Math.floor(MAX_GAP_MM / TRACK_STEP_MM);
    const points = new Map();
    for (const direction of [1, -1]) {
      const history = [];
      let t = seedIndex, miss = 0;
      while (t >= 0 && t < length && miss < maxMiss) {
        let predicted;
        if (history.length >= 3) {
          const recent = history.slice(-8);
          predicted = polyval(polyfit(recent.map(p => p[0]), recent.map(p => p[1]), 1), t);
        } else {
          predicted = history.length ? history[history.length - 1][1] : seedPos;
        }
        const near = runs(lineOf(mask, horizontal, t), 3 * SCALE).filter(c => Math.abs(c - predicted) < window);
        if (near.length) {
          const c = near.reduce((a, b) => (Math.abs(b - predicted) < Math.abs(a - predicted) ? b : a));
          history.push([t, c]);
          points.set(t + "," + c, [t, c]);
          miss = 0;
        } else {
          miss++;
        }
        t += step * direction;
      }
    }
    return [...points.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  function detectTracks(mask, horizontal, scanPositions, minLengthMm) {
    const tracks = [];
    for (const t of scanPositions) {
      for (const seed of runs(lineOf(mask, horizontal, t), 3 * SCALE)) {
        const covered = tracks.some(tr => tr.length &&
          Math.min(...tr.map(p => Math.abs(p[0] - t))) < SCALE &&
          Math.abs(interp(t, tr.map(p => p[0]), tr.map(p => p[1])) - seed) < 2 * SCALE);
        if (covered) continue;
        tracks.push(trace(mask, horizontal, t, seed));
      }
    }
    return tracks.filter(tr => {
      if (tr.length < 10 || tr[tr.length - 1][0] - tr[0][0] < minLengthMm * SCALE) return false;
      const ts = tr.map(p => p[0]), cs = tr.map(p => p[1]);
      const fit3 = polyfit(ts, cs, 3);
      const residual = rms(tr.map(p => polyval(fit3, p[0]) - p[1]));
      const fit1 = polyfit(ts, cs, 1);
      const slope = fit1.c[1] / fit1.half;
      return !(residual > 1.5 * SCALE || Math.abs(slope) > 0.6);
    });
  }

  function findLinesByCount(mask, horizontal, count, scanRange) {
    for (const t of scanRange) {
      const merged = [];
      for (const s of runs(lineOf(mask, horizontal, t), 3 * SCALE).sort((a, b) => a - b)) {
        if (merged.length && s - merged[merged.length - 1] < 3 * SCALE) continue;
        merged.push(s);
      }
      if (merged.length === count) return merged.map(s => trace(mask, horizontal, t, s));
    }
    return null;
  }

  // 線に格子の番号を付ける(make_correction.py の assign_indices と同じ)。返り値: Map(番号 → 線の番号)
  function assignIndices(lines, crossLines, values, usable) {
    const count = values.length;
    const gaps = values.slice(1).map((v, i) => v - values[i]);
    const result = new Map();
    lines.forEach((tr, index) => {
      const votes = [];
      const xp = tr.map(p => p[0]), fp = tr.map(p => p[1]);
      for (const cross of crossLines) {
        for (const [end, base] of [[cross[0], values[0]], [cross[cross.length - 1], values[count - 1]]]) {
          if (!usable(end)) continue;
          const [along, across] = end;
          if (!(tr[0][0] - 2 <= across && across <= tr[tr.length - 1][0] + 2)) continue;
          votes.push(base + (interp(across, xp, fp) - along));
        }
      }
      if (!votes.length) return;
      const n = median(votes);
      let k = 0;
      for (let i = 1; i < count; i++) if (Math.abs(values[i] - n) < Math.abs(values[k] - n)) k = i;
      const gap = Math.min(gaps[Math.max(k - 1, 0)], gaps[Math.min(k, count - 2)]);
      if (Math.abs(n - values[k]) > 0.35 * gap) return;
      if (!result.has(k) || tr.length > lines[result.get(k)].length) result.set(k, index);
    });
    return result;
  }

  // ================================================================ 3. 交点
  function localLine(points, q, radius) {
    const near = [];
    let dmin = Infinity;
    for (const p of points) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < radius) near.push(p);
      if (d < dmin) dmin = d;
    }
    if (near.length < 5) return null;
    const cx = mean(near.map(p => p[0])), cy = mean(near.map(p => p[1]));
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of near) { const a = p[0] - cx, b = p[1] - cy; sxx += a * a; sxy += a * b; syy += b * b; }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);       // 一番広がっている向き
    const dir = [Math.cos(angle), Math.sin(angle)];
    let tmin = Infinity, tmax = -Infinity;
    for (const p of near) {
      const t = (p[0] - q[0]) * dir[0] + (p[1] - q[1]) * dir[1];
      tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
    }
    return { center: [cx, cy], dir, dmin, both: tmin < -2 * SCALE && tmax > 2 * SCALE };
  }

  // 横線 i と縦線 j の交点(ピクセル)。hLines、vLines は Map(番号 → 線)
  function intersections(hLines, vLines, hCount, vCount) {
    const radius = 7 * SCALE, result = new Map();
    const hLast = hCount - 1, vLast = vCount - 1;
    for (const [i, h] of hLines) {
      const hp = h.map(p => [p[0], p[1]]);
      const hFit = polyfit(h.map(p => p[0]), h.map(p => p[1]), 3);
      for (const [j, v] of vLines) {
        const vp = v.map(p => [p[1], p[0]]);
        const vFit = polyfit(v.map(p => p[0]), v.map(p => p[1]), 3);
        let vv = polyval(hFit, median(v.map(p => p[1]))), uu = 0;
        for (let it = 0; it < 30; it++) { uu = polyval(vFit, vv); vv = polyval(hFit, uu); }
        let q = [uu, vv];
        for (let it = 0; it < 3; it++) {
          const a = localLine(hp, q, radius), b = localLine(vp, q, radius);
          if (!a || !b || a.dmin > 3 * SCALE || b.dmin > 3 * SCALE) { q = null; break; }
          if ((!a.both && j !== 0 && j !== vLast) || (!b.both && i !== 0 && i !== hLast)) { q = null; break; }
          const det = a.dir[0] * -b.dir[1] - -b.dir[0] * a.dir[1];
          if (Math.abs(det) < 1e-6) { q = null; break; }
          const rx = b.center[0] - a.center[0], ry = b.center[1] - a.center[1];
          const t0 = (rx * -b.dir[1] - -b.dir[0] * ry) / det;
          q = [a.center[0] + t0 * a.dir[0], a.center[1] + t0 * a.dir[1]];
        }
        if (q) result.set(i + "," + j, { i, j, q });
      }
    }
    return result;
  }

  // ================================================================ 4. ずれ
  function removeRigid(measured, nominal) {
    const mc = [mean(measured.map(p => p[0])), mean(measured.map(p => p[1]))];
    const nc = [mean(nominal.map(p => p[0])), mean(nominal.map(p => p[1]))];
    let sin = 0, cos = 0;
    nominal.forEach((n, k) => {
      const a = n[0] - nc[0], b = n[1] - nc[1], c = measured[k][0] - mc[0], d = measured[k][1] - mc[1];
      cos += a * c + b * d;
      sin += a * d - b * c;
    });
    const angle = Math.atan2(sin, cos), cs = Math.cos(angle), sn = Math.sin(angle);
    // measured ≒ R nominal + shift → 逆に戻す
    const shift = [mc[0] - (cs * nc[0] - sn * nc[1]), mc[1] - (sn * nc[0] + cs * nc[1])];
    const corrected = measured.map(([x, y]) => {
      const a = x - shift[0], b = y - shift[1];
      return [cs * a + sn * b, -sn * a + cs * b];
    });
    return { corrected, angle: angle * 180 / Math.PI, shift };
  }

  // ================================================================ 5. 当てはめと表
  function basis(x, y, cx, cy, sx, sy) {
    const u = (x - cx) / sx, w = (y - cy) / sy, row = [];
    for (let a = 0; a <= POLY_DEGREE; a++) for (let b = 0; b <= POLY_DEGREE - a; b++) row.push(u ** a * w ** b);
    return row;
  }

  function fitDirection(keys, nominal, errors, hCount, center, span, log) {
    const sx = keys.map(k => (k[0] % 2 === 0 ? 1 : -1));
    const sy = keys.map(k => (k[1] % 2 === 0 ? 1 : -1) * (hCount % 2 === 0 ? 1 : -1));
    const result = [];
    for (const [k, sign, name] of [[0, sy, "縦線の x"], [1, sx, "横線の y"]]) {
      const smooth = [], matrix = [];
      nominal.forEach((p, n) => {
        const u = (p[0] - center[0]) / span[0], v = (p[1] - center[1]) / span[1];
        const s = [];
        for (let a = 0; a < 4; a++) for (let b = 0; b < 4 - a; b++) s.push(u ** a * v ** b);
        smooth.push(s);
        matrix.push([sign[n], u * sign[n], v * sign[n], ...s]);
      });
      const e = errors.map(p => p[k]);
      const c = lstsq1(matrix, e), c0 = lstsq1(smooth, e);
      const before = rms(e.map((v, n) => v - smooth[n].reduce((s, b, t) => s + b * c0[t], 0)));
      const after = rms(e.map((v, n) => v - matrix[n].reduce((s, b, t) => s + b * c[t], 0)));
      log(`  ${name}: 向きのずれ ${c[0].toFixed(2)} ${c[1] >= 0 ? "+" : ""}${c[1].toFixed(2)}u ${c[2] >= 0 ? "+" : ""}${c[2].toFixed(2)}v mm(残り ${before.toFixed(2)} → ${after.toFixed(2)} mm)`);
      result.push(c.slice(0, 3));
    }
    return result;
  }

  function fitLocal(points, errors, parityI, parityJ, center, span, nodes, log, update = false) {
    const B = points.map(p => basis(p[0], p[1], center[0], center[1], span[0], span[1]));
    let cleaned = errors.map(e => e.slice());
    for (const [k, parity] of [[0, parityJ], [1, parityI]]) {
      const c = lstsq1(B.map((r, n) => [...r, parity[n]]), errors.map(e => e[k]));
      const p = c[c.length - 1];
      cleaned.forEach((e, n) => { e[k] -= p * parity[n]; });
      log(`  ${k === 0 ? "dx" : "dy"}: 往復のずれ ±${Math.abs(p).toFixed(2)} mm(取り除く)`);
    }
    function local(at, skip = -1, slope = true) {
      const d = points.map(p => [p[0] - at[0], p[1] - at[1]]);
      let w = d.map(([a, b]) => Math.exp(-(a * a + b * b) / (2 * LOCAL_SIGMA_MM ** 2)));
      if (skip >= 0) w[skip] = 0;
      if (w.reduce((s, v) => s + v, 0) < 1e-6) {
        w = d.map(([a, b]) => Math.exp(-Math.hypot(a, b) / LOCAL_SIGMA_MM));
        if (skip >= 0) w[skip] = 0;
      }
      const sw = w.map(Math.sqrt);
      const c = lstsq(d.map(([a, b], n) => slope ? [sw[n], a * sw[n], b * sw[n]] : [sw[n]]),
                      cleaned.map((e, n) => [e[0] * sw[n], e[1] * sw[n]]));
      return c[0];
    }
    // 測った交点から離れた表の点は、傾きで伸ばさない(更新のときは足す量も弱める)
    function atNode(n) {
      const near = Math.min(...points.map(p => Math.hypot(p[0] - n[0], p[1] - n[1])));
      const t = Math.min(Math.max((near - NEAR_MM) / (FAR_MM - NEAR_MM), 0), 1);
      const f = 1 - t * t * (3 - 2 * t);                  // 近い: 1 → 遠い: 0(なめらかに)
      if (f >= 1) return local(n);
      const lin = local(n), flat = local(n, -1, false);
      const v = [f * lin[0] + (1 - f) * flat[0], f * lin[1] + (1 - f) * flat[1]];
      return update ? [v[0] * f, v[1] * f] : v;
    }
    for (let round = 0; round < 2; round++) {
      const norm = points.map((q, k) => { const p = local(q, k); return Math.hypot(cleaned[k][0] - p[0], cleaned[k][1] - p[1]); });
      const limit = Math.max(1.5, 4 * median(norm));
      const bad = norm.map(v => v > limit);
      if (!bad.some(Boolean)) break;
      log(`  周りと合わない交点を ${bad.filter(Boolean).length} 個外した`);
      points = points.filter((_, k) => !bad[k]);
      cleaned = cleaned.filter((_, k) => !bad[k]);
    }
    const values = nodes.map(atNode);
    const far = nodes.filter(n => Math.min(...points.map(p => Math.hypot(p[0] - n[0], p[1] - n[1]))) > NEAR_MM).length;
    if (far) log(`  表の ${far} 点は測った交点から ${NEAR_MM}mm 以上離れている(外挿を弱めた${update ? "。足す量も弱めた" : ""})`);
    const residual = points.map((q, k) => { const f = local(q); return [cleaned[k][0] - f[0], cleaned[k][1] - f[1]]; });
    log(`  当てはめの残り(線の波など) dx ${rms(residual.map(r => r[0])).toFixed(2)} mm、dy ${rms(residual.map(r => r[1])).toFixed(2)} mm(RMS)`);
    return values;
  }

  // 表を別の格子へ双一次補間で写す。table は [x の番号][y の番号]
  function resample(xs, ys, table, nx, ny) {
    return nx.map(x => ny.map(y => {
      const fx = Math.min(Math.max((x - xs[0]) / (xs[1] - xs[0]), 0), xs.length - 1);
      const fy = Math.min(Math.max((y - ys[0]) / (ys[1] - ys[0]), 0), ys.length - 1);
      const i = Math.min(Math.floor(fx), xs.length - 2), j = Math.min(Math.floor(fy), ys.length - 2);
      const u = fx - i, v = fy - j;
      return (1 - u) * (1 - v) * table[i][j] + u * (1 - v) * table[i + 1][j] +
             (1 - u) * v * table[i][j + 1] + u * v * table[i + 1][j + 1];
    }));
  }

  // ================================================================ まとめ
  // rgba: 写真(cv.Mat、RGBA)。options.update: 補正ありで描いた格子なら true、options.current: 今の表(更新のとき)
  // 返り値: { table: サーバーへ送る表, log: 経過の文の配列, debug: 確認用の画像(cv.Mat、RGB。使ったら delete する) }
  function makeCorrection(cv, rgba, options = {}) {
    const lines = [];
    const log = s => { lines.push(s); if (options.onLog) options.onLog(s); };
    const update = !!options.update;
    const cfg = CONFIG, sheet = SHEET;
    const pitch = cfg.GRID_PITCH_MM;
    const xs = gridValues(cfg.PAPER_X_MIN, cfg.PAPER_X_MAX, pitch, true);   // 縦線の x
    const ys = gridValues(cfg.PAPER_Y_MIN, cfg.PAPER_Y_MAX, pitch, true);   // 横線の y

    const H = photoToMachine(cv, rgba, log);
    const margin = 20;
    const area = [cfg.PAPER_X_MIN - margin, cfg.PAPER_Y_MIN - margin, cfg.PAPER_X_MAX + margin, cfg.PAPER_Y_MAX + margin];
    const top = topView(cv, rgba, H, area);
    const maskMat = inkMask(cv, top);
    const mask = { w: maskMat.cols, h: maskMat.rows, d: new Uint8Array(maskMat.data) };
    maskMat.delete();

    const toPx = (x, y) => [(x - area[0]) * SCALE, (area[3] - y) * SCALE];
    const toMm = (u, v) => [u / SCALE + area[0], area[3] - v / SCALE];

    // はがきの外とマーカーの上は、線を探す対象から外す
    const rect = sheet.sheet;
    const keep = new Uint8Array(mask.d.length);
    const fill = (u0, v0, u1, v1, value) => {
      for (let v = Math.max(0, Math.trunc(v0)); v < Math.min(mask.h, Math.trunc(v1)); v++)
        for (let u = Math.max(0, Math.trunc(u0)); u < Math.min(mask.w, Math.trunc(u1)); u++) keep[v * mask.w + u] = value;
    };
    {
      const [u0, v0] = toPx(rect.x_min + 1.5, rect.y_max - 1.5), [u1, v1] = toPx(rect.x_max - 1.5, rect.y_min + 1.5);
      fill(u0, v0, u1, v1, 255);
    }
    for (const corners of Object.values(sheet.markers)) {
      const cx = corners.map(c => c[0]), cy = corners.map(c => c[1]);
      const [u0, v0] = toPx(Math.min(...cx) - 1, Math.max(...cy) + 1), [u1, v1] = toPx(Math.max(...cx) + 1, Math.min(...cy) - 1);
      fill(u0, v0, u1, v1, 0);
    }
    for (let i = 0; i < mask.d.length; i++) mask.d[i] &= keep[i];

    // 線を探す
    const midY = (cfg.PAPER_Y_MIN + cfg.PAPER_Y_MAX) / 2;
    const cols = [], rows = [];
    for (let x = -50; x <= 50; x += 5) cols.push(Math.trunc(toPx(x, 0)[0]));
    for (let k = 0; k <= 50; k += 5) rows.push(Math.trunc(toPx(0, midY - 25 + k)[1]));
    const hTracks = detectTracks(mask, true, cols, 40);    // 点は (u, v)
    const vTracks = detectTracks(mask, false, rows, 25);   // 点は (v, u)

    const hMm = tr => tr.map(([t, c]) => [area[0] + t / SCALE, area[3] - c / SCALE]);
    const vMm = tr => tr.map(([t, c]) => [area[3] - t / SCALE, area[0] + c / SCALE]).reverse();
    const hInMm = hTracks.map(hMm), vInMm = vTracks.map(vMm);
    const usableH = ([x]) => rect.x_min + 3 < x && x < rect.x_max - 3;
    const usableV = ([y]) => rect.y_min + 3 < y && y < rect.y_max - 3;
    const hIndex = assignIndices(hInMm, vInMm, ys, usableV);
    const vIndex = assignIndices(vInMm, hInMm, xs, usableH);
    const toLines = (index, tracks) => new Map([...index].map(([k, n]) => [k, tracks[n]]));
    const candidates = [["端から数える", toLines(hIndex, hTracks), toLines(vIndex, vTracks)]];

    const midX = (cfg.PAPER_X_MIN + cfg.PAPER_X_MAX) / 2;
    const colsAll = [], rowsAll = [];
    for (let n = 0; n * 0.7 < 40; n++) for (const s of [1, -1]) colsAll.push(Math.trunc(toPx(midX + n * 0.7 * s, 0)[0]));
    for (let n = 0; n * 0.7 < 25; n++) for (const s of [1, -1]) rowsAll.push(Math.trunc(toPx(0, midY + n * 0.7 * s)[1]));
    const hCount = findLinesByCount(mask, true, ys.length, colsAll);
    const vCount = findLinesByCount(mask, false, xs.length, rowsAll);
    if (hCount && vCount) {
      hCount.sort((a, b) => median(b.map(p => p[1])) - median(a.map(p => p[1])));
      vCount.sort((a, b) => median(a.map(p => p[1])) - median(b.map(p => p[1])));
      candidates.push(["並び順", new Map(hCount.map((l, k) => [k, l])), new Map(vCount.map((l, k) => [k, l]))]);
    }

    const center = [(xs[0] + xs[xs.length - 1]) / 2, (ys[0] + ys[ys.length - 1]) / 2];
    const span = [(xs[xs.length - 1] - xs[0]) / 2, (ys[ys.length - 1] - ys[0]) / 2];
    const score = (h, v) => {
      const c = intersections(h, v, ys.length, xs.length);
      if (c.size < 0.5 * xs.length * ys.length) return [null, c];
      const keys = [...c.values()];
      const nom = keys.map(k => [xs[k.j], ys[k.i]]), mea = keys.map(k => toMm(...k.q));
      const B = nom.map(p => basis(p[0], p[1], center[0], center[1], span[0], span[1]));
      const err = mea.map((m, n) => [m[0] - nom[n][0], m[1] - nom[n][1]]);
      const coef = lstsq(B, err);
      const r = err.map((e, n) => [0, 1].map(k => e[k] - B[n].reduce((s, b, t) => s + b * coef[t][k], 0)));
      return [Math.sqrt(mean(r.map(([a, b]) => a * a + b * b))), c];
    };
    let best = null;
    for (const [name, h, v] of candidates) {
      const [r, c] = score(h, v);
      log(`番号の付け方「${name}」: 横線 ${h.size} 本、縦線 ${v.size} 本、交点 ${c.size} 個` +
          (r !== null ? `、当てはめの残り ${r.toFixed(2)} mm` : "(交点が少ない)"));
      if (r !== null && (best === null || r < best.rms - 0.05 || (Math.abs(r - best.rms) <= 0.05 && c.size > best.cross.size))) {
        best = { rms: r, h, v, cross: c };
      }
    }
    if (!best) { top.delete(); throw new Error("交点が少なすぎる。格子とマーカーが全部写るように、真上から明るく撮り直す"); }
    log(`交点: ${best.cross.size} / ${xs.length * ys.length} 個を使う`);

    const keys = [...best.cross.values()].sort((a, b) => a.i - b.i || a.j - b.j);
    const nominal = keys.map(k => [xs[k.j], ys[k.i]]);
    let measured = keys.map(k => toMm(...k.q));
    const raw = measured.map((m, n) => Math.hypot(m[0] - nominal[n][0], m[1] - nominal[n][1]));
    log(`ずれ: 平均 ${mean(raw).toFixed(2)} mm、最大 ${Math.max(...raw).toFixed(2)} mm`);
    const rigid = removeRigid(measured, nominal);
    const shape = rigid.corrected;
    const shapeErr = shape.map((s, n) => [s[0] - nominal[n][0], s[1] - nominal[n][1]]);
    log(`  うち全体の回転 ${rigid.angle >= 0 ? "+" : ""}${rigid.angle.toFixed(2)} 度、平行移動 (${rigid.shift[0].toFixed(2)}, ${rigid.shift[1].toFixed(2)}) mm`);
    log("描く向きで変わるずれ:");
    let [dirXY, dirYX] = fitDirection(keys.map(k => [k.i, k.j]), nominal, shapeErr, ys.length, center, span, log);
    if (update) {
      log(`  回転と平行移動は ${Math.round(RIGID_GAIN * 100)}% だけ補正する`);
      measured = shape.map((s, n) => [s[0] + RIGID_GAIN * (measured[n][0] - s[0]), s[1] + RIGID_GAIN * (measured[n][1] - s[1])]);
    }

    const parityI = keys.map(k => (k.i % 2 ? 1 : -1));
    const parityJ = keys.map(k => (k.j % 2 ? 1 : -1));
    const cover = (start, stop) => {
      const v = gridValues(start, stop, TABLE_STEP_MM);
      if (v[v.length - 1] < stop - 0.01) v.push(v[v.length - 1] + TABLE_STEP_MM);
      return v;
    };
    const tx = cover(cfg.PAPER_X_MIN, cfg.PAPER_X_MAX), ty = cover(cfg.PAPER_Y_MIN, cfg.PAPER_Y_MAX);
    const nodes = [];
    for (const x of tx) for (const y of ty) nodes.push([x, y]);

    let oldDx, oldDy, values;
    const correction = nominal.map((n, k) => [n[0] - measured[k][0], n[1] - measured[k][1]]);
    if (update) {
      const cur = options.current;
      if (!cur) throw new Error("今の補正データが読めないので、更新できない");
      const ox = Array.from({ length: cur.nx }, (_, k) => cur.x0 + k * cur.step);
      const oy = Array.from({ length: cur.ny }, (_, k) => cur.y0 + k * cur.step);
      const unflat = a => ox.map((_, i) => a.slice(i * cur.ny, (i + 1) * cur.ny));
      oldDx = resample(ox, oy, unflat(cur.dx), tx, ty);
      oldDy = resample(ox, oy, unflat(cur.dy), tx, ty);
      dirXY = dirXY.map((v, k) => v + cur.dir.xy[k]);
      dirYX = dirYX.map((v, k) => v + cur.dir.yx[k]);
      log(`今の表(${cur.version || "?"})に残りのずれを足す:`);
      values = fitLocal(nominal, correction, parityI, parityJ, center, span, nodes, log, true);
    } else {
      oldDx = tx.map(() => ty.map(() => 0));
      oldDy = tx.map(() => ty.map(() => 0));
      log("補正量の当てはめ:");
      values = fitLocal(measured, correction, parityI, parityJ, center, span, nodes, log);
    }
    const round2 = v => Math.round(v * 100) / 100, round3 = v => Math.round(v * 1000) / 1000;
    const dx = [], dy = [];
    tx.forEach((_, i) => ty.forEach((_, j) => {
      dx.push(round2(oldDx[i][j] + values[i * ty.length + j][0]));
      dy.push(round2(oldDy[i][j] + values[i * ty.length + j][1]));
    }));
    const biggest = Math.max(...dx.map((v, k) => Math.hypot(v, dy[k])));
    log(`表: ${tx.length} x ${ty.length}、補正量の最大 ${biggest.toFixed(2)} mm`);

    // 確認用の画像(指令した位置 = 青い点、描かれた位置 = 赤い丸)
    const debug = top;
    for (const k of best.cross.values()) {
      const [u, v] = toPx(xs[k.j], ys[k.i]);
      const p = new cv.Point(Math.round(u), Math.round(v)), q = new cv.Point(Math.round(k.q[0]), Math.round(k.q[1]));
      cv.circle(debug, p, 4, new cv.Scalar(0, 0, 255), -1);
      cv.circle(debug, q, 6, new cv.Scalar(255, 0, 0), 2);
      cv.line(debug, p, q, new cv.Scalar(255, 0, 0), 1);
    }

    return {
      table: {
        nx: tx.length, ny: ty.length, x0: tx[0], y0: ty[0], step: TABLE_STEP_MM, dx, dy,
        dir: { cx: center[0], sx: span[0], cy: center[1], sy: span[1], xy: dirXY.map(round3), yx: dirYX.map(round3) },
        mode: update ? "update" : "new",
      },
      log: lines,
      debug,
    };
  }

  root.makeCorrection = makeCorrection;
  if (typeof module === "object" && module.exports) module.exports = { makeCorrection };
})(typeof window !== "undefined" ? window : globalThis);
