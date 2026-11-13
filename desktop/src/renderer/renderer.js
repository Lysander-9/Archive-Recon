/* Minimal renderer shell: consumes the preload bridge and page views only. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const bridge = window.archiveRecon;

  const state = {
    jobId: null,
    source: "wayback",
    revision: 0,
    pageIndex: 0,
    pageSize: 50,
    filter: { status: "", fileType: "", urlKeyword: "", domain: "", interestingOnly: false },
    sort: { key: "timestamp", reverse: false },
    rows: [],
    pageCount: 0,
    status: "idle",
    terminal: true,
  };

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

  let refreshTimer = null;

  function setNotice(message, isError) {
    const node = $("notice");
    node.textContent = message || "";
    node.style.color = isError ? "#d13c4b" : "";
  }

  function setStatus(status) {
    state.status = status;
    const chip = $("status-chip");
    chip.textContent = STATUS_LABEL[status] || status;
    chip.className = `chip ${status}`;
    const terminal = ["completed", "partial", "failed", "stopped"].includes(status) || status === "idle";
    state.terminal = terminal;
    $("start-button").disabled = !terminal;
    $("cancel-button").disabled = !["preparing", "running", "stopping"].includes(status);
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, 40);
  }

  function currentFilter() {
    return {
      status: $("filter-status").value,
      fileType: $("filter-filetype").value,
      urlKeyword: $("filter-url").value,
      domain: "",
      interestingOnly: false,
    };
  }

  function applyFilterInputs() {
    state.filter = currentFilter();
    state.pageIndex = 0;
    void refresh();
  }

  function clearFilters() {
    $("filter-status").value = "";
    $("filter-filetype").value = "";
    $("filter-url").value = "";
    state.filter = { status: "", fileType: "", urlKeyword: "", domain: "", interestingOnly: false };
    state.pageIndex = 0;
    void refresh();
  }

  function render(view) {
    state.revision = view.revision;
    state.rows = view.rows;
    state.pageCount = view.pageCount;
    state.pageIndex = view.pageIndex;
    state.terminal = view.terminal;
    setStatus(view.status);

    $("scope-label").textContent = `目标 ${view.scope.label} · ${view.scope.rangeLabel} · ${view.scope.proxyDisplay}`;
    $("summary").textContent = `匹配 ${view.matched} / 去重 ${view.unique} / 接收 ${view.received}`;
    $("page-label").textContent =
      view.pageCount === 0 ? "第 0 / 0 页" : `第 ${view.pageIndex + 1} / ${view.pageCount} 页`;
    $("prev-page").disabled = view.pageIndex <= 0;
    $("next-page").disabled = view.pageCount === 0 || view.pageIndex >= view.pageCount - 1;

    const body = $("rows-body");
    body.textContent = "";
    for (const row of view.rows) {
      const tr = document.createElement("tr");
      tr.dataset.rowId = row.rowId;

      const selectCell = document.createElement("td");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.rowId = row.rowId;
      selectCell.appendChild(checkbox);
      tr.appendChild(selectCell);

      for (const value of [row.timestamp, row.statusCode, row.length, row.fileType]) {
        const cell = document.createElement("td");
        cell.textContent = value;
        tr.appendChild(cell);
      }
      const urlCell = document.createElement("td");
      urlCell.className = "url";
      urlCell.textContent = row.url;
      tr.appendChild(urlCell);

      body.appendChild(tr);
    }

    const empty = $("empty-state");
    if (view.rows.length === 0) {
      empty.classList.remove("hidden");
      if (view.total === 0) {
        empty.textContent = view.terminal ? "查询完成，没有找到存档记录。" : "正在读取，暂无可用记录…";
      } else {
        empty.textContent = "没有符合条件的结果；清除筛选或调整关键词后重试。";
      }
    } else {
      empty.classList.add("hidden");
    }

    if (view.reasons.length > 0) {
      setNotice(`${view.reasons.length} 项不完整原因：${view.reasons[0].message}`, false);
    }
  }

  async function refresh() {
    if (!bridge) return;
    if (state.jobId === null) return;
    const result = await bridge.getView({
      jobId: state.jobId,
      source: state.source,
      filter: state.filter,
      sort: state.sort,
      pageIndex: state.pageIndex,
      pageSize: state.pageSize,
    });
    if (!result.ok) {
      setNotice(`${result.error.code}：${result.error.message}`, true);
      return;
    }
    render(result.value);
  }

  async function startQuery() {
    if (!bridge) return;
    const target = $("target-input").value.trim();
    if (!target) {
      setNotice("请输入目标域名后再开始查询。", true);
      return;
    }
    const mode = $("range-mode").value;
    let range;
    if (mode === "recent") {
      range = { kind: "recent", months: Number($("range-months").value || 3) };
    } else if (mode === "month") {
      range = {
        kind: "month",
        year: Number($("range-year").value || new Date().getUTCFullYear()),
        month: Number($("range-month-value").value || 1),
      };
    } else {
      range = { kind: "all" };
    }
    const proxyMode = $("proxy-mode").value;
    const proxy =
      proxyMode === "fixed"
        ? { mode: "fixed", server: $("proxy-server").value.trim() }
        : { mode: proxyMode };

    setNotice("");
    const result = await bridge.startQuery({
      target,
      source: $("source-select").value,
      range,
      proxy,
    });
    if (!result.ok) {
      setNotice(`${result.error.code}：${result.error.message}`, true);
      return;
    }
    state.jobId = result.value.jobId;
    state.source = result.value.source;
    state.pageIndex = 0;
    setStatus("preparing");
    await refresh();
  }

  async function cancelQuery() {
    if (!bridge || state.jobId === null) return;
    const result = await bridge.cancelQuery({ jobId: state.jobId, source: state.source });
    if (!result.ok) setNotice(`${result.error.code}：${result.error.message}`, true);
    else setStatus(result.value.status);
  }

  async function exportResults(format) {
    if (!bridge || state.jobId === null) return;
    const result = await bridge.exportResults({
      jobId: state.jobId,
      source: state.source,
      expectedRevision: state.revision,
      filter: state.filter,
      sort: state.sort,
      format,
    });
    if (!result.ok) {
      setNotice(`${result.error.code}：${result.error.message}`, true);
      return;
    }
    if (!result.value.saved) {
      setNotice("导出已取消。", false);
      return;
    }
    setNotice(`已导出 ${result.value.count} 条记录。`, false);
  }

  async function copySelected() {
    if (!bridge || state.jobId === null) return;
    const checked = Array.from(document.querySelectorAll("#rows-body input[type=checkbox]:checked"));
    const rowIds = checked.length > 0 ? checked.map((node) => node.dataset.rowId) : state.rows.map((row) => row.rowId);
    const result = await bridge.copySelection({
      jobId: state.jobId,
      source: state.source,
      revision: state.revision,
      rowIds,
      mode: "url",
    });
    if (!result.ok) {
      setNotice(`${result.error.code}：${result.error.message}`, true);
      return;
    }
    setNotice(`已复制 ${result.value.copiedCount} 条 URL。`, false);
  }

  function toggleRangeInputs() {
    const mode = $("range-mode").value;
    $("range-recent").classList.toggle("hidden", mode !== "recent");
    $("range-month").classList.toggle("hidden", mode !== "month");
  }

  function toggleProxyInputs() {
    $("proxy-fixed").classList.toggle("hidden", $("proxy-mode").value !== "fixed");
  }

  function sortBy(key) {
    if (state.sort.key === key) state.sort.reverse = !state.sort.reverse;
    else state.sort = { key, reverse: false };
    state.pageIndex = 0;
    void refresh();
  }

  function bind() {
    if (!bridge) {
      setNotice("preload 桥接不可用。", true);
      return;
    }
    $("start-button").addEventListener("click", () => void startQuery());
    $("cancel-button").addEventListener("click", () => void cancelQuery());
    $("apply-filter").addEventListener("click", applyFilterInputs);
    $("clear-filter").addEventListener("click", clearFilters);
    $("export-csv").addEventListener("click", () => void exportResults("csv"));
    $("export-json").addEventListener("click", () => void exportResults("json"));
    $("copy-url").addEventListener("click", () => void copySelected());
    $("range-mode").addEventListener("change", toggleRangeInputs);
    $("proxy-mode").addEventListener("change", toggleProxyInputs);
    $("page-size").addEventListener("change", () => {
      state.pageSize = Number($("page-size").value);
      state.pageIndex = 0;
      void refresh();
    });
    $("prev-page").addEventListener("click", () => {
      state.pageIndex = Math.max(0, state.pageIndex - 1);
      void refresh();
    });
    $("next-page").addEventListener("click", () => {
      state.pageIndex = Math.min(state.pageCount - 1, state.pageIndex + 1);
      void refresh();
    });
    for (const header of document.querySelectorAll("th[data-sort]")) {
      header.addEventListener("click", () => sortBy(header.dataset.sort));
    }
    bridge.onJobEvent((event) => {
      if (event.jobId !== state.jobId || event.source !== state.source) return;
      if (event.kind === "state" && typeof event.payload.status === "string") {
        setStatus(event.payload.status);
      }
      if (event.kind === "viewChanged" || event.kind === "state") scheduleRefresh();
    });
    toggleRangeInputs();
    toggleProxyInputs();
  }

  bind();
})();
