# 📋 Notion Clipper

Save selected text from any webpage directly to Notion with a single right-click.

## ✨ Features

- **Right-click to save** - Select text → Right-click → Save to Notion
- **Custom paths** - Organize clips into hierarchical pages (e.g., `Projects/Notes/Ideas`)
- **Auto-create pages** - Missing pages in the path are created automatically
- **Smart defaults** - No path? Saves to `Inbox/Year/Month/Day`
- **Preserves formatting** - Line breaks and text structure stay intact

## 🚀 Quick Start

### Step 1: Create a Notion Integration

1. Go to [Notion Integrations](https://www.notion.so/my-integrations)
2. Click **New Integration**
3. Name it (e.g., "Web Clipper")
4. Copy the **Internal Integration Token** (starts with `secret_`)

### Step 2: Share a Root Page with Your Integration

1. Open Notion and create or choose a page to be your "root" (where clips will be saved)
2. Click **Share** (top right)
3. Click **Invite**
4. Select your integration from the list
5. Copy the **Page ID** from the URL:
   ```
   https://notion.so/Your-Page-Title-abc123def456ghi789...
                                      └─────────────────┘
                                         This is the Page ID
   ```

### Step 3: Configure the Extension

1. Click the extension icon → **⚙️ Settings**
2. Paste your **Integration Token**
3. Paste your **Root Page ID**
4. Click **Test Connection** to verify
5. Click **Save Settings**

## 📖 How to Use

### Method 1: Right-Click (Fastest)
1. Select text on any webpage
2. Right-click → **📋 Save to Notion**
3. Done! Check your Notion for the clip

### Method 2: Extension Popup
1. Select text on any webpage
2. Click the extension icon
3. (Optional) Enter a custom path like `Work/Research`
4. Click **Save to Notion**

### Setting a Custom Path
- Open the popup and enter a path (e.g., `Projects/AI/Notes`)
- Click Save once - this path is remembered
- All future right-click saves use this path
- Click **✕** to clear and reset to default

## 📁 Path Examples

| Path You Enter | Where It Saves |
|----------------|----------------|
| *(empty)* | `Inbox/2026/January/18` |
| `Notes` | `Notes` page under your root |
| `Work/Projects/Ideas` | Creates `Work` → `Projects` → `Ideas` |

## 🔒 Privacy

- Your Notion token is stored locally in your browser
- No data is sent to any server except Notion's official API
- See [Privacy Policy](PRIVACY.md) for details

## 🛠️ Troubleshooting

**"Configuration Required" error**
- Open Settings and add your Notion token + root page ID

**"Failed to fetch children" error**
- Make sure you shared the root page with your integration
- Check that the page ID is correct

**Context menu not appearing**
- Reload the extension in `chrome://extensions/`
- Refresh the webpage

## 📝 License

MIT License - Feel free to modify and use!
