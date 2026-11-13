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

  const SOURCE_LABEL = {
    wayback: "Wayback Machine",
    commoncrawl: "Common Crawl",
  };

  const CONFIG_HINT_IDLE = "代理与范围在开始查询时冻结，修改只影响下一次查询";

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
    frozen: null,
    starting: false,
    viewGeneration: 0,
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
  let noticeTimer = null;

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

  function selectElementContents(node) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
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
    const busy = ACTIVE.has(status) || state.starting;
    $("start-button").disabled = busy;
    $("cancel-button").disabled = state.starting || !["preparing", "running", "stopping"].includes(status);
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
    const sourceLabel = view.source ? SOURCE_LABEL[view.source] || view.source : "";
    const parts = [`目标 ${scope.label}`];
    if (sourceLabel) parts.push(`来源 ${sourceLabel}`);
    // 范围语义来自冻结的任务快照（contracts.TargetScope.match），不是界面承诺
    parts.push(scope.match === "host-and-subdomains" ? "主机及子域" : String(scope.match));
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

  function updateConfigHint() {
    const node = $("config-hint");
    if (!state.frozen) {
      node.textContent = CONFIG_HINT_IDLE;
      node.classList.remove("dirty");
      return;
    }
    const changed = [];
    if ($("target-input").value.trim() !== state.frozen.target) changed.push("目标");
    if ($("source-select").value !== state.frozen.source) changed.push("来源");
    if (rangeKey(readRangeSelection()) !== state.frozen.rangeKey) changed.push("时间范围");
    if (proxyKey(readProxySelection()) !== state.frozen.proxyKey) changed.push("代理");
    if (changed.length === 0) {
      node.textContent = CONFIG_HINT_IDLE;
      node.classList.remove("dirty");
      return;
    }
    node.textContent = `本次查询仍使用已冻结配置；${changed.join("、")} 的修改将在下次查询生效`;
    node.classList.add("dirty");
  }

  /* ------------------------------------------------------------------ */
  /* 空状态（四种明确区分）                                                */
  /* ------------------------------------------------------------------ */

  function renderEmpty(view) {
    const box = $("empty-state");
    const title = $("empty-title");
    const detail = $("empty-detail");
    const action = $("empty-action");
    const secondary = $("empty-action-2");

    const show = (text, sub, actions) => {
      box.classList.remove("hidden");
      title.textContent = text;
      detail.textContent = sub || "";
      const slots = [action, secondary];
      slots.forEach((node, index) => {
        const entry = actions && actions[index];
        if (entry) {
          node.classList.remove("hidden");
          node.textContent = entry.label;
          node.onclick = entry.handler;
        } else {
          node.classList.add("hidden");
          node.onclick = null;
        }
      });
    };

    if (state.rows.length > 0) {
      box.classList.add("hidden");
      return;
    }
    if (!view) {
      show("还没有结果", "输入目标域名后开始查询", []);
      return;
    }
    const reasons = view.reasons.length;
    const reasonAction = { label: "查看原因", handler: openReasons };
    const retryAction = { label: "重新查询", handler: startQuery };

    if (view.matched === 0 && view.total > 0) {
      if (!view.terminal) {
        show("查询进行中，暂无匹配记录", "已接收记录中没有符合当前筛选的内容", [
          { label: "清除筛选", handler: clearFilters },
          reasonAction,
        ].slice(0, reasons > 0 ? 2 : 1));
        return;
      }
      show("当前筛选没有匹配结果", "清除筛选或调整关键词后重试", [
        { label: "清除筛选", handler: clearFilters },
        reasonAction,
      ].slice(0, reasons > 0 ? 2 : 1));
      return;
    }
    if (view.total === 0 && view.terminal) {
      if (view.status === "stopped") {
        show("查询已停止，尚未取得结果", "已保留 0 条；可重新查询", [
          retryAction,
          reasonAction,
        ].slice(0, reasons > 0 ? 2 : 1));
        return;
      }
      if (view.status === "failed") {
        show(
          "查询失败",
          reasons > 0 ? view.reasons[0].message : "检查网络或代理后可重试",
          [retryAction, reasonAction].slice(0, reasons > 0 ? 2 : 1),
        );
        return;
      }
      // 部分完成 / 范围未知 / 解析丢行等情况：不得宣称“没有存档”
      if (view.completion !== "complete" || reasons > 0) {
        show(
          "未取得可用记录",
          `${reasons > 0 ? `${reasons} 项未完成原因；` : ""}目标 ${view.scope.label} · 范围 ${
            view.scope.rangeLabel
          }`,
          [reasonAction, retryAction],
        );
        return;
      }
      show(
        "所选范围内没有存档记录",
        `目标 ${view.scope.label} · 范围 ${view.scope.rangeLabel}`,
        [retryAction],
      );
      return;
    }
    if (view.total === 0) {
      show("正在读取…", "已接收的记录会实时出现在这里", []);
      return;
    }
    show("没有可显示的结果", "调整筛选条件后重试", [{ label: "清除筛选", handler: clearFilters }]);
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
    updateConfigHint();
  }

  function showPreparingEmpty() {
    $("empty-state").classList.remove("hidden");
    $("empty-title").textContent = "准备中…";
    $("empty-detail").textContent = "正在建立查询会话，接收到的记录会实时出现在这里";
    $("empty-action").classList.add("hidden");
    $("empty-action-2").classList.add("hidden");
  }

  function resetWorkspaceForStart() {
    state.rows = [];
    state.selected = new Set();
    state.matched = 0;
    state.unique = 0;
    state.received = 0;
    state.total = 0;
    state.pageCount = 0;
    state.pageIndex = 0;
    state.reasons = [];
    state.progress = null;
    state.view = null;
    $("rows-body").textContent = "";
    $("summary").textContent = "匹配 0 / 去重 0 / 接收 0";
    $("page-range").textContent = "0 条";
    $("page-label").textContent = "第 0 / 0 页";
    $("prev-page").disabled = true;
    $("next-page").disabled = true;
    renderReasons(null);
    renderEmpty(null);
  }

  /* ------------------------------------------------------------------ */
  /* 视图刷新                                                              */
  /* ------------------------------------------------------------------ */

  async function refresh() {
    if (!bridge || state.jobId === null) return;
    // 请求代际：只有最新一次请求的响应可以渲染，旧响应直接丢弃
    const generation = ++state.viewGeneration;
    const jobId = state.jobId;
    const source = state.source;
    const result = await bridge.getView({
      jobId,
      source,
      filter: state.appliedFilter,
      sort: state.sort,
      pageIndex: state.pageIndex,
      pageSize: state.pageSize,
    });
    if (generation !== state.viewGeneration) return;
    if (jobId !== state.jobId || source !== state.source) return;
    if (!result.ok) {
      if (result.error.code === "STALE_VIEW") {
        setNotice("结果已更新，请重新查询。", "error");
        return;
      }
      setNotice(describeError(result.error), "error");
      return;
    }
    if (result.value.jobId !== jobId || result.value.source !== source) return;
    render(result.value);
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

  function readRangeSelection() {
    const mode = $("range-mode").value;
    if (mode === "recent") {
      return { kind: "recent", months: Number($("range-months").value || 3) };
    }
    if (mode === "month") {
      return {
        kind: "month",
        year: Number($("range-year").value || new Date().getUTCFullYear()),
        month: Number($("range-month-value").value || 1),
      };
    }
    return { kind: "all" };
  }

  function readProxySelection() {
    const mode = $("proxy-mode").value;
    if (mode === "fixed") return { mode, server: $("proxy-server").value.trim() };
    return { mode };
  }

  function rangeKey(range) {
    return JSON.stringify(range);
  }

  function proxyKey(proxy) {
    return `${proxy.mode}|${proxy.server || ""}`;
  }

  function readRange() {
    const range = readRangeSelection();
    if (range.kind === "recent") {
      if (!Number.isInteger(range.months) || range.months < 1 || range.months > 120) {
        return { error: "月数必须是 1–120 的整数。" };
      }
    }
    if (range.kind === "month") {
      if (!Number.isInteger(range.year) || range.year < 2000 || range.year > 2100) {
        return { error: "年份必须是 2000–2100 的整数。" };
      }
      if (!Number.isInteger(range.month) || range.month < 1 || range.month > 12) {
        return { error: "月份必须是 1–12 的整数。" };
      }
    }
    return { range };
  }

  function readProxy() {
    const proxy = readProxySelection();
    if (proxy.mode === "fixed" && !proxy.server) {
      return { error: "固定代理需要填写地址，例如 http://127.0.0.1:7890。" };
    }
    return { proxy };
  }

  async function startQuery() {
    if (!bridge || state.starting) return;
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

    const source = $("source-select").value;
    const previousStatus = state.status === "idle" ? "idle" : state.status;
    setNotice("");
    state.starting = true;
    // await 之前立即进入准备态并禁用操作，避免重复提交
    setStatus("preparing");
    $("cancel-button").disabled = true;
    resetWorkspaceForStart();
    showPreparingEmpty();

    let result;
    try {
      result = await bridge.startQuery({
        target,
        source,
        range: range.range,
        proxy: proxy.proxy,
      });
    } catch (error) {
      result = { ok: false, error: { code: "INTERNAL", message: String(error) } };
    } finally {
      state.starting = false;
    }

    if (!result.ok) {
      setNotice(describeError(result.error), "error");
      setStatus(previousStatus);
      // 回滚到上一次查询的权威视图（旧任务仍然有效）
      await refresh().catch(() => undefined);
      return;
    }

    state.jobId = result.value.jobId;
    state.source = result.value.source;
    state.lastJobTarget = target;
    state.frozen = {
      target,
      source,
      rangeKey: rangeKey(range.range),
      proxyKey: proxyKey(proxy.proxy),
    };
    state.revision = 0;
    state.viewGeneration += 1;
    state.lastSeq = 0;
    state.scope = result.value.scope || null;
    resetWorkspaceForStart();
    showPreparingEmpty();
    renderScope({ scope: state.scope, source: result.value.source });
    renderStatus(null);
    $("task-text").textContent = `准备中 · ${target} · 正在建立查询会话…`;
    updateConfigHint();
    await refresh();
  }

  async function cancelQuery() {
    if (!bridge || state.jobId === null || state.starting) return;
    if (TERMINAL.has(state.status)) return;
    const result = await bridge.cancelQuery({ jobId: state.jobId, source: state.source });
    if (!result.ok) {
      setNotice(describeError(result.error), "error");
      return;
    }
    const status = result.value.status;
    if (TERMINAL.has(status)) {
      // 取消到达时任务已自然结束：以终态为准，不回写成“停止中”
      setStatus(status);
      scheduleRefresh();
      return;
    }
    setStatus(status);
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
    return Array.from(state.selected);
  }

  async function copySelected(mode) {
    if (!bridge || state.jobId === null) {
      setNotice("请先完成一次查询后再复制。", "error");
      return;
    }
    const rowIds = selectedRowIds();
    if (rowIds.length === 0) {
      setNotice("请先勾选要复制的行（或在表头全选当前页）。", "error");
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
    $("target-input").addEventListener("input", updateConfigHint);
    $("source-select").addEventListener("change", updateConfigHint);

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
      // 原因摘要复制需要主进程剪贴板通道（尚未交付），不得提示成功。
      selectElementContents($("reasons-list"));
      setNotice(
        "原因摘要复制尚未接通主进程剪贴板通道；已选中原因文本，可手动 Ctrl+C 复制。",
        "error",
      );
    });

    $("range-mode").addEventListener("change", () => {
      toggleRangeInputs();
      updateConfigHint();
    });
    for (const id of ["range-months", "range-year", "range-month-value"]) {
      $(id).addEventListener("input", updateConfigHint);
    }
    $("proxy-mode").addEventListener("change", () => {
      toggleProxyInputs();
      updateConfigHint();
    });
    $("proxy-server").addEventListener("input", updateConfigHint);

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
        if (ACTIVE.has(state.status)) {
          const progress = state.progress;
          let where = "正在读取";
          if (progress && progress.indexId) where = `索引 ${progress.indexId} 第 ${progress.page || 1} 页`;
          else if (progress && progress.page) where = `第 ${progress.page} 页`;
          $("task-text").textContent = `查询中 · ${where} · 已接收 ${state.received} / 去重 ${state.unique}`;
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
          } else if (next === "preparing") {
            $("task-text").textContent = "准备中 · 正在建立查询会话…";
          } else if (next === "running") {
            $("task-text").textContent = `查询中 · 已接收 ${state.received} / 去重 ${state.unique}`;
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
    updateConfigHint();
    bind();
  }

  boot();
})();
