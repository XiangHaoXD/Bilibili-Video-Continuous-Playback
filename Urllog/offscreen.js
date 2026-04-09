chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "SAVE_TXT") return;

  const content = msg.logs.join("\n");
  const blob = new Blob([content], { type: "text/plain" });
  const objectUrl = URL.createObjectURL(blob);

  chrome.runtime.sendMessage({
    type: "DOWNLOAD_TXT",
    date: msg.date,
    objectUrl
  });

  setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
  }, 10000);
});