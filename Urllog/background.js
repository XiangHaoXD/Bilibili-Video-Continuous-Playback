const LOG_RETENTION_DAYS = 3;
const LOG_CHUNK_SIZE = 100;
const AUTO_SWITCH_DELAY_MS = 1500;

const TAB_STATE_PREFIX = "tabState:";
const LEGACY_TAB_STATES_KEY = "tabStates";
const SWITCHED_TABS_KEY = "switchedTabs";
const CLEANUP_DATE_KEY = "lastCleanupDate";

const tabStateMap = new Map();
const switchedTabs = new Set();
const tabSwitchTimers = new Map();

// 刚切过去的标签页在短时间内自带的 ended 状态不应再触发一次切换
const SWITCH_TARGET_SUPPRESS_MS = 3000;
let lastSwitchTarget = null;

let logCache = null; // { date: "YYYY-MM-DD", chunks: string[][] }
let writeChain = Promise.resolve();
let sessionWriteChain = Promise.resolve();

// 串行化所有日志写入，避免多标签页同时“读-改-写”互相覆盖
function enqueueWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

// session 写入同样串行化，保证增量状态与去重列表的写入顺序
function enqueueSessionWrite(task) {
  const run = sessionWriteChain.then(task, task);
  sessionWriteChain = run.catch(() => {});
  return run;
}

// ── 日期与存储键（统一使用本地时区，避免凌晨写入前一天） ──
function dateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayKey() {
  return dateKey();
}

function parseDateKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value || "");
  if (!match) return null;

  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function logStorageKey(date) {
  return `logs-${date}`;
}

function logChunkKey(date, index) {
  return `${logStorageKey(date)}-c${index}`;
}

