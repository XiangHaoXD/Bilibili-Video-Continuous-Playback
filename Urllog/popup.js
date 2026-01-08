// popup.js - 添加自动切换功能
const toggleBtn = document.getElementById('toggleBtn');
const toggleText = document.getElementById('toggleText');
const downloadBtn = document.getElementById('downloadBtn');
const statusDiv = document.getElementById('status');
const statusText = document.getElementById('statusText');
const messageDiv = document.getElementById('message');
const autoSwitchToggle = document.getElementById('autoSwitchToggle');

// 显示消息
function showMessage(text, type = 'success') {
  messageDiv.textContent = text;
  messageDiv.className = `message ${type}`;
  messageDiv.style.display = 'block';
  
  setTimeout(() => {
    messageDiv.style.display = 'none';
  }, 3000);
}

// 更新 UI 状态
function updateUI(enabled) {
  if (enabled) {
    // 记录中状态
    statusDiv.classList.remove('inactive');
    statusDiv.classList.add('active');
    statusText.textContent = '正在记录中...';
    
    toggleBtn.classList.add('active');
    toggleText.textContent = '停止记录';
    toggleBtn.innerHTML = `
      <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
      </svg>
      <span>停止记录</span>
    `;
  } else {
    // 已停止状态
    statusDiv.classList.remove('active');
    statusDiv.classList.add('inactive');
    statusText.textContent = '记录已停止';
    
    toggleBtn.classList.remove('active');
    toggleText.textContent = '开始记录';
    toggleBtn.innerHTML = `
      <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span>开始记录</span>
    `;
  }
}

// 初始化状态
chrome.storage.local.get(['enabled', 'autoSwitch'], ({ enabled, autoSwitch }) => {
  updateUI(enabled || false);
  autoSwitchToggle.checked = autoSwitch || false;
});

// 切换按钮点击事件
toggleBtn.addEventListener('click', async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  const newState = !enabled;
  
  if (newState) {
    // 开始记录
    chrome.runtime.sendMessage('START', (response) => {
      if (response?.success) {
        updateUI(true);
        showMessage('✓ 已开始记录 URL', 'success');
      }
    });
  } else {
    // 停止记录
    chrome.runtime.sendMessage('STOP', (response) => {
      if (response?.success) {
        updateUI(false);
        showMessage('✓ 已停止记录', 'success');
      }
    });
  }
});

// 下载按钮点击事件
downloadBtn.addEventListener('click', () => {
  downloadBtn.disabled = true;
  
  chrome.runtime.sendMessage({ type: 'DOWNLOAD_TODAY' }, (response) => {
    downloadBtn.disabled = false;
    
    if (response?.success) {
      showMessage(`✓ 已保存 ${response.count} 条记录`, 'success');
    } else {
      showMessage(`✗ ${response?.error || '下载失败'}`, 'error');
    }
  });
});

// 自动切换开关事件
autoSwitchToggle.addEventListener('change', (e) => {
  const enabled = e.target.checked;
  
  chrome.runtime.sendMessage({
    type: 'TOGGLE_AUTO_SWITCH',
    enabled: enabled
  }, (response) => {
    if (response?.success) {
      const message = enabled ? '✓ 已启用自动切换标签页' : '✓ 已关闭自动切换';
      showMessage(message, 'success');
    }
  });
});