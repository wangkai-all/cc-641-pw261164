/*
 * core.js — 断点回归（RDD）分析的纯逻辑层：样本筛选、局部线性拟合、
 * 有效性护栏、数据诊断。不依赖 DOM，可在 Node 中直接测试。
 *
 * 关键设计约束（对应分析纪律）：
 *  - 保留/排除只由「评分与门槛的距离」决定，因此评分相同的申请
 *    必然一起保留、一起排除，不可能被逐个挑选；
 *  - 分析范围 h 与贴门槛排除带 donut 对门槛两侧对称生效，
 *    不存在两侧各自选择范围的可能；
 *  - 任一护栏不满足时，估计结果 ok=false，不输出有限效果值。
 */
(function (global) {
  'use strict';

  const MIN_H = 2;       // 分析范围（带宽）下限，单位：评分分
  const MIN_N_SIDE = 5;  // 每侧有效样本（权重 > 0）下限
  const Z95 = 1.96;

  function fmt(x, digits) {
    return Number.isFinite(x) ? x.toFixed(digits === undefined ? 1 : digits) : '—';
  }

  // 三角核权重：离门槛越近权重越大，边界处为 0
  function triWeight(dist, h) {
    return Math.max(0, 1 - dist / h);
  }

  /*
   * 样本筛选：只按 |评分 - 门槛| 决定每条申请的状态。
   * 同分 => 同距离 => 同状态，「同分同去留」由构造保证。
   * 返回每行的：距离、所在侧、是否保留、排除原因、拟合权重。
   */
  function filterSample(rows, cutoff, h, donut) {
    return rows.map(function (row) {
      const d = Math.abs(row.score - cutoff);
      let included = true;
      let reason = null;
      if (d > h + 1e-9) { included = false; reason = 'outside'; }      // 超出分析范围
      else if (d < donut - 1e-9) { included = false; reason = 'donut'; } // 紧贴门槛被排除
      return {
        row: row,
        d: d,
        side: row.score < cutoff ? 'L' : 'R',
        included: included,
        reason: reason,
        weight: included ? triWeight(d, h) : 0,
      };
    });
  }

  /*
   * 检查获补贴是否严格由门槛决定（sharp RDD 的前提）。
   * 例外 = 达到门槛却未获补贴，或低于门槛却获补贴。
   */
  function checkSharp(rows, cutoff) {
    const exceptions = [];
    for (const r of rows) {
      const shouldBeTreated = r.score >= cutoff;
      if (shouldBeTreated !== !!r.treated) {
        exceptions.push({
          row: r,
          direction: shouldBeTreated ? '达到门槛但未获补贴' : '低于门槛仍获补贴',
        });
      }
    }
    return {
      sharp: exceptions.length === 0,
      exceptions: exceptions,
      rate: rows.length ? exceptions.length / rows.length : 0,
    };
  }

  /*
   * 单侧加权最小二乘：y ~ 1 + (score - cutoff)，三角核加权。
   * 截距即该侧在门槛处的局部水平；同时给出 HC1 稳健标准误。
   */
  function wlsSide(xs, ys, ws, cutoff) {
    let s0 = 0, s1 = 0, s2 = 0, t0 = 0, t1 = 0, n = 0;
    for (let i = 0; i < xs.length; i++) {
      if (ws[i] <= 0) continue;
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) continue; // 跳过缺失值
      n++;
      const u = xs[i] - cutoff;
      const w = ws[i];
      s0 += w; s1 += w * u; s2 += w * u * u;
      t0 += w * ys[i]; t1 += w * u * ys[i];
    }
    if (n < MIN_N_SIDE) {
      return { ok: false, reason: '有效样本不足（' + n + ' < ' + MIN_N_SIDE + '）', n: n };
    }
    const det = s0 * s2 - s1 * s1;
    if (!(det > 1e-12)) {
      return { ok: false, reason: '评分没有变化，无法拟合直线', n: n };
    }
    const b0 = (t0 * s2 - t1 * s1) / det; // 截距：门槛处水平
    const b1 = (s0 * t1 - s1 * t0) / det; // 斜率
    // HC1 稳健方差（只取截距项）
    let m00 = 0, m01 = 0, m11 = 0;
    for (let i = 0; i < xs.length; i++) {
      if (ws[i] <= 0) continue;
      const u = xs[i] - cutoff;
      const e = ys[i] - (b0 + b1 * u);
      const w2 = ws[i] * ws[i];
      m00 += w2 * e * e;
      m01 += w2 * e * e * u;
      m11 += w2 * e * e * u * u;
    }
    const v00 = (s2 * s2 * m00 - 2 * s1 * s2 * m01 + s1 * s1 * m11) / (det * det);
    const se = Math.sqrt(Math.max(0, v00 * (n / (n - 2))));
    return { ok: true, intercept: b0, slope: b1, se: se, n: n };
  }

  /*
   * 门槛两侧跳跃的通用估计：先过护栏，再分别拟合两侧，取截距之差。
   * getY 决定估计对象（后续产出 / 是否获补贴 / 原有属性）。
   * 任何护栏不满足时返回 ok:false 与原因，不输出有限效果值。
   */
  function jumpEstimate(filtered, cutoff, h, donut, getY) {
    const problems = [];
    if (!(h >= MIN_H)) problems.push('分析范围 ±' + fmt(h) + ' 分，小于下限 ' + MIN_H + ' 分（带宽过小）');
    if (!(donut < h)) problems.push('贴门槛排除带不能大于或等于分析范围');

    const L = [], R = [];
    for (const f of filtered) {
      if (!f.included || f.weight <= 0) continue;
      (f.side === 'L' ? L : R).push(f);
    }
    if (L.length === 0) problems.push('门槛左侧没有可用样本');
    if (R.length === 0) problems.push('门槛右侧没有可用样本');
    if (problems.length) return { ok: false, problems: problems, nL: L.length, nR: R.length };

    const fitL = wlsSide(L.map(f => f.row.score), L.map(f => getY(f.row)), L.map(f => f.weight), cutoff);
    const fitR = wlsSide(R.map(f => f.row.score), R.map(f => getY(f.row)), R.map(f => f.weight), cutoff);
    if (!fitL.ok) problems.push('左侧：' + fitL.reason);
    if (!fitR.ok) problems.push('右侧：' + fitR.reason);
    if (problems.length) return { ok: false, problems: problems, fitL: fitL, fitR: fitR, nL: L.length, nR: R.length };

    const tau = fitR.intercept - fitL.intercept;
    const se = Math.sqrt(fitL.se * fitL.se + fitR.se * fitR.se);
    return {
      ok: true,
      tau: tau,
      se: se,
      ci: [tau - Z95 * se, tau + Z95 * se],
      t: se > 0 ? tau / se : (tau === 0 ? 0 : Infinity),
      fitL: fitL,
      fitR: fitR,
      nL: L.length,
      nR: R.length,
    };
  }

  /* 评分桶：桶边界与门槛对齐（门槛本身是一个桶边界），便于观察两侧差异。 */
  function makeBuckets(rows, cutoff, width) {
    const map = new Map();
    let minK = Infinity, maxK = -Infinity;
    for (const r of rows) {
      const k = Math.floor((r.score - cutoff) / width);
      minK = Math.min(minK, k); maxK = Math.max(maxK, k);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    const list = [];
    if (!isFinite(minK)) return { width: width, list: list };
    // 只对有限值求均值；整列缺失时返回 null（界面显示「—」而不是 0）
    const meanOf = function (rs, fn) {
      let s = 0, n = 0;
      for (const r of rs) {
        const v = fn(r);
        if (Number.isFinite(v)) { s += v; n++; }
      }
      return n ? s / n : null;
    };
    for (let k = minK; k <= maxK; k++) {
      const rs = map.get(k) || [];
      const n = rs.length;
      list.push({
        k: k,
        lo: cutoff + k * width,
        hi: cutoff + (k + 1) * width,
        count: n,
        rows: rs,
        meanYears: meanOf(rs, r => r.years),
        meanEmployees: meanOf(rs, r => r.employees),
        treatedShare: n ? meanOf(rs, r => (r.treated ? 1 : 0)) : null,
        meanOutcome: meanOf(rs, r => r.outcome),
      });
    }
    return { width: width, list: list };
  }

  /*
   * 集中申报（bunching）启发式检查：
   *  - 门槛附近每个桶的人数与左右相邻桶均值比较（泊松近似 z 值）；
   *  - 紧贴门槛两侧桶（k=-1 与 k=0）的人数对比。
   * |z| >= 2 视为异常，仅作提示，不是正式检验。
   */
  function bunchingCheck(buckets) {
    const byK = new Map(buckets.map(b => [b.k, b]));
    const flags = [];
    for (const b of buckets) {
      if (Math.abs(b.k) > 4) continue;
      const prev = byK.get(b.k - 1), next = byK.get(b.k + 1);
      if (!prev || !next) continue;
      const expected = (prev.count + next.count) / 2;
      if (expected < 5) continue;
      const z = (b.count - expected) / Math.sqrt(expected);
      if (Math.abs(z) >= 2) {
        flags.push({ k: b.k, lo: b.lo, hi: b.hi, count: b.count, expected: expected, z: z });
      }
    }
    let straddle = null;
    const m1 = byK.get(-1), z0 = byK.get(0);
    if (m1 && z0 && (m1.count + z0.count) > 0) {
      straddle = {
        leftCount: m1.count,
        rightCount: z0.count,
        z: (z0.count - m1.count) / Math.sqrt(m1.count + z0.count),
      };
    }
    return { flags: flags, straddle: straddle };
  }

  /* 带宽敏感性：固定排除带，扫描一系列 h，观察两侧差距如何变化。 */
  function sensitivity(rows, cutoff, donut, hMax, steps) {
    const out = [];
    const n = steps || 40;
    for (let i = 0; i <= n; i++) {
      const h = MIN_H + (hMax - MIN_H) * (i / n);
      if (!(donut < h)) { out.push({ h: h, ok: false }); continue; }
      const est = jumpEstimate(filterSample(rows, cutoff, h, donut), cutoff, h, donut, r => r.outcome);
      out.push(est.ok
        ? { h: h, ok: true, tau: est.tau, lo: est.ci[0], hi: est.ci[1] }
        : { h: h, ok: false });
    }
    return out;
  }

  /* 汇总一次完整分析所需的全部结果。 */
  function analyze(rows, cutoff, h, donut) {
    const filtered = filterSample(rows, cutoff, h, donut);
    const sharp = checkSharp(rows, cutoff);
    const outcome = jumpEstimate(filtered, cutoff, h, donut, r => r.outcome);
    const firstStage = jumpEstimate(filtered, cutoff, h, donut, r => (r.treated ? 1 : 0));
    const attrKeys = ['years', 'employees'].filter(k => rows.some(r => Number.isFinite(r[k])));
    const attrs = attrKeys.map(k => Object.assign({ key: k }, jumpEstimate(filtered, cutoff, h, donut, r => r[k])));
    return { filtered: filtered, sharp: sharp, outcome: outcome, firstStage: firstStage, attrs: attrs };
  }

  const api = {
    MIN_H: MIN_H,
    MIN_N_SIDE: MIN_N_SIDE,
    Z95: Z95,
    fmt: fmt,
    triWeight: triWeight,
    filterSample: filterSample,
    checkSharp: checkSharp,
    wlsSide: wlsSide,
    jumpEstimate: jumpEstimate,
    makeBuckets: makeBuckets,
    bunchingCheck: bunchingCheck,
    sensitivity: sensitivity,
    analyze: analyze,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RDDCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
