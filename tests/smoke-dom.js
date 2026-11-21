/*
 * DOM 冒烟测试：用最小 DOM 垫片在 Node 中真实加载并运行
 * core/data/charts/app 四个脚本，驱动主要交互，捕捉运行时错误。
 * 运行：node tests/smoke-dom.js
 */
'use strict';

/* ---------- 最小 DOM 垫片 ---------- */
function makeEl(tag) {
  const el = {
    tagName: tag,
    children: [],
    attrs: {},
    listeners: {},
    style: {},
    dataset: {},
    parentNode: null,
    value: '',
    className: '',
    hidden: false,
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === 'viewBox') {
        const [x, y, w, h] = String(v).split(/\s+/).map(Number);
        this.viewBox = { baseVal: { x, y, width: w, height: h } };
      }
    },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); c.parentNode = this; delete this._text; return c; },
    remove() {},
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    removeEventListener() {},
    click() { (this.listeners.click || []).forEach(f => f({ preventDefault() {} })); },
    setPointerCapture() {},
    releasePointerCapture() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 940, height: 400 }; },
  };
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this._text !== undefined) return this._text;
      return this.children.map(c => c.textContent).join('');
    },
    set(v) { this._text = String(v); this.children.length = 0; },
  });
  return el;
}

const idRegistry = {};
global.window = global;
global.document = {
  createElement: tag => makeEl(tag),
  createElementNS: (ns, tag) => makeEl(tag),
  getElementById: id => idRegistry[id] || (idRegistry[id] = makeEl('div')),
  documentElement: makeEl('html'),
  body: makeEl('body'),
  addEventListener() {},
};
global.innerWidth = 1280;
global.innerHeight = 800;
global.localStorage = {
  _s: {},
  getItem(k) { return k in this._s ? this._s[k] : null; },
  setItem(k, v) { this._s[k] = String(v); },
  removeItem(k) { delete this._s[k]; },
};
global.URL = { createObjectURL: () => 'blob:mock', revokeObjectURL() {} };
global.Blob = class { constructor(parts) { this.parts = parts; } };

function fire(el, type) {
  (el.listeners[type] || []).forEach(f => f({ preventDefault() {}, target: el }));
}
function setAndFire(id, value, type) {
  const el = document.getElementById(id);
  el.value = String(value);
  fire(el, type || 'input');
}

/* ---------- 加载应用脚本（顺序与 index.html 一致） ---------- */
require('../js/core.js');
require('../js/data.js');
require('../js/charts.js');
require('../js/app.js'); // 加载即完成首次渲染

const $ = id => document.getElementById(id);

let passed = 0, failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

function countAll(el) {
  return el.children.reduce((n, c) => n + countAll(c), 1);
}

console.log('\n[首次渲染]');
ok($('estTau').textContent !== '' && $('estTau').textContent !== '—', '默认设置下给出有限效果值：' + $('estTau').textContent);
ok(countAll($('mainChart')) > 100, '主图已绘制（共 ' + countAll($('mainChart')) + ' 个元素）');
ok(countAll($('histChart')) > 30, '直方图已绘制（共 ' + countAll($('histChart')) + ' 个元素）');
ok($('sensChart').children.length > 3, '敏感性图已绘制');
ok($('bucketTable').children.length >= 2, '评分桶表格已填充');
ok($('sharpAlert').hidden === false, '内置数据含执行偏差 → 偏差面板可见');
ok($('sharpExceptions').children.length === 10, '例外明细 10 行');
ok($('interpretation').textContent.includes('ITT'), '存在偏差时使用 ITT 解释，不用严格门槛解释');
ok($('scopeNote').textContent.includes('不能推广到所有申请'), '适用范围声明在页面上');

console.log('\n[交互：调整范围与排除带]');
setAndFire('hSlider', 6);
ok($('hValue').textContent.includes('6'), '拖动范围滑块后读数更新：' + $('hValue').textContent);
setAndFire('donutSlider', 3);
ok($('donutValue').textContent.includes('3'), '排除带读数更新：' + $('donutValue').textContent);
ok($('scopeNote').textContent.includes('排除紧贴门槛'), '排除带写入适用范围说明');
setAndFire('donutSlider', 99); // 应被钳制到 h-0.5
ok(!$('donutValue').textContent.includes('99'), '排除带不能大于等于分析范围（已钳制）');
setAndFire('hSlider', 1); // 应被钳制到 MIN_H=2
ok($('hValue').textContent.includes('2'), '带宽下限钳制到 2 分');

console.log('\n[交互：选桶与明细]');
{
  const tbody = $('bucketTable').children.find(c => c.tagName === 'tbody');
  const row = tbody.children[10];
  fire(row, 'click');
  ok($('drilldownCard').hidden === false, '点击桶后明细面板打开');
  ok($('drillTable').children.length >= 2, '明细表已填充');
  ok($('drillNote').textContent.includes('同分联动'), '明细面板含同分联动核对');
  fire(row, 'click');
  ok($('drilldownCard').hidden === true, '再次点击收起明细');
}

console.log('\n[交互：保存 / 导出 / 清空]');
{
  $('btnSave').click();
  $('btnSave').click();
  ok($('snapTable').textContent.includes('局部估计'), '保存的结果带适用范围声明');
  ok($('snapTable').textContent.includes('±2'), '保存的结果带观察范围');
  $('btnExport').click(); // 不报错即可（Blob/URL 已垫片）
  ok(true, '导出 JSON 不报错');
  $('btnClear').click();
  ok($('snapTable').textContent.includes('还没有保存'), '清空后列表为空');
}

console.log('\n[交互：重新生成 / 换门槛 / 主题]');
{
  setAndFire('seedInput', 42);
  $('btnRegen').click();
  ok($('datasetLabel').textContent.includes('42'), '重新生成后数据标签更新');
  setAndFire('cutoffInput', 55, 'change');
  ok($('scopeNote').textContent.includes('55'), '门槛修改后适用范围同步');
  $('themeToggle').click();
  ok(document.documentElement.dataset.theme === 'dark', '主题切换到深色');
  ok(countAll($('mainChart')) > 100, '深色模式下重绘正常');
  $('themeToggle').click();
}

console.log('\n[主图指针事件]');
{
  const svg = $('mainChart');
  // 悬停（触发最近点 tooltip）
  if (typeof svg.onpointermove === 'function') {
    svg.onpointermove({ clientX: 470, clientY: 200, pointerId: 1, preventDefault() {} });
    ok(true, '悬停不报错');
  }
  // 拖到把手上并拖动（对称调整范围）
  if (typeof svg.onpointerdown === 'function') {
    svg.onpointerdown({ clientX: 470, clientY: 200, pointerId: 1, preventDefault() {} });
    svg.onpointermove({ clientX: 600, clientY: 200, pointerId: 1, preventDefault() {} });
    svg.onpointerup({});
    ok(true, '拖拽调整范围不报错');
  }
}

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败');
process.exit(failed ? 1 : 0);
