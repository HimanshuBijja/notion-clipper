// Notion Clipper - Background Service Worker

const NOTION_API_VERSION = '2022-06-28';
const NOTION_API_BASE = 'https://api.notion.com/v1';

// Get default path based on current date: Inbox/Year/Month/Day
function getDefaultPath() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.toLocaleString('en-US', { month: 'long' });
  const day = now.getDate().toString().padStart(2, '0');
  return `Inbox/${year}/${month}/${day}`;
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

// Parse HTML and convert to Notion blocks (regex-based for service worker compatibility)
function htmlToNotionBlocks(html, plainText) {
  if (!html || html.trim() === '') {
    return createTextBlocks(plainText);
  }

  // Just treat everything as text/paragraphs, preserving structure as much as possible
  // We use the plainText fallback logic derived from HTML to preserve line breaks better
  // or we can just process paragraphs. 
  
  // The user wants to "remove the code blocks text formating... remove that entirely"
  // and "format code according to the copied lines".
  
  // Let's rely on standard paragraph detection but WITHOUT special code block handling.
  
  const blocks = [];
  
  // Clean up HTML
  let content = html
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
    
  // We will still detect lists and headings as those are useful structure, 
  // but strictly treat pre/code as regular text paragraphs.
  
  // Markers for blocks we WANT to preserve structure for
  const elements = [];
  
  const patterns = [
    { regex: /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, type: 'heading' },
    { regex: /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, type: 'quote' },
    { regex: /<ul[^>]*>([\s\S]*?)<\/ul>/gi, type: 'ul' },
    { regex: /<ol[^>]*>([\s\S]*?)<\/ol>/gi, type: 'ol' },
    { regex: /<p[^>]*>([\s\S]*?)<\/p>/gi, type: 'p' },
    { regex: /<div[^>]*>([\s\S]*?)<\/div>/gi, type: 'div' },
    { regex: /<li[^>]*>([\s\S]*?)<\/li>/gi, type: 'li' },
    // Treat pre as just text container, but capture it to preserve it
    { regex: /<pre[^>]*>([\s\S]*?)<\/pre>/gi, type: 'p' } 
  ];
  
  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    while ((match = regex.exec(content)) !== null) {
      elements.push({
        type: pattern.type,
        start: match.index,
        end: match.index + match[0].length,
        match: match
      });
    }
  }
  
  elements.sort((a, b) => a.start - b.start);
  
  const filtered = [];
  for (const el of elements) {
    const isNested = filtered.some(prev => el.start >= prev.start && el.end <= prev.end);
    if (!isNested) {
      filtered.push(el);
    }
  }
  
  for (const el of filtered) {
    const match = el.match;
    
    switch (el.type) {
      case 'heading':
        const headingText = stripHtml(match[2]);
        if (headingText.trim()) {
          const level = match[1];
          const headingType = level === '1' ? 'heading_1' : level === '2' ? 'heading_2' : 'heading_3';
          blocks.push({
            object: 'block',
            type: headingType,
            [headingType]: { rich_text: [{ type: 'text', text: { content: headingText.slice(0, 2000) } }] }
          });
        }
        break;
        
      case 'quote':
        const quoteText = stripHtml(match[1]);
        if (quoteText.trim()) {
          blocks.push({
            object: 'block',
            type: 'quote',
            quote: { rich_text: [{ type: 'text', text: { content: quoteText.slice(0, 2000) } }] }
          });
        }
        break;
        
      case 'ul':
        const ulItems = extractListItems(match[1]);
        for (const item of ulItems) {
          blocks.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ type: 'text', text: { content: item.slice(0, 2000) } }] }
          });
        }
        break;
        
      case 'ol':
        const olItems = extractListItems(match[1]);
        for (const item of olItems) {
          blocks.push({
            object: 'block',
            type: 'numbered_list_item',
            numbered_list_item: { rich_text: [{ type: 'text', text: { content: item.slice(0, 2000) } }] }
          });
        }
        break;
        
      case 'li':
        const liText = stripHtml(match[1]);
        if (liText.trim()) {
          blocks.push({
            object: 'block',
            type: 'bulleted_list_item',
            bulleted_list_item: { rich_text: [{ type: 'text', text: { content: liText.slice(0, 2000) } }] }
          });
        }
        break;
        
      case 'p':
      case 'div':
        // For paragraphs, we want to respect line breaks from the source more faithfully
        // if the user wants "according to copied lines".
        const pText = stripHtml(match[1]);
        if (pText.trim()) {
           blocks.push({
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ type: 'text', text: { content: pText.slice(0, 2000) } }] }
          });
        }
        break;
    }
  }
  
  if (blocks.length === 0) {
    return createTextBlocks(plainText);
  }
  
  return blocks;
}

