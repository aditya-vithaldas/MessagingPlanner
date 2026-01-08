const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('api', {
  // Navigation
  navigateTo: (page) => ipcRenderer.invoke('navigate-to', page),

  // Setup status
  getSetupStatus: () => ipcRenderer.invoke('get-setup-status'),
  completeSetup: () => ipcRenderer.invoke('complete-setup'),
  resetSetup: () => ipcRenderer.invoke('reset-setup'),

  // Gmail
  gmailAuth: () => ipcRenderer.invoke('gmail-auth'),
  gmailGetSummary: () => ipcRenderer.invoke('gmail-get-summary'),
  gmailDisconnect: () => ipcRenderer.invoke('gmail-disconnect'),
  gmailSetCredentials: (clientId, clientSecret) => ipcRenderer.invoke('gmail-set-credentials', clientId, clientSecret),
  gmailGetCredentialsStatus: () => ipcRenderer.invoke('gmail-get-credentials-status'),
  onGmailAuthSuccess: (callback) => {
    ipcRenderer.on('gmail-auth-success', callback);
    return () => ipcRenderer.removeListener('gmail-auth-success', callback);
  },

  // WhatsApp
  whatsappInit: () => ipcRenderer.invoke('whatsapp-init'),
  whatsappGetSummary: () => ipcRenderer.invoke('whatsapp-get-summary'),
  whatsappDisconnect: () => ipcRenderer.invoke('whatsapp-disconnect'),
  onWhatsAppQR: (callback) => {
    ipcRenderer.on('whatsapp-qr', (event, qr) => callback(qr));
    return () => ipcRenderer.removeListener('whatsapp-qr', callback);
  },
  onWhatsAppReady: (callback) => {
    ipcRenderer.on('whatsapp-ready', callback);
    return () => ipcRenderer.removeListener('whatsapp-ready', callback);
  },
  onWhatsAppAuthenticated: (callback) => {
    ipcRenderer.on('whatsapp-authenticated', callback);
    return () => ipcRenderer.removeListener('whatsapp-authenticated', callback);
  },
  onWhatsAppAuthFailure: (callback) => {
    ipcRenderer.on('whatsapp-auth-failure', (event, msg) => callback(msg));
    return () => ipcRenderer.removeListener('whatsapp-auth-failure', callback);
  },
  onWhatsAppDisconnected: (callback) => {
    ipcRenderer.on('whatsapp-disconnected', (event, reason) => callback(reason));
    return () => ipcRenderer.removeListener('whatsapp-disconnected', callback);
  },
  onWhatsAppQRTimeout: (callback) => {
    ipcRenderer.on('whatsapp-qr-timeout', callback);
    return () => ipcRenderer.removeListener('whatsapp-qr-timeout', callback);
  },

  // Notion
  notionAuth: (token) => ipcRenderer.invoke('notion-auth', token),
  notionGetSummary: () => ipcRenderer.invoke('notion-get-summary'),
  notionDisconnect: () => ipcRenderer.invoke('notion-disconnect'),

  // Dashboard
  getAllSummaries: () => ipcRenderer.invoke('get-all-summaries'),

  // Claude AI
  claudeSetApiKey: (apiKey) => ipcRenderer.invoke('claude-set-api-key', apiKey),
  claudeIsConfigured: () => ipcRenderer.invoke('claude-is-configured'),
  claudeGetApiKeyStatus: () => ipcRenderer.invoke('claude-get-api-key-status'),

  // AI Summaries (with optional forceRefresh parameter)
  getTodaySummary: (type, forceRefresh = false) => ipcRenderer.invoke('get-today-summary', type, forceRefresh),
  getWeekSummary: (type, forceRefresh = false) => ipcRenderer.invoke('get-week-summary', type, forceRefresh),
  getActionItems: (type, forceRefresh = false) => ipcRenderer.invoke('get-action-items', type, forceRefresh),
  askQuestion: (type, question) => ipcRenderer.invoke('ask-question', type, question),
  getCombinedSummary: (forceRefresh = false) => ipcRenderer.invoke('get-combined-summary', forceRefresh),

  // Topic details (real-time Claude Haiku call)
  getTopicDetails: (topic, chatName, source) => ipcRenderer.invoke('get-topic-details', topic, chatName, source)
});