// 显式格式化，避免 toLocaleTimeString() 因系统 locale 变成 12 小时制或省略秒
function nowTime() {
  const now = new Date();
  return [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

// ── 设置 ──
async function getSettings() {
  const data = await chrome.storage.local.get(["enabled", "autoSwitch", "autoLike"]);
  return {
    enabled: data.enabled ?? false,
    autoSwitch: data.autoSwitch ?? false,
    autoLike: data.autoLike ?? false
  };
}

async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

// ── 标签页状态（storage.session 在 Service Worker 回收后仍然保留） ──
// v2.5.0 起每个标签页单独一个 key（tabState:<tabId>），媒体事件只写自己那一份，
// 不再每次重写整个 map。
const sessionAvailable = Boolean(chrome.storage.session);

function tabStateStorageKey(tabId) {
  return `${TAB_STATE_PREFIX}${tabId}`;
}

async function hydrateTabStates() {
  if (!sessionAvailable) return;

  try {
    const saved = await chrome.storage.session.get(null);

    for (const [key, state] of Object.entries(saved)) {
      if (!key.startsWith(TAB_STATE_PREFIX)) continue;

      const tabId = Number(key.slice(TAB_STATE_PREFIX.length));
      if (!Number.isInteger(tabId) || !state || typeof state !== "object") continue;

      tabStateMap.set(tabId, state);
    }

    const switched = saved[SWITCHED_TABS_KEY];
    if (Array.isArray(switched)) {
      for (const value of switched) {
        const tabId = Number(value);
        if (Number.isInteger(tabId)) switchedTabs.add(tabId);
      }
    }

    // 兼容 v2.4.0 的单个 tabStates 对象，导入后删除旧 key
    const legacy = saved[LEGACY_TAB_STATES_KEY];
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      const batch = {};
      for (const [key, state] of Object.entries(legacy)) {
        const tabId = Number(key);
        if (!Number.isInteger(tabId) || !state || typeof state !== "object") continue;
        if (tabStateMap.has(tabId)) continue;

        tabStateMap.set(tabId, state);
        batch[tabStateStorageKey(tabId)] = state;
      }

      if (Object.keys(batch).length > 0) {
        await chrome.storage.session.set(batch);
      }
      await chrome.storage.session.remove(LEGACY_TAB_STATES_KEY);
    }
  } catch {
    // session storage 不可用时退化为纯内存去重
  }
}

const tabStatesHydrated = hydrateTabStates();

async function persistTabState(tabId) {
  if (!sessionAvailable) return;

  // 等 session 状态恢复完成，避免用空 map 覆盖已持久化的状态
  await tabStatesHydrated;

  const key = tabStateStorageKey(tabId);
  const state = tabStateMap.get(tabId);

  await enqueueSessionWrite(async () => {
    if (state) {
      await chrome.storage.session.set({ [key]: state });
    } else {
      await chrome.storage.session.remove(key);
    }
  }).catch(() => {
    // 忽略：下一次写入会再次尝试
  });
}

function persistSwitchedTabs() {
  if (!sessionAvailable) return;

  enqueueSessionWrite(async () => {
    await tabStatesHydrated;
    await chrome.storage.session.set({ [SWITCHED_TABS_KEY]: [...switchedTabs] });
  }).catch(() => {
    // 忽略：下一次写入会再次尝试
  });
}

// 只清理标签页日志去重状态，保留 switchedTabs（自动切换与记录开关相互独立）
async function clearTabStates() {
  if (!sessionAvailable) return;

  await enqueueSessionWrite(async () => {
    await tabStatesHydrated;

    const saved = await chrome.storage.session.get(null);
    const keys = Object.keys(saved).filter(
      (key) => key.startsWith(TAB_STATE_PREFIX) || key === LEGACY_TAB_STATES_KEY
    );

    if (keys.length > 0) {
      await chrome.storage.session.remove(keys);
    }
  }).catch(() => {
    // 忽略：session 不可用时无需清理
  });
}

// ── 日志读取与分块写入 ──
// v2.4.0 起每天按 LOG_CHUNK_SIZE 条一块存储（logs-YYYY-MM-DD-cN），
// 追加时只重写最后一块，避免每次追加都重写当天完整数组。
function countLogs(cache) {
  return cache.chunks.reduce((total, entries) => total + entries.length, 0);
}

async function ensureLogCache() {
  const date = todayKey();
  if (logCache && logCache.date === date) return logCache;

  const all = await chrome.storage.local.get(null);
  const prefix = `${logStorageKey(date)}-c`;
  const chunks = [];

  const storedChunks = Object.keys(all)
    .filter((key) => key.startsWith(prefix))
    .map((key) => [Number(key.slice(prefix.length)), all[key]])
    .filter(([index, entries]) => Number.isInteger(index) && index >= 0 && Array.isArray(entries))
    .sort((a, b) => a[0] - b[0]);

  for (const [, entries] of storedChunks) {
    chunks.push(entries.slice());
  }

  // 兼容 v2.3.0 及更早的单 key 数组格式：首次访问时拆分成块。
  // 若块已存在，则以块为准，避免迁移中断后重复导入旧数据。
  const legacy = all[logStorageKey(date)];
  if (Array.isArray(legacy)) {
    if (chunks.length === 0 && legacy.length > 0) {
      const batch = {};
      for (let index = 0; index * LOG_CHUNK_SIZE < legacy.length; index += 1) {
        const entries = legacy.slice(index * LOG_CHUNK_SIZE, (index + 1) * LOG_CHUNK_SIZE);
        chunks.push(entries);
        batch[logChunkKey(date, index)] = entries;
      }
      await chrome.storage.local.set(batch);
    }
    await chrome.storage.local.remove(logStorageKey(date));
  }

  logCache = { date, chunks };

  // 跨日或 Service Worker 重启后，补一次过期清理
  await cleanupOldLogsIfNeeded();

  return logCache;
}

async function getTodayLogs() {
  const cache = await ensureLogCache();
  return cache.chunks.flat();
}

async function getTodayCount() {
  const cache = await ensureLogCache();
  return countLogs(cache);
}

async function appendLog(url, media) {
  const cache = await ensureLogCache();
  const entry = `${nowTime()} ${url}${buildMediaSummary(media)}`;

  let chunk = cache.chunks[cache.chunks.length - 1];
  if (!chunk || chunk.length >= LOG_CHUNK_SIZE) {
    chunk = [];
    cache.chunks.push(chunk);
  }

  chunk.push(entry);
  const index = cache.chunks.length - 1;
  await chrome.storage.local.set({ [logChunkKey(cache.date, index)]: chunk.slice() });
}

async function clearTodayLogs() {
  return enqueueWrite(async () => {
    await tabStatesHydrated;

    const cache = await ensureLogCache();
    const count = countLogs(cache);

    const keys = cache.chunks.map((_, index) => logChunkKey(cache.date, index));
    if (keys.length > 0) {
      await chrome.storage.local.remove(keys);
    }
    cache.chunks.length = 0;

    tabStateMap.clear();
    await clearTabStates();

    return count;
  });
}

async function cleanupOldLogs() {
  const allKeys = await chrome.storage.local.get(null);
  const today = parseDateKey(todayKey());
  const keysToRemove = [];

  for (const key of Object.keys(allKeys)) {
    if (!key.startsWith("logs-")) continue;

    const match = /^logs-(\d{4}-\d{2}-\d{2})(?:-c\d+)?$/.exec(key);
    const logDate = match ? parseDateKey(match[1]) : null;

    if (!logDate) {
      keysToRemove.push(key);
      continue;
    }

    const diffDays = Math.round((today - logDate) / (1000 * 60 * 60 * 24));
    if (diffDays >= LOG_RETENTION_DAYS) {
      keysToRemove.push(key);
    }
  }

  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
    console.log(`[URL Logger] Cleaned up ${keysToRemove.length} old log entries.`);
  }
}

