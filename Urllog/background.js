const tabStateMap = new Map();
const tabWriteLocks = new Set(); // 新增：记录正在写入的 tabId

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

async function getSettings() {
  const data = await chrome.storage.local.get([
    "enabled",
    "autoSwitch",
    "logsByDate"
  ]);

  return {
    enabled: data.enabled ?? false,
    autoSwitch: data.autoSwitch ?? false,
    logsByDate: data.logsByDate ?? {}
  };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

chrome.runtime.onInstalled.addListener(async () => {
  const oldData = await chrome.storage.local.get([
    "enabled",
    "autoSwitch",
    "logsByDate"
  ]);

  await chrome.storage.local.set({
    enabled: oldData.enabled ?? false,
    autoSwitch: oldData.autoSwitch ?? false,
    logsByDate: oldData.logsByDate ?? {}
  });
});

function buildMediaSummary(media) {
  if (!media) return "";

  if (media.hasPlayingMedia) {
    return ` [PLAYING: ${media.videoCount}V ${media.audioCount}A]`;
  }

  if (media.hasEndedMedia) {
    return ` [PLAYED: ${media.endedVideoCount}V ${media.endedAudioCount}A]`;
  }

  return "";
}

function normalizeMediaState(result = {}) {
  const playingVideos = result.videos?.length ?? 0;
  const playingAudios = result.audios?.length ?? 0;
  const endedVideos = result.endedVideos?.length ?? 0;
  const endedAudios = result.endedAudios?.length ?? 0;

  return {
    hasPlayingMedia: playingVideos + playingAudios > 0,
    hasEndedMedia: endedVideos + endedAudios > 0,
    videoCount: playingVideos,
    audioCount: playingAudios,
    endedVideoCount: endedVideos,
    endedAudioCount: endedAudios
  };
}

async function queryMediaState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "GET_MEDIA_STATE" });
    return normalizeMediaState(response);
  } catch {
    return normalizeMediaState();
  }
}

function shouldSkipUrl(url) {
  return !url || url.startsWith("chrome://") || url.startsWith("chrome-extension://");
}

async function appendLog(url, media) {
  const { logsByDate } = await getSettings();
  const date = todayKey();

  logsByDate[date] ??= [];
  logsByDate[date].push(`${nowTime()} ${url}${buildMediaSummary(media)}`);

  await setSettings({ logsByDate });
}

async function clearTodayLogs() {
  const { logsByDate } = await getSettings();
  const date = todayKey();
  const count = logsByDate[date]?.length ?? 0;

  logsByDate[date] = [];
  await setSettings({ logsByDate });
  tabStateMap.clear();

  return count;
}

// 新增：带锁的统一写入入口
// 同一 tabId 若已有写入在进行中，则本次调用直接跳过，避免重复日志
async function tryWriteLog(tabId, url, media, force = false) {
  if (tabWriteLocks.has(tabId)) return;

  tabWriteLocks.add(tabId);

  try {
    const prev = tabStateMap.get(tabId);
    const nextState = { url, media };

    if (!force) {
      const sameState =
        prev &&
        prev.url === url &&
        prev.media.hasPlayingMedia === media.hasPlayingMedia &&
        prev.media.hasEndedMedia === media.hasEndedMedia &&
        prev.media.videoCount === media.videoCount &&
        prev.media.audioCount === media.audioCount &&
        prev.media.endedVideoCount === media.endedVideoCount &&
        prev.media.endedAudioCount === media.endedAudioCount;

      if (sameState) return;
    }

    await appendLog(url, media);
    tabStateMap.set(tabId, nextState);
  } finally {
    // 无论成功或异常，都必须释放锁，防止 tabId 被永久锁死
    tabWriteLocks.delete(tabId);
  }
}

// 修改：写入逻辑收口到 tryWriteLog，自身只负责数据采集
async function logTab(tabId, force = false) {
  const { enabled } = await getSettings();
  if (!enabled) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || shouldSkipUrl(tab.url)) return;

  const media = await queryMediaState(tabId);

  await tryWriteLog(tabId, tab.url, media, force);
}

