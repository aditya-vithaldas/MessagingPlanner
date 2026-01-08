const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');

// Services
const DatabaseService = require('./services/database');
const GmailService = require('./services/gmail');
const WhatsAppService = require('./services/whatsapp');
const NotionService = require('./services/notion');
const ClaudeService = require('./services/claude');

// Initialize store for persistent data
const store = new Store({
  encryptionKey: 'my-brain-app-secure-key',
  schema: {
    gmail: { type: 'object', default: {} },
    notion: { type: 'object', default: {} },
    whatsapp: { type: 'object', default: {} },
    claude: { type: 'object', default: {} },
    setupComplete: { type: 'boolean', default: false }
  }
});

let mainWindow;
let databaseService;
let gmailService;
let whatsappService;
let notionService;
let claudeService;

// Cache duration: 2.5 hours in milliseconds
const CACHE_MAX_AGE = 2.5 * 60 * 60 * 1000;

// Cache helper functions
function getCachedSummary(type, summaryType) {
  const cacheKey = `cache.${type}.${summaryType}`;
  const cached = store.get(cacheKey);
  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  return {
    data: cached.data,
    timestamp: cached.timestamp,
    age,
    isStale: age > CACHE_MAX_AGE
  };
}

function setCachedSummary(type, summaryType, data) {
  const cacheKey = `cache.${type}.${summaryType}`;
  store.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1a1a2e'
  });

  // Check if setup is complete
  const setupComplete = store.get('setupComplete');

  if (setupComplete) {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dashboard.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/setup.html'));
  }

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }
}

// Initialize services
async function initializeServices() {
  // Initialize database first - shared across all services
  databaseService = new DatabaseService();
  await databaseService.ready; // Wait for sql.js to initialize

  claudeService = new ClaudeService(store);
  gmailService = new GmailService(store, mainWindow, databaseService);
  whatsappService = new WhatsAppService(store, mainWindow, databaseService);
  notionService = new NotionService(store, mainWindow, databaseService);

  console.log('All services initialized with database support');
}

