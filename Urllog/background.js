let offscreenReady = false;
let lastUrl = null;
let urlMediaStateMap = new Map(); // 记录每个URL的媒体状态
let autoSwitchEnabled = false; // 自动切换开关
let videoEndedTabMap = new Map(); // 记录哪些标签页的视频已结束

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    autoSwitch: false, // 默认关闭自动切换
    logsByDate: {}
  });
});

// 初始化时加载自动切换设置
chrome.storage.local.get('autoSwitch', ({ autoSwitch }) => {
  autoSwitchEnabled = autoSwitch || false;
});

async function ensureOffscreen() {
  if (offscreenReady) return;

  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["BLOBS"],
        justification: "Save URL logs to daily txt file"
      });
    }
    offscreenReady = true;
  } catch (error) {
    console.error("Failed to create offscreen document:", error);
  }
}

// 媒体检测(带重试)
async function checkMediaPlayback(tabId, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "CHECK_MEDIA" });
      
      if (response && (response.hasPlayingMedia || response.hasEndedMedia)) {
        return response;
      }
      
      if (i === retries - 1) {
        return response || { 
          hasPlayingMedia: false, 
          hasEndedMedia: false,
          videos: [], 
          audios: [], 
          endedVideos: [],
          endedAudios: [],
          playingCount: 0,
          endedCount: 0
        };
      }
      
      await new Promise(resolve => setTimeout(resolve, 800));
      
    } catch (error) {
      if (i === retries - 1) {
        return { 
          hasPlayingMedia: false, 
          hasEndedMedia: false,
          videos: [], 
          audios: [], 
          endedVideos: [],
          endedAudios: [],
          playingCount: 0,
          endedCount: 0
        };
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  return { 
    hasPlayingMedia: false, 
    hasEndedMedia: false,
    videos: [], 
    audios: [], 
    endedVideos: [],
    endedAudios: [],
    playingCount: 0,
    endedCount: 0
  };
}

// 切换到下一个标签页
async function switchToNextTab(currentTabId) {
  if (!autoSwitchEnabled) return;

  try {
    // 获取当前窗口的所有标签页
    const tabs = await chrome.tabs.query({ currentWindow: true });
    
    // 找到当前标签页的索引
    const currentIndex = tabs.findIndex(tab => tab.id === currentTabId);
    
    if (currentIndex === -1) return;
    
    // 计算下一个标签页的索引(循环)
    const nextIndex = (currentIndex + 1) % tabs.length;
    const nextTab = tabs[nextIndex];
    
    // 切换到下一个标签页
    await chrome.tabs.update(nextTab.id, { active: true });
    
    console.log(`Auto-switched from tab ${currentTabId} to tab ${nextTab.id}`);
  } catch (error) {
    console.error("Failed to switch tab:", error);
  }
}

// 记录 URL
async function logCurrentUrl(url, tabId, forceUpdate = false) {
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
    return;
  }

  const mediaStatus = await checkMediaPlayback(tabId);
  
  const { logsByDate } = await chrome.storage.local.get("logsByDate");
  const date = todayKey();
  
  logsByDate[date] ??= [];
  
  // 获取该URL之前的状态
  const previousState = urlMediaStateMap.get(url);
  const currentState = {
    hasPlayingMedia: mediaStatus.hasPlayingMedia,
    hasEndedMedia: mediaStatus.hasEndedMedia,
    videoCount: mediaStatus.videos.length + mediaStatus.endedVideos.length,
    audioCount: mediaStatus.audios.length + mediaStatus.endedAudios.length,
    playingVideoCount: mediaStatus.videos.length,
    playingAudioCount: mediaStatus.audios.length,
    endedVideoCount: mediaStatus.endedVideos.length,
    endedAudioCount: mediaStatus.endedAudios.length
  };
  
  // 检查状态是否发生变化
  const stateChanged = !previousState || 
    previousState.hasPlayingMedia !== currentState.hasPlayingMedia ||
    previousState.hasEndedMedia !== currentState.hasEndedMedia;
  
  // 只在URL改变、强制更新或状态变化时记录
  if (url !== lastUrl || forceUpdate || stateChanged) {
    let logEntry = `${new Date().toLocaleTimeString()} ${url}`;
    
    // 优先显示正在播放的媒体
    if (mediaStatus.hasPlayingMedia) {
      const videoCount = mediaStatus.videos.length;
      const audioCount = mediaStatus.audios.length;
      logEntry += ` [PLAYING: ${videoCount}V ${audioCount}A]`;
    }
    // 如果没有正在播放,但有播放完成的媒体
    else if (mediaStatus.hasEndedMedia) {
      const videoCount = mediaStatus.endedVideos.length;
      const audioCount = mediaStatus.endedAudios.length;
      logEntry += ` [PLAYED: ${videoCount}V ${audioCount}A]`;
    }
    
    logsByDate[date].push(logEntry);
    await chrome.storage.local.set({ logsByDate });
    
    // 更新状态记录
    urlMediaStateMap.set(url, currentState);
    lastUrl = url;
  }
}

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (!enabled) return;

  const tab = await chrome.tabs.get(activeInfo.tabId);
  
  // 清除该标签页的视频结束标记
  videoEndedTabMap.delete(activeInfo.tabId);
  
  if (tab.url) {
    await logCurrentUrl(tab.url, tab.id);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const { enabled } = await chrome.storage.local.get("enabled");
  if (!enabled) return;

  // URL改变时,清除视频结束标记
  if (changeInfo.url) {
    videoEndedTabMap.delete(tabId);
  }

  if (changeInfo.status === 'complete' && tab.active && tab.url) {
    setTimeout(async () => {
      await logCurrentUrl(tab.url, tab.id);
    }, 2000);
  }
});

