// content.js - 完全修复版本
let isContextValid = true;
let observer = null;
let checkTimer = null;
let intervalId = null;

// 检查扩展上下文是否有效
function checkContext() {
  try {
    // 尝试访问 chrome.runtime.id，如果失败说明上下文已失效
    if (!chrome.runtime?.id) {
      isContextValid = false;
      cleanup();
      return false;
    }
    return true;
  } catch (error) {
    isContextValid = false;
    cleanup();
    return false;
  }
}

// 安全发送消息
function safeSendMessage(message) {
  if (!checkContext()) {
    return Promise.resolve();
  }
  
  try {
    return chrome.runtime.sendMessage(message).catch((error) => {
      // 忽略上下文失效错误
      if (error.message?.includes('Extension context invalidated') ||
          error.message?.includes('message port closed')) {
        isContextValid = false;
        cleanup();
      }
      return null;
    });
  } catch (error) {
    // 同步错误也要处理
    if (error.message?.includes('Extension context invalidated') ||
        error.message?.includes('message port closed')) {
      isContextValid = false;
      cleanup();
    }
    return Promise.resolve();
  }
}

// 清理函数
function cleanup() {
  try {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  } catch (e) {}
  
  try {
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
  } catch (e) {}
  
  try {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  } catch (e) {}
}

function detectMediaPlayback() {
  const videos = [];
  const audios = [];
  const endedVideos = [];
  const endedAudios = [];

  // 扫描文档中的媒体元素
  function scanElements(root = document) {
    const videoElements = root.querySelectorAll('video');
    const audioElements = root.querySelectorAll('audio');
    
    videoElements.forEach((video) => {
      const mediaInfo = {
        src: video.currentSrc || video.src || 'unknown',
        duration: video.duration,
        currentTime: video.currentTime,
        volume: video.volume,
        muted: video.muted,
        width: video.videoWidth,
        height: video.videoHeight
      };

      // 已播放完成
      if (video.ended && video.readyState > 2) {
        endedVideos.push(mediaInfo);
      }
      // 正在播放
      else if (!video.paused && !video.ended && video.readyState > 2) {
        videos.push(mediaInfo);
      }
    });

    audioElements.forEach((audio) => {
      const mediaInfo = {
        src: audio.currentSrc || audio.src || 'unknown',
        duration: audio.duration,
        currentTime: audio.currentTime,
        volume: audio.volume,
        muted: audio.muted
      };

      // 已播放完成
      if (audio.ended && audio.readyState > 2) {
        endedAudios.push(mediaInfo);
      }
      // 正在播放
      else if (!audio.paused && !audio.ended && audio.readyState > 2) {
        audios.push(mediaInfo);
      }
    });
  }

  // 扫描主文档
  scanElements(document);

  // 扫描 Shadow DOM
  function scanShadowRoots(root = document.body) {
    if (!root) return;
    
    const walker = document.createTreeWalker(
      root,
      NodeFilter.SHOW_ELEMENT,
      null,
      false
    );

    let node;
    while (node = walker.nextNode()) {
      if (node.shadowRoot) {
        scanElements(node.shadowRoot);
        scanShadowRoots(node.shadowRoot);
      }
    }
  }

  try {
    scanShadowRoots();
  } catch (e) {
    // Shadow DOM 扫描失败
  }

  // 扫描 iframe（同源）
  try {
    const iframes = document.querySelectorAll('iframe');
    iframes.forEach(iframe => {
      try {
        if (iframe.contentDocument) {
          scanElements(iframe.contentDocument);
        }
      } catch (e) {
        // 跨域 iframe
      }
    });
  } catch (e) {
    // iframe 扫描失败
  }

  return {
    hasPlayingMedia: videos.length > 0 || audios.length > 0,
    hasEndedMedia: endedVideos.length > 0 || endedAudios.length > 0,
    videos,
    audios,
    endedVideos,
    endedAudios,
    playingCount: videos.length + audios.length,
    endedCount: endedVideos.length + endedAudios.length,
    timestamp: Date.now()
  };
}

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!checkContext()) {
    // 上下文已失效，不处理消息
    return false;
  }
  
  if (msg.type === "CHECK_MEDIA") {
    try {
      const result = detectMediaPlayback();
      sendResponse(result);
    } catch (error) {
      sendResponse({
        hasPlayingMedia: false,
        hasEndedMedia: false,
        videos: [],
        audios: [],
        endedVideos: [],
        endedAudios: [],
        playingCount: 0,
        endedCount: 0
      });
    }
  }
  return true;
});

// 状态追踪
let lastPlayingState = false;
let lastEndedState = false;

function checkAndNotify() {
  if (!isContextValid || !checkContext()) {
    return;
  }
  
  try {
    const result = detectMediaPlayback();
    const isPlaying = result.hasPlayingMedia;
    const hasEnded = result.hasEndedMedia;

    if (isPlaying !== lastPlayingState || hasEnded !== lastEndedState) {
      lastPlayingState = isPlaying;
      lastEndedState = hasEnded;
      
      // 使用安全发送消息函数
      safeSendMessage({
        type: "MEDIA_STATE_CHANGED",
        isPlaying,
        hasEnded,
        details: result
      });
    }
  } catch (error) {
    // 静默处理错误
  }
}

// 延迟检测
function scheduleCheck() {
  if (!isContextValid || !checkContext()) {
    return;
  }
  
  try {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(checkAndNotify, 500);
  } catch (e) {
    // 定时器创建失败
  }
}

// 只在上下文有效时添加事件监听
if (checkContext()) {
  // 监听播放事件
  document.addEventListener('play', scheduleCheck, true);
  document.addEventListener('pause', scheduleCheck, true);
  document.addEventListener('ended', scheduleCheck, true);

  // 监听 DOM 变化（捕获动态插入的视频）
  observer = new MutationObserver((mutations) => {
    if (!isContextValid || !checkContext()) {
      if (observer) {
        observer.disconnect();
      }
      return;
    }
    
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === 1) {
            if (node.tagName === 'VIDEO' || 
                node.tagName === 'AUDIO' || 
                node.querySelector('video') || 
                node.querySelector('audio')) {
              scheduleCheck();
              return;
            }
          }
        }
      }
    }
  });

  // 等待 body 加载后才开始监听
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      if (checkContext() && document.body && observer) {
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
      }
    });
  }

  // 初始检测
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (checkContext()) {
        setTimeout(checkAndNotify, 1500);
      }
    });
  } else {
    setTimeout(checkAndNotify, 1500);
  }

  // 定期检查（兜底）
  intervalId = setInterval(() => {
    if (!isContextValid || !checkContext()) {
      clearInterval(intervalId);
      intervalId = null;
      return;
    }
    checkAndNotify();
  }, 3000);
}

// 监听页面卸载
window.addEventListener('unload', cleanup);

// 监听可见性变化（页面隐藏时停止检查）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // 页面隐藏时清除定时器
    if (checkTimer) {
      clearTimeout(checkTimer);
      checkTimer = null;
    }
  } else if (checkContext()) {
    // 页面显示时重新检查
    scheduleCheck();
  }
});