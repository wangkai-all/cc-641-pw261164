/* 核心逻辑测试：node tests/run-tests.js */
'use strict';
const core = require('../js/core.js');
const data = require('../js/data.js');

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function approx(a, b, tol, name) { ok(Math.abs(a - b) <= tol, name + '（' + a + ' ≈ ' + b + '）'); }
function section(s) { console.log('\n[' + s + ']'); }

/* ---------- 加权最小二乘 ---------- */
section('wlsSide 加权最小二乘');
{
  // 精确直线 y = 3 + 2(x-60)
  const xs = [], ys = [], ws = [];
  for (let x = 50; x < 60; x++) { xs.push(x); ys.push(3 + 2 * (x - 60)); ws.push(1 - Math.abs(x - 60) / 10); }
  const fit = core.wlsSide(xs, ys, ws, 60);
  ok(fit.ok, '无噪声直线可拟合');
  approx(fit.intercept, 3, 1e-9, '截距');
  approx(fit.slope, 2, 1e-9, '斜率');
  ok(fit.se < 1e-9, '无噪声时标准误≈0');

  // 零权重行不影响结果
  const xs2 = xs.concat([55, 56]), ys2 = ys.concat([999, -999]), ws2 = ws.concat([0, 0]);
  const fit2 = core.wlsSide(xs2, ys2, ws2, 60);
  approx(fit2.intercept, fit.intercept, 1e-12, '零权重行不改变截距');

  // 评分无变化 → 拒绝输出
  const flat = core.wlsSide([58, 58, 58, 58, 58, 58], [1, 2, 3, 4, 5, 6], [1, 1, 1, 1, 1, 1], 60);
  ok(!flat.ok && /没有变化/.test(flat.reason), '某侧评分没有变化时不输出');

  // 样本不足 → 拒绝输出
  const few = core.wlsSide([58, 59], [1, 2], [1, 1], 60);
  ok(!few.ok && /样本不足/.test(few.reason), '样本不足时不输出');
}

/* ---------- 样本筛选与同分联动 ---------- */
section('filterSample 筛选与同分联动');
{
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push({ id: i, score: 40 + (i % 41), outcome: i, treated: 0 });
  // 同分申请在任何 h / donut 下都同去同留
  let tiesOk = true;
  for (let h = 2; h <= 20; h += 1.7) {
    for (let donut = 0; donut < h; donut += 1.3) {
      const fs = core.filterSample(rows, 60, h, donut);
      const byScore = new Map();
      for (const f of fs) {
        const key = f.row.score;
        const sig = f.included + '|' + (f.reason || '');
        if (byScore.has(key) && byScore.get(key) !== sig) tiesOk = false;
        byScore.set(key, sig);
      }
    }
  }
  ok(tiesOk, '评分相同的申请始终一起保留/一起排除');

  // 对称性：同一 h 同时约束两侧，不存在单侧范围
  const fs = core.filterSample(rows, 60, 10, 0);
  const maxL = Math.max(...fs.filter(f => f.included && f.side === 'L').map(f => f.d));
  const maxR = Math.max(...fs.filter(f => f.included && f.side === 'R').map(f => f.d));
  ok(maxL <= 10 + 1e-9 && maxR <= 10 + 1e-9, '两侧使用同一个分析范围（对称）');

  // donut 排除：|x-c| < donut 被排除，边界保留
  const fd = core.filterSample([{ score: 58 }, { score: 59 }, { score: 60 }], 60, 10, 2);
  ok(fd[0].included && !fd[1].included && !fd[2].included, '排除带边界正确（d=2 保留，d<2 排除）');

  // 权重：三角核，门槛处为 1，边界为 0
  approx(core.triWeight(0, 10), 1, 1e-12, '门槛处权重=1');
  approx(core.triWeight(10, 10), 0, 1e-12, '范围边界权重=0');
}

/* ---------- 有效性护栏 ---------- */
section('jumpEstimate 护栏');
{
  const mk = scores => scores.map(s => ({ score: s, outcome: 100 + s }));
  // 缺一侧样本
  const onlyR = core.jumpEstimate(core.filterSample(mk([60, 61, 62, 63, 64, 65]), 60, 10, 0), 60, 10, 0, r => r.outcome);
  ok(!onlyR.ok && onlyR.problems.some(p => /左侧没有/.test(p)), '缺少左侧样本时不输出');
  // 带宽过小
  const tiny = core.jumpEstimate(core.filterSample(mk([58, 59, 60, 61]), 60, 1, 0), 60, 1, 0, r => r.outcome);
  ok(!tiny.ok && tiny.problems.some(p => /带宽过小/.test(p)), '带宽过小时不输出');
  // 排除带 >= 范围
  const bigDonut = core.jumpEstimate(core.filterSample(mk([58, 59, 60, 61]), 60, 5, 5), 60, 5, 5, r => r.outcome);
  ok(!bigDonut.ok && bigDonut.problems.some(p => /排除带/.test(p)), '排除带≥范围时不输出');
  // 某侧评分无变化（donut 后左侧只剩同一分）
  const rowsFlat = mk([59, 59, 59, 59, 59, 59, 60, 61, 62, 63, 64, 65]);
  const flat = core.jumpEstimate(core.filterSample(rowsFlat, 60, 10, 0), 60, 10, 0, r => r.outcome);
  ok(!flat.ok && flat.problems.some(p => /没有变化/.test(p)), '某侧评分没有变化时不输出');
  // 正常情形输出有限值
  const good = core.jumpEstimate(
    core.filterSample(mk([55, 56, 57, 58, 59, 60, 61, 62, 63, 64]), 60, 8, 0), 60, 8, 0, r => r.outcome);
  ok(good.ok && Number.isFinite(good.tau), '正常情形输出有限效果值');
}

