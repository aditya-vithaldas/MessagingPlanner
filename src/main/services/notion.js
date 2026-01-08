const { Client } = require('@notionhq/client');

class NotionService {
  constructor(store, mainWindow, database) {
    this.store = store;
    this.mainWindow = mainWindow;
    this.db = database;
    this.client = null;

    // Initialize client if token exists
    const token = this.store.get('notion.token');
    if (token) {
      this.client = new Client({ auth: token });
    }
  }

  async authenticate(token) {
    try {
      // Create a new client with the provided token
      const testClient = new Client({ auth: token });

      // Test the token by fetching user info
      const response = await testClient.users.me();

      // Token is valid, save it
      this.store.set('notion.token', token);
      this.store.set('notion.authenticated', true);
      this.store.set('notion.user', {
        id: response.id,
        name: response.name,
        avatarUrl: response.avatar_url,
        type: response.type
      });

      this.client = testClient;

      return {
        success: true,
        user: {
          id: response.id,
          name: response.name,
          avatarUrl: response.avatar_url
        }
      };
    } catch (error) {
      console.error('Notion auth error:', error);
      return {
        success: false,
        error: error.message || 'Invalid token'
      };
    }
  }

  async syncToDatabase(fullSync = false) {
    if (!this.client || !this.store.get('notion.authenticated')) {
      return { error: 'Not authenticated' };
    }

    if (!this.db) {
      return { error: 'Database not initialized' };
    }

    try {
      // Get last sync time for incremental sync
      const lastSyncTime = this.db.getLastSyncTime('notion');
      const monthAgo = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);

      const isIncremental = !fullSync && lastSyncTime;
      console.log(`Syncing Notion data to database (${isIncremental ? 'incremental' : 'full'} sync)...`);

      // Search for all pages - Notion API returns recently edited first
      const searchResponse = await this.client.search({
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: isIncremental ? 50 : 100
      });

      const pagesToStore = [];
      const cutoffTime = isIncremental && lastSyncTime
        ? new Date(lastSyncTime * 1000).toISOString()
        : new Date(monthAgo * 1000).toISOString();

      for (const page of searchResponse.results) {
        // Skip pages older than cutoff time (for incremental sync)
        if (page.last_edited_time < cutoffTime && isIncremental) {
          continue;
        }

        const title = this.getPageTitle(page);
        const parentInfo = this.getParentInfo(page);

        // Fetch content preview
        let contentPreview = '';
        try {
          const blocks = await this.client.blocks.children.list({
            block_id: page.id,
            page_size: 10
          });

          for (const block of blocks.results) {
            const text = this.extractBlockText(block);
            if (text) {
              contentPreview += text + ' ';
              if (contentPreview.length > 300) break;
            }
          }
        } catch (e) {
          // Some pages may not be accessible
        }

        pagesToStore.push({
          id: page.id,
          title: title || 'Untitled',
          parentId: parentInfo?.id || null,
          parentType: parentInfo?.type || 'workspace',
          url: page.url,
          createdTime: Math.floor(new Date(page.created_time).getTime() / 1000),
          lastEditedTime: Math.floor(new Date(page.last_edited_time).getTime() / 1000),
          contentPreview: contentPreview.trim().substring(0, 500),
          properties: this.extractProperties(page)
        });
      }

      if (pagesToStore.length > 0) {
        this.db.bulkUpsertNotionPages(pagesToStore);
      }

      this.db.updateSyncLog('notion', pagesToStore.length);

      console.log(`Notion sync complete: ${pagesToStore.length} pages stored`);
      return { success: true, pagesStored: pagesToStore.length, isIncremental };
    } catch (error) {
      console.error('Notion sync error:', error);
      return { error: error.message };
    }
  }

  async getSummary() {
    if (!this.client || !this.store.get('notion.authenticated')) {
      return { error: 'Not authenticated', authenticated: false };
    }

    try {
      // Sync to database in background
      this.syncToDatabase().catch(err => console.error('Background Notion sync error:', err));

      // Search for all accessible pages
      const searchResponse = await this.client.search({
        filter: { property: 'object', value: 'page' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' },
        page_size: 20
      });

      const recentPages = [];
      for (const page of searchResponse.results.slice(0, 5)) {
        const title = this.getPageTitle(page);
        recentPages.push({
          id: page.id,
          title: title || 'Untitled',
          url: page.url,
          lastEdited: page.last_edited_time,
          icon: page.icon?.emoji || page.icon?.external?.url || null,
          parent: this.getParentInfo(page)
        });
      }

      // Search for databases
      const dbResponse = await this.client.search({
        filter: { property: 'object', value: 'database' },
        page_size: 20
      });

      const databases = [];
      let myJourneyDb = null;

      for (const db of dbResponse.results) {
        const title = db.title?.[0]?.plain_text || 'Untitled Database';
        const dbInfo = {
          id: db.id,
          title,
          url: db.url,
          icon: db.icon?.emoji || null
        };
        databases.push(dbInfo);

        // Check if this is the "My Journey" database
        if (title.toLowerCase().includes('my journey') || title.toLowerCase().includes('journey')) {
          myJourneyDb = db;
        }
      }

      // Get "My Journey" database summary if found
      let myJourneySummary = null;
      if (myJourneyDb) {
        myJourneySummary = await this.getMyJourneySummary(myJourneyDb);
      }

      // Get user info
      const user = this.store.get('notion.user', {});

      // Generate overall workspace summary
      const workspaceSummary = this.generateWorkspaceSummary(searchResponse.results, databases);

      return {
        authenticated: true,
        user,
        totalPages: searchResponse.results.length,
        totalDatabases: dbResponse.results.length,
        workspaceSummary,
        myJourneySummary,
        recentPages,
        databases: databases.slice(0, 5),
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Notion getSummary error:', error);

      // Handle token expiration or invalid token
      if (error.code === 'unauthorized') {
        this.store.set('notion.authenticated', false);
        return { error: 'Session expired. Please re-authenticate.', authenticated: false };
      }

      return { error: error.message, authenticated: true };
    }
  }

  async getMyJourneySummary(database) {
    try {
      // Query the database for entries
      const response = await this.client.databases.query({
        database_id: database.id,
        sorts: [{ timestamp: 'last_edited_time', direction: 'descending' }],
        page_size: 50
      });

      const entries = response.results;
      if (entries.length === 0) {
        return {
          title: database.title?.[0]?.plain_text || 'My Journey',
          summary: 'No entries found in this database.',
          entries: []
        };
      }

      // Analyze entries
      const analyzedEntries = [];
      const themes = {};
      const timeline = {
        thisWeek: [],
        thisMonth: [],
        older: []
      };

      const now = new Date();
      const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
      const monthAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);

      for (const entry of entries) {
        const title = this.getPageTitle(entry);
        const lastEdited = new Date(entry.last_edited_time);
        const created = new Date(entry.created_time);

        // Extract properties for analysis
        const properties = this.extractProperties(entry);

        const entryInfo = {
          id: entry.id,
          title: title || 'Untitled',
          url: entry.url,
          created: entry.created_time,
          lastEdited: entry.last_edited_time,
          properties,
          icon: entry.icon?.emoji || null
        };

        analyzedEntries.push(entryInfo);

        // Categorize by time
        if (lastEdited >= weekAgo) {
          timeline.thisWeek.push(entryInfo);
        } else if (lastEdited >= monthAgo) {
          timeline.thisMonth.push(entryInfo);
        } else {
          timeline.older.push(entryInfo);
        }

        // Extract themes from title and properties
        this.extractThemes(title, properties, themes);
      }

      // Get top themes
      const topThemes = Object.entries(themes)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([theme, count]) => ({ theme, count }));

      // Generate summary text
      const summaryText = this.generateJourneySummary(timeline, topThemes, analyzedEntries);

      // Fetch content from recent entries for deeper insights
      const recentInsights = await this.getRecentEntryInsights(timeline.thisWeek.slice(0, 5));

      return {
        title: database.title?.[0]?.plain_text || 'My Journey',
        totalEntries: entries.length,
        summary: summaryText,
        recentInsights,
        timeline: {
          thisWeek: timeline.thisWeek.length,
          thisMonth: timeline.thisMonth.length,
          older: timeline.older.length
        },
        topThemes,
        recentEntries: analyzedEntries.slice(0, 5),
        hasMore: entries.length > 5
      };
    } catch (error) {
      console.error('Error fetching My Journey summary:', error);
      return {
        title: 'My Journey',
        error: error.message,
        summary: 'Unable to fetch journey summary.'
      };
    }
  }

  extractProperties(page) {
    const props = {};
    if (!page.properties) return props;

    for (const [key, value] of Object.entries(page.properties)) {
      if (key.toLowerCase() === 'name' || key.toLowerCase() === 'title') continue;

      switch (value.type) {
        case 'select':
          props[key] = value.select?.name || null;
          break;
        case 'multi_select':
          props[key] = value.multi_select?.map(s => s.name) || [];
          break;
        case 'date':
          props[key] = value.date?.start || null;
          break;
        case 'checkbox':
          props[key] = value.checkbox;
          break;
        case 'number':
          props[key] = value.number;
          break;
        case 'rich_text':
          props[key] = value.rich_text?.map(t => t.plain_text).join('') || '';
          break;
        case 'status':
          props[key] = value.status?.name || null;
          break;
        case 'url':
          props[key] = value.url;
          break;
      }
    }

    return props;
  }

  extractThemes(title, properties, themes) {
    // Extract words from title
    if (title) {
      const words = title.toLowerCase().split(/\s+/);
      const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been',
        'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'and', 'or', 'but',
        'my', 'i', 'me', 'we', 'you', 'it', 'this', 'that', 'what', 'how', 'why',
        'day', 'week', 'month', 'year', '-', '–', '|']);

      words.forEach(word => {
        const cleaned = word.replace(/[^a-z0-9]/g, '');
        if (cleaned.length > 2 && !stopWords.has(cleaned)) {
          themes[cleaned] = (themes[cleaned] || 0) + 1;
        }
      });
    }

    // Extract from select/multi-select properties
    for (const [key, value] of Object.entries(properties)) {
      if (Array.isArray(value)) {
        value.forEach(v => {
          if (typeof v === 'string') {
            themes[v.toLowerCase()] = (themes[v.toLowerCase()] || 0) + 1;
          }
        });
      } else if (typeof value === 'string' && value.length > 2) {
        themes[value.toLowerCase()] = (themes[value.toLowerCase()] || 0) + 1;
      }
    }
  }

  generateJourneySummary(timeline, topThemes, entries) {
    const parts = [];

    // Activity summary
    if (timeline.thisWeek.length > 0) {
      parts.push(`${timeline.thisWeek.length} entry/entries this week`);
    }
    if (timeline.thisMonth.length > 0) {
      parts.push(`${timeline.thisMonth.length} this month`);
    }
    parts.push(`${entries.length} total entries`);

    // Theme summary
    if (topThemes.length > 0) {
      const themeNames = topThemes.slice(0, 5).map(t => t.theme).join(', ');
      parts.push(`Key themes: ${themeNames}`);
    }

    // Recent activity
    if (timeline.thisWeek.length > 0) {
      const recentTitles = timeline.thisWeek.slice(0, 3).map(e => e.title).join(', ');
      parts.push(`Recent: ${recentTitles}`);
    }

    return parts.join('. ');
  }

  async getRecentEntryInsights(entries) {
    const insights = [];

    for (const entry of entries) {
      try {
        // Fetch page content blocks
        const blocks = await this.client.blocks.children.list({
          block_id: entry.id,
          page_size: 20
        });

        let contentPreview = '';
        for (const block of blocks.results) {
          const text = this.extractBlockText(block);
          if (text) {
            contentPreview += text + ' ';
            if (contentPreview.length > 300) break;
          }
        }

        insights.push({
          title: entry.title,
          url: entry.url,
          preview: contentPreview.trim().substring(0, 200) + (contentPreview.length > 200 ? '...' : ''),
          lastEdited: entry.lastEdited
        });
      } catch (error) {
        console.error(`Error fetching content for ${entry.title}:`, error);
      }
    }

    return insights;
  }

  extractBlockText(block) {
    const type = block.type;
    const content = block[type];

    if (!content) return '';

    // Handle different block types
    if (content.rich_text) {
      return content.rich_text.map(t => t.plain_text).join('');
    }
    if (content.text) {
      return content.text.map ? content.text.map(t => t.plain_text).join('') : content.text;
    }

    return '';
  }

  generateWorkspaceSummary(pages, databases) {
    const parts = [];

    // Page activity
    const now = new Date();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const recentPages = pages.filter(p => new Date(p.last_edited_time) >= weekAgo);

    parts.push(`${pages.length} pages in workspace`);
    if (recentPages.length > 0) {
      parts.push(`${recentPages.length} edited this week`);
    }

    // Database summary
    if (databases.length > 0) {
      parts.push(`${databases.length} database(s): ${databases.slice(0, 3).map(d => d.title).join(', ')}`);
    }

    return parts.join('. ');
  }

  getPageTitle(page) {
    // Try different property locations for title
    if (page.properties) {
      // Check for 'title' property (common in databases)
      if (page.properties.title?.title?.[0]?.plain_text) {
        return page.properties.title.title[0].plain_text;
      }
      // Check for 'Name' property
      if (page.properties.Name?.title?.[0]?.plain_text) {
        return page.properties.Name.title[0].plain_text;
      }
      // Look through all properties for a title type
      for (const prop of Object.values(page.properties)) {
        if (prop.type === 'title' && prop.title?.[0]?.plain_text) {
          return prop.title[0].plain_text;
        }
      }
    }
    return null;
  }

  getParentInfo(page) {
    if (page.parent?.type === 'workspace') {
      return { type: 'workspace', name: 'Workspace' };
    }
    if (page.parent?.type === 'page_id') {
      return { type: 'page', id: page.parent.page_id };
    }
    if (page.parent?.type === 'database_id') {
      return { type: 'database', id: page.parent.database_id };
    }
    return null;
  }
}

module.exports = NotionService;
