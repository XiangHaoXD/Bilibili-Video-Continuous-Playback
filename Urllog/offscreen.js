chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "SAVE_TXT") return;

  let objectUrl = "";

  try {
    const blob = new Blob([msg.logs.join("\n")], { type: "text/plain" });
    objectUrl = URL.createObjectURL(blob);
  } catch (error) {
    sendResponse({ success: false, error: error?.message || "生成文件失败" });
    return;
  }

  // 等后台真正把下载交给 downloads API 后再回执，避免“提示成功但没下载”
  chrome.runtime
    .sendMessage({
      type: "DOWNLOAD_TXT",
      date: msg.date,
      objectUrl
    })
    .then((result) => {
      sendResponse(
        result?.success
          ? { success: true }
          : { success: false, error: result?.error || "下载失败" }
      );
    })
    .catch((error) => {
      sendResponse({ success: false, error: error?.message || "下载失败" });
    })
    .finally(() => {
      setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 10000);
    });

  // 保持消息通道打开，异步回执
  return true;
});
