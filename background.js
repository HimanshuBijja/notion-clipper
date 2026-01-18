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

  const blocks = [];
  
  // Clean up HTML - normalize line breaks
  let content = html
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  
  // Split content into processable chunks by finding block-level elements
  // Use markers to track positions and types
  const elements = [];
  
  // Find all block-level elements with their positions
  // Order matters - check more specific patterns first
  const patterns = [
    // Code blocks - various patterns used by different sites
    { regex: /<pre[^>]*><code[^>]*(?:class="[^"]*language-(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/code><\/pre>/gi, type: 'code' },
    { regex: /<pre[^>]*>[\s\S]*?<code[^>]*(?:class="[^"]*language-(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/code>[\s\S]*?<\/pre>/gi, type: 'code' },
    { regex: /<pre[^>]*(?:class="[^"]*language-(\w+)[^"]*")?[^>]*>([\s\S]*?)<\/pre>/gi, type: 'pre' },
    { regex: /<figure[^>]*>[\s\S]*?<pre[^>]*>([\s\S]*?)<\/pre>[\s\S]*?<\/figure>/gi, type: 'figure-code' },
    // Medium-specific code blocks (uses classes like graf--code, code-block)
    { regex: /<pre[^>]*class="[^"]*(?:graf--code|code-block|highlight)[^"]*"[^>]*>([\s\S]*?)<\/pre>/gi, type: 'medium-code' },
    { regex: /<div[^>]*class="[^"]*(?:code-block|highlight|prism)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi, type: 'div-code' },
    // Headings
    { regex: /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, type: 'heading' },
    // Other block elements
    { regex: /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, type: 'quote' },
    { regex: /<ul[^>]*>([\s\S]*?)<\/ul>/gi, type: 'ul' },
    { regex: /<ol[^>]*>([\s\S]*?)<\/ol>/gi, type: 'ol' },
    { regex: /<p[^>]*>([\s\S]*?)<\/p>/gi, type: 'p' },
    { regex: /<div[^>]*>([\s\S]*?)<\/div>/gi, type: 'div' },
    { regex: /<li[^>]*>([\s\S]*?)<\/li>/gi, type: 'li' }
  ];
  
  // Find all matches with their positions
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
  
  // Sort by position to maintain document order
  elements.sort((a, b) => a.start - b.start);
  
  // Remove overlapping elements (keep the outermost)
  const filtered = [];
  for (const el of elements) {
    // Check if this element is inside a previously added element
    const isNested = filtered.some(prev => el.start >= prev.start && el.end <= prev.end);
    if (!isNested) {
      filtered.push(el);
    }
  }
  
  // Process elements in order
  for (const el of filtered) {
    const match = el.match;
    
    switch (el.type) {
      case 'code':
        const cleanCode = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ''));
        if (cleanCode.trim()) {
          blocks.push({
            object: 'block',
            type: 'code',
            code: {
              rich_text: [{ type: 'text', text: { content: cleanCode.slice(0, 2000) } }],
              language: match[1] || 'plain text'
            }
          });
        }
        break;
      
      case 'pre':
        // Standalone <pre> without <code>
        const preCode = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ''));
        if (preCode.trim()) {
          blocks.push({
            object: 'block',
            type: 'code',
            code: {
              rich_text: [{ type: 'text', text: { content: preCode.slice(0, 2000) } }],
              language: match[1] || 'plain text'
            }
          });
        }
        break;
        
      case 'figure-code':
        // <figure> wrapped code (common in Medium)
        const figureCode = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ''));
        if (figureCode.trim()) {
          blocks.push({
            object: 'block',
            type: 'code',
            code: {
              rich_text: [{ type: 'text', text: { content: figureCode.slice(0, 2000) } }],
              language: 'plain text'
            }
          });
        }
        break;
      
      case 'medium-code':
      case 'div-code':
        // Medium and other class-based code blocks
        const classCode = decodeHtmlEntities(match[1].replace(/<[^>]+>/g, ''));
        if (classCode.trim()) {
          blocks.push({
            object: 'block',
            type: 'code',
            code: {
              rich_text: [{ type: 'text', text: { content: classCode.slice(0, 2000) } }],
              language: 'plain text'
            }
          });
        }
        break;
        
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
        // Standalone list items (not in ul/ol)
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
        const pHtml = match[1];
        const pText = stripHtml(pHtml);
        if (pText.trim()) {
          // Check if this paragraph contains mostly code (has <code> tags or looks like code)
          const hasCodeTag = /<code[^>]*>/i.test(pHtml);
          const looksLikeCode = /^[\s]*(?:\/\/|\/\*|{|\[|const |let |var |function |import |export |class |if\s*\(|for\s*\(|while\s*\(|return |=>|<\w+|<\/\w+)/.test(pText);
          
          if (hasCodeTag || looksLikeCode) {
            blocks.push({
              object: 'block',
              type: 'code',
              code: {
                rich_text: [{ type: 'text', text: { content: pText.slice(0, 2000) } }],
                language: 'javascript'
              }
            });
          } else {
            blocks.push({
              object: 'block',
              type: 'paragraph',
              paragraph: { rich_text: [{ type: 'text', text: { content: pText.slice(0, 2000) } }] }
            });
          }
        }
        break;
    }
  }
  
  // If no blocks were created, fall back to plain text
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

// Strip HTML tags
function stripHtml(html) {
  return decodeHtmlEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
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
  const headerBlocks = [
    {
      object: 'block',
      type: 'divider',
      divider: {}
    }
  ];
  
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
            annotations: { code: true }
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

