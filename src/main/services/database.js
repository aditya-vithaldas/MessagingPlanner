const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class DatabaseService {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'mybrain.db');
    this.db = new Database(dbPath);
    this.initTables();
  }

  initTables() {
    // WhatsApp messages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT,
        chat_name TEXT,
        is_group INTEGER,
        sender TEXT,
        body TEXT,
        timestamp INTEGER,
        from_me INTEGER,
        has_media INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // WhatsApp chats
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS whatsapp_chats (
        id TEXT PRIMARY KEY,
        name TEXT,
        is_group INTEGER,
        participant_count INTEGER,
        last_message_at INTEGER,
        updated_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Gmail messages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gmail_messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT,
        from_email TEXT,
        from_name TEXT,
        to_email TEXT,
        subject TEXT,
        snippet TEXT,
        body_preview TEXT,
        timestamp INTEGER,
        is_unread INTEGER,
        labels TEXT,
        category TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Notion pages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notion_pages (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent_id TEXT,
        parent_type TEXT,
        url TEXT,
        created_time INTEGER,
        last_edited_time INTEGER,
        content_preview TEXT,
        properties TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Sync log to track last sync time
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sync_log (
        source TEXT PRIMARY KEY,
        last_sync_at INTEGER,
        records_synced INTEGER
      )
    `);

    // Create indexes for faster queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_whatsapp_timestamp ON whatsapp_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_whatsapp_chat ON whatsapp_messages(chat_id);
      CREATE INDEX IF NOT EXISTS idx_gmail_timestamp ON gmail_messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_notion_edited ON notion_pages(last_edited_time);
    `);
  }

  // WhatsApp methods
  upsertWhatsAppChat(chat) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO whatsapp_chats (id, name, is_group, participant_count, last_message_at, updated_at)
      VALUES (?, ?, ?, ?, ?, strftime('%s', 'now'))
    `);
    stmt.run(chat.id, chat.name, chat.isGroup ? 1 : 0, chat.participantCount || 0, chat.lastMessageAt || 0);
  }

  upsertWhatsAppMessage(message) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO whatsapp_messages (id, chat_id, chat_name, is_group, sender, body, timestamp, from_me, has_media)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      message.id,
      message.chatId,
      message.chatName,
      message.isGroup ? 1 : 0,
      message.sender,
      message.body,
      message.timestamp,
      message.fromMe ? 1 : 0,
      message.hasMedia ? 1 : 0
    );
  }

  bulkUpsertWhatsAppMessages(messages) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO whatsapp_messages (id, chat_id, chat_name, is_group, sender, body, timestamp, from_me, has_media)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((msgs) => {
      for (const m of msgs) {
        stmt.run(m.id, m.chatId, m.chatName, m.isGroup ? 1 : 0, m.sender, m.body, m.timestamp, m.fromMe ? 1 : 0, m.hasMedia ? 1 : 0);
      }
    });

    insertMany(messages);
  }

  getWhatsAppMessages(timeFilter = 'all') {
    const now = Math.floor(Date.now() / 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = Math.floor(todayStart.getTime() / 1000);
    const weekAgo = now - (7 * 24 * 60 * 60);
    const monthAgo = now - (30 * 24 * 60 * 60);

    let whereClause = '';
    if (timeFilter === 'today') {
      whereClause = `WHERE timestamp >= ${todayTimestamp}`;
    } else if (timeFilter === 'week') {
      whereClause = `WHERE timestamp >= ${weekAgo}`;
    } else if (timeFilter === 'month') {
      whereClause = `WHERE timestamp >= ${monthAgo}`;
    }

    return this.db.prepare(`
      SELECT * FROM whatsapp_messages ${whereClause} ORDER BY timestamp DESC
    `).all();
  }

  getWhatsAppChats() {
    return this.db.prepare(`SELECT * FROM whatsapp_chats ORDER BY last_message_at DESC`).all();
  }

  getWhatsAppMessagesByChat(chatId, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM whatsapp_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?
    `).all(chatId, limit);
  }

  // Gmail methods
  upsertGmailMessage(email) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO gmail_messages (id, thread_id, from_email, from_name, to_email, subject, snippet, body_preview, timestamp, is_unread, labels, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      email.id,
      email.threadId,
      email.fromEmail,
      email.fromName,
      email.toEmail,
      email.subject,
      email.snippet,
      email.bodyPreview,
      email.timestamp,
      email.isUnread ? 1 : 0,
      JSON.stringify(email.labels || []),
      email.category
    );
  }

  bulkUpsertGmailMessages(emails) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO gmail_messages (id, thread_id, from_email, from_name, to_email, subject, snippet, body_preview, timestamp, is_unread, labels, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((msgs) => {
      for (const e of msgs) {
        stmt.run(e.id, e.threadId, e.fromEmail, e.fromName, e.toEmail, e.subject, e.snippet, e.bodyPreview, e.timestamp, e.isUnread ? 1 : 0, JSON.stringify(e.labels || []), e.category);
      }
    });

    insertMany(emails);
  }

  getGmailMessages(timeFilter = 'all') {
    const now = Math.floor(Date.now() / 1000);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTimestamp = Math.floor(todayStart.getTime() / 1000);
    const weekAgo = now - (7 * 24 * 60 * 60);
    const monthAgo = now - (30 * 24 * 60 * 60);

    let whereClause = '';
    if (timeFilter === 'today') {
      whereClause = `WHERE timestamp >= ${todayTimestamp}`;
    } else if (timeFilter === 'week') {
      whereClause = `WHERE timestamp >= ${weekAgo}`;
    } else if (timeFilter === 'month') {
      whereClause = `WHERE timestamp >= ${monthAgo}`;
    }

    const rows = this.db.prepare(`
      SELECT * FROM gmail_messages ${whereClause} ORDER BY timestamp DESC
    `).all();

    return rows.map(r => ({
      ...r,
      labels: JSON.parse(r.labels || '[]'),
      isUnread: r.is_unread === 1
    }));
  }

  // Notion methods
  upsertNotionPage(page) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO notion_pages (id, title, parent_id, parent_type, url, created_time, last_edited_time, content_preview, properties)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      page.id,
      page.title,
      page.parentId,
      page.parentType,
      page.url,
      page.createdTime,
      page.lastEditedTime,
      page.contentPreview,
      JSON.stringify(page.properties || {})
    );
  }

  bulkUpsertNotionPages(pages) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO notion_pages (id, title, parent_id, parent_type, url, created_time, last_edited_time, content_preview, properties)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertMany = this.db.transaction((pgs) => {
      for (const p of pgs) {
        stmt.run(p.id, p.title, p.parentId, p.parentType, p.url, p.createdTime, p.lastEditedTime, p.contentPreview, JSON.stringify(p.properties || {}));
      }
    });

    insertMany(pages);
  }

  getNotionPages(timeFilter = 'all') {
    const now = Math.floor(Date.now() / 1000);
    const weekAgo = now - (7 * 24 * 60 * 60);
    const monthAgo = now - (30 * 24 * 60 * 60);

    let whereClause = '';
    if (timeFilter === 'week') {
      whereClause = `WHERE last_edited_time >= ${weekAgo}`;
    } else if (timeFilter === 'month') {
      whereClause = `WHERE last_edited_time >= ${monthAgo}`;
    }

    const rows = this.db.prepare(`
      SELECT * FROM notion_pages ${whereClause} ORDER BY last_edited_time DESC
    `).all();

    return rows.map(r => ({
      ...r,
      properties: JSON.parse(r.properties || '{}')
    }));
  }

  // Sync log methods
  updateSyncLog(source, recordsSynced) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sync_log (source, last_sync_at, records_synced)
      VALUES (?, strftime('%s', 'now'), ?)
    `);
    stmt.run(source, recordsSynced);
  }

  getLastSyncTime(source) {
    const row = this.db.prepare(`SELECT last_sync_at FROM sync_log WHERE source = ?`).get(source);
    return row ? row.last_sync_at : null;
  }

  // Stats
  getStats() {
    const whatsappCount = this.db.prepare(`SELECT COUNT(*) as count FROM whatsapp_messages`).get().count;
    const gmailCount = this.db.prepare(`SELECT COUNT(*) as count FROM gmail_messages`).get().count;
    const notionCount = this.db.prepare(`SELECT COUNT(*) as count FROM notion_pages`).get().count;

    return {
      whatsapp: whatsappCount,
      gmail: gmailCount,
      notion: notionCount
    };
  }

  close() {
    this.db.close();
  }
}

module.exports = DatabaseService;