app.whenReady().then(async () => {
  createWindow();
  await initializeServices();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (whatsappService) {
    whatsappService.destroy();
  }
  if (databaseService) {
    databaseService.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers

// Navigation
ipcMain.handle('navigate-to', (event, page) => {
  const pagePath = path.join(__dirname, `../renderer/${page}.html`);
  mainWindow.loadFile(pagePath);
});

// Check setup status
ipcMain.handle('get-setup-status', () => {
  return {
    gmail: store.get('gmail.authenticated', false),
    whatsapp: store.get('whatsapp.authenticated', false),
    notion: store.get('notion.authenticated', false),
    setupComplete: store.get('setupComplete', false)
  };
});

// Complete setup
ipcMain.handle('complete-setup', () => {
  store.set('setupComplete', true);
  mainWindow.loadFile(path.join(__dirname, '../renderer/dashboard.html'));
});

// Reset setup
ipcMain.handle('reset-setup', () => {
  store.clear();
  if (whatsappService) {
    whatsappService.destroy();
  }
  mainWindow.loadFile(path.join(__dirname, '../renderer/setup.html'));
});

// Gmail handlers
ipcMain.handle('gmail-set-credentials', (event, clientId, clientSecret) => {
  store.set('gmail.clientId', clientId);
  store.set('gmail.clientSecret', clientSecret);
  // Reinitialize Gmail service with new credentials
  gmailService = new GmailService(store, mainWindow, databaseService);
  return { success: true };
});

ipcMain.handle('gmail-get-credentials-status', () => {
  const clientId = store.get('gmail.clientId');
  const clientSecret = store.get('gmail.clientSecret');
  return {
    configured: !!(clientId && clientSecret)
  };
});

ipcMain.handle('gmail-auth', async () => {
  return await gmailService.authenticate();
});

ipcMain.handle('gmail-get-summary', async () => {
  return await gmailService.getSummary();
});

ipcMain.handle('gmail-disconnect', () => {
  store.delete('gmail.tokens');
  store.delete('gmail.authenticated');
  // Keep credentials so user can reconnect
  return true;
});

// WhatsApp handlers
ipcMain.handle('whatsapp-init', async () => {
  return await whatsappService.initialize();
});

ipcMain.handle('whatsapp-get-summary', async () => {
  return await whatsappService.getSummary();
});

ipcMain.handle('whatsapp-disconnect', async () => {
  await whatsappService.logout();
  store.delete('whatsapp');
  return true;
});

// Notion handlers
ipcMain.handle('notion-auth', async (event, token) => {
  return await notionService.authenticate(token);
});

ipcMain.handle('notion-get-summary', async () => {
  return await notionService.getSummary();
});

ipcMain.handle('notion-disconnect', () => {
  store.delete('notion');
  return true;
});

// Get all summaries
ipcMain.handle('get-all-summaries', async () => {
  const [gmail, whatsapp, notion] = await Promise.allSettled([
    gmailService.getSummary(),
    whatsappService.getSummary(),
    notionService.getSummary()
  ]);

  return {
    gmail: gmail.status === 'fulfilled' ? gmail.value : { error: gmail.reason?.message },
    whatsapp: whatsapp.status === 'fulfilled' ? whatsapp.value : { error: whatsapp.reason?.message },
    notion: notion.status === 'fulfilled' ? notion.value : { error: notion.reason?.message }
  };
});

// Claude API handlers
ipcMain.handle('claude-set-api-key', (event, apiKey) => {
  claudeService.setApiKey(apiKey);
  return { success: true };
});

ipcMain.handle('claude-is-configured', () => {
  return claudeService.isConfigured();
});

ipcMain.handle('claude-get-api-key-status', () => {
  return {
    configured: claudeService.isConfigured(),
    hasEnvKey: !!process.env.ANTHROPIC_API_KEY
  };
});

// AI Summary handlers
ipcMain.handle('get-today-summary', async (event, type, forceRefresh = false) => {
  if (!claudeService.isConfigured()) {
    return { error: 'Claude API key not configured' };
  }

  // Check cache first
  const cached = getCachedSummary(type, 'today');

  // If cache is fresh (< 2.5 hours), return it immediately
  if (cached && !cached.isStale && !forceRefresh) {
    return { summary: cached.data, fromCache: true, cacheAge: cached.age };
  }

  // If cache exists but is stale, return it with isStale flag
  // The frontend will show it while loading fresh data
  if (cached && !forceRefresh) {
    // Start background refresh (don't await)
    refreshTodaySummary(type).catch(err => console.error('Background refresh error:', err));
    return { summary: cached.data, fromCache: true, isStale: true, cacheAge: cached.age };
  }

  // No cache or force refresh - fetch fresh data
  return await refreshTodaySummary(type);
});

async function refreshTodaySummary(type) {
  try {
    let data;
    let dateRange = null;

    switch (type) {
      case 'gmail':
        data = await gmailService.getSummary();
        break;
      case 'whatsapp':
        // Use today-filtered data for WhatsApp
        data = await whatsappService.getTodaySummary();
        // Calculate date range from messages
        if (data.messages && data.messages.length > 0) {
          const timestamps = data.messages.map(m => m.timestamp);
          const oldest = Math.min(...timestamps);
          const newest = Math.max(...timestamps);
          dateRange = formatDateRange(oldest, newest);
        }
        break;
      case 'notion':
        data = await notionService.getSummary();
        break;
      default:
        return { error: 'Invalid type' };
    }

    if (data.error || !data.authenticated) {
      return { error: data.error || 'Not authenticated' };
    }

    const summary = await claudeService.generateTodaySummary(data, type);
    setCachedSummary(type, 'today', summary);
    return { summary, fromCache: false, dateRange };
  } catch (error) {
    console.error('Today summary error:', error);
    return { error: error.message };
  }
}

function formatDateRange(oldestTimestamp, newestTimestamp) {
  const oldest = new Date(oldestTimestamp * 1000);
  const newest = new Date(newestTimestamp * 1000);

  const formatDate = (date) => {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  };

  const formatTime = (date) => {
    return date.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true
    });
  };

  const oldestDate = formatDate(oldest);
  const newestDate = formatDate(newest);

  if (oldestDate === newestDate) {
    return `${oldestDate}, ${formatTime(oldest)} - ${formatTime(newest)}`;
  } else {
    return `${formatDate(oldest)} ${formatTime(oldest)} - ${formatDate(newest)} ${formatTime(newest)}`;
  }
}

ipcMain.handle('get-week-summary', async (event, type, forceRefresh = false) => {
  if (!claudeService.isConfigured()) {
    return { error: 'Claude API key not configured' };
  }

  const cached = getCachedSummary(type, 'week');

  if (cached && !cached.isStale && !forceRefresh) {
    return { summary: cached.data, fromCache: true, cacheAge: cached.age };
  }

  if (cached && !forceRefresh) {
    refreshWeekSummary(type).catch(err => console.error('Background refresh error:', err));
    return { summary: cached.data, fromCache: true, isStale: true, cacheAge: cached.age };
  }

  return await refreshWeekSummary(type);
});

async function refreshWeekSummary(type) {
  try {
    let data;
    switch (type) {
      case 'gmail':
        data = await gmailService.getSummary();
        break;
      case 'whatsapp':
        // Use week-filtered data for WhatsApp
        data = await whatsappService.getWeekSummary();
        break;
      case 'notion':
        data = await notionService.getSummary();
        break;
      default:
        return { error: 'Invalid type' };
    }

    if (data.error || !data.authenticated) {
      return { error: data.error || 'Not authenticated' };
    }

    const summary = await claudeService.generateWeekSummary(data, type);
    setCachedSummary(type, 'week', summary);
    return { summary, fromCache: false };
  } catch (error) {
    console.error('Week summary error:', error);
    return { error: error.message };
  }
}

ipcMain.handle('get-action-items', async (event, type, forceRefresh = false) => {
  if (!claudeService.isConfigured()) {
    return { error: 'Claude API key not configured' };
  }

  const cached = getCachedSummary(type, 'actions');

  if (cached && !cached.isStale && !forceRefresh) {
    return { actionItems: cached.data, fromCache: true, cacheAge: cached.age };
  }

  if (cached && !forceRefresh) {
    refreshActionItems(type).catch(err => console.error('Background refresh error:', err));
    return { actionItems: cached.data, fromCache: true, isStale: true, cacheAge: cached.age };
  }

  return await refreshActionItems(type);
});

async function refreshActionItems(type) {
  try {
    let data;
    switch (type) {
      case 'gmail':
        data = await gmailService.getSummary();
        break;
      case 'whatsapp':
        data = await whatsappService.getSummary();
        break;
      case 'notion':
        data = await notionService.getSummary();
        break;
      default:
        return { error: 'Invalid type' };
    }

    if (data.error || !data.authenticated) {
      return { error: data.error || 'Not authenticated' };
    }

    const actionItems = await claudeService.generateActionItems(data, type);
    setCachedSummary(type, 'actions', actionItems);
    return { actionItems, fromCache: false };
  } catch (error) {
    console.error('Action items error:', error);
    return { error: error.message };
  }
}

// Get topic details in real-time using Claude Haiku
ipcMain.handle('get-topic-details', async (event, topic, chatName, source) => {
  if (!claudeService.isConfigured()) {
    return { error: 'Claude API key not configured' };
  }

  try {
    let data;
    switch (source) {
      case 'whatsapp':
        data = await whatsappService.getSummary();
        break;
      case 'gmail':
        data = await gmailService.getSummary();
        break;
      case 'notion':
        data = await notionService.getSummary();
        break;
      default:
        return { error: 'Invalid source' };
    }

    if (data.error || !data.authenticated) {
      return { error: data.error || 'Not authenticated' };
    }

    // For WhatsApp, filter to relevant chat if chatName provided
    let relevantData = data;
    if (source === 'whatsapp' && chatName && data.chats) {
      const relevantChat = data.chats.find(c =>
        c.name?.toLowerCase().includes(chatName.toLowerCase())
      );
      if (relevantChat) {
        relevantData = { chat: relevantChat };
      }
    }

    const details = await claudeService.getTopicDetails(topic, chatName || source, relevantData);
    return { details };
  } catch (error) {
    console.error('Topic details error:', error);
    return { error: error.message };
  }
});

ipcMain.handle('ask-question', async (event, type, question) => {
  if (!claudeService.isConfigured()) {
    return { error: 'Claude API key not configured' };
  }

  try {
    let data;
    switch (type) {
      case 'gmail':
        data = await gmailService.getSummary();
        break;
      case 'whatsapp':
        data = await whatsappService.getSummary();
        break;
      case 'notion':
        data = await notionService.getSummary();
        break;
      default:
        return { error: 'Invalid type' };
    }

    if (data.error || !data.authenticated) {
      return { error: data.error || 'Not authenticated' };
    }

    const answer = await claudeService.answerQuestion(data, type, question);
    return { answer };
  } catch (error) {
    console.error('Ask question error:', error);
    return { error: error.message };
  }
});

// Combined daily summary
ipcMain.handle('get-combined-summary', async (event, forceRefresh = false) => {
  if (!claudeService.isConfigured()) {
    return { error: 'Claude API key not configured' };
  }

  const cached = getCachedSummary('combined', 'daily');

  if (cached && !cached.isStale && !forceRefresh) {
    return { summary: cached.data, fromCache: true, cacheAge: cached.age };
  }

  if (cached && !forceRefresh) {
    refreshCombinedSummary().catch(err => console.error('Background refresh error:', err));
    return { summary: cached.data, fromCache: true, isStale: true, cacheAge: cached.age };
  }

  return await refreshCombinedSummary();
});

async function refreshCombinedSummary() {
  try {
    // Fetch all data in parallel
    const [gmail, whatsapp, notion] = await Promise.allSettled([
      gmailService.getSummary(),
      whatsappService.getSummary(),
      notionService.getSummary()
    ]);

    const allData = {
      gmail: gmail.status === 'fulfilled' && gmail.value.authenticated ? gmail.value : null,
      whatsapp: whatsapp.status === 'fulfilled' && whatsapp.value.authenticated ? whatsapp.value : null,
      notion: notion.status === 'fulfilled' && notion.value.authenticated ? notion.value : null
    };

    // Generate combined summary using Claude
    const combinedSummary = await claudeService.generateCombinedSummary(allData);
    setCachedSummary('combined', 'daily', combinedSummary);
    return { summary: combinedSummary, fromCache: false };
  } catch (error) {
    console.error('Combined summary error:', error);
    return { error: error.message };
  }
}
