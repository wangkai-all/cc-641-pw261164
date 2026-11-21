/*
 * charts.js — SVG 图表渲染：主散点+拟合图、评分桶直方图、带宽敏感性图。
 * 所有图表共享同一套主题色（由 app.js 按明暗模式传入）。
 * 交互：主图可拖动范围把手、点位悬停提示；直方图点击选桶；敏感性图十字线。
 */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const W = 940;                 // 主图 / 直方图共享 viewBox 宽度（保证 x 轴对齐）
  const M = { t: 26, r: 24, b: 40, l: 56 };  // 共享边距
  const H_MAIN = 400;
  const H_HIST = 190;
  const SENS_W = 460, SENS_H = 280;
  const SENS_M = { t: 20, r: 16, b: 36, l: 52 };

  function el(name, attrs, parent) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k of Object.keys(attrs)) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function scale(d0, d1, r0, r1) {
    return x => r0 + (x - d0) * (r1 - r0) / (d1 - d0);
  }

  function niceTicks(min, max, count) {
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = mag * 10;
    for (const m of [1, 2, 2.5, 5, 10]) { if (mag * m >= raw) { step = mag * m; break; } }
    const ticks = [];
    for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-6; t += step) {
      ticks.push(Math.round(t / step) * step);
    }
    return ticks;
  }

  function svgPoint(svg, evt) {
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    return {
      x: vb.x + (evt.clientX - rect.left) * (vb.width / rect.width),
      y: vb.y + (evt.clientY - rect.top) * (vb.height / rect.height),
    };
  }

  /* 共享悬停提示：全部用 textContent 写入（数据不可信，不拼 HTML） */
  const tooltip = (function () {
    const box = document.createElement('div');
    box.className = 'chart-tooltip';
    box.hidden = true;
    document.body.appendChild(box);
    function show(clientX, clientY, rows) {
      box.textContent = '';
      for (const r of rows) {
        const div = document.createElement('div');
        div.className = 'tt-row';
        if (r.swatch) {
          const s = document.createElement('span');
          s.className = 'tt-swatch';
          s.style.background = r.swatch;
          div.appendChild(s);
        }
        const v = document.createElement('strong');
        v.textContent = r.value;
        div.appendChild(v);
        const l = document.createElement('span');
        l.textContent = '　' + r.label;
        div.appendChild(l);
        box.appendChild(div);
      }
      box.hidden = false;
      const w = box.offsetWidth, hgt = box.offsetHeight;
      let x = clientX + 14, y = clientY + 14;
      if (x + w > window.innerWidth - 8) x = clientX - w - 14;
      if (y + hgt > window.innerHeight - 8) y = clientY - hgt - 14;
      box.style.left = x + 'px';
      box.style.top = y + 'px';
    }
    function hide() { box.hidden = true; }
    return { show: show, hide: hide };
  })();

  function fmtTick(v) {
    return Math.abs(v) >= 1000 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  }

  /* 顶部圆角、底部贴基线的柱形路径 */
  function barPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return 'M' + x + ',' + (y + h) +
      ' L' + x + ',' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      ' L' + (x + w - r) + ',' + y + ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      ' L' + (x + w) + ',' + (y + h) + ' Z';
  }

  /* 分析范围 / 排除带的背景分区（主图与直方图共用） */
  function drawRegions(g, x, cutoff, h, donut, xDom, plotTop, plotBottom, theme) {
    const xL = x(cutoff - h), xR = x(cutoff + h);
    const plotL = x(xDom[0]), plotR = x(xDom[1]);
    if (xL > plotL) {
      el('rect', { x: plotL, y: plotTop, width: xL - plotL, height: plotBottom - plotTop, fill: theme.regionOutside }, g);
    }
    if (xR < plotR) {
      el('rect', { x: xR, y: plotTop, width: plotR - xR, height: plotBottom - plotTop, fill: theme.regionOutside }, g);
    }
    if (donut > 0) {
      el('rect', {
        x: x(cutoff - donut), y: plotTop,
        width: x(cutoff + donut) - x(cutoff - donut), height: plotBottom - plotTop,
        fill: theme.regionDonut,
      }, g);
    }
  }

  function drawWindowLines(g, x, cutoff, h, donut, plotTop, plotBottom, theme) {
    for (const s of [-1, 1]) {
      el('line', {
        x1: x(cutoff + s * h), y1: plotTop, x2: x(cutoff + s * h), y2: plotBottom,
        stroke: theme.windowLine, 'stroke-width': 1,
      }, g);
      if (donut > 0) {
        el('line', {
          x1: x(cutoff + s * donut), y1: plotTop, x2: x(cutoff + s * donut), y2: plotBottom,
          stroke: theme.donutLine, 'stroke-width': 1,
        }, g);
      }
    }
  }

  /* ---------- 主图：散点 + 两侧局部线性拟合 ---------- */
  function renderMain(svg, opts) {
    const theme = opts.theme;
    const xDom = opts.xDom, yDom = opts.yDom;
    const cutoff = opts.cutoff, h = opts.h, donut = opts.donut;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H_MAIN);
    svg.textContent = '';
    const plotTop = M.t, plotBottom = H_MAIN - M.b;
    const x = scale(xDom[0], xDom[1], M.l, W - M.r);
    const y = scale(yDom[0], yDom[1], plotBottom, plotTop);
    const xInv = px => xDom[0] + (px - M.l) * (xDom[1] - xDom[0]) / (W - M.r - M.l);

    // 背景分区与网格
    const gRegions = el('g', null, svg);
    drawRegions(gRegions, x, cutoff, h, donut, xDom, plotTop, plotBottom, theme);
    const gGrid = el('g', null, svg);
    for (const t of niceTicks(yDom[0], yDom[1], 5)) {
      el('line', { x1: M.l, y1: y(t), x2: W - M.r, y2: y(t), stroke: theme.grid, 'stroke-width': 1 }, gGrid);
      const label = el('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, gGrid);
      label.textContent = fmtTick(t);
    }
    for (let t = Math.ceil(xDom[0] / 5) * 5; t <= xDom[1]; t += 5) {
      const label = el('text', { x: x(t), y: plotBottom + 18, 'text-anchor': 'middle', class: 'tick' }, gGrid);
      label.textContent = String(t);
    }
    el('line', { x1: M.l, y1: plotBottom, x2: W - M.r, y2: plotBottom, stroke: theme.baseline, 'stroke-width': 1 }, gGrid);

    // 轴标题
    const xt = el('text', { x: (M.l + W - M.r) / 2, y: H_MAIN - 6, 'text-anchor': 'middle', class: 'axis-title' }, gGrid);
    xt.textContent = '原始评分';
    const yt = el('text', { x: M.l - 44, y: plotTop - 10, 'text-anchor': 'start', class: 'axis-title' }, gGrid);
    yt.textContent = '后续产出（万元）';

    // 范围边界线 / 排除带边界线
    const gWin = el('g', null, svg);
    drawWindowLines(gWin, x, cutoff, h, donut, plotTop, plotBottom, theme);

    // 门槛线
    el('line', { x1: x(cutoff), y1: plotTop, x2: x(cutoff), y2: plotBottom, stroke: theme.cutoffLine, 'stroke-width': 1.5 }, gWin);
    const cutLabel = el('text', { x: x(cutoff) + 5, y: plotTop + 12, class: 'cutoff-label' }, gWin);
    cutLabel.textContent = '门槛 ' + cutoff;

    // 散点：先画排除的（底层），再画保留的
    const gPts = el('g', null, svg);
    const exSet = opts.exceptionRows || new Set();
    function drawPoint(f) {
      const cx = x(f.row.score), cy = y(f.row.outcome);
      const isEx = exSet.has(f.row);
      if (isEx) {
        el('circle', { cx: cx, cy: cy, r: 6.5, fill: 'none', stroke: theme.critical, 'stroke-width': 1.5 }, gPts);
      }
      el('circle', {
        cx: cx, cy: cy, r: 4,
        fill: f.included ? (f.side === 'L' ? theme.s1 : theme.s2) : theme.excluded,
        'fill-opacity': f.included ? 0.85 : 0.45,
        stroke: theme.surface, 'stroke-width': 2,
      }, gPts);
    }
    for (const f of opts.filtered) if (!f.included) drawPoint(f);
    for (const f of opts.filtered) if (f.included) drawPoint(f);

    // 两侧拟合线 + 门槛处端点
    const est = opts.estimate;
    if (est && est.ok) {
      const gFit = el('g', null, svg);
      const xL0 = Math.max(cutoff - h, xDom[0]), xR1 = Math.min(cutoff + h, xDom[1]);
      el('line', {
        x1: x(xL0), y1: y(est.fitL.intercept + est.fitL.slope * (xL0 - cutoff)),
        x2: x(cutoff), y2: y(est.fitL.intercept),
        stroke: theme.s1, 'stroke-width': 2, 'stroke-linecap': 'round',
      }, gFit);
      el('line', {
        x1: x(cutoff), y1: y(est.fitR.intercept),
        x2: x(xR1), y2: y(est.fitR.intercept + est.fitR.slope * (xR1 - cutoff)),
        stroke: theme.s2, 'stroke-width': 2, 'stroke-linecap': 'round',
      }, gFit);
      for (const side of ['fitL', 'fitR']) {
        el('circle', {
          cx: x(cutoff), cy: y(est[side].intercept), r: 4,
          fill: side === 'fitL' ? theme.s1 : theme.s2,
          stroke: theme.surface, 'stroke-width': 2,
        }, gFit);
      }
    }

    // 范围把手（左右联动，拖动任意一个即对称调整两侧）
    const gHandles = el('g', null, svg);
    for (const s of [-1, 1]) {
      const hx = x(cutoff + s * h);
      el('rect', {
        x: hx - 4, y: plotBottom - 10, width: 8, height: 20, rx: 4,
        fill: theme.handle, class: 'range-handle',
      }, gHandles);
    }

    // 悬停高亮圈（默认隐藏）
    const hoverRing = el('circle', { r: 7, fill: 'none', stroke: theme.ink, 'stroke-width': 1.5, visibility: 'hidden' }, svg);

    // —— 交互：拖把手调范围（对称）；悬停看明细 ——
    let dragging = false;
    function dragTo(evt) {
      const p = svgPoint(svg, evt);
      const newH = Math.abs(xInv(p.x) - cutoff);
      const snapped = Math.round(newH * 2) / 2;
      opts.onDragH(Math.min(Math.max(snapped, opts.minH), opts.maxH));
    }
    svg.onpointerdown = function (evt) {
      const p = svgPoint(svg, evt);
      const nearHandle = Math.abs(Math.abs(xInv(p.x) - cutoff) - h) * (W - M.l - M.r) / (xDom[1] - xDom[0]) < 14;
      if (nearHandle && p.y > plotTop && p.y < plotBottom + 24) {
        dragging = true;
        svg.setPointerCapture(evt.pointerId);
        dragTo(evt);
        evt.preventDefault();
      }
    };
    svg.onpointermove = function (evt) {
      if (dragging) { dragTo(evt); return; }
      const p = svgPoint(svg, evt);
      if (p.x < M.l || p.x > W - M.r || p.y < plotTop || p.y > plotBottom) {
        hoverRing.setAttribute('visibility', 'hidden');
        tooltip.hide();
        return;
      }
      // 最近点（24 视图单位内）
      let best = null, bestD = 24;
      for (const f of opts.filtered) {
        const dx = x(f.row.score) - p.x, dy = y(f.row.outcome) - p.y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < bestD) { bestD = d; best = f; }
      }
      if (!best) {
        hoverRing.setAttribute('visibility', 'hidden');
        tooltip.hide();
        return;
      }
      hoverRing.setAttribute('cx', x(best.row.score));
      hoverRing.setAttribute('cy', y(best.row.outcome));
      hoverRing.setAttribute('visibility', 'visible');
      const r = best.row;
      tooltip.show(evt.clientX, evt.clientY, [
        { value: String(r.outcome), label: '后续产出（万元）' },
        { value: String(r.score), label: '原始评分' },
        { value: r.treated ? '是' : '否', label: '获补贴' },
        { value: r.years == null ? '—' : String(r.years), label: '成立年限' },
        { value: r.employees == null ? '—' : String(r.employees), label: '员工数' },
        { value: r.industry || '—', label: '行业' },
        { value: best.included ? '保留（权重 ' + best.weight.toFixed(3) + '）' : (best.reason === 'donut' ? '已排除：紧贴门槛' : '已排除：超出范围'), label: '当前状态' },
      ]);
    };
    svg.onpointerleave = function () {
      hoverRing.setAttribute('visibility', 'hidden');
      tooltip.hide();
    };
    svg.onpointerup = function () { dragging = false; };
  }

  /* ---------- 直方图：评分桶人数，点击选桶 ---------- */
  function renderHistogram(svg, opts) {
    const theme = opts.theme;
    const xDom = opts.xDom, cutoff = opts.cutoff;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H_HIST);
    svg.textContent = '';
    const plotTop = 14, plotBottom = H_HIST - 30;
    const x = scale(xDom[0], xDom[1], M.l, W - M.r);
    const maxCount = Math.max(1, ...opts.buckets.map(b => b.count));
    const y = scale(0, maxCount * 1.12, plotBottom, plotTop);

    const gRegions = el('g', null, svg);
    drawRegions(gRegions, x, cutoff, opts.h, opts.donut, xDom, plotTop, plotBottom, theme);
    const gGrid = el('g', null, svg);
    for (const t of niceTicks(0, maxCount, 3)) {
      el('line', { x1: M.l, y1: y(t), x2: W - M.r, y2: y(t), stroke: theme.grid, 'stroke-width': 1 }, gGrid);
      const label = el('text', { x: M.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, gGrid);
      label.textContent = String(t);
    }
    for (let t = Math.ceil(xDom[0] / 5) * 5; t <= xDom[1]; t += 5) {
      const label = el('text', { x: x(t), y: plotBottom + 16, 'text-anchor': 'middle', class: 'tick' }, gGrid);
      label.textContent = String(t);
    }
    el('line', { x1: M.l, y1: plotBottom, x2: W - M.r, y2: plotBottom, stroke: theme.baseline, 'stroke-width': 1 }, gGrid);
    const yt = el('text', { x: M.l - 44, y: plotTop - 2, 'text-anchor': 'start', class: 'axis-title' }, gGrid);
    yt.textContent = '人数';
    drawWindowLines(el('g', null, svg), x, cutoff, opts.h, opts.donut, plotTop, plotBottom, theme);
    el('line', { x1: x(cutoff), y1: plotTop, x2: x(cutoff), y2: plotBottom, stroke: theme.cutoffLine, 'stroke-width': 1.5 }, gGrid);

    const gBars = el('g', null, svg);
    const bw = opts.bucketWidth;
    for (const b of opts.buckets) {
      const slotX = x(b.lo), slotW = x(b.hi) - x(b.lo);
      const barW = Math.max(1, Math.min(24, slotW - 2)); // 柱宽上限 24px，2px 表面间隔，下限 1px
      const bx = slotX + (slotW - barW) / 2;
      const included = (opts.includedByBucket.get(b.k) || 0) > 0;
      const selected = opts.selectedK === b.k;
      const rect = el('path', {
        d: barPath(bx, y(b.count), barW, plotBottom - y(b.count), 4),
        fill: included ? theme.s1 : theme.excluded,
        'fill-opacity': selected ? 1 : (opts.selectedK == null ? 0.9 : 0.45),
        class: 'bucket-bar',
        tabindex: '0',
        role: 'button',
        'aria-label': '评分 ' + b.lo + ' 到 ' + b.hi + '，' + b.count + ' 人',
      }, gBars);
      rect.addEventListener('click', () => opts.onSelect(b.k));
      rect.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opts.onSelect(b.k); } });
      rect.addEventListener('pointermove', e => {
        tooltip.show(e.clientX, e.clientY, [
          { value: String(b.count), label: '人数（评分 ' + b.lo + '–' + b.hi + '）' },
          { value: b.treatedShare == null ? '—' : (b.treatedShare * 100).toFixed(0) + '%', label: '获补贴比例' },
          { value: b.meanYears == null ? '—' : b.meanYears.toFixed(1), label: '平均成立年限' },
          { value: b.meanEmployees == null ? '—' : b.meanEmployees.toFixed(0), label: '平均员工数' },
          { value: b.meanOutcome == null ? '—' : b.meanOutcome.toFixed(1), label: '平均后续产出' },
        ]);
      });
      rect.addEventListener('pointerleave', () => tooltip.hide());
      if (opts.flaggedKs && opts.flaggedKs.has(b.k)) {
        const warn = el('text', { x: slotX + slotW / 2, y: y(b.count) - 6, 'text-anchor': 'middle', class: 'bucket-flag' }, gBars);
        warn.textContent = '⚠';
      }
    }
    svg.onpointerdown = null;
    svg.onpointermove = null;
    svg.onpointerleave = null;
  }

  /* ---------- 敏感性：差距随分析范围变化 ---------- */
  function renderSensitivity(svg, opts) {
    const theme = opts.theme;
    svg.setAttribute('viewBox', '0 0 ' + SENS_W + ' ' + SENS_H);
    svg.textContent = '';
    const pts = opts.points;
    const valid = pts.filter(p => p.ok);
    const plotTop = SENS_M.t, plotBottom = SENS_H - SENS_M.b;
    const hMin = pts.length ? pts[0].h : 0;
    let hMax = pts.length ? pts[pts.length - 1].h : 1;
    if (!(hMax > hMin)) hMax = hMin + 1; // 退化数据兜底，避免零宽坐标
    const x = scale(hMin, hMax, SENS_M.l, SENS_W - SENS_M.r);

    if (!valid.length) {
      const t = el('text', { x: SENS_W / 2, y: SENS_H / 2, 'text-anchor': 'middle', class: 'axis-title' }, svg);
      t.textContent = '当前排除带设置下，所有范围均无法给出有效估计';
      return;
    }
    let yMin = Infinity, yMax = -Infinity;
    for (const p of valid) { yMin = Math.min(yMin, p.lo); yMax = Math.max(yMax, p.hi); }
    const pad = (yMax - yMin) * 0.12 || 1;
    yMin -= pad; yMax += pad;
    const y = scale(yMin, yMax, plotBottom, plotTop);

    const gGrid = el('g', null, svg);
    for (const t of niceTicks(yMin, yMax, 4)) {
      el('line', { x1: SENS_M.l, y1: y(t), x2: SENS_W - SENS_M.r, y2: y(t), stroke: theme.grid, 'stroke-width': 1 }, gGrid);
      const label = el('text', { x: SENS_M.l - 8, y: y(t) + 4, 'text-anchor': 'end', class: 'tick' }, gGrid);
      label.textContent = fmtTick(t);
    }
    for (const t of niceTicks(hMin, hMax, 6)) {
      const label = el('text', { x: x(t), y: plotBottom + 16, 'text-anchor': 'middle', class: 'tick' }, gGrid);
      label.textContent = fmtTick(t);
    }
    el('line', { x1: SENS_M.l, y1: plotBottom, x2: SENS_W - SENS_M.r, y2: plotBottom, stroke: theme.baseline, 'stroke-width': 1 }, gGrid);
    const xt = el('text', { x: (SENS_M.l + SENS_W - SENS_M.r) / 2, y: SENS_H - 4, 'text-anchor': 'middle', class: 'axis-title' }, gGrid);
    xt.textContent = '分析范围 ±h（分）';
    const yt = el('text', { x: SENS_M.l - 40, y: plotTop - 8, 'text-anchor': 'start', class: 'axis-title' }, gGrid);
    yt.textContent = '两侧差距';

    // 连续有效段：置信带 + 估计线（无效处断开）
    const gLine = el('g', null, svg);
    let seg = [];
    function flush() {
      if (seg.length >= 2) {
        const area = seg.map(p => x(p.h) + ',' + y(p.hi)).join(' L') +
          ' L' + seg.slice().reverse().map(p => x(p.h) + ',' + y(p.lo)).join(' L') + ' Z';
        el('path', { d: 'M' + area, fill: theme.s1, 'fill-opacity': 0.1, stroke: 'none' }, gLine);
        el('path', {
          d: 'M' + seg.map(p => x(p.h) + ',' + y(p.tau)).join(' L'),
          fill: 'none', stroke: theme.s1, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        }, gLine);
      }
      seg = [];
    }
    for (const p of pts) {
      if (p.ok) seg.push(p);
      else flush();
    }
    flush();

    // 当前范围标记
    el('line', {
      x1: x(opts.currentH), y1: plotTop, x2: x(opts.currentH), y2: plotBottom,
      stroke: theme.ink, 'stroke-width': 1,
    }, gLine);
    const cur = valid.reduce((a, p) => (Math.abs(p.h - opts.currentH) < Math.abs(a.h - opts.currentH) ? p : a), valid[0]);
    if (cur && Math.abs(cur.h - opts.currentH) < (hMax - hMin) / 40) {
      el('circle', { cx: x(cur.h), cy: y(cur.tau), r: 4, fill: theme.s1, stroke: theme.surface, 'stroke-width': 2 }, gLine);
    }

    // 十字线悬停
    const cross = el('line', { y1: plotTop, y2: plotBottom, stroke: theme.ink, 'stroke-width': 0.5, visibility: 'hidden' }, svg);
    const dot = el('circle', { r: 4, fill: theme.s1, stroke: theme.surface, 'stroke-width': 2, visibility: 'hidden' }, svg);
    svg.onpointermove = function (evt) {
      const p = svgPoint(svg, evt);
      if (p.x < SENS_M.l || p.x > SENS_W - SENS_M.r || p.y < plotTop || p.y > plotBottom) {
        cross.setAttribute('visibility', 'hidden');
        dot.setAttribute('visibility', 'hidden');
        tooltip.hide();
        return;
      }
      const hHover = hMin + (p.x - SENS_M.l) * (hMax - hMin) / (SENS_W - SENS_M.r - SENS_M.l);
      let best = null, bestD = Infinity;
      for (const q of pts) {
        const d = Math.abs(q.h - hHover);
        if (d < bestD) { bestD = d; best = q; }
      }
      cross.setAttribute('x1', x(best.h)); cross.setAttribute('x2', x(best.h));
      cross.setAttribute('visibility', 'visible');
      if (best.ok) {
        dot.setAttribute('cx', x(best.h)); dot.setAttribute('cy', y(best.tau));
        dot.setAttribute('visibility', 'visible');
        tooltip.show(evt.clientX, evt.clientY, [
          { value: best.tau.toFixed(1), label: '两侧差距（±' + best.h.toFixed(1) + ' 分）' },
          { value: best.lo.toFixed(1) + ' ~ ' + best.hi.toFixed(1), label: '95% 置信区间' },
        ]);
      } else {
        dot.setAttribute('visibility', 'hidden');
        tooltip.show(evt.clientX, evt.clientY, [
          { value: '—', label: '±' + best.h.toFixed(1) + ' 分：无有效估计' },
        ]);
      }
    };
    svg.onpointerleave = function () {
      cross.setAttribute('visibility', 'hidden');
      dot.setAttribute('visibility', 'hidden');
      tooltip.hide();
    };
    svg.onpointerdown = null;
  }

  global.RDDCharts = {
    renderMain: renderMain,
    renderHistogram: renderHistogram,
    renderSensitivity: renderSensitivity,
    tooltip: tooltip,
  };
})(window);