/* ---------- 已知效应回收 ---------- */
section('效应回收（合成数据）');
{
  // y = 10 + 1*(x-60) + 5*(x>=60)，无噪声 → tau 应精确等于 5
  const rows = [];
  for (let s = 50; s <= 70; s++) for (let j = 0; j < 6; j++) {
    rows.push({ score: s, outcome: 10 + 1 * (s - 60) + 5 * (s >= 60 ? 1 : 0), treated: s >= 60 ? 1 : 0 });
  }
  const est = core.jumpEstimate(core.filterSample(rows, 60, 10, 0), 60, 10, 0, r => r.outcome);
  ok(est.ok, '合成数据可估计');
  approx(est.tau, 5, 1e-9, '无噪声时精确回收跳跃值 5');

  // 虚构数据：真实效应 35，估计应落在合理邻域
  const ds = data.generate(641);
  const a = core.analyze(ds.rows, ds.cutoff, 10, 0);
  ok(a.outcome.ok, '虚构数据可估计');
  ok(Math.abs(a.outcome.tau - 35) < 12, '虚构数据估计接近真实效应 35（实际 ' + core.fmt(a.outcome.tau) + '）');
}

/* ---------- 执行偏差检查 ---------- */
section('checkSharp 执行偏差');
{
  const strict = [{ score: 59, treated: 0 }, { score: 60, treated: 1 }];
  ok(core.checkSharp(strict, 60).sharp, '严格按门槛时判定 sharp');
  const fuzzy = [
    { score: 59, treated: 1 }, // 低于门槛仍获补贴
    { score: 61, treated: 0 }, // 达到门槛未获补贴
    { score: 62, treated: 1 },
  ];
  const chk = core.checkSharp(fuzzy, 60);
  ok(!chk.sharp && chk.exceptions.length === 2, '两个方向的例外都被发现');
  const ds = data.generate(641);
  const chk2 = core.checkSharp(ds.rows, ds.cutoff);
  ok(!chk2.sharp && chk2.exceptions.length === 10, '内置虚构数据含 10 例执行偏差（实际 ' + chk2.exceptions.length + '）');
}

/* ---------- 评分桶与集中申报 ---------- */
section('评分桶 / bunching');
{
  const ds = data.generate(641);
  const bk = core.makeBuckets(ds.rows, ds.cutoff, 2);
  const total = bk.list.reduce((s, b) => s + b.count, 0);
  ok(total === ds.rows.length, '桶人数合计 = 总样本');
  const b0 = bk.list.find(b => b.k === 0);
  ok(b0 && b0.lo === ds.cutoff, '桶边界与门槛对齐（k=0 从门槛开始）');
  const bunch = core.bunchingCheck(bk.list);
  ok(bunch.flags.length > 0 || Math.abs(bunch.straddle.z) >= 2, '检出虚构数据中的集中申报');
}

/* ---------- 敏感性扫描 ---------- */
section('sensitivity');
{
  const ds = data.generate(641);
  const pts = core.sensitivity(ds.rows, ds.cutoff, 0, 20, 30);
  ok(pts.length === 31 && pts.every(p => Number.isFinite(p.h)), '返回完整网格');
  ok(pts.some(p => p.ok), '存在有效带宽');
  const ptsDonut = core.sensitivity(ds.rows, ds.cutoff, 5, 20, 30);
  ok(ptsDonut.filter(p => p.h <= 5).every(p => !p.ok), 'h ≤ 排除带时全部无效（不输出有限值）');
}

/* ---------- 数据生成器与 CSV ---------- */
section('data 生成器 / CSV');
{
  const d1 = data.generate(641), d2 = data.generate(641), d3 = data.generate(642);
  ok(JSON.stringify(d1.rows[0]) === JSON.stringify(d2.rows[0]), '同一种子结果确定');
  ok(JSON.stringify(d1.rows[0]) !== JSON.stringify(d3.rows[0]), '不同种子结果不同');
  ok(d1.rows.every(r => r.score >= 0 && r.score <= 100), '评分在 0–100 内');
  ok(d1.rows.every(r => Number.isFinite(r.outcome)), '产出均为有限数');

  const csv = data.toCSV(d1.rows);
  const back = data.parseCSV(csv);
  ok(back.rows && back.rows.length === d1.rows.length, 'CSV 往返行数一致');
  ok(back.rows.every(r => r.treated === 0 || r.treated === 1), 'CSV 往返 treated 解析正确');
  const bad = data.parseCSV('a,b,c\n1,2,3\n');
  ok(!bad.rows && bad.errors.length > 0, '缺列时报错而不是崩溃');

  // 无属性列的 CSV：桶均值应为 null（显示「—」），而不是 0
  const noAttr = data.parseCSV('score,treated,outcome\n58,0,100\n59,0,101\n60,1,140\n61,1,141\n');
  const bk2 = core.makeBuckets(noAttr.rows, 60, 2);
  ok(bk2.list.every(b => b.meanYears === null), '缺失属性列时桶均值为 null');
  // 缺失属性不参与拟合：估计仍正常
  const est2 = core.jumpEstimate(
    core.filterSample(noAttr.rows, 60, 5, 0), 60, 5, 0, r => r.years);
  ok(!est2.ok, '整侧属性缺失时不输出该属性的跳跃值');
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
