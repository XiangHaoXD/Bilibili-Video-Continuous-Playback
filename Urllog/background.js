const tabStateMap = new Map();
const tabWriteLocks = new Set();

const LOG_RETENTION_DAYS = 7;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function logStorageKey(date) {
  return `logs-${date}`;
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

async function getSettings() {
  const data = await chrome.storage.local.get(["enabled", "autoSwitch"]);
  return {
    enabled: data.enabled ?? false,
    autoSwitch: data.autoSwitch ?? false
  };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

async function getTodayLogs() {
  const key = logStorageKey(todayKey());
  const data = await chrome.storage.local.get([key]);
  return data[key] ?? [];
}

async function setTodayLogs(logs) {
  const key = logStorageKey(todayKey());
  await chrome.storage.local.set({ [key]: logs });
}

async function cleanupOldLogs() {
  const allKeys = await chrome.storage.local.get(null);
  const keysToRemove = [];
  const now = new Date();

  for (const key of Object.keys(allKeys)) {
    if (!key.startsWith("logs-")) continue;

    const dateStr = key.replace("logs-", "");
    const logDate = new Date(dateStr + "T00:00:00");

    if (isNaN(logDate.getTime())) {
      keysToRemove.push(key);
      continue;
    }

    const diffDays = Math.floor((now - logDate) / (1000 * 60 * 60 * 24));
    if (diffDays > LOG_RETENTION_DAYS) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
    console.log(`[URL Logger] Cleaned up ${keysToRemove.length} old log entries.`);
  }
}

async function migrateOldFormat() {
  const data = await chrome.storage.local.get(["logsByDate"]);
  if (!data.logsByDate) return;

  const logsByDate = data.logsByDate;
  const batch = {};

  for (const [date, logs] of Object.entries(logsByDate)) {
    if (Array.isArray(logs) && logs.length > 0) {
      batch[logStorageKey(date)] = logs;
    }
  }

  if (Object.keys(batch).length > 0) {
    await chrome.storage.local.set(batch);
  }

  await chrome.storage.local.remove(["logsByDate"]);
  console.log("[URL Logger] Migrated logsByDate to per-day keys.");
}

chrome.runtime.onInstalled.addListener(async () => {
  const oldData = await chrome.storage.local.get(["enabled", "autoSwitch"]);

  await chrome.storage.local.set({
    enabled: oldData.enabled ?? false,
    autoSwitch: oldData.autoSwitch ?? false
  });

  await migrateOldFormat();
  await cleanupOldLogs();
});

function buildMediaSummary(media) {
  if (!media) return "";

  if (media.isLivePage) {
    return " [LIVE]";
  }

  if (media.hasPlayingMedia) {
    return ` [PLAYING: ${media.videoCount}V ${media.audioCount}A]`;
  }

  if (media.hasEndedMedia) {
    return ` [PLAYED: ${media.endedVideoCount}V ${media.endedAudioCount}A]`;
  }

  return "";
}

function normalizeMediaState(result = {}) {
  // 如果是直播页面，直接返回直播标记
  if (result.isLivePage) {
    return {
      isLivePage: true,
      hasPlayingMedia: false,
      hasEndedMedia: false,
      videoCount: 0,
      audioCount: 0,
      endedVideoCount: 0,
      endedAudioCount: 0
    };
  }

  const playingVideos = result.videos?.length ?? 0;
  const playingAudios = result.audios?.length ?? 0;
  const endedVideos = result.endedVideos?.length ?? 0;
  const endedAudios = result.endedAudios?.length ?? 0;

  return {
    isLivePage: false,
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
  const logs = await getTodayLogs();
  logs.push(`${nowTime()} ${url}${buildMediaSummary(media)}`);
  await setTodayLogs(logs);
}

async function clearTodayLogs() {
  const logs = await getTodayLogs();
  const count = logs.length;
  await setTodayLogs([]);
  tabStateMap.clear();
  return count;
}

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
        prev.media.isLivePage === media.isLivePage &&
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
    tabWriteLocks.delete(tabId);
  }
}

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

  // 切换前二次确认：重新查询媒体状态
  const media = await queryMediaState(currentTabId);

  // 如果是直播页面，绝不切换
  if (media.isLivePage) return;

  // 如果视频恢复播放了（比如卡顿后恢复），取消切换
  if (media.hasPlayingMedia) return;

  // 确认确实有视频已结束且没有正在播放的视频
  if (!(media.endedVideoCount > 0 && media.videoCount === 0)) return;

  const tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length <= 1) return;

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

  await cleanupOldLogs();

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
      const { enabled, autoSwitch } = await getSettings();
      const todayLogs = await getTodayLogs();

      sendResponse({
        enabled,
        autoSwitch,
        todayCount: todayLogs.length,
        todayDate: todayKey()
      });
      return;
    }

    if (msg.type === "TOGGLE_AUTO_SWITCH") {
      await setSettings({ autoSwitch: !!msg.enabled });
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "MEDIA_STATE_CHANGED") {
      const tabId = sender.tab?.id;
      const tab = sender.tab;

      if (!tabId || !tab?.active || shouldSkipUrl(tab.url)) {
        sendResponse({ success: true });
        return;
      }

      const media = normalizeMediaState(msg.payload);

      // 直播页面：只记录日志，绝不触发切换
      if (media.isLivePage) {
        await tryWriteLog(tabId, tab.url, media);
        sendResponse({ success: true });
        return;
      }

      await tryWriteLog(tabId, tab.url, media);

      // 只有非直播视频结束时才考虑切换
      if (media.endedVideoCount > 0 && media.videoCount === 0) {
        setTimeout(async () => {
          const currentTab = await chrome.tabs.get(tabId).catch(() => null);
          if (currentTab?.active) {
            await switchToNextTab(tabId);
          }
        }, 1500);
      }

      sendResponse({ success: true });
      return;
    }

    if (msg.type === "DOWNLOAD_TODAY") {
      const logs = await getTodayLogs();
      const date = todayKey();

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
      const logs = await getTodayLogs();

      if (!logs.length) {
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