// 标签页关闭时清理
chrome.tabs.onRemoved.addListener((tabId) => {
  videoEndedTabMap.delete(tabId);
});

chrome.runtime.onMessage.addListener(async (msg, sender) => {
  if (msg.type === "MEDIA_STATE_CHANGED") {
    const { enabled } = await chrome.storage.local.get("enabled");
    if (!enabled) return;

    const tab = sender.tab;
    if (tab && tab.active && tab.url) {
      // 当媒体状态改变时,强制更新日志
      if (msg.isPlaying) {
        console.log(`Media playing on: ${tab.url}`, msg.details);
        // 视频开始播放时,清除结束标记
        videoEndedTabMap.delete(tab.id);
        await logCurrentUrl(tab.url, tab.id, true);
      } else if (msg.hasEnded) {
        console.log(`Media ended on: ${tab.url}`, msg.details);
        await logCurrentUrl(tab.url, tab.id, true);
        
        // 检查是否有视频播放完成
        const hasVideoEnded = msg.details.endedVideos && msg.details.endedVideos.length > 0;
        
        if (hasVideoEnded && autoSwitchEnabled) {
          // 检查是否已经为此标签页触发过切换
          if (!videoEndedTabMap.get(tab.id)) {
            videoEndedTabMap.set(tab.id, true);
            
            // 延迟1秒后切换,给用户一点反应时间
            setTimeout(async () => {
              // 再次检查标签页是否仍然活跃
              const currentTab = await chrome.tabs.get(tab.id).catch(() => null);
              if (currentTab && currentTab.active) {
                await switchToNextTab(tab.id);
              }
            }, 1000);
          }
        }
      }
    }
  }
});

function startLogging() {
  chrome.storage.local.set({ enabled: true });
  lastUrl = null;
  urlMediaStateMap.clear();
  videoEndedTabMap.clear();
  
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    if (tabs[0]?.url) {
      setTimeout(async () => {
        await logCurrentUrl(tabs[0].url, tabs[0].id);
      }, 2000);
    }
  });
}

function stopLogging() {
  chrome.storage.local.set({ enabled: false });
  lastUrl = null;
  urlMediaStateMap.clear();
  videoEndedTabMap.clear();
}

// 消息监听器(修复异步响应问题)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // 处理下载请求
  if (msg.type === "DOWNLOAD_TODAY") {
    (async () => {
      try {
        const { logsByDate } = await chrome.storage.local.get("logsByDate");
        const date = todayKey();
        const logs = logsByDate[date] || [];

        if (logs.length === 0) {
          sendResponse({ success: false, error: "今天还没有记录" });
          return;
        }

        await ensureOffscreen();

        chrome.runtime.sendMessage({
          type: "SAVE_TXT",
          date,
          logs
        });

        sendResponse({ success: true, count: logs.length });
      } catch (error) {
        console.error("Download error:", error);
        sendResponse({ success: false, error: error.message });
      }
    })();
    return true;
  }

  // 处理文件下载
  if (msg.type === "DOWNLOAD_TXT") {
    const { date, objectUrl } = msg;

    chrome.downloads.download({
      url: objectUrl,
      filename: `urls-${date}.txt`,
      conflictAction: "overwrite",
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error("Download failed:", chrome.runtime.lastError);
      }
    });
    return false;
  }

  // 处理启动/停止
  if (msg === "START") {
    startLogging();
    sendResponse({ success: true });
    return false;
  }
  
  if (msg === "STOP") {
    stopLogging();
    sendResponse({ success: true });
    return false;
  }

  // 处理自动切换开关
  if (msg.type === "TOGGLE_AUTO_SWITCH") {
    autoSwitchEnabled = msg.enabled;
    chrome.storage.local.set({ autoSwitch: msg.enabled });
    sendResponse({ success: true });
    return false;
  }

  // 获取自动切换状态
  if (msg.type === "GET_AUTO_SWITCH") {
    sendResponse({ enabled: autoSwitchEnabled });
    return false;
  }
});