// 每天只清理一次，避免每次 Service Worker 启动都全量扫描
async function cleanupOldLogsIfNeeded(force = false) {
  try {
    const today = todayKey();
    const stored = await chrome.storage.local.get(CLEANUP_DATE_KEY);

    if (!force && stored?.[CLEANUP_DATE_KEY] === today) return;

    await cleanupOldLogs();
    await chrome.storage.local.set({ [CLEANUP_DATE_KEY]: today });
  } catch (error) {
    // 清理失败不应影响日志记录本身
    console.warn("[URL Logger] Cleanup skipped:", error);
  }
}

async function migrateOldFormat() {
  const data = await chrome.storage.local.get(["logsByDate"]);
  if (!data.logsByDate) return;

  const logsByDate = data.logsByDate;
  const batch = {};

  for (const [date, logs] of Object.entries(logsByDate)) {
    if (!Array.isArray(logs) || logs.length === 0) continue;

    for (let index = 0; index * LOG_CHUNK_SIZE < logs.length; index += 1) {
      batch[logChunkKey(date, index)] = logs.slice(
        index * LOG_CHUNK_SIZE,
        (index + 1) * LOG_CHUNK_SIZE
      );
    }
  }

  if (Object.keys(batch).length > 0) {
    await chrome.storage.local.set(batch);
  }

  await chrome.storage.local.remove(["logsByDate"]);
  console.log("[URL Logger] Migrated logsByDate to chunked per-day keys.");
}

chrome.runtime.onInstalled.addListener(async () => {
  const oldData = await chrome.storage.local.get(["enabled", "autoSwitch", "autoLike"]);

  await chrome.storage.local.set({
    enabled: oldData.enabled ?? false,
    autoSwitch: oldData.autoSwitch ?? false,
    autoLike: oldData.autoLike ?? false
  });

  await migrateOldFormat();
  await cleanupOldLogsIfNeeded(true);
});

// ── 媒体状态 ──
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

  if (media.hasPausedMedia) {
    return ` [PAUSED: ${media.pausedVideoCount}V ${media.pausedAudioCount}A]`;
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
      hasPausedMedia: false,
      mainVideoEnded: false,
      videoCount: 0,
      audioCount: 0,
      endedVideoCount: 0,
      endedAudioCount: 0,
      pausedVideoCount: 0,
      pausedAudioCount: 0
    };
  }

  const playingVideos = result.videos?.length ?? 0;
  const playingAudios = result.audios?.length ?? 0;
  const endedVideos = result.endedVideos?.length ?? 0;
  const endedAudios = result.endedAudios?.length ?? 0;
  const pausedVideos = result.pausedVideos?.length ?? 0;
  const pausedAudios = result.pausedAudios?.length ?? 0;

  // 旧版内容脚本没有 mainVideoEnded 字段时退回“任意视频结束”的旧行为，
  // 避免扩展更新后、页面还没刷新时自动点赞直接失效。
  const mainVideoEnded =
    result.mainVideoEnded === undefined ? endedVideos > 0 : Boolean(result.mainVideoEnded);

  return {
    isLivePage: false,
    hasPlayingMedia: playingVideos + playingAudios > 0,
    hasEndedMedia: endedVideos + endedAudios > 0,
    hasPausedMedia: pausedVideos + pausedAudios > 0,
    mainVideoEnded,
    videoCount: playingVideos,
    audioCount: playingAudios,
    endedVideoCount: endedVideos,
    endedAudioCount: endedAudios,
    pausedVideoCount: pausedVideos,
    pausedAudioCount: pausedAudios
  };
}

async function queryMediaState(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: "GET_MEDIA_STATE" },
      { frameId: 0 }
    );
    return normalizeMediaState(response);
  } catch {
    return normalizeMediaState();
  }
}

