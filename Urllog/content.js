function isContextValid() {
  return typeof chrome !== "undefined" && !!chrome.runtime?.id;
}

function isLiveVideo(video) {
  const { duration } = video;

  // 元数据尚未加载时 duration 为 NaN：此时不能判定直播，
  // 否则页面里任何未加载的 <video> 都会把整页误标为直播。
  if (Number.isNaN(duration)) return false;

  // duration 为 Infinity：标准直播标识
  if (duration === Infinity) return true;

  // duration 为 0 且已在播放且已有播放进度：部分直播在元数据阶段时长为 0。
  // 要求 currentTime > 0，避免把刚起播的普通视频误判为直播。
  if (duration === 0 && !video.ended && !video.paused && video.currentTime > 0) {
    return true;
  }

  // 某些平台直播 duration 会不断增长但 seekable start > 0
  if (video.seekable && video.seekable.length > 0) {
    const start = video.seekable.start(0);
    const end = video.seekable.end(0);
    // seekable 起点远大于 0 且当前时间接近末尾，典型的 DVR 直播
    if (start > 300 && Math.abs(video.currentTime - end) < 5) return true;
  }

  return false;
}

function mediaSrc(element) {
  return element.currentSrc || element.src || "";
}

// 主播放器容器：用于区分主视频与广告/预览视频
const MAIN_VIDEO_HOSTS = [
  "#bilibili-player",
  ".bpx-player-container",
  "#playerWrap",
  ".bilibili-player",
  ".bpx-player-video-wrap"
];

function pickMainVideo(videos) {
  if (videos.length <= 1) return videos[0] || null;

  for (const selector of MAIN_VIDEO_HOSTS) {
    const host = document.querySelector(selector);
    const video = host?.querySelector("video");
    if (video) return video;
  }

  // 识别不到播放器容器时，取时长最长的视频（广告/预览通常更短）
  let main = null;
  for (const video of videos) {
    if (!Number.isFinite(video.duration)) continue;
    if (!main || video.duration > main.duration) main = video;
  }

  return main;
}

function getMediaState() {
  const videos = [...document.querySelectorAll("video")];
  const audios = [...document.querySelectorAll("audio")];

  // 只要页面存在直播视频，整个页面标记为直播页
  const hasLiveVideo = videos.some((video) => isLiveVideo(video));

  if (hasLiveVideo) {
    return {
      isLivePage: true,
      mainVideoEnded: false,
      videos: [],
      audios: [],
      endedVideos: [],
      endedAudios: [],
      pausedVideos: [],
      pausedAudios: []
    };
  }

  const normalVideos = videos.filter((video) => isFinite(video.duration) && video.duration > 0);

  const playingVideos = normalVideos.filter(
    (video) => !video.paused && !video.ended && video.readyState > 2
  );
  const endedVideos = normalVideos.filter((video) => video.ended && video.readyState > 2);
  // 暂停判定要求已经播放过（currentTime > 0），避免把预加载/隐藏的静默 <video>
  // 误记为 [PAUSED]。
  const pausedVideos = normalVideos.filter(
    (video) => video.paused && !video.ended && video.currentTime > 0 && video.readyState > 2
  );

  const playingAudios = audios.filter(
    (audio) => !audio.paused && !audio.ended && audio.readyState > 2
  );
  const endedAudios = audios.filter((audio) => audio.ended && audio.readyState > 2);
  const pausedAudios = audios.filter(
    (audio) => audio.paused && !audio.ended && audio.currentTime > 0 && audio.readyState > 2
  );

  const mainVideo = pickMainVideo(videos);
  const mainVideoEnded = Boolean(mainVideo && mainVideo.ended && mainVideo.readyState > 2);

  return {
    isLivePage: false,
    mainVideoEnded,
    videos: playingVideos.map((video) => ({ src: mediaSrc(video) })),
    audios: playingAudios.map((audio) => ({ src: mediaSrc(audio) })),
    endedVideos: endedVideos.map((video) => ({ src: mediaSrc(video) })),
    endedAudios: endedAudios.map((audio) => ({ src: mediaSrc(audio) })),
    pausedVideos: pausedVideos.map((video) => ({ src: mediaSrc(video) })),
    pausedAudios: pausedAudios.map((audio) => ({ src: mediaSrc(audio) }))
  };
}