async function switchToNextTab(currentTabId) {
  const { autoSwitch } = await getSettings();
  if (!autoSwitch) return;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (!tabs.length) return;

  const currentIndex = tabs.findIndex(tab => tab.id === currentTabId);
  if (currentIndex < 0) return;

  const nextIndex = (currentIndex + 1) % tabs.length;
  const nextTab = tabs[nextIndex];

  if (nextTab?.id) {
    await chrome.tabs.update(nextTab.id, { active: true });
  }
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Export logs as txt"
  });
}

async function startLogging() {
  await setSettings({ enabled: true });
  tabStateMap.clear();

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tabs[0]?.id) {
    await logTab(tabs[0].id, true);
  }
}

async function stopLogging() {
  await setSettings({ enabled: false });
  tabStateMap.clear();
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await logTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    await logTab(tabId);
  }
});

// 修改：标签页关闭时同步清理锁（防止 tabWriteLocks 残留）
chrome.tabs.onRemoved.addListener((tabId) => {
  tabStateMap.delete(tabId);
  tabWriteLocks.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === "START") {
      await startLogging();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "STOP") {
      await stopLogging();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "GET_STATE") {
      const { enabled, autoSwitch, logsByDate } = await getSettings();
      const date = todayKey();
      const todayLogs = logsByDate[date] || [];

      sendResponse({
        enabled,
        autoSwitch,
        todayCount: todayLogs.length,
        todayDate: date
      });
      return;
    }

    if (msg.type === "TOGGLE_AUTO_SWITCH") {
      await setSettings({ autoSwitch: !!msg.enabled });
      sendResponse({ success: true });
      return;
    }

    // 修改：写入逻辑收口到 tryWriteLog，与 logTab 互斥
    if (msg.type === "MEDIA_STATE_CHANGED") {
      const tabId = sender.tab?.id;
      const tab = sender.tab;

      if (!tabId || !tab?.active || shouldSkipUrl(tab.url)) {
        sendResponse({ success: true });
        return;
      }

      const media = normalizeMediaState(msg.payload);

      await tryWriteLog(tabId, tab.url, media);

      // autoSwitch：同时修复误触发（需确认已无正在播放的视频）
      if (media.endedVideoCount > 0 && media.videoCount === 0) {
        setTimeout(async () => {
          const currentTab = await chrome.tabs.get(tabId).catch(() => null);
          if (currentTab?.active) {
            await switchToNextTab(tabId);
          }
        }, 1000);
      }

      sendResponse({ success: true });
      return;
    }

    if (msg.type === "DOWNLOAD_TODAY") {
      const { logsByDate } = await getSettings();
      const date = todayKey();
      const logs = logsByDate[date] || [];

      if (!logs.length) {
        sendResponse({ success: false, error: "今天还没有记录可下载" });
        return;
      }

      await ensureOffscreen();

      await chrome.runtime.sendMessage({
        type: "SAVE_TXT",
        date,
        logs
      });

      sendResponse({ success: true, count: logs.length });
      return;
    }

    if (msg.type === "CLEAR_TODAY_LOGS") {
      const { logsByDate } = await getSettings();
      const date = todayKey();
      const count = logsByDate[date]?.length ?? 0;

      if (!count) {
        sendResponse({ success: false, error: "今天没有可清空的日志" });
        return;
      }

      const clearedCount = await clearTodayLogs();
      sendResponse({ success: true, count: clearedCount });
      return;
    }

    if (msg.type === "DOWNLOAD_TXT") {
      await chrome.downloads.download({
        url: msg.objectUrl,
        filename: `urls-${msg.date}.txt`,
        conflictAction: "overwrite",
        saveAs: false
      });

      sendResponse({ success: true });
      return;
    }

    sendResponse({ success: false, error: "Unknown message type" });
  })().catch((error) => {
    sendResponse({
      success: false,
      error: error?.message || "Unexpected error"
    });
  });

  return true;
});