function shouldSkipUrl(url) {
  return !/^https?:\/\//i.test(url || "");
}

// ── 日志写入 ──
// 敏感查询参数与超长 token 值在写日志前脱敏，避免把登录态/分享 token 明文存下来
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "refresh_token",
  "id_token",
  "auth",
  "authorization",
  "session",
  "sessionid",
  "session_id",
  "csrf",
  "bili_jct",
  "sessdata",
  "sign",
  "signature",
  "key",
  "api_key",
  "apikey",
  "secret",
  "password",
  "passwd",
  "pwd",
  "ticket",
  "uid",
  "mid",
  "userid",
  "user_id",
  "email",
  "phone",
  "vd_source"
]);
const LONG_TOKEN_PATTERN = /^[A-Za-z0-9_\-=]{32,}$/;

function sanitizeUrl(url) {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    let changed = false;

    for (const key of keys) {
      const value = parsed.searchParams.get(key) || "";
      if (
        SENSITIVE_QUERY_KEYS.has(key.toLowerCase()) ||
        LONG_TOKEN_PATTERN.test(value)
      ) {
        parsed.searchParams.set(key, "***");
        changed = true;
      }
    }

    return changed ? parsed.toString() : url;
  } catch {
    return url;
  }
}

function isSameState(prev, url, media) {
  return (
    prev &&
    prev.url === url &&
    prev.media?.isLivePage === media.isLivePage &&
    prev.media?.hasPlayingMedia === media.hasPlayingMedia &&
    prev.media?.hasEndedMedia === media.hasEndedMedia &&
    prev.media?.hasPausedMedia === media.hasPausedMedia &&
    prev.media?.videoCount === media.videoCount &&
    prev.media?.audioCount === media.audioCount &&
    prev.media?.endedVideoCount === media.endedVideoCount &&
    prev.media?.endedAudioCount === media.endedAudioCount &&
    prev.media?.pausedVideoCount === media.pausedVideoCount &&
    prev.media?.pausedAudioCount === media.pausedAudioCount
  );
}

async function tryWriteLog(tabId, url, media, force = false) {
  try {
    return await enqueueWrite(async () => {
      await tabStatesHydrated;

      const safeUrl = sanitizeUrl(url);
      const prev = tabStateMap.get(tabId);
      if (!force && isSameState(prev, safeUrl, media)) return;

      await appendLog(safeUrl, media);
      tabStateMap.set(tabId, { url: safeUrl, media });
      await persistTabState(tabId);
    });
  } catch (error) {
    // 日志写入失败不应中断自动点赞/自动切换
    console.warn("[URL Logger] 写日志失败：", error);
  }
}

async function logTab(tabId, force = false, requireActive = false) {
  const { enabled } = await getSettings();
  if (!enabled) return;

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || shouldSkipUrl(tab.url)) return;
  if (requireActive && !tab.active) return;

  const media = await queryMediaState(tabId);

  await tryWriteLog(tabId, tab.url, media, force);
}

// ── 自动切换 ──
function cancelPendingSwitch(tabId) {
  const timer = tabSwitchTimers.get(tabId);
  if (!timer) return;

  clearTimeout(timer);
  tabSwitchTimers.delete(tabId);
}

function resetSwitchState() {
  switchedTabs.clear();
  for (const timer of tabSwitchTimers.values()) clearTimeout(timer);
  tabSwitchTimers.clear();
  persistSwitchedTabs();
}

function markTabSwitched(tabId) {
  switchedTabs.add(tabId);
  persistSwitchedTabs();
}

function unmarkTabSwitched(tabId) {
  if (switchedTabs.delete(tabId)) {
    persistSwitchedTabs();
  }
}

