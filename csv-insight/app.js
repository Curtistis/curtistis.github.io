/* CSV 数据洞察看板 —— 纯前端：解析 → 字段画像 → 筛选 → 图表 / 分组聚合 → 导出 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const PALETTE = ["#5b7cff", "#22c493", "#ffb547", "#ff6b81", "#a35cff", "#2ec7e6", "#ff8f4d", "#7d8db5"];
  const AXIS = dark ? "#2a3246" : "#e9ecf4", LABEL = dark ? "#8f98ab" : "#7a8399";
  // 竖向 / 横向渐变
  const grad = (top, bottom, horizontal = false) =>
    new echarts.graphic.LinearGradient(0, horizontal ? 0 : 0, horizontal ? 1 : 0, horizontal ? 0 : 1,
      [{ offset: 0, color: top }, { offset: 1, color: bottom }]);
  const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, "0");

  const state = { name: "", rows: [], cols: [], meta: {}, view: [], charts: {} };

  // ---------------------------------------------------------------- 解析与类型推断
  const NUM_RE = /^[-+]?(\d{1,3}(,\d{3})+|\d+)?(\.\d+)?([eE][-+]?\d+)?%?$/;
  const DATE_RE = /^\d{4}[-/.]\d{1,2}([-/.]\d{1,2})?([ T]\d{1,2}:\d{2}(:\d{2})?)?$/;

  const isEmpty = (v) => v === null || v === undefined || String(v).trim() === "";
  function toNumber(v) {
    if (typeof v === "number") return v;
    const s = String(v).trim();
    if (!NUM_RE.test(s) || s === "" || s === "." ) return NaN;
    const n = parseFloat(s.replace(/,/g, "").replace(/%$/, ""));
    return s.endsWith("%") ? n / 100 : n;
  }
  function toDate(v) {
    const s = String(v).trim();
    if (!DATE_RE.test(s)) return null;
    const t = Date.parse(s.replace(/\//g, "-").replace(/\./g, "-"));
    return Number.isNaN(t) ? null : t;
  }

  function inferType(values) {
    const filled = values.filter((v) => !isEmpty(v));
    if (!filled.length) return "category";
    const sample = filled.length > 2000 ? filled.filter((_, i) => i % Math.ceil(filled.length / 2000) === 0) : filled;
    const ratio = (fn) => sample.filter(fn).length / sample.length;
    if (ratio((v) => toDate(v) !== null) >= 0.9) return "date";
    if (ratio((v) => !Number.isNaN(toNumber(v))) >= 0.9) return "number";
    return "category";
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  function profile(rows, cols) {
    const meta = {};
    for (const c of cols) {
      const raw = rows.map((r) => r[c]);
      const type = inferType(raw);
      const missing = raw.filter(isEmpty).length;
      const m = { type, missing, unique: new Set(raw.filter((v) => !isEmpty(v))).size };
      if (type === "number") {
        const nums = raw.map(toNumber).filter(Number.isFinite).sort((a, b) => a - b);
        const mean = nums.reduce((a, b) => a + b, 0) / (nums.length || 1);
        const sd = Math.sqrt(nums.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, nums.length - 1));
        Object.assign(m, {
          mean, sd, min: nums[0], max: nums[nums.length - 1],
          q1: quantile(nums, 0.25), median: quantile(nums, 0.5), q3: quantile(nums, 0.75),
          hist: histogram(nums, 12).counts,
        });
      } else if (type === "date") {
        const ts = raw.map(toDate).filter((t) => t !== null).sort((a, b) => a - b);
        Object.assign(m, { min: ts[0], max: ts[ts.length - 1] });
      } else {
        m.top = topCounts(raw, 5);
      }
      meta[c] = m;
    }
    return meta;
  }

  // ---------------------------------------------------------------- 统计工具
  function histogram(nums, bins) {
    if (!nums.length) return { edges: [], counts: [] };
    const min = nums[0], max = nums[nums.length - 1];
    const k = bins || Math.max(5, Math.min(40, Math.ceil(Math.log2(nums.length) + 1)));
    const width = (max - min) / k || 1;
    const counts = new Array(k).fill(0);
    for (const v of nums) counts[Math.min(k - 1, Math.floor((v - min) / width))]++;
    const edges = counts.map((_, i) => min + i * width);
    return { edges, counts, width };
  }
  function topCounts(values, n) {
    const map = new Map();
    for (const v of values) if (!isEmpty(v)) map.set(String(v), (map.get(String(v)) || 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
  }
  function pearson(xs, ys) {
    let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i], y = ys[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
    return n > 2 && den ? (n * sxy - sx * sy) / den : NaN;
  }
  const AGG = {
    sum: (a) => a.reduce((s, v) => s + v, 0),
    mean: (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN),
    count: (a) => a.length,
    max: (a) => (a.length ? Math.max(...a) : NaN),
    min: (a) => (a.length ? Math.min(...a) : NaN),
  };
  const fmt = (v, d = 2) => {
    if (v === undefined || v === null || Number.isNaN(v)) return "—";
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(d) + "M";
    if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + "k";
    return Number.isInteger(v) ? String(v) : v.toFixed(d);
  };
  const fmtDate = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "—");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------------------------------------------------------------- 筛选表达式
  // 语法：  列 运算符 值  [and|且|&&  列 运算符 值 ...]   运算符：= != > >= < <= ~(包含)
  function compileFilter(text) {
    const src = text.trim();
    if (!src) return () => true;
    const parts = src.split(/\s+(?:and|且)\s+|\s*&&\s*/i);
    const preds = parts.map((p) => {
      const m = p.match(/^\s*(.+?)\s*(>=|<=|!=|=|>|<|~)\s*(.+?)\s*$/);
      if (!m) throw new Error(`无法解析条件：${p}`);
      const [, col, op, rawVal] = m;
      if (!state.cols.includes(col)) throw new Error(`没有这一列：${col}`);
      const type = state.meta[col].type;
      const val = rawVal.replace(/^["']|["']$/g, "");
      const conv = type === "number" ? toNumber : type === "date" ? toDate : (v) => String(v);
      const target = conv(val);
      if (op === "~") return (r) => String(r[col] ?? "").toLowerCase().includes(val.toLowerCase());
      return (r) => {
        const x = conv(r[col] ?? "");
        switch (op) {
          case "=": return x === target;
          case "!=": return x !== target;
          case ">": return x > target;
          case ">=": return x >= target;
          case "<": return x < target;
          case "<=": return x <= target;
        }
        return true;
      };
    });
    return (r) => preds.every((f) => f(r));
  }

  // ---------------------------------------------------------------- 渲染
  function chart(id) {
    if (!state.charts[id]) state.charts[id] = echarts.init($(id), dark ? "dark" : null, { renderer: "canvas" });
    return state.charts[id];
  }
  const axisStyle = {
    axisLine: { lineStyle: { color: AXIS } }, axisTick: { show: false },
    axisLabel: { color: LABEL }, splitLine: { lineStyle: { color: AXIS, type: "dashed" } }, nameTextStyle: { color: LABEL },
  };
  const base = () => ({
    backgroundColor: "transparent",
    color: PALETTE,
    textStyle: { fontFamily: "Inter, 'Noto Sans SC', 'Microsoft YaHei', sans-serif" },
    grid: { left: 50, right: 20, top: 34, bottom: 40, containLabel: true },
    tooltip: {
      trigger: "axis", backgroundColor: dark ? "rgba(22,28,40,.95)" : "rgba(255,255,255,.97)", borderWidth: 0,
      textStyle: { color: dark ? "#e8ebf3" : "#1b2236" }, extraCssText: "box-shadow:0 8px 24px rgba(20,30,70,.18);border-radius:10px;padding:10px 12px;",
      axisPointer: { type: "line", lineStyle: { color: alpha("#5b7cff", 0.5) } },
    },
    toolbox: { right: 4, top: 0, iconStyle: { borderColor: LABEL }, feature: { saveAsImage: { title: "导出 PNG", pixelRatio: 2 } } },
    animationDuration: 700, animationEasing: "cubicOut",
  });
  const xA = (o) => ({ ...axisStyle, ...o, splitLine: { show: false, ...(o.splitLine || {}) } });
  const yA = (o) => ({ ...axisStyle, ...o });
  const colsOf = (type) => state.cols.filter((c) => state.meta[c].type === type);
  function fillSelect(id, options, preferred) {
    const el = $(id), keep = el.value;
    el.innerHTML = options.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("");
    if (options.includes(keep)) el.value = keep;
    else if (preferred !== undefined && options[preferred]) el.value = options[preferred];
    el.disabled = !options.length;
  }

  function sparkline(counts) {
    if (!counts || !counts.length) return "";
    const max = Math.max(...counts), w = 120, h = 28, bw = w / counts.length;
    return `<svg class="spark" viewBox="0 0 ${w} ${h}">${counts.map((c, i) => {
      const bh = max ? (c / max) * (h - 2) : 0;
      return `<rect x="${i * bw + 1}" y="${h - bh}" width="${bw - 2}" height="${bh}" rx="1" fill="${PALETTE[0]}" opacity=".75"/>`;
    }).join("")}</svg>`;
  }

  function renderKpis() {
    const cells = state.rows.length * state.cols.length;
    const missing = state.cols.reduce((s, c) => s + state.meta[c].missing, 0);
    const share = state.rows.length ? ((state.view.length / state.rows.length) * 100).toFixed(1) + "%" : "—";
    const items = [
      ["数据集", esc(state.name), "🗂", "#5b7cff"],
      ["总行数", state.rows.length.toLocaleString(), "≡", "#a35cff"],
      [`当前筛选 · 占 ${share}`, state.view.length.toLocaleString(), "⚲", "#22c493"],
      ["字段数", state.cols.length, "▦", "#2ec7e6"],
      ["数值 / 日期 / 类别", `${colsOf("number").length} / ${colsOf("date").length} / ${colsOf("category").length}`, "◔", "#ffb547"],
      ["缺失单元格", cells ? ((missing / cells) * 100).toFixed(2) + "%" : "—", "⚠", "#ff6b81"],
    ];
    $("kpis").innerHTML = items.map(([l, v, icon, color], i) =>
      `<div class="kpi" style="--c:${color}"><div class="icon">${icon}</div><div class="body"><div class="label">${l}</div>
       <div class="value${i === 0 ? " small" : ""}" title="${esc(String(v).replace(/<[^>]+>/g, ""))}">${v}</div></div></div>`).join("");
  }

  function renderSchema() {
    const n = state.rows.length || 1;
    const head = "<tr><th>字段</th><th>类型</th><th>缺失</th><th>唯一值</th><th>分布 / Top 值</th><th>均值</th><th>标准差</th><th>最小</th><th>中位数</th><th>最大</th></tr>";
    const body = state.cols.map((c) => {
      const m = state.meta[c], pct = (m.missing / n) * 100;
      const label = { number: "数值", date: "日期", category: "类别" }[m.type];
      const dist = m.type === "number" ? sparkline(m.hist)
        : m.type === "date" ? `${fmtDate(m.min)} → ${fmtDate(m.max)}`
        : (m.top || []).map(([v, k]) => `${esc(v)} <span class="muted">${k}</span>`).join("、");
      const num = m.type === "number";
      return `<tr><td><strong>${esc(c)}</strong></td><td><span class="tag ${m.type}">${label}</span></td>
        <td><span class="bar"><i style="width:${Math.min(100, pct)}%"></i></span> ${pct.toFixed(1)}%</td>
        <td>${m.unique.toLocaleString()}</td><td>${dist}</td>
        <td>${num ? fmt(m.mean) : ""}</td><td>${num ? fmt(m.sd) : ""}</td>
        <td>${num ? fmt(m.min) : ""}</td><td>${num ? fmt(m.median) : ""}</td><td>${num ? fmt(m.max) : ""}</td></tr>`;
    }).join("");
    $("schema-table").innerHTML = head + body;
  }

  function renderHist() {
    const c = $("hist-col").value;
    if (!c) return chart("chart-hist").clear();
    const nums = state.view.map((r) => toNumber(r[c])).filter(Number.isFinite).sort((a, b) => a - b);
    const h = histogram(nums);
    const opt = base();
    Object.assign(opt, {
      tooltip: { trigger: "axis", formatter: (p) => `${fmt(h.edges[p[0].dataIndex])} ~ ${fmt(h.edges[p[0].dataIndex] + h.width)}<br/>频数：${p[0].value}` },
      xAxis: xA({ type: "category", data: h.edges.map((e) => fmt(e)), axisLabel: { hideOverlap: true, color: LABEL } }),
      yAxis: yA({ type: "value", name: "频数" }),
      series: [{
        type: "bar", data: h.counts, barCategoryGap: "12%",
        itemStyle: { borderRadius: [6, 6, 0, 0], color: grad("#7f97ff", alpha("#5b7cff", 0.35)) },
        emphasis: { itemStyle: { color: grad("#a35cff", "#5b7cff") } },
        markLine: { symbol: "none", silent: true, lineStyle: { color: "#ff6b81", type: "dashed" },
          label: { formatter: "中位数", color: "#ff6b81" },
          data: [{ xAxis: Math.max(0, h.edges.findIndex((e) => e + h.width > quantile(nums, 0.5))) }] },
      }],
    });
    chart("chart-hist").setOption(opt, true);
  }

  function renderCategory() {
    const c = $("cat-col").value;
    if (!c) return chart("chart-cat").clear();
    const top = topCounts(state.view.map((r) => r[c]), 10).reverse();
    const opt = base();
    Object.assign(opt, {
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      grid: { left: 10, right: 40, top: 24, bottom: 10, containLabel: true },
      xAxis: yA({ type: "value" }),
      yAxis: xA({ type: "category", data: top.map((t) => t[0]), axisLabel: { color: LABEL, fontWeight: 600 } }),
      series: [{
        type: "bar", barWidth: "58%",
        data: top.map((t, i) => ({ value: t[1], itemStyle: { color: grad(alpha("#22c493", 0.45), i >= top.length - 3 ? "#13b07f" : "#22c493", true) } })),
        itemStyle: { borderRadius: [0, 8, 8, 0] },
        showBackground: true, backgroundStyle: { color: dark ? "rgba(255,255,255,.03)" : "rgba(30,40,80,.035)", borderRadius: [0, 8, 8, 0] },
        label: { show: true, position: "right", color: LABEL, fontWeight: 600 },
      }],
    });
    chart("chart-cat").setOption(opt, true);
  }

  function renderTrend() {
    const dc = $("trend-date").value, vc = $("trend-val").value, agg = $("trend-agg").value;
    if (!dc) return chart("chart-trend").clear();
    const pts = state.view.map((r) => [toDate(r[dc]), toNumber(r[vc])]).filter((p) => p[0] !== null);
    if (!pts.length) return chart("chart-trend").clear();
    const span = (Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))) / 86400000;
    const keyOf = span > 400 ? (t) => new Date(t).toISOString().slice(0, 7) : (t) => new Date(t).toISOString().slice(0, 10);
    const groups = new Map();
    for (const [t, v] of pts) {
      const k = keyOf(t);
      if (!groups.has(k)) groups.set(k, []);
      if (agg === "count" || Number.isFinite(v)) groups.get(k).push(Number.isFinite(v) ? v : 0);
    }
    const keys = [...groups.keys()].sort();
    const vals = keys.map((k) => AGG[agg](groups.get(k)));
    const opt = base();
    Object.assign(opt, {
      xAxis: xA({ type: "category", data: keys, boundaryGap: false }),
      yAxis: yA({ type: "value", scale: true, axisLabel: { color: LABEL, formatter: (v) => fmt(v, 1) } }),
      dataZoom: [{ type: "inside" }, {
        type: "slider", height: 18, bottom: 6, borderColor: "transparent", backgroundColor: alpha("#5b7cff", 0.06),
        fillerColor: alpha("#5b7cff", 0.16), handleStyle: { color: "#5b7cff" }, dataBackground: { lineStyle: { color: alpha("#5b7cff", 0.5) }, areaStyle: { color: alpha("#5b7cff", 0.12) } },
      }],
      grid: { left: 50, right: 30, top: 40, bottom: 50, containLabel: true },
      series: [{
        name: agg === "count" ? "计数" : `${vc}（${$("trend-agg").selectedOptions[0].text}）`,
        type: "line", smooth: 0.25, showSymbol: false, symbolSize: 8, data: vals,
        lineStyle: { width: 3, color: grad("#5b7cff", "#a35cff", true), shadowColor: alpha("#5b7cff", 0.35), shadowBlur: 12, shadowOffsetY: 6 },
        itemStyle: { color: "#5b7cff" },
        areaStyle: { color: grad(alpha("#5b7cff", 0.32), alpha("#a35cff", 0.02)) },
        markPoint: {
          symbol: "pin", symbolSize: 50, label: { color: "#fff", fontSize: 10, formatter: (p) => fmt(p.value, 1) },
          data: [{ type: "max", name: "峰值", itemStyle: { color: "#ff6b81" } }, { type: "min", name: "谷值", itemStyle: { color: "#22c493" } }],
        },
        markLine: { symbol: "none", silent: true, data: [{ type: "average", name: "均值" }],
          lineStyle: { type: "dashed", color: alpha("#ffb547", 0.9) }, label: { color: "#ffb547", formatter: (p) => "均值 " + fmt(p.value, 1) } },
      }],
    });
    chart("chart-trend").setOption(opt, true);
  }

  function renderCorr() {
    const nc = colsOf("number").slice(0, 12);
    if (nc.length < 2) return chart("chart-corr").clear();
    const series = nc.map((c) => state.view.map((r) => toNumber(r[c])));
    const data = [];
    nc.forEach((_, i) => nc.forEach((__, j) => data.push([j, i, +pearson(series[i], series[j]).toFixed(2)])));
    const opt = base();
    Object.assign(opt, {
      tooltip: { formatter: (p) => `${nc[p.value[1]]} × ${nc[p.value[0]]}<br/>r = ${p.value[2]}` },
      grid: { left: 10, right: 20, top: 10, bottom: 60, containLabel: true },
      xAxis: xA({ type: "category", data: nc, axisLabel: { rotate: 30, color: LABEL }, axisLine: { show: false } }),
      yAxis: xA({ type: "category", data: nc, inverse: true, axisLine: { show: false } }),
      visualMap: { min: -1, max: 1, calculable: true, orient: "horizontal", left: "center", bottom: 0, itemHeight: 140, itemWidth: 12,
        textStyle: { color: LABEL }, inRange: { color: ["#ff6b81", "#ffc2cc", dark ? "#1f2638" : "#f6f7fb", "#b8c6ff", "#4f6bff"] } },
      series: [{
        type: "heatmap", data,
        itemStyle: { borderColor: dark ? "#161c28" : "#ffffff", borderWidth: 3, borderRadius: 6 },
        label: { show: nc.length <= 8, fontSize: 11, fontWeight: 600, color: dark ? "#e8ebf3" : "#1b2236" },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,.25)" } },
      }],
    });
    chart("chart-corr").setOption(opt, true);
  }

  function renderScatter() {
    const x = $("sc-x").value, y = $("sc-y").value;
    if (!x || !y) return chart("chart-scatter").clear();
    let pts = state.view.map((r) => [toNumber(r[x]), toNumber(r[y])]).filter((p) => p.every(Number.isFinite));
    const total = pts.length;
    if (pts.length > 3000) pts = pts.filter((_, i) => i % Math.ceil(total / 3000) === 0);
    const r = pearson(pts.map((p) => p[0]), pts.map((p) => p[1]));
    const opt = base();
    Object.assign(opt, {
      grid: { left: 50, right: 20, top: 40, bottom: 40, containLabel: true },
      title: { text: `r = ${Number.isNaN(r) ? "—" : r.toFixed(3)}  ·  n = ${total.toLocaleString()}`, left: "center", top: 0,
        textStyle: { fontSize: 12, fontWeight: "normal", color: dark ? "#8d96a8" : "#6b7489" } },
      tooltip: { trigger: "item", formatter: (p) => `${x}: ${fmt(p.value[0])}<br/>${y}: ${fmt(p.value[1])}` },
      xAxis: yA({ type: "value", name: x, scale: true, nameLocation: "middle", nameGap: 28, axisLabel: { color: LABEL, formatter: (v) => fmt(v, 1) } }),
      yAxis: yA({ type: "value", name: y, scale: true, axisLabel: { color: LABEL, formatter: (v) => fmt(v, 1) } }),
      visualMap: { show: false, dimension: 1, min: Math.min(...pts.map((p) => p[1])), max: Math.max(...pts.map((p) => p[1])),
        inRange: { color: ["#2ec7e6", "#5b7cff", "#a35cff", "#ff6b81"], symbolSize: [4, 9] } },
      series: [{ type: "scatter", data: pts, itemStyle: { opacity: 0.7, borderColor: "rgba(255,255,255,.6)", borderWidth: 0.5 } }],
    });
    chart("chart-scatter").setOption(opt, true);
  }

  function renderGroupBy() {
    const k = $("gb-key").value, v = $("gb-val").value, agg = $("gb-agg").value;
    if (!k) { $("gb-table").innerHTML = ""; return chart("chart-gb").clear(); }
    const groups = new Map();
    for (const r of state.view) {
      const key = isEmpty(r[k]) ? "(空)" : String(r[k]);
      if (!groups.has(key)) groups.set(key, []);
      const n = toNumber(r[v]);
      if (agg === "count" || Number.isFinite(n)) groups.get(key).push(n);
    }
    const rows = [...groups.entries()].map(([key, arr]) => [key, AGG[agg](arr), arr.length])
      .sort((a, b) => b[1] - a[1]).slice(0, 30);
    const aggName = $("gb-agg").selectedOptions[0].text;
    $("gb-table").innerHTML = `<tr><th>${esc(k)}</th><th>${agg === "count" ? "计数" : esc(v) + " · " + aggName}</th><th>行数</th></tr>` +
      rows.map(([key, val, n], i) => `<tr><td><span class="rank${i < 3 ? " r" + (i + 1) : ""}">${i + 1}</span>${esc(key)}</td><td><strong>${fmt(val)}</strong></td><td>${n}</td></tr>`).join("");
    const top = rows.slice(0, 12);
    const opt = base();
    const total = top.reduce((s, r) => s + Math.max(0, r[1]), 0);
    if (top.length <= 8 && top.every((r) => r[1] >= 0)) {
      // 类别不多时用南丁格尔玫瑰环图，中心显示总量
      Object.assign(opt, {
        tooltip: { ...opt.tooltip, trigger: "item", formatter: (p) => `${p.name}<br/><b>${fmt(p.value)}</b>（${p.percent}%）` },
        legend: { orient: "vertical", right: 6, top: "middle", icon: "circle", textStyle: { color: LABEL } },
        title: { text: fmt(total, 1), subtext: agg === "count" ? "总计数" : `${v} · ${aggName}合计`, left: "34%", top: "41%", textAlign: "center",
          textStyle: { fontSize: 22, fontWeight: 700, color: dark ? "#e8ebf3" : "#1b2236" }, subtextStyle: { color: LABEL } },
        series: [{
          type: "pie", roseType: "radius", radius: ["38%", "78%"], center: ["35%", "52%"], padAngle: 2,
          itemStyle: { borderRadius: 8, borderColor: dark ? "#161c28" : "#fff", borderWidth: 2 },
          label: { show: true, color: LABEL, formatter: "{d}%" }, labelLine: { length: 8, length2: 6 },
          data: top.map((r, i) => ({ name: r[0], value: +r[1].toFixed(2), itemStyle: { color: grad(PALETTE[i % 8], alpha(PALETTE[i % 8], 0.7)) } })),
        }],
      });
    } else {
      Object.assign(opt, {
        tooltip: { ...opt.tooltip, axisPointer: { type: "shadow" } },
        xAxis: xA({ type: "category", data: top.map((r) => r[0]), axisLabel: { rotate: top.length > 6 ? 30 : 0, color: LABEL } }),
        yAxis: yA({ type: "value", axisLabel: { color: LABEL, formatter: (x) => fmt(x, 1) } }),
        series: [{ type: "bar", barWidth: "55%",
          data: top.map((r, i) => ({ value: +r[1].toFixed(2), itemStyle: { color: grad(PALETTE[i % 8], alpha(PALETTE[i % 8], 0.35)) } })),
          itemStyle: { borderRadius: [8, 8, 0, 0] }, label: { show: true, position: "top", color: LABEL, formatter: (p) => fmt(p.value, 1) } }],
      });
    }
    chart("chart-gb").setOption(opt, true);
  }

  function renderPreview() {
    const shown = state.view.slice(0, 100);
    $("preview-note").textContent = `（显示前 ${shown.length} 行，共 ${state.view.length.toLocaleString()} 行）`;
    $("preview-table").innerHTML = `<tr>${state.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>` +
      shown.map((r) => `<tr>${state.cols.map((c) => `<td>${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("");
  }

  function renderViews() {
    renderKpis(); renderHist(); renderCategory(); renderTrend(); renderCorr(); renderScatter(); renderGroupBy(); renderPreview();
  }

  // ---------------------------------------------------------------- 数据装载
  function load(name, rows, cols) {
    state.name = name;
    state.cols = cols.filter((c) => c !== "" && c !== undefined);
    state.rows = rows.filter((r) => state.cols.some((c) => !isEmpty(r[c])));
    state.meta = profile(state.rows, state.cols);
    state.view = state.rows;
    $("filter-input").value = "";
    $("filter-input").classList.remove("error");

    const num = colsOf("number"), dates = colsOf("date");
    // 趋势/聚合默认取"总量最大"的数值列（通常是金额、销量），比固定取某一列更合理
    const total = (c) => Math.abs(state.meta[c].mean || 0) * (state.rows.length - state.meta[c].missing);
    const mainNum = num.length ? num.indexOf([...num].sort((a, b) => total(b) - total(a))[0]) : 0;
    const cats = colsOf("category").filter((c) => state.meta[c].unique <= Math.max(50, state.rows.length * 0.2));
    fillSelect("hist-col", num, 0);
    fillSelect("cat-col", cats.length ? cats : colsOf("category"), 0);
    fillSelect("trend-date", dates, 0);
    fillSelect("trend-val", num, mainNum);
    // 散点图默认展示相关性最强的一对数值列
    let best = [0, Math.min(1, num.length - 1)], bestR = -1;
    const vecs = num.slice(0, 12).map((c) => state.rows.map((r) => toNumber(r[c])));
    for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) {
      const r = Math.abs(pearson(vecs[i], vecs[j]));
      if (r > bestR && r < 0.999) { bestR = r; best = [i, j]; }
    }
    fillSelect("sc-x", num, best[0]);
    fillSelect("sc-y", num, best[1]);
    fillSelect("gb-key", cats.length ? cats : colsOf("category"), 0);
    fillSelect("gb-val", num, mainNum);

    $("dropzone").hidden = true;
    $("dashboard").hidden = false;
    renderSchema();
    renderViews();
    Object.values(state.charts).forEach((c) => c.resize());
  }

  function parseFile(file) {
    Papa.parse(file, {
      header: true, skipEmptyLines: "greedy", worker: false,
      complete: (res) => {
        if (!res.data.length) return alert("文件里没有可用的数据行");
        load(file.name, res.data, res.meta.fields || Object.keys(res.data[0]));
      },
      error: (err) => alert("解析失败：" + err.message),
    });
  }

  // 示例数据：固定种子生成的模拟销售明细（带真实的相关结构：单价↑销量↓、折扣↑利润率↓、季节性）
  function sampleData() {
    let seed = 20261109;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const pick = (arr, w) => { let x = rnd() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < arr.length; i++) { x -= w[i]; if (x <= 0) return arr[i]; } return arr[arr.length - 1]; };
    const regions = ["华东", "华南", "华北", "西南", "华中", "西北", "东北"];
    const channels = ["线上商城", "直播带货", "线下门店", "企业采购"];
    const products = { "智能手表": 899, "蓝牙耳机": 299, "平板电脑": 2599, "机械键盘": 459, "显示器": 1299, "移动电源": 129 };
    const rows = [];
    const start = Date.UTC(2024, 0, 1);
    for (let i = 0; i < 1200; i++) {
      const day = Math.floor(rnd() * 730);
      const d = new Date(start + day * 86400000);
      const season = 1 + 0.35 * Math.sin(((d.getUTCMonth() + 1) / 12) * 2 * Math.PI - 1) + (d.getUTCMonth() === 10 ? 0.6 : 0);
      const product = pick(Object.keys(products), [3, 4, 1.2, 2, 1.5, 3.5]);
      const list = products[product];
      const discount = Math.max(0, Math.min(0.4, 0.08 + 0.06 * gauss() + (rnd() < 0.15 ? 0.15 : 0)));
      const price = Math.round(list * (1 - discount));
      const units = Math.max(1, Math.round((60 / Math.sqrt(list)) * 12 * season * (1 + discount * 2) * Math.exp(0.35 * gauss())));
      const revenue = price * units;
      const cost = Math.round(list * 0.62 * units * (1 + 0.04 * gauss()));
      rows.push({
        order_date: d.toISOString().slice(0, 10),
        region: pick(regions, [5, 4, 3.5, 2.5, 2.5, 1, 1]),
        channel: pick(channels, [5, 3, 2.5, 1]),
        product,
        unit_price: price,
        discount: discount.toFixed(3),
        units,
        revenue,
        profit: revenue - cost,
        rating: rnd() < 0.04 ? "" : Math.max(1, Math.min(5, 4.3 - discount * 2 + 0.5 * gauss())).toFixed(1),
      });
    }
    rows.sort((a, b) => a.order_date.localeCompare(b.order_date));
    return rows;
  }

  // ---------------------------------------------------------------- 事件绑定
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((e) => document.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((e) => document.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.remove("over"); }));
  document.addEventListener("drop", (ev) => { const f = ev.dataTransfer.files[0]; if (f) parseFile(f); });
  $("file-input").addEventListener("change", (ev) => { const f = ev.target.files[0]; if (f) parseFile(f); ev.target.value = ""; });
  $("btn-sample").addEventListener("click", () => { const rows = sampleData(); load("电商销售示例.csv", rows, Object.keys(rows[0])); });

  let timer;
  $("filter-input").addEventListener("input", (ev) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        const pred = compileFilter(ev.target.value);
        state.view = state.rows.filter(pred);
        ev.target.classList.remove("error");
        ev.target.title = "";
        renderViews();
      } catch (e) {
        ev.target.classList.add("error");
        ev.target.title = e.message;
      }
    }, 250);
  });

  [["hist-col", renderHist], ["cat-col", renderCategory], ["trend-date", renderTrend], ["trend-val", renderTrend],
   ["trend-agg", renderTrend], ["sc-x", renderScatter], ["sc-y", renderScatter],
   ["gb-key", renderGroupBy], ["gb-val", renderGroupBy], ["gb-agg", renderGroupBy]]
    .forEach(([id, fn]) => $(id).addEventListener("change", fn));

  $("btn-export").addEventListener("click", () => {
    const csv = Papa.unparse(state.view, { columns: state.cols });
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: state.name.replace(/\.csv$/i, "") + "_filtered.csv" });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  window.addEventListener("resize", () => Object.values(state.charts).forEach((c) => c.resize()));
})();
