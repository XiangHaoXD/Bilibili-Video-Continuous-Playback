const toggleBtn        = document.getElementById("toggleBtn");
const toggleBtnLabel   = document.getElementById("toggleBtnLabel");  // 新增
const downloadBtn      = document.getElementById("downloadBtn");
const clearBtn         = document.getElementById("clearBtn");
const statusText       = document.getElementById("statusText");
const messageDiv       = document.getElementById("message");
const autoSwitchToggle = document.getElementById("autoSwitchToggle");

const todayCountEl = document.getElementById("todayCount");
const todayDateEl  = document.getElementById("todayDate");

const confirmModal   = document.getElementById("confirmModal");
const cancelClearBtn = document.getElementById("cancelClearBtn");
const confirmClearBtn= document.getElementById("confirmClearBtn");

let messageTimer = null;

function showMessage(text, type = "success") {
  if (messageTimer) clearTimeout(messageTimer);

  messageDiv.textContent = text;
  messageDiv.className   = `message ${type}`;
  messageDiv.style.display = "block";

  messageTimer = setTimeout(() => {
    messageDiv.style.display = "none";
  }, 2500);
}

// 修改：statusBox 与 toggleBtn 合并，改为操作 toggleBtn 自身的 class
function renderStatus(enabled) {
  toggleBtn.classList.toggle("active",   enabled);
  toggleBtn.classList.toggle("inactive", !enabled);
  statusText.textContent     = enabled ? "正在记录中..." : "记录已停止";
  toggleBtnLabel.textContent = enabled ? "停止记录"      : "开始记录";
}

function renderStats(todayCount, todayDate) {
  todayCountEl.textContent = `${todayCount} 条`;
  todayDateEl.textContent  = todayDate || "--";
}

function openConfirmModal() {
  confirmModal.classList.add("show");
  confirmModal.setAttribute("aria-hidden", "false");
}

function closeConfirmModal() {
  confirmModal.classList.remove("show");
  confirmModal.setAttribute("aria-hidden", "true");
}

async function refreshState() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  renderStatus(!!state.enabled);
  autoSwitchToggle.checked = !!state.autoSwitch;
  renderStats(state.todayCount ?? 0, state.todayDate ?? "--");
}

async function init() {
  await refreshState();
}

toggleBtn.addEventListener("click", async () => {
  toggleBtn.disabled = true;

  try {
    const state  = await chrome.runtime.sendMessage({ type: "GET_STATE" });
    const type   = state.enabled ? "STOP" : "START";
    const result = await chrome.runtime.sendMessage({ type });

    if (result?.success) {
      showMessage(state.enabled ? "✓ 已停止记录" : "✓ 已开始记录 URL");
      await refreshState();
    } else {
      showMessage(`✗ ${result?.error || "操作失败"}`, "error");
    }
  } catch (err) {
    showMessage(`✗ ${err?.message || "操作失败"}`, "error");
  } finally {
    toggleBtn.disabled = false;
  }
});

downloadBtn.addEventListener("click", async () => {
  downloadBtn.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: "DOWNLOAD_TODAY" });

    if (result?.success) {
      showMessage(`✓ 已保存 ${result.count} 条记录`);
      await refreshState();
    } else {
      showMessage(`✗ ${result?.error || "下载失败"}`, "error");
    }
  } catch (err) {
    showMessage(`✗ ${err?.message || "下载失败"}`, "error");
  } finally {
    downloadBtn.disabled = false;
  }
});

clearBtn.addEventListener("click", () => {
  openConfirmModal();
});

cancelClearBtn.addEventListener("click", () => {
  closeConfirmModal();
});

confirmClearBtn.addEventListener("click", async () => {
  confirmClearBtn.disabled = true;
  cancelClearBtn.disabled  = true;

  try {
    const result = await chrome.runtime.sendMessage({ type: "CLEAR_TODAY_LOGS" });

    if (result?.success) {
      closeConfirmModal();
      showMessage(`✓ 已清空今日日志（${result.count} 条）`);
      await refreshState();
    } else {
      closeConfirmModal();
      showMessage(`✗ ${result?.error || "清空失败"}`, "error");
    }
  } catch (err) {
    closeConfirmModal();
    showMessage(`✗ ${err?.message || "清空失败"}`, "error");
  } finally {
    confirmClearBtn.disabled = false;
    cancelClearBtn.disabled  = false;
  }
});

autoSwitchToggle.addEventListener("change", async (e) => {
  const enabled = e.target.checked;
  autoSwitchToggle.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      type: "TOGGLE_AUTO_SWITCH",
      enabled
    });

    if (result?.success) {
      showMessage(enabled ? "✓ 已启用自动切换标签页" : "✓ 已关闭自动切换");
      await refreshState();
    } else {
      autoSwitchToggle.checked = !enabled;
      showMessage(`✗ ${result?.error || "设置失败"}`, "error");
    }
  } catch (err) {
    autoSwitchToggle.checked = !enabled;
    showMessage(`✗ ${err?.message || "设置失败"}`, "error");
  } finally {
    autoSwitchToggle.disabled = false;
  }
});

confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirmModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeConfirmModal();
});

init();