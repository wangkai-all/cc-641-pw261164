/*
 * app.js — 页面状态与渲染：把 core.js 的分析结果接到 DOM 与图表上。
 */
(function () {
  'use strict';

  const Core = window.RDDCore;
  const Data = window.RDDData;
  const Charts = window.RDDCharts;

  /* 主题色：与 palette.md 的参考色板一致（蓝=左侧，橙=右侧，灰=排除） */
  const THEMES = {
    light: {
      surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781',
      grid: '#e1e0d9', baseline: '#c3c2b7',
      s1: '#2a78d6', s2: '#eb6834', excluded: '#b3b1aa',
      regionOutside: 'rgba(11,11,11,0.045)', regionDonut: 'rgba(250,178,25,0.14)',
      windowLine: '#b9b7b0', donutLine: '#d9a832', cutoffLine: '#52514e',
      handle: '#52514e', critical: '#d03b3b', warning: '#fab219', good: '#0ca30c',
    },
    dark: {
      surface: '#1a1a19', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781',
      grid: '#2c2c2a', baseline: '#383835',
      s1: '#3987e5', s2: '#d95926', excluded: '#5d5c56',
      regionOutside: 'rgba(240,239,236,0.05)', regionDonut: 'rgba(250,178,25,0.16)',
      windowLine: '#4a4a46', donutLine: '#8a6a1f', cutoffLine: '#c3c2b7',
      handle: '#c3c2b7', critical: '#e66767', warning: '#fab219', good: '#0ca30c',
    },
  };

  const BUCKET_WIDTH = 2;
  const ATTR_NAMES = { years: '成立年限', employees: '员工数' };
  const LS_KEY = 'rdd-snapshots-v1';

  const state = {
    data: null,
    cutoff: 60,
    h: 10,
    donut: 0,
    selectedK: null,
    snapshots: [],
  };

  const $ = id => document.getElementById(id);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function theme() {
    return THEMES[document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'];
  }

  const r3 = x => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
  const fmtSigned = x => (x >= 0 ? '+' : '') + Core.fmt(x);

  /* ---------- 计算 ---------- */
  function compute() {
    const rows = state.data.rows;
    let minS = Infinity, maxS = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const r of rows) {
      minS = Math.min(minS, r.score); maxS = Math.max(maxS, r.score);
      yMin = Math.min(yMin, r.outcome); yMax = Math.max(yMax, r.outcome);
    }
    const maxH = Math.max(Core.MIN_H, Math.floor(Math.min(state.cutoff - minS, maxS - state.cutoff)));
    state.h = Math.min(Math.max(state.h, Core.MIN_H), maxH);
    state.donut = Math.min(Math.max(state.donut, 0), Math.max(0, state.h - 0.5));
    const analysis = Core.analyze(rows, state.cutoff, state.h, state.donut);
    const buckets = Core.makeBuckets(rows, state.cutoff, BUCKET_WIDTH);
    const bunch = Core.bunchingCheck(buckets.list);
    const sens = Core.sensitivity(rows, state.cutoff, state.donut, maxH, 48);
    const yPad = (yMax - yMin) * 0.06 || 1;
    return {
      rows, minS, maxS, maxH, analysis, buckets, bunch, sens,
      xDom: [minS - 1, maxS + 1],
      yDom: [yMin - yPad, yMax + yPad],
    };
  }

  /* ---------- 渲染 ---------- */
  function render() {
    const c = compute();
    renderControls(c);
    renderSharpAlert(c);
    renderEstimate(c);
    renderWarnings(c);
    renderBucketTable(c);
    renderDrilldown(c);
    renderSnapshots();
    renderSensTable(c);
    renderFullTable(c);

    const exRows = new Set(c.analysis.sharp.exceptions.map(e => e.row));
    Charts.renderMain($('mainChart'), {
      filtered: c.analysis.filtered,
      cutoff: state.cutoff, h: state.h, donut: state.donut,
      xDom: c.xDom, yDom: c.yDom,
      estimate: c.analysis.outcome,
      exceptionRows: exRows,
      theme: theme(),
      minH: Core.MIN_H, maxH: c.maxH,
      onDragH: h => { state.h = h; render(); },
    });

    const includedByBucket = new Map();
    for (const f of c.analysis.filtered) {
      if (!f.included) continue;
      const k = Math.floor((f.row.score - state.cutoff) / BUCKET_WIDTH);
      includedByBucket.set(k, (includedByBucket.get(k) || 0) + 1);
    }
    const flaggedKs = new Set(c.bunch.flags.map(f => f.k));
    Charts.renderHistogram($('histChart'), {
      buckets: c.buckets.list,
      bucketWidth: BUCKET_WIDTH,
      cutoff: state.cutoff, h: state.h, donut: state.donut,
      xDom: c.xDom,
      includedByBucket, flaggedKs,
      selectedK: state.selectedK,
      theme: theme(),
      onSelect: k => { state.selectedK = (state.selectedK === k ? null : k); render(); },
    });

    Charts.renderSensitivity($('sensChart'), {
      points: c.sens,
      currentH: state.h,
      theme: theme(),
    });
  }

  function renderControls(c) {
    $('hSlider').min = Core.MIN_H;
    $('hSlider').max = c.maxH;
    $('hSlider').step = 0.5;
    $('hSlider').value = state.h;
    $('hValue').textContent = '±' + Core.fmt(state.h) + ' 分';
    $('donutSlider').min = 0;
    $('donutSlider').max = Math.max(0, state.h - 0.5);
    $('donutSlider').step = 0.5;
    $('donutSlider').value = state.donut;
    $('donutValue').textContent = state.donut > 0 ? '±' + Core.fmt(state.donut) + ' 分' : '不排除';
    $('datasetLabel').textContent = state.data.label + ' · ' + state.data.rows.length + ' 条申请';

    const legend = $('mainLegend');
    legend.textContent = '';
    const t = theme();
    const items = [
      { color: t.s1, text: '门槛左侧（评分 < ' + state.cutoff + '）' },
      { color: t.s2, text: '门槛右侧（评分 ≥ ' + state.cutoff + '）' },
      { color: t.excluded, text: '已排除（范围外 / 贴门槛）' },
      { ring: t.critical, text: '执行偏差例外' },
    ];
    for (const it of items) {
      const span = el('span', 'legend-item');
      const sw = el('span', it.ring ? 'legend-ring' : 'legend-dot');
      sw.style.background = it.ring ? 'transparent' : it.color;
      if (it.ring) sw.style.borderColor = it.ring;
      span.appendChild(sw);
      span.appendChild(el('span', null, it.text));
      legend.appendChild(span);
    }
  }

  function renderSharpAlert(c) {
    const box = $('sharpAlert');
    const sharp = c.analysis.sharp;
    if (sharp.sharp) { box.hidden = true; return; }
    box.hidden = false;
    $('sharpAlertText').textContent =
      '发现 ' + sharp.exceptions.length + ' 例执行偏差（占 ' + (sharp.rate * 100).toFixed(1) +
      '%）：获补贴并非严格由门槛决定。下方差距只能解释为「评分跨过门槛」本身的影响（意向处理效应 ITT），' +
      '不能当作补贴本身的效应。';
    const tbody = $('sharpExceptions');
    tbody.textContent = '';
    for (const e of sharp.exceptions) {
      const tr = el('tr');
      tr.appendChild(el('td', null, String(e.row.id)));
      tr.appendChild(el('td', null, String(e.row.score)));
      tr.appendChild(el('td', null, e.row.treated ? '是' : '否'));
      tr.appendChild(el('td', null, e.direction + (e.row.exception ? '：' + e.row.exception : '')));
      tbody.appendChild(tr);
    }
  }

  function renderEstimate(c) {
    const o = c.analysis.outcome;
    const fs = c.analysis.firstStage;
    const sharp = c.analysis.sharp;
    const problems = $('estProblems');
    const facts = $('estFacts');
    facts.textContent = '';

    if (o.ok) {
      $('estTau').textContent = fmtSigned(o.tau);
      problems.hidden = true;
      const rows = [
        ['95% 置信区间', Core.fmt(o.ci[0]) + ' ~ ' + Core.fmt(o.ci[1])],
        ['标准误', '±' + Core.fmt(o.se)],
        ['有效样本', '左侧 ' + o.nL + ' / 右侧 ' + o.nR + '（三角核加权）'],
      ];
      if (fs.ok) {
        rows.push(['获补贴概率跳跃', fmtSigned(fs.tau) + '（±' + Core.fmt(fs.se) + '，第一阶段）']);
      }
      for (const [k, v] of rows) {
        const d = el('div', 'fact');
        d.appendChild(el('div', 'fact-label', k));
        d.appendChild(el('div', 'fact-value', v));
        facts.appendChild(d);
      }
    } else {
      $('estTau').textContent = '—';
      problems.hidden = false;
      problems.textContent = '';
      problems.appendChild(el('strong', null, '当前设置下不输出有限效果值：'));
      const ul = el('ul');
      for (const p of o.problems) ul.appendChild(el('li', null, p));
      problems.appendChild(ul);
    }

    const interp = $('interpretation');
    if (!o.ok) {
      interp.textContent = '请先解决上述问题，再解读两侧差距。';
    } else if (sharp.sharp) {
      interp.textContent = '未发现执行偏差：获补贴严格由门槛决定。在两侧申请构成连续的前提下，' +
        '该差距可解释为补贴对「刚好跨过门槛」申请的局部效应。';
    } else {
      interp.textContent = '由于存在执行偏差，该差距是「跨过门槛」的影响（ITT），' +
        '不是补贴本身的效应；要得到补贴效应还需额外的工具变量假设，本页不做此推断。';
    }
    $('scopeNote').textContent =
      '适用范围：本结果为评分 ' + state.cutoff + ' 附近（±' + Core.fmt(state.h) + ' 分' +
      (state.donut > 0 ? '，排除紧贴门槛的 ±' + Core.fmt(state.donut) + ' 分' : '') +
      '）的局部估计，不能推广到所有申请。';
  }

  function renderWarnings(c) {
    const box = $('warnings');
    box.textContent = '';
    const items = [];
    for (const f of c.bunch.flags) {
      items.push({
        level: 'warning',
        text: '评分 ' + f.lo + '–' + f.hi + ' 桶有 ' + f.count + ' 人，明显多于相邻桶（期望约 ' +
          Core.fmt(f.expected) + ' 人，z=' + Core.fmt(f.z) + '）：存在门槛附近集中申报的迹象，' +
          '门槛两侧样本可能不可比。',
      });
    }
    const st = c.bunch.straddle;
    if (st && Math.abs(st.z) >= 2) {
      items.push({
        level: 'warning',
        text: '紧贴门槛两侧人数悬殊（左侧 ' + st.leftCount + ' 人 vs 右侧 ' + st.rightCount +
          ' 人，z=' + Core.fmt(st.z) + '），提示评分可能被操纵。',
      });
    }
    for (const a of c.analysis.attrs) {
      if (a.ok && Math.abs(a.t) >= 1.96) {
        items.push({
          level: 'warning',
          text: (ATTR_NAMES[a.key] || a.key) + ' 在门槛处不连续（跳跃 ' + fmtSigned(a.tau) +
            '，t=' + Core.fmt(a.t) + '）：两侧申请的原有构成不同，削弱因果解释。',
        });
      }
    }
    if (!items.length) {
      items.push({ level: 'good', text: '未发现明显的集中申报或原有属性不连续。' });
    }
    for (const it of items) {
      const div = el('div', 'warn-item warn-' + it.level);
      div.appendChild(el('span', 'warn-icon', it.level === 'good' ? '✓' : '⚠'));
      div.appendChild(el('span', null, it.text));
      box.appendChild(div);
    }
  }

  function renderBucketTable(c) {
    const table = $('bucketTable');
    table.textContent = '';
    const flaggedKs = new Set(c.bunch.flags.map(f => f.k));
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['评分区间', '人数', '获补贴比例', '平均成立年限', '平均员工数', '平均后续产出']) {
      hr.appendChild(el('th', null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const b of c.buckets.list) {
      const tr = el('tr', state.selectedK === b.k ? 'row-selected' : null);
      tr.dataset.k = b.k;
      const rangeTd = el('td', null, b.lo + ' – ' + b.hi + (flaggedKs.has(b.k) ? ' ⚠' : ''));
      tr.appendChild(rangeTd);
      tr.appendChild(el('td', null, String(b.count)));
      tr.appendChild(el('td', null, b.treatedShare == null ? '—' : (b.treatedShare * 100).toFixed(0) + '%'));
      tr.appendChild(el('td', null, b.meanYears == null ? '—' : b.meanYears.toFixed(1)));
      tr.appendChild(el('td', null, b.meanEmployees == null ? '—' : b.meanEmployees.toFixed(0)));
      tr.appendChild(el('td', null, b.meanOutcome == null ? '—' : b.meanOutcome.toFixed(1)));
      tr.addEventListener('click', () => {
        state.selectedK = (state.selectedK === b.k ? null : b.k);
        render();
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function renderDrilldown(c) {
    const card = $('drilldownCard');
    if (state.selectedK == null) { card.hidden = true; return; }
    const bucket = c.buckets.list.find(b => b.k === state.selectedK);
    if (!bucket) { card.hidden = true; return; }
    card.hidden = false;
    $('drillTitle').textContent = '桶明细：评分 ' + bucket.lo + ' – ' + bucket.hi + ' · ' + bucket.count + ' 人';

    // 同分联动核对：桶内每个评分值应整体保留或整体排除
    const fmap = new Map();
    for (const f of c.analysis.filtered) fmap.set(f.row, f);
    const byScore = new Map();
    for (const r of bucket.rows) {
      const f = fmap.get(r);
      if (!byScore.has(r.score)) byScore.set(r.score, { total: 0, included: 0 });
      const g = byScore.get(r.score);
      g.total++;
      if (f && f.included) g.included++;
    }
    let allTogether = true;
    const parts = [];
    for (const [score, g] of [...byScore.entries()].sort((a, b) => a[0] - b[0])) {
      const whole = g.included === 0 || g.included === g.total;
      if (!whole) allTogether = false;
      parts.push('评分 ' + score + '（' + g.total + ' 条，' + (g.included === g.total ? '全部保留' : g.included === 0 ? '全部排除' : '不一致！') + '）');
    }
    $('drillNote').textContent =
      (allTogether ? '同分联动核对通过：' : '⚠ 同分联动被破坏：') +
      '同一评分的申请始终一起保留或一起排除。' + parts.join('；') + '。';

    const table = $('drillTable');
    table.textContent = '';
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['编号', '评分', '成立年限', '员工数', '行业', '获补贴', '后续产出', '当前状态', '拟合权重']) {
      hr.appendChild(el('th', null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const r of bucket.rows) {
      const f = fmap.get(r);
      const tr = el('tr');
      tr.appendChild(el('td', null, String(r.id)));
      tr.appendChild(el('td', null, String(r.score)));
      tr.appendChild(el('td', null, r.years == null ? '—' : String(r.years)));
      tr.appendChild(el('td', null, r.employees == null ? '—' : String(r.employees)));
      tr.appendChild(el('td', null, r.industry || '—'));
      tr.appendChild(el('td', null, r.treated ? '是' : '否'));
      tr.appendChild(el('td', null, Core.fmt(r.outcome)));
      tr.appendChild(el('td', null, !f || !f.included
        ? (f && f.reason === 'donut' ? '排除：紧贴门槛' : '排除：超出范围')
        : (f.side === 'L' ? '保留（左侧）' : '保留（右侧）')));
      tr.appendChild(el('td', null, f && f.included ? f.weight.toFixed(3) : '0.000'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function renderSensTable(c) {
    const table = $('sensTable');
    table.textContent = '';
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['分析范围 ±h', '两侧差距', '95% 置信区间']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const p of c.sens) {
      const tr = el('tr');
      tr.appendChild(el('td', null, '±' + Core.fmt(p.h)));
      tr.appendChild(el('td', null, p.ok ? fmtSigned(p.tau) : '—'));
      tr.appendChild(el('td', null, p.ok ? Core.fmt(p.lo) + ' ~ ' + Core.fmt(p.hi) : '无有效估计'));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function renderFullTable(c) {
    const table = $('fullTable');
    table.textContent = '';
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['编号', '评分', '获补贴', '后续产出', '成立年限', '员工数', '行业', '执行偏差']) {
      hr.appendChild(el('th', null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    const CAP = 500;
    c.rows.slice(0, CAP).forEach(r => {
      const tr = el('tr');
      tr.appendChild(el('td', null, String(r.id)));
      tr.appendChild(el('td', null, String(r.score)));
      tr.appendChild(el('td', null, r.treated ? '是' : '否'));
      tr.appendChild(el('td', null, Core.fmt(r.outcome)));
      tr.appendChild(el('td', null, r.years == null ? '—' : String(r.years)));
      tr.appendChild(el('td', null, r.employees == null ? '—' : String(r.employees)));
      tr.appendChild(el('td', null, r.industry || '—'));
      tr.appendChild(el('td', null, r.exception || ''));
      tbody.appendChild(tr);
    });
    if (c.rows.length > CAP) {
      const tr = el('tr');
      const td = el('td', null, '……共 ' + c.rows.length + ' 行，仅显示前 ' + CAP + ' 行');
      td.colSpan = 8;
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  /* ---------- 保存的结果 ---------- */
  function loadSnapshots() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      state.snapshots = raw ? JSON.parse(raw) : [];
    } catch (e) {
      state.snapshots = [];
    }
  }

  function persistSnapshots() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state.snapshots)); } catch (e) { /* 忽略 */ }
  }

  function saveSnapshot() {
    const c = compute();
    const o = c.analysis.outcome;
    const fs = c.analysis.firstStage;
    const sharp = c.analysis.sharp;
    state.snapshots.unshift({
      savedAt: new Date().toISOString(),
      dataset: state.data.label,
      cutoff: state.cutoff,
      bandwidth: state.h,
      donutExclusion: state.donut,
      nLeft: o.nL !== undefined ? o.nL : null,
      nRight: o.nR !== undefined ? o.nR : null,
      execution: sharp.sharp ? '严格门槛（未发现例外）' : '存在 ' + sharp.exceptions.length + ' 例执行偏差',
      estimate: o.ok ? { tau: r3(o.tau), se: r3(o.se), ci95: [r3(o.ci[0]), r3(o.ci[1])] } : null,
      invalidReasons: o.ok ? [] : o.problems.slice(),
      firstStage: fs.ok ? { jump: r3(fs.tau), se: r3(fs.se) } : null,
      scope: '局部估计：仅适用于评分接近 ' + state.cutoff + ' 的申请（±' + state.h + ' 分' +
        (state.donut > 0 ? '，排除 ±' + state.donut + ' 分' : '') + '），不能推广到所有申请。',
    });
    persistSnapshots();
    renderSnapshots();
  }

  function renderSnapshots() {
    const table = $('snapTable');
    table.textContent = '';
    if (!state.snapshots.length) {
      const tr = el('tr');
      const td = el('td', 'snap-empty', '还没有保存的结果。');
      tr.appendChild(td);
      table.appendChild(tr);
      return;
    }
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['保存时间', '数据', '门槛', '范围', '排除', '样本 左/右', '两侧差距 [95% CI]', '执行', '适用范围']) {
      hr.appendChild(el('th', null, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const s of state.snapshots) {
      const tr = el('tr');
      tr.appendChild(el('td', null, s.savedAt.replace('T', ' ').slice(0, 19)));
      tr.appendChild(el('td', null, s.dataset));
      tr.appendChild(el('td', null, String(s.cutoff)));
      tr.appendChild(el('td', null, '±' + s.bandwidth));
      tr.appendChild(el('td', null, s.donutExclusion > 0 ? '±' + s.donutExclusion : '无'));
      tr.appendChild(el('td', null, (s.nLeft == null ? '—' : s.nLeft) + ' / ' + (s.nRight == null ? '—' : s.nRight)));
      tr.appendChild(el('td', null, s.estimate
        ? fmtSigned(s.estimate.tau) + ' [' + Core.fmt(s.estimate.ci95[0]) + ' ~ ' + Core.fmt(s.estimate.ci95[1]) + ']'
        : '无效：' + (s.invalidReasons || []).join('；')));
      tr.appendChild(el('td', null, s.execution));
      tr.appendChild(el('td', null, s.scope));
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
  }

  function download(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  }

  /* ---------- 事件 ---------- */
  function bind() {
    $('btnRegen').addEventListener('click', () => {
      const seed = Number($('seedInput').value) || 641;
      state.data = Data.generate(seed);
      state.cutoff = state.data.cutoff;
      $('cutoffInput').value = state.cutoff;
      state.selectedK = null;
      $('importErrors').hidden = true;
      render();
    });
    $('btnDownloadCsv').addEventListener('click', () => {
      download('补贴申请数据.csv', '\uFEFF' + Data.toCSV(state.data.rows), 'text/csv;charset=utf-8');
    });
    $('fileInput').addEventListener('change', evt => {
      const file = evt.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const res = Data.parseCSV(String(reader.result));
        const errBox = $('importErrors');
        if (!res.rows) {
          errBox.hidden = false;
          errBox.textContent = '导入失败：' + res.errors.join('；');
          return;
        }
        state.data = { rows: res.rows, label: '导入：' + file.name, cutoff: state.cutoff };
        state.selectedK = null;
        if (res.errors.length) {
          errBox.hidden = false;
          errBox.textContent = '部分行被跳过：' + res.errors.slice(0, 5).join('；');
        } else {
          errBox.hidden = true;
        }
        render();
      };
      reader.readAsText(file);
      evt.target.value = '';
    });
    $('cutoffInput').addEventListener('change', () => {
      const v = Number($('cutoffInput').value);
      if (Number.isFinite(v)) {
        state.cutoff = v;
        state.selectedK = null;
        render();
      }
    });
    $('hSlider').addEventListener('input', () => { state.h = Number($('hSlider').value); render(); });
    $('donutSlider').addEventListener('input', () => { state.donut = Number($('donutSlider').value); render(); });
    $('btnSave').addEventListener('click', saveSnapshot);
    $('btnExport').addEventListener('click', () => {
      download('rdd-保存结果.json', JSON.stringify(state.snapshots, null, 2), 'application/json;charset=utf-8');
    });
    $('btnClear').addEventListener('click', () => {
      state.snapshots = [];
      persistSnapshots();
      renderSnapshots();
    });
    $('themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme === 'dark';
      document.documentElement.dataset.theme = cur ? 'light' : 'dark';
      $('themeToggle').textContent = cur ? '深色模式' : '浅色模式';
      render();
    });
  }

  /* ---------- 启动 ---------- */
  loadSnapshots();
  const seed = 641;
  $('seedInput').value = seed;
  state.data = Data.generate(seed);
  state.cutoff = state.data.cutoff;
  $('cutoffInput').value = state.cutoff;
  bind();
  render();
})();
