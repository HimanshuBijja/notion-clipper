// Notion Clipper - Background Service Worker

const NOTION_API_VERSION = '2022-06-28';
const NOTION_API_BASE = 'https://api.notion.com/v1';

// Get default path based on current date: Notion-Extension/Year/Month/Day
function getDefaultPath() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const day = now.getDate().toString().padStart(2, '0');
  return `Notion-Extension/${year}/${month}/${day}`;
}

// Load config from storage
async function getConfig() {
  const result = await chrome.storage.sync.get(['notionToken', 'rootPageId']);
  return {
    token: result.notionToken || '',
    rootPageId: result.rootPageId || ''
  };
}

// Search for a child page by title under a parent
async function findChildPage(token, parentId, title) {
  const response = await fetch(`${NOTION_API_BASE}/blocks/${parentId}/children?page_size=100`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Notion-Version': NOTION_API_VERSION
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch children: ${response.status}`);
  }

  const data = await response.json();
  
  for (const block of data.results) {
    if (block.type === 'child_page' && block.child_page.title.toLowerCase() === title.toLowerCase()) {
      return block.id;
    }
  }
  
  return null;
}

// Create a new child page under a parent
async function createChildPage(token, parentId, title) {
  const response = await fetch(`${NOTION_API_BASE}/pages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_API_VERSION
    },
    body: JSON.stringify({
      parent: { page_id: parentId },
      properties: {
        title: {
          title: [{ text: { content: title } }]
        }
      }
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to create page: ${error.message || response.status}`);
  }

  const data = await response.json();
  return data.id;
}

// Resolve path to final page ID, creating pages as needed
async function resolvePath(token, rootPageId, path, autoCreate = true) {
  const segments = path.split('/').map(s => s.trim()).filter(s => s.length > 0);
  
  if (segments.length === 0) {
    return rootPageId;
  }

  let currentPageId = rootPageId;

  for (const segment of segments) {
    const childId = await findChildPage(token, currentPageId, segment);
    
    if (childId) {
      currentPageId = childId;
    } else if (autoCreate) {
      currentPageId = await createChildPage(token, currentPageId, segment);
    } else {
      throw new Error(`Page not found: ${segment}`);
    }
  }

  return currentPageId;
}

// Append content to a page
async function appendContent(token, pageId, text, sourceUrl) {
  const blocks = [
    {
      object: 'block',
      type: 'divider',
      divider: {}
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: `📋 Copied from: ` }
          },
          {
            type: 'text',
            text: { content: sourceUrl, link: { url: sourceUrl } }
          }
        ]
      }
    },
    {
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: `⏰ ${new Date().toLocaleString()}` }
          }
        ]
      }
    },
    {
      object: 'block',
      type: 'quote',
      quote: {
        rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }]
      }
    }
  ];

  const response = await fetch(`${NOTION_API_BASE}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_API_VERSION
    },
    body: JSON.stringify({ children: blocks })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(`Failed to append content: ${error.message || response.status}`);
  }

  return true;
}

// Show notification
function showNotification(title, message, isError = false) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: title,
    message: message
  });
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveToNotion') {
    handleSaveToNotion(request)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep channel open for async response
  }
  
  if (request.action === 'getDefaultPath') {
    sendResponse({ path: getDefaultPath() });
    return false;
  }
});

async function handleSaveToNotion({ text, url, path, autoCreate }) {
  const config = await getConfig();
  
  if (!config.token || !config.rootPageId) {
    showNotification('Configuration Required', 'Please set up your Notion token and root page ID in options.', true);
    return { success: false, error: 'Not configured' };
  }

  const targetPath = path && path.trim() ? path.trim() : getDefaultPath();

  try {
    const pageId = await resolvePath(config.token, config.rootPageId, targetPath, autoCreate);
    await appendContent(config.token, pageId, text, url);
    
    showNotification('Saved to Notion! ✅', `Path: ${targetPath}`);
    return { success: true, path: targetPath };
  } catch (error) {
    showNotification('Save Failed ❌', error.message, true);
    return { success: false, error: error.message };
  }
}

// ==========================================
// CONTEXT MENU (Right-click -> Save to Notion)
// ==========================================

// Create context menu on extension install/update
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'saveToNotion',
    title: '📋 Save to Notion',
    contexts: ['selection']
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'saveToNotion') return;

  // Use scripting to get formatted text (preserves line breaks)
  let selectedText = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString()
    });
    selectedText = results?.[0]?.result || '';
  } catch (error) {
    // Fallback to info.selectionText if scripting fails
    selectedText = info.selectionText || '';
  }
  
  if (!selectedText || !selectedText.trim()) {
    showNotification('No text selected', 'Please select some text first.', true);
    return;
  }

  // Get custom path from storage (set via popup) or use default
  const { lastPath } = await chrome.storage.sync.get(['lastPath']);
  
  await handleSaveToNotion({
    text: selectedText,
    url: tab.url,
    path: lastPath || '', // Uses lastPath if set, otherwise default
    autoCreate: true
  });
});

