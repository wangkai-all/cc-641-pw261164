/*
 * data.js — 虚构补贴申请数据生成器 + CSV 导入导出。
 * 虚构数据刻意包含三类「真实世界麻烦」，用于演示页面的诊断能力：
 *  1) 执行偏差：少量申请未按门槛严格发补贴（sharp 检查应报警）；
 *  2) 集中申报：门槛正上方（60–62 分）人数异常偏多（bunching 检查应报警）；
 *  3) 属性不连续：门槛下方附近的申请成立年限略长（属性连续性检查应报警）。
 */
(function (global) {
  'use strict';

  const CUTOFF = 60;
  const INDUSTRIES = ['制造', '软件', '零售', '服务'];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeRandn(rand) {
    let spare = null;
    return function () {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = 0, v = 0;
      while (u === 0) u = rand();
      v = rand();
      const mag = Math.sqrt(-2 * Math.log(u));
      spare = mag * Math.sin(2 * Math.PI * v);
      return mag * Math.cos(2 * Math.PI * v);
    };
  }

  function shufflePick(arr, n, rand) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a.slice(0, Math.min(n, a.length));
  }

  function generate(seed) {
    const rand = mulberry32(seed);
    const randn = makeRandn(rand);
    const rows = [];
    let id = 1;

    function add(score, bunch) {
      // 原有属性：成立年限、员工数、行业（获补贴前已确定）
      const nearBelow = score >= 55 && score < CUTOFF;
      const years = Math.max(1, Math.min(20,
        Math.round(3 + rand() * 12 + (nearBelow ? 2.4 : 0) + randn() * 0.6)));
      const employees = Math.max(3, Math.round(8 * Math.exp(rand() * Math.log(25))));
      const industry = INDUSTRIES[Math.floor(rand() * INDUSTRIES.length)];
      rows.push({
        id: id++,
        score: score,
        years: years,
        employees: employees,
        industry: industry,
        treated: 0,
        outcome: 0,
        bunch: !!bunch,
        exception: null,
      });
    }

    // 基础样本：评分 32–88 近似均匀
    for (let i = 0; i < 520; i++) add(32 + Math.floor(rand() * 57), false);
    // 集中申报：门槛正上方 60–62 分异常堆积
    for (let i = 0; i < 90; i++) add(CUTOFF + Math.min(2, Math.floor(Math.abs(randn()) * 1.4)), true);

    // 补贴发放：原则上严格按门槛
    for (const r of rows) r.treated = r.score >= CUTOFF ? 1 : 0;
    // 执行偏差 1：低于门槛仍获补贴（特批）——散布在较大评分范围，而非堆在门槛边
    shufflePick(rows.filter(r => r.score >= 45 && r.score < CUTOFF), 5, rand)
      .forEach(r => { r.treated = 1; r.exception = '低于门槛仍获补贴（特批）'; });
    // 执行偏差 2：达到门槛但未获补贴（执行遗漏）
    shufflePick(rows.filter(r => r.score >= CUTOFF && r.score <= 75 && !r.exception), 5, rand)
      .forEach(r => { r.treated = 0; r.exception = '达到门槛但未获补贴（执行遗漏）'; });

    // 后续产出（万元）：随评分平滑上升 + 补贴的真实局部效应 + 噪声
    const TRUE_EFFECT = 35;
    for (const r of rows) {
      const base = 150 + 2.0 * (r.score - CUTOFF) + 0.9 * r.years + 0.15 * r.employees;
      r.outcome = Math.round((base + TRUE_EFFECT * r.treated + randn() * 10) * 10) / 10;
    }

    rows.sort((a, b) => a.score - b.score || a.id - b.id);
    return {
      cutoff: CUTOFF,
      rows: rows,
      seed: seed,
      label: '内置虚构数据（种子 ' + seed + '）',
    };
  }

  /* ---------- CSV ---------- */

  const ALIASES = {
    id: ['id', '编号', '申请编号'],
    score: ['score', '评分', '原始评分'],
    treated: ['treated', '获补贴', '是否获补贴', 'subsidy', 'subsidized'],
    outcome: ['outcome', '产出', '后续产出'],
    years: ['years', '成立年限', '年限'],
    employees: ['employees', '员工数', '员工人数'],
    industry: ['industry', '行业'],
  };

  function toCSV(rows) {
    const head = 'id,score,treated,outcome,years,employees,industry';
    const lines = rows.map(r => [
      r.id, r.score, r.treated ? 1 : 0, r.outcome,
      r.years == null ? '' : r.years,
      r.employees == null ? '' : r.employees,
      r.industry == null ? '' : r.industry,
    ].join(','));
    return head + '\n' + lines.join('\n') + '\n';
  }

  function parseCSVLine(line) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQ) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else inQ = false;
        } else cur += c;
      } else if (c === '"') inQ = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseTreated(v) {
    const s = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', '是', '获补贴'].includes(s)) return 1;
    if (['0', 'false', 'no', 'n', '否', '未获补贴'].includes(s)) return 0;
    return null;
  }

  /*
   * 解析 CSV：必需列 score / treated / outcome（支持中文别名），
   * 可选列 id / years / employees / industry。
   */
  function parseCSV(text) {
    const errors = [];
    const lines = String(text).split(/\r\n|\r|\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return { rows: null, errors: ['CSV 至少需要表头和一行数据'] };

    const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
    const colOf = {};
    for (const key of Object.keys(ALIASES)) {
      for (const name of ALIASES[key]) {
        const idx = header.indexOf(name.toLowerCase());
        if (idx >= 0) { colOf[key] = idx; break; }
      }
    }
    for (const req of ['score', 'treated', 'outcome']) {
      if (colOf[req] === undefined) {
        errors.push('缺少必需列：' + req + '（可用别名：' + ALIASES[req].join(' / ') + '）');
      }
    }
    if (errors.length) return { rows: null, errors: errors };

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      const get = k => (colOf[k] === undefined ? '' : (cells[colOf[k]] || '').trim());
      const score = Number(get('score'));
      const treated = parseTreated(get('treated'));
      const outcome = Number(get('outcome'));
      if (!Number.isFinite(score) || treated === null || !Number.isFinite(outcome)) {
        errors.push('第 ' + (i + 1) + ' 行无法解析（score/treated/outcome）');
        continue;
      }
      const years = get('years') === '' ? null : Number(get('years'));
      const employees = get('employees') === '' ? null : Number(get('employees'));
      rows.push({
        id: get('id') || ('R' + i),
        score: score,
        treated: treated,
        outcome: outcome,
        years: Number.isFinite(years) ? years : null,
        employees: Number.isFinite(employees) ? employees : null,
        industry: get('industry') || null,
        exception: null,
      });
      if (errors.length > 20) { errors.push('……错误过多，已停止解析'); return { rows: null, errors: errors }; }
    }
    if (!rows.length) return { rows: null, errors: errors.length ? errors : ['没有可用数据行'] };
    rows.sort((a, b) => a.score - b.score);
    return { rows: rows, errors: errors };
  }

  const api = {
    CUTOFF: CUTOFF,
    INDUSTRIES: INDUSTRIES,
    generate: generate,
    toCSV: toCSV,
    parseCSV: parseCSV,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.RDDData = api;
})(typeof window !== 'undefined' ? window : globalThis);