// 按标签栏顺序直接切到下一个 http(s) 标签页：
// 不检查目标页是直播、暂停还是已播完，只切换一次。
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

  // 固定使用最后聚焦的窗口，避免 Service Worker 中 currentWindow 语义不明确
  const focusedWindow = await chrome.windows
    .getLastFocused({ windowTypes: ["normal"] })
    .catch(() => null);

  const allTabs = await chrome.tabs.query(
    focusedWindow?.id ? { windowId: focusedWindow.id } : { lastFocusedWindow: true }
  );

  // 只在 http(s) 标签页之间循环，跳过 chrome://、扩展页、新标签页等
  const tabs = allTabs
    .filter((tab) => tab.id != null && /^https?:\/\//i.test(tab.url || ""))
    .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  if (tabs.length <= 1) return;

  const currentIndex = tabs.findIndex((tab) => tab.id === currentTabId);
  if (currentIndex < 0) return;

  const nextTab = tabs[(currentIndex + 1) % tabs.length];
  if (!nextTab?.id) return;

  // 二次确认期间用户可能已经切走，避免抢走当前焦点
  const currentTab = await chrome.tabs.get(currentTabId).catch(() => null);
  if (!currentTab?.active) return;

  // 只激活目标标签页，不调用 windows.update({ focused: true })。
  // 浏览器窗口在后台（例如全屏游戏）时保持后台，不会把窗口弹到前台。
  // 先记录目标页，避免激活瞬间它自带的 ended 状态抢在赋值前触发连锁切换。
  lastSwitchTarget = { tabId: nextTab.id, at: Date.now() };
  await chrome.tabs.update(nextTab.id, { active: true });
}

// ── 自动点赞（B站） ──
// 点赞请求由内容脚本在页面上下文发起：同站 Cookie、CORS 与 CSRF 都按 B 站页面
// 自身的方式处理，比在 Service Worker 里伪造更稳定，也不需要额外权限。
function isBilibiliVideoUrl(url) {
  return /^https?:\/\/(?:www\.|m\.)?bilibili\.com\/video\/(?:BV[0-9A-Za-z]+|av\d+)/i.test(
    url || ""
  );
}

function bilibiliVideoId(url) {
  const match = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i.exec(url || "");
  return match ? match[1] : "";
}

function triggerAutoLike(tabId, videoId) {
  chrome.tabs
    .sendMessage(tabId, { type: "AUTO_LIKE", videoId })
    .then((result) => {
      if (result?.ok && !result.skipped) {
        console.log("[URL Logger] 已自动点赞：", result.videoId);
      }
    })
    .catch(() => {
      // 内容脚本未注入或页面已关闭时忽略
    });
}

// ── 下载 ──
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["BLOBS"],
    justification: "Export logs as txt"
  });
}

// ── 开始 / 停止 ──
async function startLogging() {
  await setSettings({ enabled: true });
  await tabStatesHydrated;
  await writeChain;
  tabStateMap.clear();
  await clearTabStates();

  await cleanupOldLogsIfNeeded(true);

  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs[0]?.id) {
    await logTab(tabs[0].id, true);
  }
}

async function stopLogging() {
  await setSettings({ enabled: false });
  await tabStatesHydrated;
  await writeChain;
  tabStateMap.clear();
  await clearTabStates();
}

// ── 标签页事件 ──
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  // 用户手动激活标签页：取消该页待执行的自动切换，使其可以停留
  cancelPendingSwitch(tabId);
  await logTab(tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    await logTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tabStatesHydrated;
  tabStateMap.delete(tabId);
  await persistTabState(tabId);
  unmarkTabSwitched(tabId);
  cancelPendingSwitch(tabId);
});

// SPA 路由变化（pushState / replaceState / hash）不会触发 onUpdated complete，
// 用 webNavigation 补齐；只记录当前活动标签页。
if (chrome.webNavigation?.onHistoryStateUpdated) {
  const onHistoryNavigation = ({ frameId, tabId }) => {
    if (frameId !== 0) return;
    logTab(tabId, false, true).catch(() => {});
  };

  chrome.webNavigation.onHistoryStateUpdated.addListener(onHistoryNavigation);
  chrome.webNavigation.onReferenceFragmentUpdated.addListener(onHistoryNavigation);
}

