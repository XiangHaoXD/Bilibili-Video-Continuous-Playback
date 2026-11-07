const toggleBtn        = document.getElementById("toggleBtn");
const toggleBtnLabel   = document.getElementById("toggleBtnLabel");  // 新增
const downloadBtn      = document.getElementById("downloadBtn");
const clearBtn         = document.getElementById("clearBtn");
const statusText       = document.getElementById("statusText");
const messageDiv       = document.getElementById("message");
const autoSwitchToggle = document.getElementById("autoSwitchToggle");
const autoLikeToggle   = document.getElementById("autoLikeToggle");

const toggleMeta = document.getElementById("toggleMeta");

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
  // 只显示 yy-mm-dd 和已记录条数，紧凑展示
  const dateShort = (todayDate || "").slice(2);
  toggleMeta.innerHTML =
    `<span class="meta-date">${dateShort || "--"}</span> · ` +
    `<span class="meta-count">已记录 <b>${todayCount}</b> 条</span>`;
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
  autoLikeToggle.checked = !!state.autoLike;
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

// 两个设置开关共用同一套交互：禁用输入 → 发消息 → 成功刷新 / 失败回滚
async function updateToggle(input, type, messages) {
  const enabled = input.checked;
  input.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({ type, enabled });

    if (result?.success) {
      showMessage(enabled ? messages.enabled : messages.disabled);
      // 刷新失败只提示刷新失败，不回滚已经保存的设置
      refreshState().catch((error) => {
        showMessage(`✗ 状态刷新失败：${error?.message || "未知错误"}`, "error");
      });
    } else {
      input.checked = !enabled;
      showMessage(`✗ ${result?.error || "设置失败"}`, "error");
    }
  } catch (err) {
    input.checked = !enabled;
    showMessage(`✗ ${err?.message || "设置失败"}`, "error");
  } finally {
    input.disabled = false;
  }
}

autoSwitchToggle.addEventListener("change", (e) =>
  updateToggle(e.target, "TOGGLE_AUTO_SWITCH", {
    enabled: "✓ 已启用自动切换标签页",
    disabled: "✓ 已关闭自动切换"
  })
);

autoLikeToggle.addEventListener("change", (e) =>
  updateToggle(e.target, "TOGGLE_AUTO_LIKE", {
    enabled: "✓ 已启用自动点赞（B站）",
    disabled: "✓ 已关闭自动点赞"
  })
);

confirmModal.addEventListener("click", (e) => {
  if (e.target === confirmModal) closeConfirmModal();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeConfirmModal();
});

init().catch((error) => {
  showMessage(`✗ ${error?.message || "读取扩展状态失败"}`, "error");
});
