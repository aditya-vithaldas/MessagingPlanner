const { google } = require('googleapis');
const { shell } = require('electron');
const http = require('http');
const url = require('url');

// You'll need to create these credentials at https://console.cloud.google.com/
// 1. Create a new project
// 2. Enable Gmail API
// 3. Create OAuth 2.0 credentials (Desktop app)
// 4. Set environment variables GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET
const CREDENTIALS = {
  client_id: process.env.GMAIL_CLIENT_ID || '',
  client_secret: process.env.GMAIL_CLIENT_SECRET || '',
  redirect_uri: 'http://localhost:3000/oauth2callback'
};

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.labels'
];

class GmailService {
  constructor(store, mainWindow, database) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.db = database;
    this.oauth2Client = new google.auth.OAuth2(
      CREDENTIALS.client_id,
      CREDENTIALS.client_secret,
      CREDENTIALS.redirect_uri
    );

    // Load saved tokens if available
    const tokens = this.store.get('gmail.tokens');
    if (tokens) {
      this.oauth2Client.setCredentials(tokens);
    }

    // Handle token refresh
    this.oauth2Client.on('tokens', (tokens) => {
      const currentTokens = this.store.get('gmail.tokens', {});
      this.store.set('gmail.tokens', { ...currentTokens, ...tokens });
    });
  }

  async authenticate() {
    return new Promise((resolve, reject) => {
      // Create a local server to handle the OAuth callback
      const server = http.createServer(async (req, res) => {
        try {
          const queryParams = new url.URL(req.url, 'http://localhost:3000').searchParams;
          const code = queryParams.get('code');

          if (code) {
            // Exchange code for tokens
            const { tokens } = await this.oauth2Client.getToken(code);
            this.oauth2Client.setCredentials(tokens);

            // Save tokens
            this.store.set('gmail.tokens', tokens);
            this.store.set('gmail.authenticated', true);

            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(`
              <html>
                <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: white;">
                  <div style="text-align: center;">
                    <h1>✓ Gmail Connected!</h1>
                    <p>You can close this window and return to the app.</p>
                  </div>
                </body>
              </html>
            `);

            server.close();

            // Notify renderer
            this.mainWindow.webContents.send('gmail-auth-success');
            resolve({ success: true });
          }
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`
            <html>
              <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #ff6b6b;">
                <div style="text-align: center;">
                  <h1>✗ Authentication Failed</h1>
                  <p>${error.message}</p>
                </div>
              </body>
            </html>
          `);
          server.close();
          reject(error);
        }
      });

      server.listen(3000, () => {
        // Generate auth URL and open in browser
        const authUrl = this.oauth2Client.generateAuthUrl({
          access_type: 'offline',
          scope: SCOPES,
          prompt: 'consent'
        });

        shell.openExternal(authUrl);
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error('Authentication timed out'));
      }, 300000);
    });
  }

  async syncToDatabase(fullSync = false) {
    if (!this.store.get('gmail.authenticated')) {
      return { error: 'Not authenticated' };
    }

    if (!this.db) {
      return { error: 'Database not initialized' };
    }

    try {
      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Get last sync time for incremental sync
      const lastSyncTime = this.db.getLastSyncTime('gmail');
      const monthAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

      // Build query: get emails from last month (or since last sync for incremental)
      let query = 'in:inbox newer_than:30d';
      if (!fullSync && lastSyncTime) {
        // Gmail uses seconds since epoch for after:
        const afterDate = new Date(lastSyncTime * 1000).toISOString().split('T')[0];
        query = `in:inbox after:${afterDate}`;
      }

      const isIncremental = !fullSync && lastSyncTime;
      console.log(`Syncing Gmail data to database (${isIncremental ? 'incremental' : 'full'} sync)...`);

      // Fetch emails
      const messagesResponse = await gmail.users.messages.list({
        userId: 'me',
        maxResults: isIncremental ? 100 : 500,
        q: query
      });

      const messages = messagesResponse.data.messages || [];
      let newEmails = 0;

      const emailsToStore = [];

      for (const msg of messages) {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });

        const headers = details.data.payload.headers;
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

        const from = getHeader('From');
        const subject = getHeader('Subject');
        const to = getHeader('To');
        const dateStr = getHeader('Date');
        const labels = details.data.labelIds || [];

        // Parse timestamp from date header
        const timestamp = Math.floor(new Date(dateStr).getTime() / 1000);

        // Extract body text
        let bodyText = '';
        if (details.data.payload.body?.data) {
          bodyText = Buffer.from(details.data.payload.body.data, 'base64').toString('utf-8');
        } else if (details.data.payload.parts) {
          const textPart = details.data.payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        }

        const category = this.categorizeEmail({ from, subject, snippet: details.data.snippet, labels });

        emailsToStore.push({
          id: msg.id,
          threadId: details.data.threadId,
          fromEmail: this.extractEmail(from),
          fromName: this.extractSenderName(from),
          toEmail: to,
          subject,
          snippet: details.data.snippet,
          bodyPreview: bodyText.substring(0, 500),
          timestamp,
          isUnread: labels.includes('UNREAD'),
          labels,
          category
        });
      }

      if (emailsToStore.length > 0) {
        this.db.bulkUpsertGmailMessages(emailsToStore);
        newEmails = emailsToStore.length;
      }

      this.db.updateSyncLog('gmail', newEmails);

      console.log(`Gmail sync complete: ${newEmails} emails stored`);
      return { success: true, newEmails, isIncremental };
    } catch (error) {
      console.error('Gmail sync error:', error);
      return { error: error.message };
    }
  }

  extractEmail(from) {
    if (!from) return '';
    const match = from.match(/<([^>]+)>/);
    return match ? match[1] : from;
  }

  async getSummary() {
    if (!this.store.get('gmail.authenticated')) {
      return { error: 'Not authenticated', authenticated: false };
    }

    try {
      // Sync to database in background
      this.syncToDatabase().catch(err => console.error('Background Gmail sync error:', err));

      const gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });

      // Get unread count
      const unreadResponse = await gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 1
      });
      const unreadCount = unreadResponse.data.resultSizeEstimate || 0;

      // Get recent emails with full content for summarization
      const messagesResponse = await gmail.users.messages.list({
        userId: 'me',
        maxResults: 50,
        q: 'in:inbox newer_than:7d'
      });

      const messages = messagesResponse.data.messages || [];
      const emailsData = [];
      const categorizedEmails = {
        actionRequired: [],
        newsletters: [],
        social: [],
        promotions: [],
        updates: [],
        personal: []
      };

      // Fetch email details
      for (const msg of messages.slice(0, 30)) {
        const details = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'full'
        });

        const headers = details.data.payload.headers;
        const getHeader = (name) => headers.find(h => h.name === name)?.value || '';

        const from = getHeader('From');
        const subject = getHeader('Subject');
        const date = getHeader('Date');
        const labels = details.data.labelIds || [];

        // Extract body text
        let bodyText = '';
        if (details.data.payload.body?.data) {
          bodyText = Buffer.from(details.data.payload.body.data, 'base64').toString('utf-8');
        } else if (details.data.payload.parts) {
          const textPart = details.data.payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            bodyText = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        }

        const emailInfo = {
          id: msg.id,
          from,
          subject,
          date,
          snippet: details.data.snippet,
          bodyPreview: bodyText.substring(0, 500),
          isUnread: labels.includes('UNREAD'),
          labels
        };

        emailsData.push(emailInfo);

        // Categorize emails
        const category = this.categorizeEmail(emailInfo);
        if (categorizedEmails[category]) {
          categorizedEmails[category].push(emailInfo);
        }
      }

      // Generate summaries by category
      const summaries = this.generateEmailSummaries(categorizedEmails);

      // Get top senders
      const senderCounts = {};
      emailsData.forEach(email => {
        const senderName = this.extractSenderName(email.from);
        senderCounts[senderName] = (senderCounts[senderName] || 0) + 1;
      });

      const topSenders = Object.entries(senderCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => ({ name, count }));

      // Get labels/categories summary
      const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
      const importantLabels = ['INBOX', 'SENT', 'DRAFT', 'SPAM'];
      const labelCounts = {};

      for (const label of labelsResponse.data.labels || []) {
        if (importantLabels.includes(label.id)) {
          const labelDetails = await gmail.users.labels.get({
            userId: 'me',
            id: label.id
          });
          labelCounts[label.name.toLowerCase()] = {
            total: labelDetails.data.messagesTotal || 0,
            unread: labelDetails.data.messagesUnread || 0
          };
        }
      }

      return {
        authenticated: true,
        unreadCount,
        totalEmailsAnalyzed: emailsData.length,
        summaries,
        categorizedCounts: {
          actionRequired: categorizedEmails.actionRequired.length,
          newsletters: categorizedEmails.newsletters.length,
          social: categorizedEmails.social.length,
          promotions: categorizedEmails.promotions.length,
          updates: categorizedEmails.updates.length,
          personal: categorizedEmails.personal.length
        },
        topSenders,
        recentEmails: emailsData.slice(0, 5),
        labelCounts,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Gmail getSummary error:', error);

      // Handle token expiration
      if (error.code === 401) {
        this.store.set('gmail.authenticated', false);
        return { error: 'Session expired. Please re-authenticate.', authenticated: false };
      }

      return { error: error.message, authenticated: true };
    }
  }

  categorizeEmail(email) {
    const from = email.from.toLowerCase();
    const subject = email.subject.toLowerCase();
    const labels = email.labels || [];

    // Check Gmail's built-in categories
    if (labels.includes('CATEGORY_PROMOTIONS')) return 'promotions';
    if (labels.includes('CATEGORY_SOCIAL')) return 'social';
    if (labels.includes('CATEGORY_UPDATES')) return 'updates';

    // Action required detection
    const actionKeywords = ['action required', 'urgent', 'asap', 'deadline', 'please respond',
      'waiting for', 'reminder', 'follow up', 'approval needed', 'review needed'];
    if (actionKeywords.some(kw => subject.includes(kw) || email.snippet?.toLowerCase().includes(kw))) {
      return 'actionRequired';
    }

    // Newsletter detection
    const newsletterKeywords = ['newsletter', 'digest', 'weekly', 'monthly', 'unsubscribe',
      'noreply', 'no-reply', 'news@', 'updates@', 'hello@'];
    if (newsletterKeywords.some(kw => from.includes(kw) || subject.includes(kw))) {
      return 'newsletters';
    }

    // Social detection
    const socialDomains = ['linkedin', 'twitter', 'facebook', 'instagram', 'github', 'slack'];
    if (socialDomains.some(domain => from.includes(domain))) {
      return 'social';
    }

    // Promotion detection
    const promoKeywords = ['sale', 'discount', 'offer', 'deal', 'off', 'free', 'limited time',
      'exclusive', 'promo', 'coupon'];
    if (promoKeywords.some(kw => subject.includes(kw))) {
      return 'promotions';
    }

    return 'personal';
  }

  generateEmailSummaries(categorizedEmails) {
    const summaries = {};

    // Action Required Summary
    if (categorizedEmails.actionRequired.length > 0) {
      const items = categorizedEmails.actionRequired.map(e =>
        `• ${this.extractSenderName(e.from)}: "${e.subject}"`
      ).slice(0, 5);
      summaries.actionRequired = {
        title: 'Action Required',
        count: categorizedEmails.actionRequired.length,
        description: `You have ${categorizedEmails.actionRequired.length} email(s) that may need your attention:`,
        items
      };
    }

    // Personal emails summary
    if (categorizedEmails.personal.length > 0) {
      const senders = [...new Set(categorizedEmails.personal.map(e => this.extractSenderName(e.from)))];
      summaries.personal = {
        title: 'Personal Messages',
        count: categorizedEmails.personal.length,
        description: `${categorizedEmails.personal.length} personal email(s) from ${senders.slice(0, 3).join(', ')}${senders.length > 3 ? ` and ${senders.length - 3} others` : ''}.`,
        topSubjects: categorizedEmails.personal.slice(0, 3).map(e => e.subject)
      };
    }

    // Newsletters summary
    if (categorizedEmails.newsletters.length > 0) {
      const sources = [...new Set(categorizedEmails.newsletters.map(e => this.extractSenderName(e.from)))];
      summaries.newsletters = {
        title: 'Newsletters & Digests',
        count: categorizedEmails.newsletters.length,
        description: `${categorizedEmails.newsletters.length} newsletter(s) from ${sources.slice(0, 3).join(', ')}${sources.length > 3 ? ` and ${sources.length - 3} more sources` : ''}.`
      };
    }

    // Updates summary
    if (categorizedEmails.updates.length > 0) {
      summaries.updates = {
        title: 'Updates & Notifications',
        count: categorizedEmails.updates.length,
        description: `${categorizedEmails.updates.length} update notification(s) from various services.`
      };
    }

    // Promotions summary
    if (categorizedEmails.promotions.length > 0) {
      summaries.promotions = {
        title: 'Promotions',
        count: categorizedEmails.promotions.length,
        description: `${categorizedEmails.promotions.length} promotional email(s). Consider reviewing or unsubscribing.`
      };
    }

    // Social summary
    if (categorizedEmails.social.length > 0) {
      const platforms = [...new Set(categorizedEmails.social.map(e => {
        const from = e.from.toLowerCase();
        if (from.includes('linkedin')) return 'LinkedIn';
        if (from.includes('twitter')) return 'Twitter';
        if (from.includes('github')) return 'GitHub';
        if (from.includes('slack')) return 'Slack';
        return 'Social';
      }))];
      summaries.social = {
        title: 'Social & Professional',
        count: categorizedEmails.social.length,
        description: `${categorizedEmails.social.length} notification(s) from ${platforms.join(', ')}.`
      };
    }

    // Overall summary
    const total = Object.values(categorizedEmails).reduce((sum, arr) => sum + arr.length, 0);
    summaries.overall = {
      title: 'Email Overview (Last 7 Days)',
      description: this.generateOverallSummary(categorizedEmails, total)
    };

    return summaries;
  }

  generateOverallSummary(categorizedEmails, total) {
    const parts = [];

    if (categorizedEmails.actionRequired.length > 0) {
      parts.push(`${categorizedEmails.actionRequired.length} need attention`);
    }
    if (categorizedEmails.personal.length > 0) {
      parts.push(`${categorizedEmails.personal.length} personal`);
    }
    if (categorizedEmails.newsletters.length + categorizedEmails.updates.length > 0) {
      parts.push(`${categorizedEmails.newsletters.length + categorizedEmails.updates.length} newsletters/updates`);
    }
    if (categorizedEmails.promotions.length > 0) {
      parts.push(`${categorizedEmails.promotions.length} promotions`);
    }

    return `Analyzed ${total} emails: ${parts.join(', ')}.`;
  }

  extractSenderName(from) {
    if (!from) return 'Unknown';
    const match = from.match(/^([^<]+)/);
    if (match) {
      return match[1].trim().replace(/"/g, '');
    }
    const emailMatch = from.match(/<([^>]+)>/);
    if (emailMatch) {
      return emailMatch[1].split('@')[0];
    }
    return from.split('@')[0];
  }
}

module.exports = GmailService;
