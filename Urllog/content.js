function isContextValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

function getMediaState() {
  const videos = [...document.querySelectorAll("video")];
  const audios  = [...document.querySelectorAll("audio")];

  const playingVideos = videos.filter(v => !v.paused && !v.ended && v.readyState > 2);
  const endedVideos   = videos.filter(v =>  v.ended  && v.readyState > 2);
  const playingAudios = audios.filter(a => !a.paused && !a.ended && a.readyState > 2);
  const endedAudios   = audios.filter(a =>  a.ended  && a.readyState > 2);

  return {
    videos:      playingVideos.map(v => ({ src: v.currentSrc || v.src || "" })),
    audios:      playingAudios.map(a => ({ src: a.currentSrc || a.src || "" })),
    endedVideos: endedVideos.map(v   => ({ src: v.currentSrc || v.src || "" })),
    endedAudios: endedAudios.map(a   => ({ src: a.currentSrc || a.src || "" }))
  };
}

function removeMediaListeners() {
  document.removeEventListener("play",   notifyStateChange, true);
  document.removeEventListener("pause",  notifyStateChange, true);
  document.removeEventListener("ended",  notifyStateChange, true);
}

function notifyStateChange() {
  if (!isContextValid()) {
    removeMediaListeners();
    return;
  }

  // sendMessage 在上下文失效时会同步抛出，.catch() 无法捕获，必须用 try-catch
  try {
    chrome.runtime.sendMessage({
      type: "MEDIA_STATE_CHANGED",
      payload: getMediaState()
    }).catch(() => {});
  } catch (e) {
    // 捕获到同步异常说明上下文已失效，移除监听避免后续持续报错
    removeMediaListeners();
  }
}

function onRuntimeMessage(msg, sender, sendResponse) {
  if (msg.type === "GET_MEDIA_STATE") {
    sendResponse(getMediaState());
  }
}

if (isContextValid()) {
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch (e) {
    // 静默处理
  }

  document.addEventListener("play",   notifyStateChange, true);
  document.addEventListener("pause",  notifyStateChange, true);
  document.addEventListener("ended",  notifyStateChange, true);
}