function isContextValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

function isLiveVideo(video) {
  // duration 为 Infinity：标准直播标识
  if (!isFinite(video.duration)) return true;
  // duration 为 0 且仍在加载中（未结束、未暂停）：可能是直播加载阶段
  if (video.duration === 0 && !video.ended && !video.paused) return true;
  // 某些平台直播 duration 会不断增长但 seekable start > 0
  if (video.seekable && video.seekable.length > 0) {
    const start = video.seekable.start(0);
    const end = video.seekable.end(0);
    // seekable 起点远大于 0 且当前时间接近末尾，典型的 DVR 直播
    if (start > 300 && Math.abs(video.currentTime - end) < 5) return true;
  }
  return false;
}

function getMediaState() {
  const videos = [...document.querySelectorAll("video")];
  const audios = [...document.querySelectorAll("audio")];

  // 只要页面存在直播视频，整个页面标记为直播页
  const hasLiveVideo = videos.some(v => isLiveVideo(v));

  if (hasLiveVideo) {
    return {
      isLivePage: true,
      videos: [],
      audios: [],
      endedVideos: [],
      endedAudios: []
    };
  }

  const normalVideos = videos.filter(v => isFinite(v.duration) && v.duration > 0);

  const playingVideos = normalVideos.filter(v => !v.paused && !v.ended && v.readyState > 2);
  const endedVideos = normalVideos.filter(v => v.ended && v.readyState > 2);
  const playingAudios = audios.filter(a => !a.paused && !a.ended && a.readyState > 2);
  const endedAudios = audios.filter(a => a.ended && a.readyState > 2);

  return {
    isLivePage: false,
    videos: playingVideos.map(v => ({ src: v.currentSrc || v.src || "" })),
    audios: playingAudios.map(a => ({ src: a.currentSrc || a.src || "" })),
    endedVideos: endedVideos.map(v => ({ src: v.currentSrc || v.src || "" })),
    endedAudios: endedAudios.map(a => ({ src: a.currentSrc || a.src || "" }))
  };
}

function removeMediaListeners() {
  document.removeEventListener("play", handleMediaEvent, true);
  document.removeEventListener("pause", handleMediaEvent, true);
  document.removeEventListener("ended", handleMediaEvent, true);
}

function notifyStateChange() {
  if (!isContextValid()) {
    removeMediaListeners();
    return;
  }

  const state = getMediaState();

  // 直播页面不发送任何状态变更通知
  if (state.isLivePage) return;

  try {
    chrome.runtime.sendMessage({
      type: "MEDIA_STATE_CHANGED",
      payload: state
    }).catch(() => {});
  } catch (e) {
    removeMediaListeners();
  }
}

function handleMediaEvent() {
  notifyStateChange();
}

function onRuntimeMessage(msg, sender, sendResponse) {
  if (msg.type === "GET_MEDIA_STATE") {
    sendResponse(getMediaState());
  }
}

if (isContextValid()) {
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (e) {}

  document.addEventListener("play", handleMediaEvent, true);
  document.addEventListener("pause", handleMediaEvent, true);
  document.addEventListener("ended", handleMediaEvent, true);
}