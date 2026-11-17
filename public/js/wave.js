// 線の波(モーターの角度のむら)の係数を、格子の写真から当てはめる
//
// 写真は >_ の「Cal grid wave」で描いたもの(補正の表は使い、角度のむら wave と向きのずれ dir の補正は切る)。
// このとき機械が指令した角度は、補正の表と機構の寸法(補正データ)だけから計算できる。
//
// 1. 格子の各線を 0.1mm ごとになぞり、線に垂直な方向のぶれを測る(交点と丸の近くは使わない)
// 2. 測った点ごとに、機械が指令した角度 θA、θB を求める(表を足した位置で IK。ファームと同じ計算)
// 3. ぶれ = (腕のてこ比 J) × (角度のむら δ(θ)) の線に垂直な成分、として δ の係数を最小二乗で求める
//    δ(θ) = Σ cos[k] cos(2π h[k] θ / 7.2°) + sin[k] sin(…)(ファームの correctionWave と同じ形。実際の角度 = 指令 + δ)
//    線ごとのゆっくりしたずれ(表で消しきれない分)は、線ごとの多項式で取り除く
// 乱数は使わないので、同じ写真からは毎回同じ結果になる。
//
// 角度の位相が毎回同じになるのは、ファームが原点出しのあとに電気角で位置を付け直しているから(Motors.h)。
(function (root) {
  const SCALE = 20;            // 真上から見た画像の 1mm あたりのピクセル数(細かい波を測るため calibrate.js の倍)
  const STEP_MM = 0.1;         // 線をなぞる間隔
  const SEARCH_MM = 1.2;       // 線を探す範囲(前の点からのずれ)
  const SKIP_CROSS_MM = 1.6;   // 交わる線の近くは使わない
  const SKIP_MARK_MM = 6;      // 丸の近くは使わない
  const HARMONICS = [1, 2, 3, 4];   // 7.2 度の何倍の周波数を当てはめるか(周期 7.2、3.6、2.4、1.8 度)
  const POLY = { h: 6, v: 4 };      // 線ごとの多項式の次数(横線は長いので高め)
  const FADE_MM = 10;               // ファームの offsetAt と同じ
  const DEG = Math.PI / 180;

  // ---- ファームの offsetAt と同じ(表から「指令に足す量」を補間) ----
  function offsetAt(rec, x, y) {
    const fx = (x - rec.x0) / rec.step, fy = (y - rec.y0) / rec.step;
    const cx = Math.min(Math.max(fx, 0), rec.nx - 1), cy = Math.min(Math.max(fy, 0), rec.ny - 1);
    const outside = Math.hypot(fx - cx, fy - cy) * rec.step;
    const w = Math.max(0, 1 - outside / FADE_MM);
    if (w <= 0) return [0, 0];
    const i = Math.min(Math.floor(cx), rec.nx - 2), j = Math.min(Math.floor(cy), rec.ny - 2);
    const u = cx - i, v = cy - j;
    const at = (a, ii, jj) => a[ii * rec.ny + jj];
    const f = a => w * ((1 - u) * (1 - v) * at(a, i, j) + u * (1 - v) * at(a, i + 1, j) +
                        (1 - u) * v * at(a, i, j + 1) + u * v * at(a, i + 1, j + 1));
    return [f(rec.dx), f(rec.dy)];
  }

  // 描きたい位置 → 機械が指令した角度(表を足して IK)。解けなければ null
  function commandedAngles(rec, geom, x, y) {
    const [dx, dy] = offsetAt(rec, x, y);
    return PlotGeometry.ik(geom, x + dx, y + dy);
  }

  // 角度 → ペン先のてこ比 J(列 0 = θA を 1 度、列 1 = θB を 1 度動かしたときのペン先の動き [mm])
  function jacobian(geom, th) {
    const p = PlotGeometry.fk(geom, th[0], th[1]);
    const h = 0.01;
    const pa = PlotGeometry.fk(geom, th[0] + h, th[1]), pb = PlotGeometry.fk(geom, th[0], th[1] + h);
    if (!p || !pa || !pb) return null;
    return [[(pa[0] - p[0]) / h, (pb[0] - p[0]) / h], [(pa[1] - p[1]) / h, (pb[1] - p[1]) / h]];
  }

  // ---- 1. 線をなぞる ----
  // mask: { w, h, d }(0/255)、toPx / toMm: 機械座標 ⇄ 画素
  // horizontal なら y = value の線を x 方向に、そうでなければ x = value の線を y 方向になぞる
  // → [{ s(線に沿う座標), off(線に垂直なずれ = 測った位置 - 指令した位置) }]
  function traceLine(mask, toPx, horizontal, value, from, to, skipAlong, marks) {
    const out = [];
    let predicted = 0;   // 前の点のずれ(線は指令の位置から 1mm 以内にあるはず)
    let miss = 0;
    for (let s = from; s <= to + 1e-9; s += STEP_MM) {
      if (skipAlong.some(c => Math.abs(s - c) < SKIP_CROSS_MM)) continue;
      const pt = horizontal ? [s, value] : [value, s];
      if (marks.some(m => Math.hypot(pt[0] - m[0], pt[1] - m[1]) < SKIP_MARK_MM)) continue;
      // 線に垂直な方向に画素を並べ、予測の近くでいちばん近いインクの塊の中心を取る
      let best = null;
      const half = Math.round(SEARCH_MM * SCALE);
      const [u0, v0] = toPx(horizontal ? s : value + predicted, horizontal ? value + predicted : s);
      let run = [];
      const runs = [];
      for (let k = -half; k <= half + 1; k++) {
        const u = Math.round(horizontal ? u0 : u0 + k), v = Math.round(horizontal ? v0 + k : v0);
        const on = k <= half && u >= 0 && v >= 0 && u < mask.w && v < mask.h && mask.d[v * mask.w + u] > 0;
        if (on) run.push(k);
        else if (run.length) { runs.push(run); run = []; }
      }
      for (const r of runs) {
        if (r.length > 1.5 * SCALE) continue;   // 太すぎる(線が重なっている、汚れ)
        const c = (r[0] + r[r.length - 1]) / 2;
        if (!best || Math.abs(c) < Math.abs(best)) best = c;
      }
      if (best === null) { if (++miss > 30) predicted = 0; continue; }
      miss = 0;
      // 画素 → mm。横線は v が下向きに増える(y と逆)、縦線は u が x と同じ向き
      const off = predicted + (horizontal ? -best : best) / SCALE;
      out.push({ s, off });
      predicted = off;
    }
    return out;
  }

  // ---- 3. 最小二乗 ----
  // 列ごとに、線ごとの多項式の成分を取り除く(グラム・シュミット)
  function legendreBasis(t, degree) {
    const p = [1, t];
    for (let n = 1; n < degree; n++) p.push(((2 * n + 1) * t * p[n] - n * p[n - 1]) / (n + 1));
    return p.slice(0, degree + 1);
  }
  function projectOut(columns, polys) {
    // polys: [点][次数] の基底。正規直交化してから、各列からその成分を引く
    const n = polys.length, m = polys[0].length;
    const Q = [];
    for (let k = 0; k < m; k++) {
      let q = polys.map(r => r[k]);
      for (const prev of Q) { const d = dot(q, prev); q = q.map((x, i) => x - d * prev[i]); }
      const norm = Math.sqrt(dot(q, q));
      if (norm < 1e-9) continue;
      Q.push(q.map(x => x / norm));
    }
    return columns.map(col => {
      let c = col.slice();
      for (const q of Q) { const d = dot(c, q); c = c.map((x, i) => x - d * q[i]); }
      return c;
    });
    function dot(a, b) { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
  }
  function solve(A, b) {
    const n = b.length, M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (Math.abs(M[c][c]) < 1e-12) return null;
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    return M.map((r, i) => r[n] / r[i]);
  }

  // 測った線(lines: [{ horizontal, value, samples: [{ s, off }] }])から係数を求める
  // rec: 機械が使っていた補正データ(表と寸法)
  function fitFromLines(lines, rec, options = {}) {
    const geom = { ...PlotGeometry.DEFAULT_GEOM, ...(rec.geom || {}) };
    const harmonics = options.harmonics || HARMONICS;
    const nPar = 4 * harmonics.length;   // A cos, A sin, B cos, B sin
    const ATA = Array.from({ length: nPar }, () => new Array(nPar).fill(0));
    const ATb = new Array(nPar).fill(0);
    const kept = [];   // 当てはめ後の残りを出すため(列とデータ)
    let used = 0;
    for (const line of lines) {
      const rows = [], data = [], polys = [];
      const span = line.samples.length ? [line.samples[0].s, line.samples[line.samples.length - 1].s] : [0, 1];
      for (const { s, off } of line.samples) {
        const target = line.horizontal ? [s, line.value] : [line.value, s];
        const th = commandedAngles(rec, geom, target[0], target[1]);
        if (!th) continue;
        const J = jacobian(geom, th);
        if (!J) continue;
        // 線に垂直な向き(横線なら y、縦線なら x)のてこ比
        const ga = line.horizontal ? J[1][0] : J[0][0], gb = line.horizontal ? J[1][1] : J[0][1];
        const row = [];
        for (const h of harmonics) {
          const pa = 2 * Math.PI * h * th[0] / 7.2, pb = 2 * Math.PI * h * th[1] / 7.2;
          row.push(ga * Math.cos(pa), ga * Math.sin(pa), gb * Math.cos(pb), gb * Math.sin(pb));
        }
        rows.push(row);
        data.push(off);
        const t = 2 * (s - span[0]) / Math.max(1e-6, span[1] - span[0]) - 1;
        polys.push(legendreBasis(t, line.horizontal ? POLY.h : POLY.v));
      }
      if (rows.length < 100) continue;   // 短すぎる線は使わない
      // 線ごとの多項式の成分を、データと各列から取り除く
      const cols = projectOut([data, ...Array.from({ length: nPar }, (_, k) => rows.map(r => r[k]))], polys);
      const y = cols[0], X = cols.slice(1);
      for (let a = 0; a < nPar; a++) {
        for (let b = a; b < nPar; b++) { let s = 0; for (let i = 0; i < y.length; i++) s += X[a][i] * X[b][i]; ATA[a][b] += s; if (a !== b) ATA[b][a] += s; }
        let s = 0; for (let i = 0; i < y.length; i++) s += X[a][i] * y[i]; ATb[a] += s;
      }
      kept.push({ y, X, line });
      used += y.length;
    }
    if (kept.length < (options.minLines || 6) || used < (options.minPoints || 2000)) throw new Error(`なぞれた線が少なすぎる(${kept.length} 本、${used} 点)。格子全体が写るように撮り直す`);
    // わずかに 0 へ寄せて、決まりにくい成分が暴れないようにする
    const ridge = 1e-6 * Math.max(...ATA.map((r, i) => r[i]));
    const coef = solve(ATA.map((r, i) => r.map((x, j) => (i === j ? x + ridge : x))), ATb);
    if (!coef) throw new Error("係数を決められなかった");

    // 残りの大きさ: 補正なし / 今の係数 / 新しい係数
    const current = rec.wave || null;
    const rmsOf = model => {
      let s = 0, n = 0;
      for (const { y, X } of kept) for (let i = 0; i < y.length; i++) {
        let p = 0;
        if (model) for (let k = 0; k < nPar; k++) p += model[k] * X[k][i];
        s += (y[i] - p) ** 2; n++;
      }
      return Math.sqrt(s / n);
    };
    const asVector = w => {   // 今の係数を、この当てはめの並びにする(ない成分は 0)
      if (!w) return null;
      return harmonics.flatMap(h => {
        const k = w.h.indexOf(h);
        return k < 0 ? [0, 0, 0, 0] : [w.a.cos[k], w.a.sin[k], w.b.cos[k], w.b.sin[k]];
      });
    };
    const round = v => Math.round(v * 10000) / 10000;
    const wave = {
      h: harmonics.slice(),
      a: { cos: harmonics.map((_, k) => round(coef[4 * k])), sin: harmonics.map((_, k) => round(coef[4 * k + 1])) },
      b: { cos: harmonics.map((_, k) => round(coef[4 * k + 2])), sin: harmonics.map((_, k) => round(coef[4 * k + 3])) },
    };
    return {
      wave, lines: kept.length, points: used,
      rmsNone: rmsOf(null), rmsCurrent: current ? rmsOf(asVector(current)) : null, rmsNew: rmsOf(coef),
    };
  }

  // 写真から測って当てはめる。rec: 機械が今使っている補正データ。→ { wave, log, debug, ... }
  function fitWave(cv, rgba, rec, options = {}) {
    const lines = [];
    const log = s => { lines.push(s); if (options.onLog) options.onLog(s); };
    const C = root.PlotCalibrate;
    const cfg = C.CONFIG;
    const xs = C.gridValues(cfg.PAPER_X_MIN, cfg.PAPER_X_MAX, cfg.GRID_PITCH_MM, true);
    const ys = C.gridValues(cfg.PAPER_Y_MIN, cfg.PAPER_Y_MAX, cfg.GRID_PITCH_MM, true);
    const H = C.photoToMachine(cv, rgba, log);
    const area = [cfg.PAPER_X_MIN - 4, cfg.PAPER_Y_MIN - 4, cfg.PAPER_X_MAX + 4, cfg.PAPER_Y_MAX + 4];
    const top = C.topView(cv, rgba, H, area, SCALE);
    const maskMat = C.inkMask(cv, top);
    const mask = { w: maskMat.cols, h: maskMat.rows, d: new Uint8Array(maskMat.data) };
    maskMat.delete();
    const toPx = (x, y) => [(x - area[0]) * SCALE, (area[3] - y) * SCALE];

    const measured = [];
    for (const y of ys) {
      const samples = traceLine(mask, toPx, true, y, xs[0] + 2, xs[xs.length - 1] - 2, xs, C.MARKS);
      measured.push({ horizontal: true, value: y, samples });
    }
    for (const x of xs) {
      const samples = traceLine(mask, toPx, false, x, ys[0] + 2, ys[ys.length - 1] - 2, ys, C.MARKS);
      measured.push({ horizontal: false, value: x, samples });
    }
    log(`線をなぞった: 横 ${measured.filter(l => l.horizontal && l.samples.length > 100).length} 本、` +
        `縦 ${measured.filter(l => !l.horizontal && l.samples.length > 100).length} 本、` +
        `点 ${measured.reduce((s, l) => s + l.samples.length, 0)} 個`);
    const r = fitFromLines(measured, rec, options);
    log(`線の波(線ごとのゆっくりしたずれを除いた残り、RMS):`);
    log(`  補正なし ${r.rmsNone.toFixed(3)} mm`);
    if (r.rmsCurrent !== null) log(`  今の係数で補正したら ${r.rmsCurrent.toFixed(3)} mm`);
    log(`  新しい係数で補正したら ${r.rmsNew.toFixed(3)} mm(見込み)`);
    log("新しい係数 [度](実際の角度 = 指令 + Σ cos・cos(2π h θ/7.2) + sin・sin(…)):");
    r.wave.h.forEach((h, k) => log(`  周期 ${(7.2 / h).toFixed(1)} 度: A ${r.wave.a.cos[k].toFixed(4)}, ${r.wave.a.sin[k].toFixed(4)}  B ${r.wave.b.cos[k].toFixed(4)}, ${r.wave.b.sin[k].toFixed(4)}`));
    if (r.rmsNew > 0.9 * r.rmsNone) log("注意: あまり減らない。写真がぼけているか、波が角度で決まっていない可能性がある");

    // 確認用の画像: なぞった点(緑)
    for (const l of measured) for (const { s, off } of l.samples) {
      const [u, v] = toPx(l.horizontal ? s : l.value + off, l.horizontal ? l.value + off : s);
      const i = (Math.round(v) * top.cols + Math.round(u)) * 3;
      if (i >= 0 && i < top.data.length - 2) { top.data[i] = 0; top.data[i + 1] = 200; top.data[i + 2] = 0; }
    }
    return { ...r, log: lines, debug: top };
  }

  const api = { fitWave, fitFromLines, offsetAt, commandedAngles, HARMONICS };
  root.PlotWave = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