// ── 消息 ──
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    // 所有入口先等 session 状态恢复，避免用空内存状态覆盖已持久化的数据
    await tabStatesHydrated;

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
      // 等待排队中的写入落库，避免弹窗读到滞后的条数
      await writeChain;
      const { enabled, autoSwitch, autoLike } = await getSettings();

      sendResponse({
        enabled,
        autoSwitch,
        autoLike,
        todayCount: await getTodayCount(),
        todayDate: todayKey()
      });
      return;
    }

    if (msg.type === "TOGGLE_AUTO_SWITCH") {
      await setSettings({ autoSwitch: !!msg.enabled });
      if (!msg.enabled) resetSwitchState();
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "TOGGLE_AUTO_LIKE") {
      await setSettings({ autoLike: !!msg.enabled });
      sendResponse({ success: true });
      return;
    }

    if (msg.type === "MEDIA_STATE_CHANGED") {
      const tabId = sender.tab?.id;
      const tab = sender.tab;

      if (!tabId || shouldSkipUrl(tab.url)) {
        sendResponse({ success: true });
        return;
      }

      const media = normalizeMediaState(msg.payload);
      const { enabled, autoSwitch, autoLike } = await getSettings();

      // 自动点赞：后台标签页里播放结束的视频也点赞，不要求 tab.active。
      // 只认主播放器视频结束，避免广告/预览视频结束提前点赞。
      if (
        autoLike &&
        !media.isLivePage &&
        media.mainVideoEnded &&
        media.videoCount === 0 &&
        isBilibiliVideoUrl(tab.url)
      ) {
        triggerAutoLike(tabId, bilibiliVideoId(tab.url));
      }

      // 视频重新开始播放：重置切换状态，允许本页下次结束再切换。
      // 放在后台标签页返回之前，避免后台播放后状态一直停留在“已切换”。
      if (media.videoCount > 0) {
        if (lastSwitchTarget?.tabId === tabId) lastSwitchTarget = null;
        unmarkTabSwitched(tabId);
        cancelPendingSwitch(tabId);
      }

      // 后台标签页只参与点赞：不写日志，也不触发切换。
      // 这样用户手动切回一个已经播完的页面时可以停留（v2.2.2 行为）。
      if (!tab.active) {
        sendResponse({ success: true });
        return;
      }

      // 直播页面：只记录日志，绝不触发切换
      if (media.isLivePage) {
        if (enabled) await tryWriteLog(tabId, tab.url, media);
        sendResponse({ success: true });
        return;
      }

      if (enabled) await tryWriteLog(tabId, tab.url, media);

      // 只有非直播视频结束时才考虑切换
      if (media.endedVideoCount > 0 && media.videoCount === 0) {
        // 刚被切过去的页面自带的结束状态：只切换一次，不再连锁切换
        if (
          lastSwitchTarget &&
          lastSwitchTarget.tabId === tabId &&
          Date.now() - lastSwitchTarget.at < SWITCH_TARGET_SUPPRESS_MS
        ) {
          sendResponse({ success: true });
          return;
        }

        // 已切换过的标签页不再重复切换，防止手动切回后被再次切走
        if (switchedTabs.has(tabId)) {
          sendResponse({ success: true });
          return;
        }

        if (!autoSwitch) {
          sendResponse({ success: true });
          return;
        }

        markTabSwitched(tabId);
        cancelPendingSwitch(tabId);

        const timer = setTimeout(async () => {
          tabSwitchTimers.delete(tabId);
          const currentTab = await chrome.tabs.get(tabId).catch(() => null);
          if (currentTab?.active) {
            await switchToNextTab(tabId);
          }
        }, AUTO_SWITCH_DELAY_MS);
        tabSwitchTimers.set(tabId, timer);
      }

      sendResponse({ success: true });
      return;
    }

    if (msg.type === "DOWNLOAD_TODAY") {
      // 等排队中的写入落库，保证导出内容与弹窗条数一致
      await writeChain;

      const logs = await getTodayLogs();
      const date = todayKey();

      if (!logs.length) {
        sendResponse({ success: false, error: "今天还没有记录可下载" });
        return;
      }

      await ensureOffscreen();

      // 等待离屏文档与 downloads API 的真实结果，失败时如实返回
      const result = await chrome.runtime
        .sendMessage({ type: "SAVE_TXT", date, logs })
        .catch((error) => ({ success: false, error: error?.message || "无法连接下载模块" }));

      if (!result?.success) {
        sendResponse({ success: false, error: result?.error || "保存文件失败" });
        return;
      }

      sendResponse({ success: true, count: logs.length });
      return;
    }

    if (msg.type === "CLEAR_TODAY_LOGS") {
      // 先等排队写入完成，避免把刚写入的记录算漏
      await writeChain;
      const count = await getTodayCount();

      if (!count) {
        sendResponse({ success: false, error: "今天没有可清空的日志" });
        return;
      }

      const clearedCount = await clearTodayLogs();
      sendResponse({ success: true, count: clearedCount });
      return;
    }

    if (msg.type === "DOWNLOAD_TXT") {
      try {
        await chrome.downloads.download({
          url: msg.objectUrl,
          filename: `urls-${msg.date}.txt`,
          conflictAction: "overwrite",
          saveAs: false
        });
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({ success: false, error: error?.message || "下载失败" });
      }
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