function removeMediaListeners() {
  document.removeEventListener("play", handleMediaEvent, true);
  document.removeEventListener("pause", handleMediaEvent, true);
  document.removeEventListener("ended", handleMediaEvent, true);

  try {
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
  } catch {
    // 扩展上下文已失效时忽略
  }
}

function notifyStateChange() {
  if (!isContextValid()) {
    removeMediaListeners();
    return;
  }

  const state = getMediaState();

  try {
    chrome.runtime.sendMessage({
      type: "MEDIA_STATE_CHANGED",
      payload: state
    }).catch(() => {});
  } catch {
    removeMediaListeners();
  }
}

function handleMediaEvent() {
  notifyStateChange();
}

// ── B 站自动点赞 ──
// 由后台在视频播完时发消息触发。请求放在页面上下文里发，同站 Cookie、CSRF
// 与 CORS 都按 B 站页面自身的方式处理，不需要额外扩展权限。
const BILIBILI_VIDEO_PATH = /\/video\/(BV[0-9A-Za-z]+|av\d+)/i;
const attemptedLikes = new Set();

// 点赞按钮选择器：当前版工具栏优先，其次旧版工具栏
const LIKE_BUTTON_SELECTOR =
  ".video-like, #arc_toolbar_report .like, .video-toolbar-left .like";

function querySelectorDeep(selector, root = document, budget = { remaining: 5000 }) {
  const direct = root.querySelector(selector);
  if (direct) return direct;

  // B 站部分按钮位于 open shadow root 内；限制扫描节点数，避免大页面卡顿
  for (const element of root.querySelectorAll("*")) {
    if (budget.remaining-- <= 0) return null;
    if (!element.shadowRoot) continue;

    const nested = querySelectorDeep(selector, element.shadowRoot, budget);
    if (nested) return nested;
  }

  return null;
}

function readCookie(name) {
  const prefix = `${name}=`;

  for (const part of document.cookie.split(";")) {
    const value = part.trim();
    if (!value.startsWith(prefix)) continue;

    const raw = value.slice(prefix.length);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }

  return "";
}

function findLikeButton() {
  return querySelectorDeep(LIKE_BUTTON_SELECTOR);
}

function isLikeButtonActive(button) {
  if (!button) return false;

  if (button.classList?.contains("on") || button.classList?.contains("liked")) return true;
  if (button.getAttribute?.("aria-pressed") === "true") return true;
  if (button.querySelector?.(".on, .liked, [aria-pressed='true']")) return true;

  const label = `${button.getAttribute?.("title") || ""} ${button.getAttribute?.("aria-label") || ""}`;
  return /取消点赞|已点赞|已赞/.test(label);
}

// BV 号区分大小写，只有 av 前缀需要统一大小写
function normalizeVideoId(videoId) {
  return /^av/i.test(videoId) ? `av${videoId.slice(2)}` : videoId;
}

async function waitForLikeState(button, timeoutMs = 1000) {
  // 按钮可能被 B 站重新渲染，旧节点不再承载状态时重新找一次
  const currentButton = () => (button?.isConnected ? button : findLikeButton());

  if (isLikeButtonActive(currentButton())) return true;

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (isLikeButtonActive(currentButton())) return true;
  }

  return false;
}

// 点击前的额外保险：最近点过赞的视频直接跳过，避免误点成取消赞
async function hasLikedRecently(videoId) {
  const params = new URLSearchParams();
  if (/^BV/i.test(videoId)) {
    params.set("bvid", videoId);
  } else {
    params.set("aid", videoId.slice(2));
  }

  const result = await fetch(
    `https://api.bilibili.com/x/web-interface/archive/has/like?${params.toString()}`,
    { credentials: "include" }
  )
    .then((response) => response.json())
    .catch(() => null);

  return result?.code === 0 && Number(result.data) === 1;
}

async function postBilibiliLike(videoId, csrf) {
  const body = new URLSearchParams({ like: "1", csrf });
  if (/^BV/i.test(videoId)) {
    body.set("bvid", videoId);
  } else {
    body.set("aid", videoId.slice(2));
  }

  const result = await fetch("https://api.bilibili.com/x/web-interface/archive/like", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  })
    .then((response) => response.json())
    .catch((error) => ({ code: -1, message: String(error) }));

  // 65006：重复点赞，说明之前已经点过，按成功处理
  if (result?.code === 0 || result?.code === 65006) {
    return { ok: true, skipped: result?.code === 65006 };
  }

  return {
    ok: false,
    reason: result?.message || `接口返回 ${result?.code ?? "未知"}`
  };
}

