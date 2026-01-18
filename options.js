// Notion Clipper - Options Page Script

const NOTION_API_VERSION = '2022-06-28';

// Show status message
function showStatus(message, type = 'info') {
  const status = document.getElementById('status');
  status.textContent = message;
  status.className = 'status ' + type;
}

// Load saved settings
async function loadSettings() {
  const settings = await chrome.storage.sync.get([
    'notionToken',
    'rootPageId',
    'defaultPath'
  ]);

  if (settings.notionToken) {
    document.getElementById('token').value = settings.notionToken;
  }
  if (settings.rootPageId) {
    document.getElementById('rootPageId').value = settings.rootPageId;
  }
  if (settings.defaultPath) {
    document.getElementById('defaultPath').value = settings.defaultPath;
  }
}

// Save settings
async function saveSettings() {
  const token = document.getElementById('token').value.trim();
  const rootPageId = document.getElementById('rootPageId').value.trim();
  const defaultPath = document.getElementById('defaultPath').value.trim();

  if (!token) {
    showStatus('Please enter your Notion token', 'error');
    return;
  }

  if (!rootPageId) {
    showStatus('Please enter your root page ID', 'error');
    return;
  }

  // Clean up page ID (remove dashes if pasted with them, or extract from URL)
  const cleanPageId = extractPageId(rootPageId);

  await chrome.storage.sync.set({
    notionToken: token,
    rootPageId: cleanPageId,
    defaultPath: defaultPath
  });

  showStatus('✅ Settings saved successfully!', 'success');
}

// Extract page ID from URL or clean up format
function extractPageId(input) {
  // If it's a full Notion URL
  const urlMatch = input.match(/[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  if (urlMatch) {
    return urlMatch[0];
  }
  return input;
}

// Test connection to Notion
async function testConnection() {
  const token = document.getElementById('token').value.trim();
  const rootPageId = document.getElementById('rootPageId').value.trim();

  if (!token || !rootPageId) {
    showStatus('Please fill in both token and page ID first', 'error');
    return;
  }

  showStatus('Testing connection...', 'info');

  try {
    const cleanPageId = extractPageId(rootPageId);
    
    const response = await fetch(`https://api.notion.com/v1/pages/${cleanPageId}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': NOTION_API_VERSION
      }
    });

    if (response.ok) {
      const data = await response.json();
      const pageTitle = data.properties?.title?.title?.[0]?.plain_text || 'Untitled';
      showStatus(`✅ Connected! Root page: "${pageTitle}"`, 'success');
    } else {
      const error = await response.json();
      showStatus(`❌ ${error.message || 'Connection failed'}`, 'error');
    }
  } catch (error) {
    showStatus(`❌ ${error.message}`, 'error');
  }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('testBtn').addEventListener('click', testConnection);
});
