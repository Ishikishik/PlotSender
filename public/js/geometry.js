// 機構の寸法(幾何)を、補正なしで描いた格子の写真から逆算する
//
// 補正なしの格子の各交点について、
//   指令した位置 → 機械がそのとき使っていた寸法で IK → モーターの角度(機械が実際に回した角度)
//   写真で測った、実際に描かれた位置
// が分かる。「本当の寸法なら、その角度でペン先は測った位置に来る」はずなので、
// 順運動学(FK)の結果が測った位置に一番近くなる寸法を、Levenberg–Marquardt 法で求める。
// 乱数は使わないので、同じ写真からは毎回同じ結果になる。
//
// IK と FK は firm/src/motion/Kinematics.h と同じ計算(変えるときは両方そろえる)。
// 寸法の項目は firm/src/motion/Geometry.h、PlotSender/server/main.py の GEOM_LIMITS と同じ。
(function (root) {
  // 設計値(firm/src/config/PlotterConfig.h の LINK_* と同じ)。ずれは 0
  const DEFAULT_GEOM = {
    d: 50, l1a: 65, l1b: 65, l2a: 85, l2b: 85, e: 36,   // 長さ [mm](a = 左の腕 A、b = 右の腕 B)
    offA: 0, offB: 0,                                    // 原点の角度のずれ [度](実際の角度 = 指令 + off)
    tx: 0, ty: 0, rot: 0,                                // 機械の座標と天板のマーカーとのずれ [mm]、[度]
  };
  const KEYS = ["d", "l1a", "l1b", "l2a", "l2b", "e", "offA", "offB", "tx", "ty", "rot"];
  // 当てはめで設計値から離れにくくする強さ(この量だけ動かすと、交点 1 個が 1mm ずれたのと同じ重さ)
  const PRIOR = { d: 3, l1a: 3, l1b: 3, l2a: 3, l2b: 3, e: 3, offA: 5, offB: 5, tx: 5, ty: 5, rot: 3 };
  // 設計値からこれ以上離れたら、写真か番号付けがおかしいとみなして送らない
  const LIMIT = { d: 8, l1a: 8, l1b: 8, l2a: 8, l2b: 8, e: 8, offA: 10, offB: 10, tx: 15, ty: 15, rot: 5 };
  // 機構の干渉を避ける条件(PlotterConfig.h と同じ)
  const SAFE_JOINT_MARGIN = 1, SAFE_ELBOW_Y = 20, SAFE_CROSS_X = 10, SAFE_CROSS_Y = 10;
  const DEG = Math.PI / 180;

  const wrap = d => { d = (d + 180) % 360; if (d < 0) d += 360; return d - 180; };

  // 天板の座標 ⇄ 機械の座標(モーター軸の中点が原点)
  function toMachine(g, x, y) {
    const c = Math.cos(-g.rot * DEG), s = Math.sin(-g.rot * DEG);
    const ux = x - g.tx, uy = y - g.ty;
    return [c * ux - s * uy, s * ux + c * uy];
  }
  function fromMachine(g, x, y) {
    const c = Math.cos(g.rot * DEG), s = Math.sin(g.rot * DEG);
    return [c * x - s * y + g.tx, s * x + c * y + g.ty];
  }

  // ペン先の座標 → モーターの角度 [θL(A), θR(B)](度)。解けない、または干渉するなら null
  // Kinematics.h の inverseKinematics と同じ(x を反転して、レポートの形で解く)
  function ik(g, x, y) {
    [x, y] = toMachine(g, x, y);
    const mx = -x;
    const l3 = g.l2a + g.e;
    const ux = mx - g.d / 2;
    const penRadius = Math.hypot(ux, y);
    if (penRadius < 1e-6) return null;
    const penCos = (g.l1a * g.l1a + penRadius * penRadius - l3 * l3) / (2 * g.l1a * penRadius);
    if (Math.abs(penCos) > 1) return null;
    const penTheta = Math.atan2(y, ux) - Math.acos(penCos);
    const bx = g.d / 2 + g.l1a * Math.cos(penTheta);
    const by = g.l1a * Math.sin(penTheta);
    const px = bx + (g.l2a / l3) * (mx - bx);
    const py = by + (g.l2a / l3) * (y - by);
    const vx = px + g.d / 2;
    const otherRadius = Math.hypot(vx, py);
    if (otherRadius < 1e-6) return null;
    const otherCos = (g.l1b * g.l1b + otherRadius * otherRadius - g.l2b * g.l2b) / (2 * g.l1b * otherRadius);
    if (Math.abs(otherCos) > 1) return null;
    const otherTheta = Math.atan2(py, -vx) - Math.acos(otherCos);
    const ax = -g.d / 2 - g.l1b * Math.cos(otherTheta);
    const ay = g.l1b * Math.sin(otherTheta);
    const bax = bx - ax, bay = by - ay, pax = px - ax, pay = py - ay;
    const cross = bax * pay - bay * pax;
    if ((cross >= 0) !== (bax >= 0)) return null;
    if (!(ax + SAFE_JOINT_MARGIN < px && px < bx - SAFE_JOINT_MARGIN)) return null;
    if (ay < SAFE_ELBOW_Y && by < SAFE_ELBOW_Y) return null;
    if (ax > g.d / 2 + SAFE_CROSS_X && ay < -SAFE_CROSS_Y) return null;
    if (bx < -g.d / 2 - SAFE_CROSS_X && by < -SAFE_CROSS_Y) return null;
    return [wrap(penTheta / DEG - g.offA), wrap(otherTheta / DEG - g.offB)];
  }

  // モーターの角度 → ペン先の座標。腕が組めないなら null(Kinematics.h の forwardKinematics と同じ)
  function fk(g, thetaL, thetaR) {
    const tl = (thetaL + g.offA) * DEG, tr = (thetaR + g.offB) * DEG;
    const ax = -g.d / 2 - g.l1a * Math.cos(tl), ay = g.l1a * Math.sin(tl);
    const bx = g.d / 2 + g.l1b * Math.cos(tr), by = g.l1b * Math.sin(tr);
    const dx = bx - ax, dy = by - ay;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6 || dist > g.l2a + g.l2b || dist < Math.abs(g.l2a - g.l2b)) return null;
    // A を中心とする半径 l2a と、B を中心とする半径 l2b の円の交点のうち、上側を P とする
    const along = (g.l2a * g.l2a - g.l2b * g.l2b + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, g.l2a * g.l2a - along * along));
    const mx = ax + along * dx / dist, my = ay + along * dy / dist;
    const rx = -dy * h / dist, ry = dx * h / dist;
    const px = ry >= 0 ? mx + rx : mx - rx;
    const py = ry >= 0 ? my + ry : my - ry;
    const x = px + (px - ax) / g.l2a * g.e;
    const y = py + (py - ay) / g.l2a * g.e;
    return fromMachine(g, x, y);
  }

  const toVec = g => KEYS.map(k => g[k]);
  const fromVec = v => Object.fromEntries(KEYS.map((k, i) => [k, v[i]]));

  // 連立一次方程式 A x = b(A は n×n)をガウスの消去法で解く
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

  // samples: [{ cmd: [x, y](指令した位置), meas: [x, y](測った位置) }]
  // used: 格子を描いたときに機械が使っていた寸法
  // → { geom, before, after, used: 使った交点の数, dropped, log }
  function fitGeometry(samples, used, options = {}) {
    const lines = [];
    const log = s => { lines.push(s); if (options.onLog) options.onLog(s); };
    used = { ...DEFAULT_GEOM, ...used };
    // 機械が実際に回した角度(描いたときの寸法で IK)
    let pts = [];
    for (const s of samples) {
      const th = ik(used, s.cmd[0], s.cmd[1]);
      if (th) pts.push({ th, meas: s.meas, cmd: s.cmd });
    }
    if (pts.length < 20) throw new Error(`使える交点が少なすぎる(${pts.length} 個)`);

    const fitKeys = options.keys || KEYS;
    const prior = fitKeys.map(k => DEFAULT_GEOM[k]), sig = fitKeys.map(k => PRIOR[k]);
    const full = v => { const g = { ...used, ...(options.start || {}) }; fitKeys.forEach((k, i) => { g[k] = v[i]; }); return g; };
    const residuals = (v, list) => {
      const g = full(v), r = [];
      for (const p of list) {
        const q = fk(g, p.th[0], p.th[1]);
        if (!q) { r.push(50, 50); continue; }
        r.push(q[0] - p.meas[0], q[1] - p.meas[1]);
      }
      v.forEach((x, i) => r.push((x - prior[i]) / sig[i]));   // 設計値から離れにくくする
      return r;
    };
    const cost = r => r.reduce((s, x) => s + x * x, 0);
    const pointErrors = (v, list) => {
      const g = full(v);
      return list.map(p => { const q = fk(g, p.th[0], p.th[1]); return q ? Math.hypot(q[0] - p.meas[0], q[1] - p.meas[1]) : 1e9; });
    };

    const lm = (start, list) => {
      let v = start.slice(), r = residuals(v, list), c = cost(r), lambda = 1e-3;
      for (let iter = 0; iter < 100; iter++) {
        // ヤコビアン(数値微分)
        const J = v.map((_, j) => {
          const h = 1e-4 * Math.max(1, Math.abs(v[j]));
          const w = v.slice(); w[j] += h;
          return residuals(w, list).map((x, i) => (x - r[i]) / h);
        });
        const n = v.length;
        const A = Array.from({ length: n }, (_, a) => Array.from({ length: n }, (_, b) =>
          J[a].reduce((s, x, i) => s + x * J[b][i], 0)));
        const g = J.map(col => col.reduce((s, x, i) => s + x * r[i], 0));
        let improved = false;
        for (let t = 0; t < 10; t++) {
          const Ad = A.map((row, a) => row.map((x, b) => (a === b ? x * (1 + lambda) + 1e-9 : x)));
          const step = solve(Ad, g.map(x => -x));
          if (!step) { lambda *= 10; continue; }
          const w = v.map((x, i) => x + step[i]);
          const rw = residuals(w, list), cw = cost(rw);
          if (cw < c) {
            const done = c - cw < 1e-10 * c;
            v = w; r = rw; c = cw; lambda = Math.max(lambda / 10, 1e-9); improved = true;
            if (done) return v;
            break;
          }
          lambda *= 10;
        }
        if (!improved) break;
      }
      return v;
    };

    const start = { ...used, ...(options.start || {}) };
    const v0 = fitKeys.map(k => start[k]);
    const before = pointErrors(fitKeys.map(k => used[k]), pts.map(p => p)).map((_, i) => Math.hypot(pts[i].cmd[0] - pts[i].meas[0], pts[i].cmd[1] - pts[i].meas[1]));
    log(`寸法の逆算: 交点 ${pts.length} 個`);
    log(`  合わせる前のずれ: 平均 ${mean(before).toFixed(2)} mm、最大 ${Math.max(...before).toFixed(2)} mm`);
    let v = lm(v0, pts);
    // 周りと合わない交点(番号の付け間違いなど)を外して、もう一度合わせる
    const errs = pointErrors(v, pts);
    const med = median(errs);
    const keep = pts.filter((_, i) => errs[i] <= Math.max(1.5, 4 * med));
    const dropped = pts.length - keep.length;
    if (dropped) {
      log(`  ずれの大きい交点を ${dropped} 個外した`);
      v = lm(v, keep);
    }
    const after = pointErrors(v, keep);
    log(`  合わせた後のずれ: 平均 ${mean(after).toFixed(2)} mm、最大 ${Math.max(...after).toFixed(2)} mm`);
    const geom = Object.fromEntries(Object.entries(full(v)).map(([k, x]) => [k, Math.round(x * 1000) / 1000]));
    log("  寸法(設計値との差):");
    for (const k of KEYS) {
      const diff = geom[k] - DEFAULT_GEOM[k];
      log(`    ${k.padEnd(5)} ${geom[k].toFixed(3).padStart(8)}  (${diff >= 0 ? "+" : ""}${diff.toFixed(3)})`);
    }
    const bad = options.noLimit ? [] : KEYS.filter(k => Math.abs(geom[k] - DEFAULT_GEOM[k]) > LIMIT[k]);
    if (bad.length) throw new Error(`寸法が設計値から離れすぎている(${bad.join(", ")})。写真か格子の番号付けを確かめる`);
    return { geom, before: mean(before), after: mean(after), maxAfter: Math.max(...after), used: keep.length, dropped, log: lines };
  }

  // 番号の付いていない交点(写真で見つかった線どうしの交点)から寸法を求める
  // points: [[x, y], ...](測った位置)、grid: { xs, ys }(指令した格子)、used: 描いたときの寸法
  // 1. 予測の格子(最初は指令どおり)を、ずらしと回転を広く振って、写真の交点に一番多く重なる位置を探す
  // 2. 重なった交点だけで寸法を合わせ、予測を描き直して重ね直す。重なる数が増えなくなるまで繰り返す
  // 格子の上端だけは間隔が 5mm なので、1 列・1 行ずれた位置では重なりが減り、正しい位置が一番よく重なる
  function fitGeometryFromPoints(points, grid, used, options = {}) {
    const lines = [];
    const log = s => { lines.push(s); if (options.onLog) options.onLog(s); };
    used = { ...DEFAULT_GEOM, ...used };
    const cmds = [];
    for (const y of grid.ys) for (const x of grid.xs) {
      const th = ik(used, x, y);
      if (th) cmds.push({ cmd: [x, y], th });
    }
    // 写真の交点を 1mm の升に分けておく(近くの点を速く探すため)
    const bucket = new Map();
    const keyOf = (x, y) => Math.floor(x) + "," + Math.floor(y);
    points.forEach((p, i) => { const k = keyOf(p[0], p[1]); if (!bucket.has(k)) bucket.set(k, []); bucket.get(k).push(i); });
    const nearest = (x, y, gate) => {
      let best = -1, bd = gate;
      const r = Math.ceil(gate);
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        const list = bucket.get(Math.floor(x) + a + "," + (Math.floor(y) + b));
        if (!list) continue;
        for (const i of list) { const d = Math.hypot(points[i][0] - x, points[i][1] - y); if (d < bd) { bd = d; best = i; } }
      }
      return best;
    };
    const predict = g => cmds.map(c => fk(g, c.th[0], c.th[1]));
    // 予測と写真の交点を 1 対 1 で結ぶ(近い組から)
    const match = (pred, gate) => {
      const pairs = [];
      pred.forEach((p, n) => { if (!p) return; const i = nearest(p[0], p[1], gate); if (i >= 0) pairs.push({ n, i, d: Math.hypot(points[i][0] - p[0], points[i][1] - p[1]) }); });
      pairs.sort((a, b) => a.d - b.d);
      const usedN = new Set(), usedI = new Set(), out = [];
      for (const q of pairs) { if (usedN.has(q.n) || usedI.has(q.i)) continue; usedN.add(q.n); usedI.add(q.i); out.push(q); }
      return out;
    };

    // 1. 大まかな位置: 予測の格子を、紙の中心のまわりに回して、ずらす
    const cx = (grid.xs[0] + grid.xs[grid.xs.length - 1]) / 2, cy = (grid.ys[0] + grid.ys[grid.ys.length - 1]) / 2;
    const base = predict(used);
    // 粗く探してから、見つかった位置のまわりを細かく探す(全部を細かく探すとスマホで遅い)
    const score = (rot, sx, sy, gate) => {
      const c = Math.cos(rot * DEG), s = Math.sin(rot * DEG);
      let n = 0;
      for (const p of base) {
        if (!p) continue;
        const x = c * (p[0] - cx) - s * (p[1] - cy) + cx + sx, y = s * (p[0] - cx) + c * (p[1] - cy) + cy + sy;
        if (nearest(x, y, gate) >= 0) n++;
      }
      return n;
    };
    let coarse = { n: -1 };
    for (let rot = -6; rot <= 6.001; rot += 1)
      for (let sx = -20; sx <= 20; sx += 2) for (let sy = -20; sy <= 20; sy += 2) {
        const n = score(rot, sx, sy, 3.5);
        if (n > coarse.n) coarse = { n, rot, sx, sy };
      }
    const c0 = coarse;
    coarse = { n: -1 };
    for (let rot = c0.rot - 1; rot <= c0.rot + 1.001; rot += 0.25)
      for (let sx = c0.sx - 2; sx <= c0.sx + 2.001; sx += 0.5) for (let sy = c0.sy - 2; sy <= c0.sy + 2.001; sy += 0.5) {
        const n = score(rot, sx, sy, 2.5);
        if (n > coarse.n) coarse = { n, rot, sx, sy };
      }
    log(`寸法の逆算: 写真の交点 ${points.length} 個、格子の交点 ${cmds.length} 個`);
    log(`  大まかな位置: 回転 ${coarse.rot} 度、ずらし (${coarse.sx}, ${coarse.sy}) mm で ${coarse.n} 個が重なる`);
    // 回転とずらしを、機械の座標のずれ(原点まわりの回転 + 平行移動)に直す
    let g = { ...used };
    {
      const c = Math.cos(coarse.rot * DEG), s = Math.sin(coarse.rot * DEG);
      // 天板の座標 = R(rot) (機械の座標) + t。紙の中心 (cx, cy) のまわりに回したのと同じになるように t を決める
      const c0 = fromMachine(used, cx, cy);   // 今の寸法での紙の中心(機械の座標 → 天板)
      const m = toMachine(used, cx, cy);
      const r = used.rot + coarse.rot;
      const cr = Math.cos(r * DEG), sr = Math.sin(r * DEG);
      g.rot = r;
      g.tx = c0[0] + coarse.sx - (cr * m[0] - sr * m[1]) + (cx - c0[0]) * 0;
      g.ty = c0[1] + coarse.sy - (sr * m[0] + cr * m[1]);
      // c0 は (cx, cy) と同じ(used で往復しているため)。紙の中心が (cx + sx, cy + sy) に来る
      void c; void s;
    }

    // 2. 重ねて合わせる、を繰り返す
    let matched = [], result = null;
    for (let iter = 0; iter < 15; iter++) {
      const pairs = match(predict(g), iter === 0 ? 3 : 4);
      const samples = pairs.map(q => ({ cmd: cmds[q.n].cmd, meas: points[q.i] }));
      log(`  ${iter + 1} 回目: ${pairs.length} 個が重なる`);
      if (samples.length < 20) throw new Error(`重なる交点が少なすぎる(${samples.length} 個)。写真を撮り直す`);
      result = fitGeometry(samples, used, { start: g, keys: options.keys, noLimit: options.noLimit });
      const same = pairs.length === matched.length && pairs.every((q, k) => matched[k] && matched[k].n === q.n && matched[k].i === q.i);
      g = result.geom;
      matched = pairs;
      if (same) break;
    }
    result.log.forEach(s => log(s));
    if (matched.length < 0.6 * cmds.length) throw new Error(`重なった交点が ${matched.length} / ${cmds.length} 個しかない。写真を撮り直す`);
    return { ...result, matched: matched.length, total: cmds.length, log: lines };
  }

  function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
  function median(a) { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }

  const api = { DEFAULT_GEOM, GEOM_KEYS: KEYS, ik, fk, fitGeometry, fitGeometryFromPoints };
  root.PlotGeometry = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
