// Notion Clipper - Popup Script

let selectedText = '';
let currentUrl = '';

// Get selected text from active tab
async function getSelectedText() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    currentUrl = tab.url;

    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString()
    });

    if (results && results[0] && results[0].result) {
      selectedText = results[0].result.trim();
      return selectedText;
    }
  } catch (error) {
    console.error('Failed to get selection:', error);
  }
  return '';
}

// Update UI with selected text
function updatePreview(text) {
  const preview = document.getElementById('preview');
  const saveBtn = document.getElementById('saveBtn');

  if (text) {
    const displayText = text.length > 300 ? text.slice(0, 300) + '...' : text;
    preview.innerHTML = `<p class="selected-text">${escapeHtml(displayText)}</p>`;
    saveBtn.disabled = false;
  } else {
    preview.innerHTML = '<p class="placeholder">Select text on the page first</p>';
    saveBtn.disabled = true;
  }
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Show status message
function showStatus(message, isError = false) {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = 'status ' + (isError ? 'error' : 'success');
}

// Set loading state
function setLoading(loading) {
  const saveBtn = document.getElementById('saveBtn');
  const btnText = saveBtn.querySelector('.btn-text');
  const btnLoading = saveBtn.querySelector('.btn-loading');

  saveBtn.disabled = loading;
  btnText.hidden = loading;
  btnLoading.hidden = !loading;
}

// Save to Notion
async function saveToNotion() {
  if (!selectedText) {
    showStatus('No text selected!', true);
    return;
  }

  const path = document.getElementById('path').value.trim();
  const autoCreate = document.getElementById('autoCreate').checked;

  setLoading(true);
  showStatus('');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'saveToNotion',
      text: selectedText,
      url: currentUrl,
      path: path,
      autoCreate: autoCreate
    });

    if (response.success) {
      showStatus(`✅ Saved to: ${response.path}`);
      // Save last used path
      if (path) {
        chrome.storage.sync.set({ lastPath: path });
      }
    } else {
      showStatus(`❌ ${response.error}`, true);
    }
  } catch (error) {
    showStatus(`❌ ${error.message}`, true);
  } finally {
    setLoading(false);
  }
}

// Initialize popup
async function init() {
  // Load default path
  chrome.runtime.sendMessage({ action: 'getDefaultPath' }, (response) => {
    if (response && response.path) {
      document.getElementById('defaultPath').textContent = response.path;
    }
  });

  // Load last used path
  const { lastPath } = await chrome.storage.sync.get(['lastPath']);
  if (lastPath) {
    document.getElementById('path').value = lastPath;
  }

  // Get selected text
  const text = await getSelectedText();
  updatePreview(text);

  // Event listeners
  document.getElementById('saveBtn').addEventListener('click', saveToNotion);
  document.getElementById('openOptions').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  // Save on Enter key in path input
  document.getElementById('path').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !document.getElementById('saveBtn').disabled) {
      saveToNotion();
    }
  });

  // Clear path button
  document.getElementById('clearPathBtn').addEventListener('click', async () => {
    document.getElementById('path').value = '';
    await chrome.storage.sync.remove('lastPath');
    showStatus('Path cleared - using default', false);
  });
}

document.addEventListener('DOMContentLoaded', init);
