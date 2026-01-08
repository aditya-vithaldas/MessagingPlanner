const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

class DatabaseService {
  constructor() {
    this.db = null;
    this.dbPath = path.join(app.getPath('userData'), 'mybrain.db');
    this.ready = this.initialize();
  }

  async initialize() {
    const SQL = await initSqlJs();

    // Load existing database or create new one
    if (fs.existsSync(this.dbPath)) {
      const fileBuffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(fileBuffer);
    } else {
      this.db = new SQL.Database();
    }

    this.initTables();
    return true;
  }

  initTables() {
    // WhatsApp messages
    this.db.run(`
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
    this.db.run(`
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
    this.db.run(`
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
    this.db.run(`
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
    this.db.run(`
      CREATE TABLE IF NOT EXISTS sync_log (
        source TEXT PRIMARY KEY,
        last_sync_at INTEGER,
        records_synced INTEGER
      )
    `);

    // Create indexes for faster queries
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_timestamp ON whatsapp_messages(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_whatsapp_chat ON whatsapp_messages(chat_id)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_gmail_timestamp ON gmail_messages(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_notion_edited ON notion_pages(last_edited_time)`);

    this.save();
  }

  save() {
    if (this.db) {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
    }
  }

  // Helper to convert result to array of objects
  queryAll(sql, params = []) {
    const stmt = this.db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  }

  queryOne(sql, params = []) {
    const results = this.queryAll(sql, params);
    return results.length > 0 ? results[0] : null;
  }

  runSql(sql, params = []) {
    if (params.length > 0) {
      this.db.run(sql, params);
    } else {
      this.db.run(sql);
    }
  }

  // WhatsApp methods
  upsertWhatsAppChat(chat) {
    const now = Math.floor(Date.now() / 1000);
    this.runSql(`
      INSERT OR REPLACE INTO whatsapp_chats (id, name, is_group, participant_count, last_message_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [chat.id, chat.name, chat.isGroup ? 1 : 0, chat.participantCount || 0, chat.lastMessageAt || 0, now]);
    this.save();
  }

  upsertWhatsAppMessage(message) {
    this.runSql(`
      INSERT OR REPLACE INTO whatsapp_messages (id, chat_id, chat_name, is_group, sender, body, timestamp, from_me, has_media)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      message.id,
      message.chatId,
      message.chatName,
      message.isGroup ? 1 : 0,
      message.sender,
      message.body,
      message.timestamp,
      message.fromMe ? 1 : 0,
      message.hasMedia ? 1 : 0
    ]);
    this.save();
  }

  bulkUpsertWhatsAppMessages(messages) {
    for (const m of messages) {
      this.runSql(`
        INSERT OR REPLACE INTO whatsapp_messages (id, chat_id, chat_name, is_group, sender, body, timestamp, from_me, has_media)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [m.id, m.chatId, m.chatName, m.isGroup ? 1 : 0, m.sender, m.body, m.timestamp, m.fromMe ? 1 : 0, m.hasMedia ? 1 : 0]);
    }
    this.save();
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

    return this.queryAll(`SELECT * FROM whatsapp_messages ${whereClause} ORDER BY timestamp DESC`);
  }

  getWhatsAppChats() {
    return this.queryAll(`SELECT * FROM whatsapp_chats ORDER BY last_message_at DESC`);
  }

  getWhatsAppMessagesByChat(chatId, limit = 100) {
    return this.queryAll(`SELECT * FROM whatsapp_messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`, [chatId, limit]);
  }

  // Gmail methods
  upsertGmailMessage(email) {
    this.runSql(`
      INSERT OR REPLACE INTO gmail_messages (id, thread_id, from_email, from_name, to_email, subject, snippet, body_preview, timestamp, is_unread, labels, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
    ]);
    this.save();
  }

  bulkUpsertGmailMessages(emails) {
    for (const e of emails) {
      this.runSql(`
        INSERT OR REPLACE INTO gmail_messages (id, thread_id, from_email, from_name, to_email, subject, snippet, body_preview, timestamp, is_unread, labels, category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [e.id, e.threadId, e.fromEmail, e.fromName, e.toEmail, e.subject, e.snippet, e.bodyPreview, e.timestamp, e.isUnread ? 1 : 0, JSON.stringify(e.labels || []), e.category]);
    }
    this.save();
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

    const rows = this.queryAll(`SELECT * FROM gmail_messages ${whereClause} ORDER BY timestamp DESC`);

    return rows.map(r => ({
      ...r,
      labels: JSON.parse(r.labels || '[]'),
      isUnread: r.is_unread === 1
    }));
  }

  // Notion methods
  upsertNotionPage(page) {
    this.runSql(`
      INSERT OR REPLACE INTO notion_pages (id, title, parent_id, parent_type, url, created_time, last_edited_time, content_preview, properties)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      page.id,
      page.title,
      page.parentId,
      page.parentType,
      page.url,
      page.createdTime,
      page.lastEditedTime,
      page.contentPreview,
      JSON.stringify(page.properties || {})
    ]);
    this.save();
  }

  bulkUpsertNotionPages(pages) {
    for (const p of pages) {
      this.runSql(`
        INSERT OR REPLACE INTO notion_pages (id, title, parent_id, parent_type, url, created_time, last_edited_time, content_preview, properties)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [p.id, p.title, p.parentId, p.parentType, p.url, p.createdTime, p.lastEditedTime, p.contentPreview, JSON.stringify(p.properties || {})]);
    }
    this.save();
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

    const rows = this.queryAll(`SELECT * FROM notion_pages ${whereClause} ORDER BY last_edited_time DESC`);

    return rows.map(r => ({
      ...r,
      properties: JSON.parse(r.properties || '{}')
    }));
  }

  // Sync log methods
  updateSyncLog(source, recordsSynced) {
    const now = Math.floor(Date.now() / 1000);
    this.runSql(`
      INSERT OR REPLACE INTO sync_log (source, last_sync_at, records_synced)
      VALUES (?, ?, ?)
    `, [source, now, recordsSynced]);
    this.save();
  }

  getLastSyncTime(source) {
    const row = this.queryOne(`SELECT last_sync_at FROM sync_log WHERE source = ?`, [source]);
    return row ? row.last_sync_at : null;
  }

  // Stats
  getStats() {
    const whatsappCount = this.queryOne(`SELECT COUNT(*) as count FROM whatsapp_messages`);
    const gmailCount = this.queryOne(`SELECT COUNT(*) as count FROM gmail_messages`);
    const notionCount = this.queryOne(`SELECT COUNT(*) as count FROM notion_pages`);

    return {
      whatsapp: whatsappCount ? whatsappCount.count : 0,
      gmail: gmailCount ? gmailCount.count : 0,
      notion: notionCount ? notionCount.count : 0
    };
  }

  close() {
    if (this.db) {
      this.save();
      this.db.close();
      this.db = null;
    }
  }
}

module.exports = DatabaseService;
