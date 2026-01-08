const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const { app } = require('electron');

class WhatsAppService {
  constructor(store, mainWindow, database) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.db = database;
    this.client = null;
    this.isReady = false;
    this.isInitializing = false;
  }

  async initialize() {
    if (this.isInitializing) {
      return { status: 'initializing' };
    }

    if (this.isReady && this.client) {
      return { status: 'ready', authenticated: true };
    }

    this.isInitializing = true;

    return new Promise((resolve, reject) => {
      try {
        // Create WhatsApp client with local auth to persist session
        this.client = new Client({
          authStrategy: new LocalAuth({
            dataPath: path.join(app.getPath('userData'), 'whatsapp-session')
          }),
          puppeteer: {
            headless: true,
            args: [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--disable-dev-shm-usage',
              '--disable-accelerated-2d-canvas',
              '--no-first-run',
              '--no-zygote',
              '--disable-gpu'
            ]
          }
        });

        // QR Code event
        this.client.on('qr', async (qr) => {
          console.log('WhatsApp QR received');
          try {
            const qrDataUrl = await qrcode.toDataURL(qr, {
              width: 256,
              margin: 2,
              color: {
                dark: '#000000',
                light: '#ffffff'
              }
            });
            this.mainWindow.webContents.send('whatsapp-qr', qrDataUrl);
          } catch (err) {
            console.error('QR generation error:', err);
          }
        });

        // Ready event
        this.client.on('ready', () => {
          console.log('WhatsApp client is ready!');
          this.isReady = true;
          this.isInitializing = false;
          this.store.set('whatsapp.authenticated', true);
          this.mainWindow.webContents.send('whatsapp-ready');
          resolve({ status: 'ready', authenticated: true });
        });

        // Authenticated event
        this.client.on('authenticated', () => {
          console.log('WhatsApp authenticated');
          this.mainWindow.webContents.send('whatsapp-authenticated');
        });

        // Auth failure event
        this.client.on('auth_failure', (msg) => {
          console.error('WhatsApp auth failure:', msg);
          this.isInitializing = false;
          this.store.set('whatsapp.authenticated', false);
          this.mainWindow.webContents.send('whatsapp-auth-failure', msg);
          reject(new Error('Authentication failed: ' + msg));
        });

        // Disconnected event - auto-reconnect
        this.client.on('disconnected', async (reason) => {
          console.log('WhatsApp disconnected:', reason);
          this.isReady = false;
          this.isInitializing = false;
          this.mainWindow.webContents.send('whatsapp-disconnected', reason);

          // Auto-reconnect after 3 seconds
          console.log('Attempting auto-reconnect in 3 seconds...');
          setTimeout(async () => {
            try {
              if (!this.isReady && !this.isInitializing) {
                console.log('Auto-reconnecting WhatsApp...');
                this.client = null;
                await this.initialize();
              }
            } catch (err) {
              console.error('Auto-reconnect failed:', err);
              this.store.set('whatsapp.authenticated', false);
            }
          }, 3000);
        });

        // Initialize the client
        this.client.initialize();

        // Timeout after 2 minutes - just reset state, don't throw error
        setTimeout(() => {
          if (!this.isReady && this.isInitializing) {
            this.isInitializing = false;
            if (this.client) {
              try {
                this.client.destroy();
              } catch (e) {}
              this.client = null;
            }
            this.mainWindow.webContents.send('whatsapp-qr-timeout');
            resolve({ status: 'timeout' });
          }
        }, 120000);

      } catch (error) {
        this.isInitializing = false;
        console.error('WhatsApp init error:', error);
        reject(error);
      }
    });
  }

  async syncToDatabase(fullSync = false) {
    if (!this.isReady || !this.client) {
      return { error: 'WhatsApp not connected' };
    }

    if (!this.db) {
      return { error: 'Database not initialized' };
    }

    // Get last sync time for incremental sync
    const lastSyncTime = this.db.getLastSyncTime('whatsapp');
    const monthAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

    // Use the later of: last sync time or 1 month ago
    // For first sync or full sync, use 1 month ago
    const syncFromTime = (!fullSync && lastSyncTime && lastSyncTime > monthAgo)
      ? lastSyncTime
      : monthAgo;

    const isIncremental = syncFromTime > monthAgo;
    console.log(`Syncing WhatsApp data to database (${isIncremental ? 'incremental' : 'full'} sync from ${new Date(syncFromTime * 1000).toISOString()})...`);

    let totalMessages = 0;
    let newMessages = 0;

    try {
      const chats = await this.client.getChats();

      for (const chat of chats.slice(0, 50)) {
        const chatName = chat.name || chat.id.user || 'Unknown';
        const chatId = chat.id._serialized;

        // Store chat info
        this.db.upsertWhatsAppChat({
          id: chatId,
          name: chatName,
          isGroup: chat.isGroup,
          participantCount: chat.participants?.length || 0,
          lastMessageAt: chat.timestamp || 0
        });

        // For incremental sync, fetch fewer messages (most recent only)
        // For full sync, fetch more to cover the month
        const fetchLimit = isIncremental ? 100 : 500;
        const messages = await chat.fetchMessages({ limit: fetchLimit });

        // Filter to messages newer than sync time
        const newMsgs = messages.filter(m => m.timestamp > syncFromTime);

        if (newMsgs.length > 0) {
          const messagesToStore = newMsgs.map(m => ({
            id: m.id._serialized || `${chatId}_${m.timestamp}`,
            chatId: chatId,
            chatName: chatName,
            isGroup: chat.isGroup,
            sender: this.formatSender(m.author || m.from),
            body: m.body || '',
            timestamp: m.timestamp,
            fromMe: m.fromMe,
            hasMedia: m.hasMedia
          }));

          this.db.bulkUpsertWhatsAppMessages(messagesToStore);
          newMessages += messagesToStore.length;
        }
        totalMessages += messages.length;
      }

      this.db.updateSyncLog('whatsapp', newMessages);

      console.log(`WhatsApp sync complete: ${newMessages} new messages stored (${totalMessages} total checked)`);
      return { success: true, newMessages, totalChecked: totalMessages, isIncremental };
    } catch (error) {
      console.error('WhatsApp sync error:', error);
      return { error: error.message };
    }
  }

  async getSummary(timeFilter = 'all') {
    if (!this.isReady || !this.client) {
      return {
        error: 'WhatsApp not connected',
        authenticated: false,
        needsInit: true
      };
    }

    try {
      // Sync to database first (in background for fresh data)
      this.syncToDatabase().catch(err => console.error('Background sync error:', err));

      // Get all chats
      const chats = await this.client.getChats();

      // Calculate time boundaries
      const now = Date.now() / 1000;
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTimestamp = todayStart.getTime() / 1000;
      const weekAgo = now - (7 * 24 * 60 * 60);
      const monthAgo = now - (30 * 24 * 60 * 60);

      // Count unread messages
      let totalUnread = 0;
      const groupSummaries = [];
      const contactSummaries = [];

      // Process chats for summaries
      for (const chat of chats.slice(0, 30)) {
        totalUnread += chat.unreadCount || 0;

        // Fetch messages - get more for month view
        const limit = timeFilter === 'month' ? 500 : 100;
        const messages = await chat.fetchMessages({ limit });

        if (messages.length > 0) {
          // Filter messages based on timeFilter
          let filteredMessages = messages;
          if (timeFilter === 'today') {
            filteredMessages = messages.filter(m => m.timestamp >= todayTimestamp);
          } else if (timeFilter === 'week') {
            filteredMessages = messages.filter(m => m.timestamp >= weekAgo);
          } else if (timeFilter === 'month') {
            filteredMessages = messages.filter(m => m.timestamp >= monthAgo);
          }

          // Only include if there are messages in the time period
          if (filteredMessages.length > 0) {
            const chatSummary = await this.generateChatSummary(chat, filteredMessages, timeFilter);

            if (chat.isGroup) {
              groupSummaries.push(chatSummary);
            } else {
              contactSummaries.push(chatSummary);
            }
          }
        }
      }

      // Sort by activity (unread first, then by timestamp)
      groupSummaries.sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0) || (b.lastActivity || 0) - (a.lastActivity || 0));
      contactSummaries.sort((a, b) => (b.unreadCount || 0) - (a.unreadCount || 0) || (b.lastActivity || 0) - (a.lastActivity || 0));

      // Get contact count
      const contacts = await this.client.getContacts();
      const savedContacts = contacts.filter(c => c.isMyContact).length;

      // Generate overall summary
      const overallSummary = this.generateOverallSummary(groupSummaries, contactSummaries, totalUnread);

      return {
        authenticated: true,
        timeFilter,
        totalUnread,
        totalChats: chats.length,
        totalGroups: groupSummaries.length,
        totalContacts: contactSummaries.length,
        savedContacts,
        overallSummary,
        chats: [...groupSummaries.slice(0, 10), ...contactSummaries.slice(0, 10)],
        groupSummaries: groupSummaries.slice(0, 10),
        contactSummaries: contactSummaries.slice(0, 10),
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('WhatsApp getSummary error:', error);
      return { error: error.message, authenticated: this.isReady };
    }
  }

  // Get summary filtered for today only
  async getTodaySummary() {
    return this.getSummary('today');
  }

  // Get summary filtered for this week
  async getWeekSummary() {
    return this.getSummary('week');
  }

  // Get summary for the month
  async getMonthSummary() {
    return this.getSummary('month');
  }

  // Get data from database (for when WhatsApp is disconnected)
  getFromDatabase(timeFilter = 'all') {
    if (!this.db) return null;

    const messages = this.db.getWhatsAppMessages(timeFilter);
    const chats = this.db.getWhatsAppChats();

    // Group messages by chat
    const chatMessages = {};
    for (const msg of messages) {
      if (!chatMessages[msg.chat_id]) {
        chatMessages[msg.chat_id] = [];
      }
      chatMessages[msg.chat_id].push(msg);
    }

    return {
      authenticated: true,
      fromDatabase: true,
      totalMessages: messages.length,
      totalChats: chats.length,
      chats: chats.map(c => ({
        ...c,
        messages: chatMessages[c.id] || []
      })),
      lastUpdated: new Date().toISOString()
    };
  }

  async generateChatSummary(chat, messages, timeFilter) {
    const name = chat.name || chat.id.user || 'Unknown';
    const isGroup = chat.isGroup;
    const unreadCount = chat.unreadCount || 0;

    // Get participant info for groups
    let participants = [];
    if (isGroup && chat.participants) {
      participants = chat.participants.map(p => p.id.user);
    }

    // Analyze messages
    const messageAnalysis = this.analyzeMessages(messages, isGroup);

    // Extract actual message content for better AI summaries
    const messageExcerpts = messages
      .filter(m => m.body && m.body.length > 5)
      .slice(0, 20)
      .map(m => ({
        text: m.body.substring(0, 200),
        sender: this.formatSender(m.author || m.from),
        fromMe: m.fromMe,
        time: new Date(m.timestamp * 1000).toLocaleTimeString()
      }));

    // Build summary
    const summary = {
      id: chat.id._serialized,
      name,
      isGroup,
      unreadCount,
      timeFilter,
      lastActivity: messages[0]?.timestamp || chat.timestamp,
      messageCount: messages.length,
      messageExcerpts, // Include actual messages for AI
      ...messageAnalysis
    };

    if (isGroup) {
      summary.participantCount = participants.length;
      summary.activeParticipants = messageAnalysis.activeSenders?.slice(0, 5) || [];
    }

    return summary;
  }

  analyzeMessages(messages, isGroup) {
    if (!messages || messages.length === 0) {
      return {
        summary: 'No recent messages',
        topics: [],
        mediaCount: 0
      };
    }

    // Filter to last 24-48 hours of messages for relevance
    const now = Date.now() / 1000;
    const recentMessages = messages.filter(m => (now - m.timestamp) < 172800); // 48 hours

    // Count message types
    let textMessages = [];
    let mediaCount = 0;
    let linksCount = 0;
    const senderCounts = {};
    const wordFrequency = {};

    for (const msg of recentMessages) {
      // Track senders
      const sender = msg.author || msg.from;
      if (sender && !msg.fromMe) {
        const senderName = this.formatSender(sender);
        senderCounts[senderName] = (senderCounts[senderName] || 0) + 1;
      }

      // Categorize message type
      if (msg.hasMedia) {
        mediaCount++;
      } else if (msg.body) {
        textMessages.push({
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          sender: this.formatSender(msg.author || msg.from)
        });

        // Check for links
        if (msg.body.match(/https?:\/\/[^\s]+/)) {
          linksCount++;
        }

        // Word frequency for topic detection (skip common words)
        const words = msg.body.toLowerCase().split(/\s+/);
        const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
          'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
          'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used', 'to', 'of',
          'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
          'before', 'after', 'above', 'below', 'between', 'under', 'again', 'further', 'then',
          'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more',
          'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so',
          'than', 'too', 'very', 'just', 'and', 'but', 'if', 'or', 'because', 'until', 'while',
          'i', 'me', 'my', 'myself', 'we', 'our', 'you', 'your', 'he', 'him', 'his', 'she',
          'her', 'it', 'its', 'they', 'them', 'their', 'what', 'which', 'who', 'whom', 'this',
          'that', 'these', 'those', 'am', 'ok', 'okay', 'yes', 'no', 'yeah', 'hi', 'hello',
          'hey', 'thanks', 'thank', 'please', 'sorry', 'good', 'great', 'nice', 'like', 'know']);

        words.forEach(word => {
          const cleaned = word.replace(/[^a-z0-9]/g, '');
          if (cleaned.length > 3 && !stopWords.has(cleaned)) {
            wordFrequency[cleaned] = (wordFrequency[cleaned] || 0) + 1;
          }
        });
      }
    }

    // Get top senders (for groups)
    const activeSenders = Object.entries(senderCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, messageCount: count }));

    // Get potential topics (words that appear multiple times)
    const topics = Object.entries(wordFrequency)
      .filter(([word, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([word]) => word);

    // Generate human-readable summary
    const summaryText = this.generateTextSummary(textMessages, topics, activeSenders, mediaCount, linksCount, isGroup);

    return {
      summary: summaryText,
      topics,
      activeSenders: isGroup ? activeSenders : undefined,
      mediaCount,
      linksCount,
      recentMessageCount: recentMessages.length,
      lastMessages: textMessages.slice(0, 3).map(m => ({
        text: m.body.substring(0, 100),
        sender: m.sender,
        fromMe: m.fromMe
      }))
    };
  }

  generateTextSummary(textMessages, topics, activeSenders, mediaCount, linksCount, isGroup) {
    const parts = [];

    // Message activity
    if (textMessages.length === 0) {
      return 'No recent text messages';
    }

    // For groups, mention active participants
    if (isGroup && activeSenders.length > 0) {
      const topSenders = activeSenders.slice(0, 3).map(s => s.name).join(', ');
      parts.push(`Active participants: ${topSenders}`);
    }

    // Topic detection
    if (topics.length > 0) {
      const topTopics = topics.slice(0, 5).join(', ');
      parts.push(`Discussion topics: ${topTopics}`);
    }

    // Recent activity indicator
    const lastMsg = textMessages[0];
    if (lastMsg) {
      const hoursAgo = Math.floor((Date.now() / 1000 - lastMsg.timestamp) / 3600);
      if (hoursAgo < 1) {
        parts.push('Active in the last hour');
      } else if (hoursAgo < 24) {
        parts.push(`Last active ${hoursAgo} hour(s) ago`);
      } else {
        parts.push(`Last active ${Math.floor(hoursAgo / 24)} day(s) ago`);
      }
    }

    return parts.join('. ') || 'Conversation with recent activity';
  }

  generateOverallSummary(groupSummaries, contactSummaries, totalUnread) {
    const parts = [];

    // Unread summary
    if (totalUnread > 0) {
      parts.push(`You have ${totalUnread} unread message(s)`);
    }

    // Active groups
    const activeGroups = groupSummaries.filter(g => g.recentMessageCount > 0);
    if (activeGroups.length > 0) {
      const groupNames = activeGroups.slice(0, 3).map(g => g.name).join(', ');
      parts.push(`Active groups: ${groupNames}${activeGroups.length > 3 ? ` and ${activeGroups.length - 3} more` : ''}`);
    }

    // Active contacts
    const activeContacts = contactSummaries.filter(c => c.recentMessageCount > 0);
    if (activeContacts.length > 0) {
      const contactNames = activeContacts.slice(0, 3).map(c => c.name).join(', ');
      parts.push(`Recent conversations with: ${contactNames}${activeContacts.length > 3 ? ` and ${activeContacts.length - 3} more` : ''}`);
    }

    // Groups needing attention (high unread)
    const urgentGroups = groupSummaries.filter(g => g.unreadCount > 5);
    if (urgentGroups.length > 0) {
      parts.push(`${urgentGroups.length} group(s) with many unread messages`);
    }

    return parts.join('. ') || 'No recent WhatsApp activity';
  }

  formatSender(sender) {
    if (!sender) return 'Unknown';
    if (typeof sender === 'string') {
      // Extract number or name from serialized ID
      const match = sender.match(/^(\d+)@/);
      return match ? `+${match[1]}` : sender;
    }
    if (sender.user) {
      return `+${sender.user}`;
    }
    return 'Unknown';
  }

  async logout() {
    if (this.client) {
      try {
        await this.client.logout();
      } catch (e) {
        console.error('Logout error:', e);
      }
    }
    this.isReady = false;
    this.store.set('whatsapp.authenticated', false);
  }

  destroy() {
    if (this.client) {
      try {
        this.client.destroy();
      } catch (e) {
        console.error('Destroy error:', e);
      }
      this.client = null;
    }
    this.isReady = false;
  }
}

module.exports = WhatsAppService;