// Create text blocks from plain text, splitting by paragraphs
function createTextBlocks(text) {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  
  if (paragraphs.length === 0) {
    return [{
      object: 'block',
      type: 'paragraph',
      paragraph: { rich_text: [{ type: 'text', text: { content: text.slice(0, 2000) } }] }
    }];
  }
  
  return paragraphs.map(p => ({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [{ type: 'text', text: { content: p.trim().slice(0, 2000) } }] }
  }));
}

// Extract list items from list content
function extractListItems(listHtml) {
  const items = [];
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;
  while ((match = liRegex.exec(listHtml)) !== null) {
    const text = stripHtml(match[1]);
    if (text.trim()) {
      items.push(text);
    }
  }
  return items;
}

// Strip HTML tags but preserve newlines better
function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n') // End of paragraph is a newline
      .replace(/<\/div>/gi, '\n') // End of div is a newline
      .replace(/<[^>]+>/g, '') // Strip other tags
      .replace(/[ \t]+/g, ' ') // Collapse multiple spaces/tabs to single space, but NOT newlines
      .trim()
  );
}

// Decode HTML entities
function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
}

// Append content to a page
async function appendContent(token, pageId, text, sourceUrl, html) {
  // Check if this is the same URL as last time
  const { lastSavedUrl } = await chrome.storage.local.get(['lastSavedUrl']);
  const isSameSource = lastSavedUrl === sourceUrl;
  
  // Save current URL for next comparison
  await chrome.storage.local.set({ lastSavedUrl: sourceUrl });
  
  // Format date and time
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
  
  // Build header blocks
  const headerBlocks = [];
  
  // Add a spacer block (empty paragraph) before the divider to separate from previous content
  headerBlocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [] } // Empty text block acts as spacer
  });
  
  headerBlocks.push({
    object: 'block',
    type: 'divider',
    divider: {}
  });
  
  // Only add source line if different URL
  if (!isSameSource) {
    headerBlocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          { 
            type: 'text', 
            text: { content: 'source' },
            annotations: { code: true, color: 'red' } // Attempt to style, though color support via API is limited in rich_text annotations directly without specific color param, usually 'code' is enough for the look user wants. Actually Notion API 'annotations' object supports 'color'.
          },
          { type: 'text', text: { content: ' : ' } },
          { type: 'text', text: { content: sourceUrl, link: { url: sourceUrl } } }
        ]
      }
    });
  }
  
  // Add date and time line
  headerBlocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        { 
          type: 'text', 
          text: { content: dateStr },
          annotations: { code: true }
        },
        { type: 'text', text: { content: '  ' } },
        { 
          type: 'text', 
          text: { content: timeStr },
          annotations: { code: true }
        }
      ]
    }
  });
  
  // Convert HTML to Notion blocks (or fall back to quote)
  const contentBlocks = htmlToNotionBlocks(html, text);
  
  // Combine all blocks (max 100 per request)
  const allBlocks = [...headerBlocks, ...contentBlocks].slice(0, 100);

  const response = await fetch(`${NOTION_API_BASE}/blocks/${pageId}/children`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Notion-Version': NOTION_API_VERSION
    },
    body: JSON.stringify({ children: allBlocks })
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

// Process special path tokens like #today
function processPathTokens(path) {
  if (!path) return path;
  
  const now = new Date();
  const day = now.getDate().toString().padStart(2, '0');
  const month = now.toLocaleString('en-US', { month: 'long' });
  const year = now.getFullYear();
  
  // Replace #today with dd-Month-YYYY format (e.g., 18-January-2026)
  const todayFormatted = `${day}-${month}-${year}`;
  
  return path.replace(/#today/gi, todayFormatted);
}

async function handleSaveToNotion({ text, html, url, path, autoCreate }) {
  const config = await getConfig();
  
  if (!config.token || !config.rootPageId) {
    showNotification('Configuration Required', 'Please set up your Notion token and root page ID in options.', true);
    return { success: false, error: 'Not configured' };
  }

  // Process path tokens like #today
  let targetPath = path && path.trim() ? path.trim() : getDefaultPath();
  targetPath = processPathTokens(targetPath);

  try {
    const pageId = await resolvePath(config.token, config.rootPageId, targetPath, autoCreate);
    await appendContent(config.token, pageId, text, url, html || '');
    
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

  // Use scripting to get both text and HTML (preserves formatting)
  let selectedText = '';
  let selectedHtml = '';
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const selection = window.getSelection();
        if (!selection.rangeCount) return { text: '', html: '' };
        
        const range = selection.getRangeAt(0);
        const container = document.createElement('div');
        container.appendChild(range.cloneContents());
        
        return {
          text: selection.toString(),
          html: container.innerHTML
        };
      }
    });
    selectedText = results?.[0]?.result?.text || '';
    selectedHtml = results?.[0]?.result?.html || '';
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
    html: selectedHtml,
    url: tab.url,
    path: lastPath || '',
    autoCreate: true
  });
});