async function likeCurrentBilibiliVideo(expectedVideoId = "") {
  const match = BILIBILI_VIDEO_PATH.exec(location.pathname);
  if (!match) {
    return { ok: false, reason: "当前页面不是 B 站视频页" };
  }

  const videoId = match[1];
  const normalizedId = normalizeVideoId(videoId);

  // 视频播完到消息送达之间页面可能已经自动切到下一个视频，避免点错稿件
  if (expectedVideoId && normalizedId !== normalizeVideoId(String(expectedVideoId))) {
    return { ok: false, reason: "页面视频已切换" };
  }

  const dedupeKey = normalizedId;

  if (attemptedLikes.has(dedupeKey)) {
    return { ok: true, skipped: true, videoId };
  }

  const csrf = readCookie("bili_jct");
  if (!csrf) {
    return { ok: false, reason: "未登录 B 站（缺少 bili_jct）" };
  }

  // 先占位，避免 ended 与 pause 连续触发时重复请求
  attemptedLikes.add(dedupeKey);

  // 优先点击页面自己的点赞按钮：B 站会同时完成接口请求和按钮点亮，
  // 和手动点赞完全一致。
  const button = findLikeButton();

  if (button) {
    if (isLikeButtonActive(button)) {
      return { ok: true, skipped: true, via: "dom", videoId };
    }

    // 点击会切换点赞状态：最近已赞过的视频直接跳过，降低误取消赞的风险
    if (await hasLikedRecently(videoId)) {
      return { ok: true, skipped: true, via: "api", videoId };
    }

    // has/like 请求期间页面可能已经切到下一个视频，重新确认后再点击
    const currentMatch = BILIBILI_VIDEO_PATH.exec(location.pathname);
    if (!currentMatch || normalizeVideoId(currentMatch[1]) !== normalizedId) {
      return { ok: false, reason: "页面视频已切换" };
    }

    // 按钮可能被重新渲染；仍连接在原文档时直接用，否则重新找
    const currentButton = button.isConnected ? button : findLikeButton();

    if (currentButton && isLikeButtonActive(currentButton)) {
      return { ok: true, skipped: true, via: "dom", videoId };
    }

    if (currentButton) {
      currentButton.click();

      if (await waitForLikeState(currentButton)) {
        return { ok: true, via: "dom", videoId };
      }
    }
  }

  // 页面结构变化导致找不到按钮/点击未生效时，回退到官方接口
  // （服务端会点赞成功，但页面按钮可能不会立即变色）。
  const result = await postBilibiliLike(videoId, csrf);
  if (result.ok) {
    return { ...result, via: "api", videoId };
  }

  attemptedLikes.delete(dedupeKey);
  return result;
}

function onRuntimeMessage(msg, sender, sendResponse) {
  if (msg.type === "GET_MEDIA_STATE") {
    sendResponse(getMediaState());
    return;
  }

  if (msg.type === "AUTO_LIKE") {
    likeCurrentBilibiliVideo(msg.videoId)
      .then((result) => {
        if (result.ok) {
          const via = result.via === "dom" ? "（页面按钮）" : "（接口）";
          console.log(
            result.skipped
              ? `[URL Logger] ${result.videoId} 已经点过赞，跳过`
              : `[URL Logger] 已自动点赞 ${result.videoId}${via}`
          );
        } else {
          console.warn(`[URL Logger] 自动点赞跳过：${result.reason}`);
        }

        sendResponse(result);
      })
      .catch((error) => {
        sendResponse({ ok: false, reason: error?.message || "未知错误" });
      });

    // 异步回执
    return true;
  }
}

if (isContextValid()) {
  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    // 扩展上下文已失效（如扩展被重载）时放弃监听
  }

  document.addEventListener("play", handleMediaEvent, true);
  document.addEventListener("pause", handleMediaEvent, true);
  document.addEventListener("ended", handleMediaEvent, true);
}
