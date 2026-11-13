/* Archive Recon renderer: result workspace, job status, filters, paging, export.
 *
 * Design notes
 * - All data comes from the preload bridge (startQuery / getView / cancelQuery /
 *   exportResults / copySelection / onJobEvent). No node, no network here.
 * - Job status and transient notices are rendered in separate regions so proxy or
 *   export messages never overwrite "查询中 / 部分完成" state text.
 * - The paging/export footer is a fixed grid row: it can never be squeezed out,
 *   regardless of window height or table font size.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const bridge = window.archiveRecon;

  const STATUS_LABEL = {
    idle: "就绪",
    preparing: "准备中",
    running: "查询中",
    stopping: "停止中",
    completed: "完成",
    partial: "部分完成",
    failed: "失败",
    stopped: "已停止",
  };

  const TERMINAL = new Set(["completed", "partial", "failed", "stopped"]);
  const ACTIVE = new Set(["preparing", "running", "stopping"]);

  const REASON_LABEL = {
    parse_line: "响应解析丢行",
    parse_record: "记录解析失败",
    network: "网络错误",
    page_limit: "达到页数上限",
    record_limit: "达到记录上限",
    stopped: "已停止",
    range_unknown: "时间范围未知",
    unknown: "其他原因",
  };

  const FONT_CLASS = {
    small: "font-small",
    default: "",
    medium: "font-medium",
    large: "font-large",
    xlarge: "font-xlarge",
  };

  const EMPTY_FILTER = {
    status: "",
    fileType: "",
    urlKeyword: "",
    domain: "",
    interestingOnly: false,
  };

  const state = {
    jobId: null,
    source: "wayback",
    lastJobTarget: "",
    revision: 0,
    pageIndex: 0,
    pageSize: 50,
    appliedFilter: { ...EMPTY_FILTER },
    sort: { key: null, reverse: false },
    status: "idle",
    terminal: true,
    rows: [],
    pageCount: 0,
    matched: 0,
    unique: 0,
    received: 0,
    total: 0,
    scope: null,
    reasons: [],
    progress: null,
    selected: new Set(),
    lastSeq: 0,
    view: null,
  };

  let refreshTimer = null;
  let refreshPending = false;
  let noticeTimer = null;
  let refreshing = false;

  /* ------------------------------------------------------------------ */
  /* 基础工具                                                             */
  /* ------------------------------------------------------------------ */

  function setNotice(message, kind) {
    const node = $("notice");
    node.textContent = message || "";
    node.className = "notice" + (kind ? ` ${kind}` : "");
    if (noticeTimer) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    if (message) {
      const delay = kind === "error" ? 9000 : 6000;
      noticeTimer = setTimeout(() => {
        node.textContent = "";
        node.className = "notice";
      }, delay);
    }
  }

  function describeError(error) {
    const prefix = error && error.code ? `${error.code}：` : "";
    const message = error && error.message ? error.message : "未知错误";
    return `${prefix}${message}`;
  }

  function reasonLabel(reason) {
    return REASON_LABEL[reason.code] || REASON_LABEL.unknown;
  }

  function reasonDetail(reason) {
    const parts = [];
    if (reason.source) parts.push(reason.source === "wayback" ? "Wayback" : "Common Crawl");
    if (reason.indexId) parts.push(reason.indexId);
    if (typeof reason.page === "number") parts.push(`第 ${reason.page + 1} 页`);
    if (typeof reason.count === "number") parts.push(`${reason.count} 条`);
    return parts.join(" · ");
  }

  function copyText(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.className = "hidden";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  /* ------------------------------------------------------------------ */
  /* 任务状态（唯一来源）                                                  */
  /* ------------------------------------------------------------------ */

  function setStatus(status) {
    state.status = status;
    state.terminal = TERMINAL.has(status) || status === "idle";
    const chip = $("status-chip");
    chip.textContent = STATUS_LABEL[status] || status;
    chip.className = `chip ${status}`;
    const busy = ACTIVE.has(status);
    $("start-button").disabled = busy;
    $("cancel-button").disabled = !["preparing", "running", "stopping"].includes(status);
    $("start-button").textContent = status === "idle" ? "开始查询" : "开始新查询";
  }

  function taskTextFor(view) {
    if (!view) return "输入目标域名后开始查询";
    const counts = `已接收 ${view.received} / 去重 ${view.unique}`;
    switch (view.status) {
      case "preparing":
        return "准备中 · 正在建立查询会话…";
      case "running": {
        const progress = state.progress;
        let where = "正在读取";
        if (progress && progress.indexId) {
          where = `索引 ${progress.indexId} 第 ${progress.page || 1} 页`;
        } else if (progress && progress.page) {
          where = `第 ${progress.page} 页`;
        }
        return `查询中 · ${where} · ${counts}`;
      }
      case "stopping":
        return `停止中 · 等待在途请求结束 · 已保留 ${view.unique} 条`;
      case "completed":
        return `完成 · ${view.unique} 条（去重后）· ${view.scope.rangeLabel}`;
      case "partial":
        return `部分完成 · ${view.unique} 条`;
      case "failed":
        return `失败 · ${view.reasons.length > 0 ? view.reasons[0].message : "查询未完成"}`;
      case "stopped":
        return `已停止 · 保留 ${view.unique} 条 · 未查完`;
      default:
        return "输入目标域名后开始查询";
    }
  }

  function renderStatus(view) {
    if (view) setStatus(view.status);
    $("task-text").textContent = taskTextFor(view);
    $("task-text").title = $("task-text").textContent;
  }

  /* ------------------------------------------------------------------ */
  /* 结果归属与摘要                                                        */
  /* ------------------------------------------------------------------ */

  function renderScope(view) {
    const scope = view && view.scope ? view.scope : null;
    if (!scope) {
      $("scope-label").textContent = "尚未开始查询";
      $("budget-label").textContent = "";
      return;
    }
    const parts = [`目标 ${scope.label}`];
    // 范围语义来自冻结的任务快照（contracts.TargetScope.match），不是界面承诺
    parts.push(scope.match === "host-and-subdomains" ? "主机及子域" : scope.match);
    parts.push(`范围 ${scope.rangeLabel}`);
    parts.push(`代理 ${scope.proxyDisplay}`);
    $("scope-label").textContent = parts.join(" · ");
    $("scope-label").title = `查询时钟（UTC）：${scope.clockUtc}\n${parts.join(" · ")}`;
    $("budget-label").textContent = scope.budgetLabel ? `读取上限：${scope.budgetLabel}` : "";
  }

  function renderSummary(view) {
    if (!view) {
      $("summary").textContent = "0 条";
      return;
    }
    $("summary").textContent = `匹配 ${view.matched} / 去重 ${view.unique} / 接收 ${view.received}`;
  }

  function renderPager(view) {
    const pageCount = view ? view.pageCount : 0;
    const matched = view ? view.matched : 0;
    const start = state.pageIndex * state.pageSize;
    $("page-range").textContent =
      matched > 0 ? `${start + 1}–${Math.min(start + state.pageSize, matched)} / ${matched}` : "0 条";
    $("page-label").textContent =
      pageCount === 0 ? "第 0 / 0 页" : `第 ${state.pageIndex + 1} / ${pageCount} 页`;
    $("prev-page").disabled = state.pageIndex <= 0 || pageCount === 0;
    $("next-page").disabled = pageCount === 0 || state.pageIndex >= pageCount - 1;
  }

  function updateDirtyHint() {
    const node = $("dirty-hint");
    const value = $("target-input").value.trim();
    const dirty = state.jobId !== null && value !== "" && value !== state.lastJobTarget;
    node.classList.toggle("hidden", !dirty);
  }

  /* ------------------------------------------------------------------ */
  /* 空状态（四种明确区分）                                                */
  /* ------------------------------------------------------------------ */

  function renderEmpty(view) {
    const box = $("empty-state");
    const title = $("empty-title");
    const detail = $("empty-detail");
    const action = $("empty-action");

    const show = (text, sub, actionLabel, handler) => {
      box.classList.remove("hidden");
      title.textContent = text;
      detail.textContent = sub || "";
      if (actionLabel && handler) {
        action.classList.remove("hidden");
        action.textContent = actionLabel;
        action.onclick = handler;
      } else {
        action.classList.add("hidden");
        action.onclick = null;
      }
    };

    if (state.rows.length > 0) {
      box.classList.add("hidden");
      return;
    }
    if (!view) {
      show("还没有结果", "输入目标域名后开始查询", null, null);
      return;
    }
    if (view.matched === 0 && view.total > 0) {
      if (!view.terminal) {
        show("查询进行中，暂无匹配记录", "已接收记录中没有符合当前筛选的内容", "清除筛选", clearFilters);
        return;
      }
      show("当前筛选没有匹配结果", "清除筛选或调整关键词后重试", "清除筛选", clearFilters);
      return;
    }
    if (view.total === 0 && view.terminal) {
      if (view.status === "stopped") {
        show("查询已停止，尚未取得结果", "已保留 0 条；可重新查询", "重新查询", startQuery);
      } else if (view.status === "failed") {
        show(
          "查询失败",
          view.reasons.length > 0 ? view.reasons[0].message : "检查网络或代理后可重试",
          "重新查询",
          startQuery,
        );
      } else {
        show(
          "所选范围内没有存档记录",
          `目标 ${view.scope.label} · 范围 ${view.scope.rangeLabel}`,
          "重新查询",
          startQuery,
        );
      }
      return;
    }
    if (view.total === 0) {
      show("正在读取…", "已接收的记录会实时出现在这里", null, null);
      return;
    }
    show("没有可显示的结果", "调整筛选条件后重试", "清除筛选", clearFilters);
  }

  /* ------------------------------------------------------------------ */
  /* 未完成原因                                                            */
  /* ------------------------------------------------------------------ */

  function renderReasons(view) {
    const reasons = view ? view.reasons : [];
    const button = $("reasons-button");
    state.reasons = reasons;
    if (reasons.length > 0) {
      button.textContent = `${reasons.length} 项未完成`;
      button.classList.remove("hidden");
    } else {
      button.classList.add("hidden");
    }
  }

  function openReasons() {
    const list = $("reasons-list");
    list.textContent = "";
    $("reasons-scope").textContent = state.scope
      ? `目标 ${state.scope.label} · 范围 ${state.scope.rangeLabel} · 读取上限 ${
          state.scope.budgetLabel || "-"
        }`
      : "";
    if (state.reasons.length === 0) {
      const item = document.createElement("li");
      item.textContent = "没有记录到未完成原因。";
      list.appendChild(item);
    }
    for (const reason of state.reasons) {
      const item = document.createElement("li");
      const head = document.createElement("strong");
      head.textContent = reasonLabel(reason);
      item.appendChild(head);
      const message = document.createElement("span");
      message.textContent = reason.message ? `：${reason.message}` : "";
      item.appendChild(message);
      const meta = reasonDetail(reason);
      if (meta) {
        const code = document.createElement("span");
        code.className = "reason-code";
        code.textContent = ` [${meta}]`;
        item.appendChild(code);
      }
      list.appendChild(item);
    }
    const dialog = $("reasons-dialog");
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function reasonsSummary() {
    const lines = ["未完成原因："];
    if (state.scope) {
      lines.push(`目标 ${state.scope.label} · 范围 ${state.scope.rangeLabel}`);
      lines.push(`读取上限 ${state.scope.budgetLabel || "-"}`);
    }
    for (const reason of state.reasons) {
      const meta = reasonDetail(reason);
      lines.push(`- ${reasonLabel(reason)}${reason.message ? `：${reason.message}` : ""}${meta ? `（${meta}）` : ""}`);
    }
    if (state.reasons.length === 0) lines.push("- 无");
    return lines.join("\n");
  }

  /* ------------------------------------------------------------------ */
  /* 表格渲染                                                              */
  /* ------------------------------------------------------------------ */

  function statusClass(code) {
    const text = String(code || "");
    if (/^2/.test(text)) return "status-2xx";
    if (/^3/.test(text)) return "status-3xx";
    if (/^4/.test(text)) return "status-4xx";
    if (/^5/.test(text)) return "status-5xx";
    return "";
  }

  function renderRows(view) {
    const body = $("rows-body");
    body.textContent = "";
    const start = state.pageIndex * state.pageSize;
    const fragment = document.createDocumentFragment();

    view.rows.forEach((row, index) => {
      const tr = document.createElement("tr");
      tr.dataset.rowId = row.rowId;
      if (state.selected.has(row.rowId)) tr.classList.add("selected");

      const selectCell = document.createElement("td");
      selectCell.className = "select-col";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.rowId = row.rowId;
      checkbox.checked = state.selected.has(row.rowId);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) state.selected.add(row.rowId);
        else state.selected.delete(row.rowId);
        tr.classList.toggle("selected", checkbox.checked);
        syncSelectAll();
      });
      selectCell.appendChild(checkbox);
      tr.appendChild(selectCell);

      const numberCell = document.createElement("td");
      numberCell.className = "rownum-col";
      numberCell.textContent = String(start + index + 1);
      tr.appendChild(numberCell);

      const timestampCell = document.createElement("td");
      timestampCell.textContent = row.timestamp;
      timestampCell.title = row.timestamp;
      tr.appendChild(timestampCell);

      const statusCell = document.createElement("td");
      statusCell.textContent = row.statusCode;
      statusCell.className = statusClass(row.statusCode);
      tr.appendChild(statusCell);

      const lengthCell = document.createElement("td");
      lengthCell.textContent = row.length;
      tr.appendChild(lengthCell);

      const typeCell = document.createElement("td");
      typeCell.textContent = row.fileType;
      typeCell.title = row.fileType;
      tr.appendChild(typeCell);

      const urlCell = document.createElement("td");
      urlCell.className = "url";
      urlCell.textContent = row.url;
      urlCell.title = row.url;
      tr.appendChild(urlCell);

      fragment.appendChild(tr);
    });

    body.appendChild(fragment);
    syncSelectAll();
    updateDomainOptions(view.rows);
  }

  function syncSelectAll() {
    const boxes = Array.from(document.querySelectorAll("#rows-body input[type=checkbox]"));
    const selectAll = $("select-all");
    const checked = boxes.filter((box) => box.checked).length;
    selectAll.checked = boxes.length > 0 && checked === boxes.length;
    selectAll.indeterminate = checked > 0 && checked < boxes.length;
    selectAll.disabled = boxes.length === 0;
  }

  function updateDomainOptions(rows) {
    const hosts = new Set();
    for (const row of rows) {
      try {
        hosts.add(new URL(row.url).hostname);
      } catch {
        // 非标准 URL 不参与域名提示
      }
    }
    const datalist = $("domain-options");
    datalist.textContent = "";
    for (const host of Array.from(hosts).sort()) {
      const option = document.createElement("option");
      option.value = host;
      datalist.appendChild(option);
    }
  }

  function renderSortHeaders() {
    for (const header of document.querySelectorAll("th[data-sort]")) {
      if (!header.dataset.label) header.dataset.label = header.textContent;
      const arrow = header.dataset.sort === state.sort.key ? (state.sort.reverse ? "▼" : "▲") : "";
      header.textContent = header.dataset.label;
      if (arrow) {
        const span = document.createElement("span");
        span.className = "arrow";
        span.textContent = ` ${arrow}`;
        header.appendChild(span);
      }
      if (header.dataset.sort === state.sort.key) {
        header.setAttribute("aria-sort", state.sort.reverse ? "descending" : "ascending");
      } else {
        header.removeAttribute("aria-sort");
      }
    }
  }

  function render(view) {
    state.view = view;
    state.revision = view.revision;
    state.rows = view.rows;
    state.pageIndex = view.pageIndex;
    state.pageCount = view.pageCount;
    state.matched = view.matched;
    state.unique = view.unique;
    state.received = view.received;
    state.total = view.total;
    state.scope = view.scope;
    state.selected = new Set(
      Array.from(state.selected).filter((rowId) => view.rows.some((row) => row.rowId === rowId)),
    );

    renderStatus(view);
    renderScope(view);
    renderSummary(view);
    renderPager(view);
    renderRows(view);
    renderEmpty(view);
    renderReasons(view);
    renderSortHeaders();
    updateDirtyHint();
  }

  /* ------------------------------------------------------------------ */
  /* 视图刷新                                                              */
  /* ------------------------------------------------------------------ */

  async function refresh() {
    if (!bridge || state.jobId === null) return;
    if (refreshing) {
      refreshPending = true;
      return;
    }
    refreshing = true;
    try {
      const result = await bridge.getView({
        jobId: state.jobId,
        source: state.source,
        filter: state.appliedFilter,
        sort: state.sort,
        pageIndex: state.pageIndex,
        pageSize: state.pageSize,
      });
      if (!result.ok) {
        if (result.error.code === "STALE_VIEW") {
          setStatus("idle");
          setNotice("任务已结束，请重新查询。", "error");
          return;
        }
        setNotice(describeError(result.error), "error");
        return;
      }
      render(result.value);
    } finally {
      refreshing = false;
      if (refreshPending) {
        refreshPending = false;
        scheduleRefresh();
      }
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 60);
  }

  /* ------------------------------------------------------------------ */
  /* 筛选                                                                  */
  /* ------------------------------------------------------------------ */

  function readDraftFilter() {
    return {
      status: $("filter-status").value.trim(),
      fileType: $("filter-filetype").value.trim(),
      urlKeyword: $("filter-url").value.trim(),
      domain: $("filter-domain").value.trim(),
      interestingOnly: $("filter-interesting").checked,
    };
  }

  function sameFilter(a, b) {
    return (
      a.status === b.status &&
      a.fileType === b.fileType &&
      a.urlKeyword === b.urlKeyword &&
      a.domain === b.domain &&
      a.interestingOnly === b.interestingOnly
    );
  }

  function renderPending() {
    const pending = !sameFilter(readDraftFilter(), state.appliedFilter);
    $("filter-pending").classList.toggle("hidden", !pending);
  }

  function applyFilters() {
    state.appliedFilter = readDraftFilter();
    state.pageIndex = 0;
    renderPending();
    scheduleRefresh();
  }

  function clearFilters() {
    $("filter-status").value = "";
    $("filter-filetype").value = "";
    $("filter-url").value = "";
    $("filter-domain").value = "";
    $("filter-interesting").checked = false;
    state.appliedFilter = { ...EMPTY_FILTER };
    state.pageIndex = 0;
    renderPending();
    scheduleRefresh();
  }

  /* ------------------------------------------------------------------ */
  /* 分页                                                                  */
  /* ------------------------------------------------------------------ */

  function gotoPage(index) {
    const maxPage = Math.max(0, state.pageCount - 1);
    const clamped = Math.min(Math.max(0, Math.trunc(index)), maxPage);
    if (clamped !== index) {
      setNotice(`页码范围 1–${Math.max(1, state.pageCount)}，已跳到第 ${clamped + 1} 页。`);
    }
    state.pageIndex = clamped;
    scheduleRefresh();
  }

  function jumpToPage() {
    const raw = $("page-jump").value.trim();
    if (!raw) return;
    const page = Number(raw);
    if (!Number.isFinite(page)) {
      setNotice("请输入数字页码。", "error");
      return;
    }
    gotoPage(Math.trunc(page) - 1);
  }

  /* ------------------------------------------------------------------ */
  /* 查询                                                                  */
  /* ------------------------------------------------------------------ */

  function readRange() {
    const mode = $("range-mode").value;
    if (mode === "recent") {
      const months = Number($("range-months").value || 3);
      if (!Number.isInteger(months) || months < 1 || months > 120) {
        return { error: "月数必须是 1–120 的整数。" };
      }
      return { range: { kind: "recent", months } };
    }
    if (mode === "month") {
      const year = Number($("range-year").value || new Date().getUTCFullYear());
      const month = Number($("range-month-value").value || 1);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return { error: "年份必须是 2000–2100 的整数。" };
      }
      if (!Number.isInteger(month) || month < 1 || month > 12) {
        return { error: "月份必须是 1–12 的整数。" };
      }
      return { range: { kind: "month", year, month } };
    }
    return { range: { kind: "all" } };
  }

  function readProxy() {
    const mode = $("proxy-mode").value;
    if (mode === "fixed") {
      const server = $("proxy-server").value.trim();
      if (!server) return { error: "固定代理需要填写地址，例如 http://127.0.0.1:7890。" };
      return { proxy: { mode, server } };
    }
    return { proxy: { mode } };
  }

  async function startQuery() {
    if (!bridge) return;
    const target = $("target-input").value.trim();
    if (!target) {
      setNotice("请输入目标域名后再开始查询。", "error");
      $("target-input").focus();
      return;
    }
    const range = readRange();
    if (range.error) {
      setNotice(range.error, "error");
      return;
    }
    const proxy = readProxy();
    if (proxy.error) {
      setNotice(proxy.error, "error");
      return;
    }

    setNotice("");
    const result = await bridge.startQuery({
      target,
      source: $("source-select").value,
      range: range.range,
      proxy: proxy.proxy,
    });
    if (!result.ok) {
      setNotice(describeError(result.error), "error");
      return;
    }

    state.jobId = result.value.jobId;
    state.source = result.value.source;
    state.lastJobTarget = target;
    state.revision = 0;
    state.pageIndex = 0;
    state.rows = [];
    state.selected = new Set();
    state.reasons = [];
    state.progress = null;
    state.lastSeq = 0;
    state.scope = result.value.scope || null;
    state.view = null;
    setStatus("preparing");
    renderScope({ scope: state.scope });
    renderReasons(null);
    renderPager(null);
    renderEmpty(null);
    updateDirtyHint();

    if (state.scope) {
      renderStatus(null);
      $("task-text").textContent = `准备中 · ${state.scope.label} · ${state.scope.rangeLabel}`;
    }
    await refresh();
  }

  async function cancelQuery() {
    if (!bridge || state.jobId === null) return;
    const result = await bridge.cancelQuery({ jobId: state.jobId, source: state.source });
    if (!result.ok) {
      setNotice(describeError(result.error), "error");
      return;
    }
    setStatus(result.value.status);
    $("task-text").textContent = "停止中 · 等待在途请求结束…";
  }

  /* ------------------------------------------------------------------ */
  /* 导出与复制                                                            */
  /* ------------------------------------------------------------------ */

  async function exportResults(format) {
    if (!bridge || state.jobId === null) {
      setNotice("请先完成一次查询后再导出。", "error");
      return;
    }
    const result = await bridge.exportResults({
      jobId: state.jobId,
      source: state.source,
      expectedRevision: state.revision,
      filter: state.appliedFilter,
      sort: state.sort,
      format,
    });
    if (!result.ok) {
      if (result.error.code === "STALE_VIEW") {
        setNotice("结果已更新，正在刷新，请稍后重新导出。", "error");
        await refresh();
        return;
      }
      setNotice(describeError(result.error), "error");
      return;
    }
    if (!result.value.saved) {
      setNotice("导出已取消。");
      return;
    }
    setNotice(`已导出 ${result.value.count} 条记录。`);
  }

  function selectedRowIds() {
    if (state.selected.size > 0) return Array.from(state.selected);
    return state.rows.map((row) => row.rowId);
  }

  async function copySelected(mode) {
    if (!bridge || state.jobId === null) {
      setNotice("请先完成一次查询后再复制。", "error");
      return;
    }
    const rowIds = selectedRowIds();
    if (rowIds.length === 0) {
      setNotice("当前页没有可复制的记录。", "error");
      return;
    }
    const result = await bridge.copySelection({
      jobId: state.jobId,
      source: state.source,
      revision: state.revision,
      rowIds,
      mode,
    });
    if (!result.ok) {
      if (result.error.code === "STALE_VIEW") {
        setNotice("结果已更新，正在刷新，请稍后重试复制。", "error");
        await refresh();
        return;
      }
      setNotice(describeError(result.error), "error");
      return;
    }
    setNotice(`已复制 ${result.value.copiedCount} 条 ${mode === "url" ? "URL" : "整行数据"}。`);
  }

  /* ------------------------------------------------------------------ */
  /* 事件与绑定                                                            */
  /* ------------------------------------------------------------------ */

  function toggleRangeInputs() {
    const mode = $("range-mode").value;
    $("range-recent").classList.toggle("hidden", mode !== "recent");
    $("range-month").classList.toggle("hidden", mode !== "month");
  }

  function toggleProxyInputs() {
    $("proxy-fixed").classList.toggle("hidden", $("proxy-mode").value !== "fixed");
  }

  function applyFontClass() {
    const wrap = document.querySelector(".table-wrap");
    for (const name of Object.values(FONT_CLASS)) {
      if (name) wrap.classList.remove(name);
    }
    const chosen = FONT_CLASS[$("font-size").value];
    if (chosen) wrap.classList.add(chosen);
  }

  function bind() {
    $("target-input").addEventListener("input", updateDirtyHint);

    $("start-button").addEventListener("click", () => void startQuery());
    $("cancel-button").addEventListener("click", () => void cancelQuery());

    $("apply-filter").addEventListener("click", applyFilters);
    $("clear-filter").addEventListener("click", clearFilters);
    for (const id of ["filter-status", "filter-filetype", "filter-url", "filter-domain"]) {
      $(id).addEventListener("input", renderPending);
    }
    $("filter-interesting").addEventListener("change", () => {
      renderPending();
      applyFilters();
    });

    $("font-size").addEventListener("change", applyFontClass);

    $("export-csv").addEventListener("click", () => void exportResults("csv"));
    $("export-json").addEventListener("click", () => void exportResults("json"));
    $("copy-url").addEventListener("click", () => void copySelected("url"));
    $("copy-row").addEventListener("click", () => void copySelected("row"));

    $("prev-page").addEventListener("click", () => gotoPage(state.pageIndex - 1));
    $("next-page").addEventListener("click", () => gotoPage(state.pageIndex + 1));
    $("page-jump-go").addEventListener("click", jumpToPage);
    $("page-jump").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        jumpToPage();
      }
    });
    $("page-size").addEventListener("change", () => {
      const first = state.pageIndex * state.pageSize;
      state.pageSize = Number($("page-size").value) || 50;
      state.pageIndex = Math.floor(first / state.pageSize);
      void refresh();
    });

    $("select-all").addEventListener("change", () => {
      const checked = $("select-all").checked;
      for (const row of state.rows) {
        if (checked) state.selected.add(row.rowId);
        else state.selected.delete(row.rowId);
      }
      for (const box of document.querySelectorAll("#rows-body input[type=checkbox]")) {
        box.checked = checked;
        box.closest("tr").classList.toggle("selected", checked);
      }
      syncSelectAll();
    });

    for (const header of document.querySelectorAll("th[data-sort]")) {
      header.tabIndex = 0;
      const activate = () => {
        const key = header.dataset.sort;
        if (state.sort.key === key) state.sort = { key, reverse: !state.sort.reverse };
        else state.sort = { key, reverse: false };
        state.pageIndex = 0;
        renderSortHeaders();
        scheduleRefresh();
      };
      header.addEventListener("click", activate);
      header.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          activate();
        }
      });
    }

    document.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
        const active = document.activeElement;
        const editing =
          active && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
        if (!editing) {
          event.preventDefault();
          void copySelected("url");
        }
      }
    });

    $("reasons-button").addEventListener("click", openReasons);
    $("reasons-close").addEventListener("click", () => $("reasons-dialog").close());
    $("reasons-copy").addEventListener("click", () => {
      const ok = copyText(reasonsSummary());
      setNotice(ok ? "原因摘要已复制。" : "复制失败，请手动选择文本。", ok ? "ok" : "error");
    });

    $("range-mode").addEventListener("change", toggleRangeInputs);
    $("proxy-mode").addEventListener("change", toggleProxyInputs);

    if (!bridge) {
      setNotice("preload 桥接不可用，界面只能查看空状态。", "error");
      return;
    }

    bridge.onJobEvent((event) => {
      if (event.jobId !== state.jobId || event.source !== state.source) return;
      if (typeof event.seq === "number") {
        if (event.seq <= state.lastSeq) return;
        state.lastSeq = event.seq;
      }
      if (event.kind === "progress") {
        state.progress = event.payload;
        if (typeof event.payload.received === "number") state.received = event.payload.received;
        if (typeof event.payload.unique === "number") state.unique = event.payload.unique;
        if (state.view && ACTIVE.has(state.status)) {
          $("task-text").textContent = taskTextFor({
            ...state.view,
            status: "running",
            received: state.received,
            unique: state.unique,
          });
        }
      }
      if (event.kind === "state" && typeof event.payload.status === "string") {
        const next = event.payload.status;
        if (typeof event.payload.received === "number") state.received = event.payload.received;
        if (typeof event.payload.unique === "number") state.unique = event.payload.unique;
        if (TERMINAL.has(next)) {
          // 终态以 getView 返回的权威视图为准：状态块与最终行同时更新，
          // 避免出现“已完成但表格还是空的”中间态。
          scheduleRefresh();
        } else {
          setStatus(next);
          if (next === "stopping") {
            $("task-text").textContent = "停止中 · 等待在途请求结束…";
          }
        }
      }
      if (event.kind === "reason") {
        scheduleRefresh();
      }
      if (event.kind === "viewChanged" || event.kind === "state") {
        scheduleRefresh();
      }
    });
  }

  function boot() {
    toggleRangeInputs();
    toggleProxyInputs();
    applyFontClass();
    renderPending();
    renderSortHeaders();
    setStatus("idle");
    renderEmpty(null);
    bind();
  }

  boot();
})();
