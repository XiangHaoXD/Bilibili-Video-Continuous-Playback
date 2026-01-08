chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "SAVE_TXT") {
    const { date, logs } = msg;
    const content = logs.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const objectUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      type: "DOWNLOAD_TXT",
      date,
      objectUrl
    });

    // 延迟清理 URL，确保下载完成
    setTimeout(() => {
      URL.revokeObjectURL(objectUrl);
    }, 10000); // 10 秒后清理
  }
});