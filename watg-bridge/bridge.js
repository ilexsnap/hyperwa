const TelegramBot = require('node-telegram-bot-api');
const qrcode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const { connectDb } = require('../utils/db');
const config = require('../config');
const logger = require('../Core/logger');
const TelegramCommands = require('./commands');

class TelegramBridge {
    constructor(whatsappBot) {
        this.whatsappBot = whatsappBot;
        this.telegramBot = null;
        this.chatMappings = new Map(); // WhatsApp JID -> Telegram Topic ID
        this.userMappings = new Map(); // WhatsApp JID -> User Info
        this.contactMappings = new Map(); // Phone -> Name
        this.topicMappings = new Map(); // Topic ID -> WhatsApp JID
        this.statusTopicId = null; // Dedicated status topic ID
        this.db = null;
        this.commands = null;
        this.messageQueue = new Map(); // User JID -> Array of pending messages
        this.processingQueue = new Set(); // Track users being processed
        this.topicValidation = new Map(); // Topic ID -> Last validation timestamp
        this.profilePicCache = new Map(); // JID -> Last profile pic hash
    }

    async initialize() {
        if (!config.get('telegram.enabled') || !config.get('telegram.botToken')) {
            logger.warn('⚠️ Telegram bridge disabled or token missing');
            return;
        }

        try {
            this.telegramBot = new TelegramBot(config.get('telegram.botToken'), { polling: true });
            this.commands = new TelegramCommands(this);
            
            this.db = await connectDb();
            await this.loadMappingsFromDb();
            await this.setupTelegramHandlers();
            await this.commands.registerBotCommands();
            
            logger.info('✅ Telegram bridge initialized successfully');
        } catch (error) {
            logger.error('❌ Failed to initialize Telegram bridge:', error);
            throw error;
        }
    }

    async setupTelegramHandlers() {
        // Handle incoming messages from Telegram
        this.telegramBot.on('message', async (msg) => {
            try {
                if (msg.text && msg.text.startsWith('/')) {
                    await this.commands.handleCommand(msg);
                } else if (msg.message_thread_id && config.get('telegram.features.replySupport')) {
                    await this.handleTelegramReply(msg);
                }
            } catch (error) {
                logger.error('❌ Error handling Telegram message:', error);
            }
        });

        // Handle callback queries (button presses)
        this.telegramBot.on('callback_query', async (query) => {
            try {
                await this.handleCallbackQuery(query);
            } catch (error) {
                logger.error('❌ Error handling callback query:', error);
            }
        });

        logger.info('✅ Telegram handlers setup complete');
    }

    async handleTelegramReply(msg) {
        const topicId = msg.message_thread_id;
        const text = msg.text || msg.caption || '';
        
        if (!text.trim()) return;

        // Validate topic exists
        const isValidTopic = await this.validateTopicExists(topicId);
        if (!isValidTopic) {
            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                '❌ This topic no longer exists. Please use /sync to recreate topics.',
                { message_thread_id: topicId }
            );
            return;
        }

        // Check if it's status topic
        if (topicId === this.statusTopicId) {
            await this.handleStatusReply(msg, text);
            return;
        }

        // Find WhatsApp JID for this topic
        const whatsappJid = this.topicMappings.get(topicId);
        if (!whatsappJid) {
            logger.warn(`⚠️ No WhatsApp mapping found for topic ${topicId}`);
            return;
        }

        try {
            // Check if replying to a specific message
            if (msg.reply_to_message && msg.reply_to_message.text) {
                // Send as reply in WhatsApp
                await this.whatsappBot.sendMessage(whatsappJid, { 
                    text: text,
                    quoted: { 
                        key: { 
                            remoteJid: whatsappJid,
                            id: msg.reply_to_message.message_id.toString()
                        }
                    }
                });
            } else {
                // Send as regular message
                await this.whatsappBot.sendMessage(whatsappJid, { text: text });
            }

            // React to confirm sent
            try {
                await this.telegramBot.setMessageReaction(
                    config.get('telegram.chatId'),
                    msg.message_id,
                    [{ type: 'emoji', emoji: '✅' }]
                );
            } catch (reactionError) {
                // Fallback if reactions not supported
                logger.debug('Reactions not supported, skipping');
            }

            logger.info(`📤 Message sent from Telegram to WhatsApp: ${whatsappJid}`);
        } catch (error) {
            logger.error('❌ Failed to send message to WhatsApp:', error);
            try {
                await this.telegramBot.setMessageReaction(
                    config.get('telegram.chatId'),
                    msg.message_id,
                    [{ type: 'emoji', emoji: '❌' }]
                );
            } catch (reactionError) {
                // Fallback message
                await this.telegramBot.sendMessage(
                    config.get('telegram.chatId'),
                    '❌ Failed to send message to WhatsApp',
                    { message_thread_id: topicId }
                );
            }
        }
    }

    async handleStatusReply(msg, text) {
        // Extract phone number from the replied status message
        const replyText = msg.reply_to_message?.text || '';
        const phoneMatch = replyText.match(/📱 \+(\d+)/);
        
        if (!phoneMatch) {
            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                '❌ Could not find phone number in status message',
                { message_thread_id: this.statusTopicId }
            );
            return;
        }

        const phone = phoneMatch[1];
        const whatsappJid = `${phone}@s.whatsapp.net`;

        try {
            await this.whatsappBot.sendMessage(whatsappJid, { text: text });
            
            try {
                await this.telegramBot.setMessageReaction(
                    config.get('telegram.chatId'),
                    msg.message_id,
                    [{ type: 'emoji', emoji: '✅' }]
                );
            } catch (reactionError) {
                await this.telegramBot.sendMessage(
                    config.get('telegram.chatId'),
                    '✅ Reply sent successfully',
                    { message_thread_id: this.statusTopicId }
                );
            }

            logger.info(`📤 Status reply sent to ${phone}`);
        } catch (error) {
            logger.error('❌ Failed to send status reply:', error);
            try {
                await this.telegramBot.setMessageReaction(
                    config.get('telegram.chatId'),
                    msg.message_id,
                    [{ type: 'emoji', emoji: '❌' }]
                );
            } catch (reactionError) {
                await this.telegramBot.sendMessage(
                    config.get('telegram.chatId'),
                    '❌ Failed to send reply',
                    { message_thread_id: this.statusTopicId }
                );
            }
        }
    }

    async validateTopicExists(topicId) {
        const now = Date.now();
        const lastValidation = this.topicValidation.get(topicId) || 0;
        
        // Check every 5 minutes
        if (now - lastValidation < 5 * 60 * 1000) {
            return true;
        }

        try {
            // Try to get topic info
            const chatInfo = await this.telegramBot.getChat(config.get('telegram.chatId'));
            // If we can access the chat, assume topic exists for now
            // Telegram Bot API doesn't provide direct topic validation
            this.topicValidation.set(topicId, now);
            return true;
        } catch (error) {
            logger.warn(`⚠️ Topic ${topicId} validation failed:`, error);
            this.topicValidation.delete(topicId);
            return false;
        }
    }

    async setupWhatsAppHandlers() {
        if (!this.whatsappBot?.sock) return;

        // Listen for contact updates
        if (config.get('telegram.features.autoUpdateContactNames')) {
            this.whatsappBot.sock.ev.on('contacts.update', async (updates) => {
                for (const update of updates) {
                    await this.handleContactUpdate(update);
                }
            });
        }

        // Listen for profile picture updates
        if (config.get('telegram.features.profilePicSync')) {
            this.whatsappBot.sock.ev.on('contacts.update', async (updates) => {
                for (const update of updates) {
                    if (update.imgUrl) {
                        await this.handleProfilePictureUpdate(update);
                    }
                }
            });
        }

        // Listen for connection events for auto-sync
        this.whatsappBot.sock.ev.on('connection.update', async (update) => {
            if (update.connection === 'open') {
                // Auto-sync contacts when connected
                setTimeout(() => this.syncContacts(), 3000);
            }
        });

        logger.info('✅ WhatsApp handlers setup for bridge');
    }

    async handleContactUpdate(update) {
        try {
            const phone = update.id.split('@')[0];
            const newName = update.name || update.notify || phone;
            
            // Update contact mapping
            this.contactMappings.set(phone, newName);
            
            // Update topic name if auto-update is enabled
            if (config.get('telegram.features.autoUpdateTopicNames')) {
                const topicId = this.chatMappings.get(update.id);
                if (topicId) {
                    await this.updateTopicName(topicId, newName, phone);
                }
            }

            // Save to database
            await this.saveContactToDb(phone, newName);
            
            logger.info(`📝 Contact updated: ${phone} -> ${newName}`);
        } catch (error) {
            logger.error('❌ Failed to handle contact update:', error);
        }
    }

    async handleProfilePictureUpdate(update) {
        try {
            const jid = update.id;
            const phone = jid.split('@')[0];
            
            if (!update.imgUrl) return;

            // Check if profile picture changed
            const currentHash = this.profilePicCache.get(jid);
            const newHash = this.generateHash(update.imgUrl);
            
            if (currentHash === newHash) return;

            this.profilePicCache.set(jid, newHash);
            
            // Download and send profile picture
            const topicId = this.chatMappings.get(jid);
            if (topicId) {
                const name = this.contactMappings.get(phone) || phone;
                
                try {
                    const response = await fetch(update.imgUrl);
                    const buffer = await response.buffer();
                    
                    await this.telegramBot.sendPhoto(
                        config.get('telegram.chatId'),
                        buffer,
                        {
                            caption: `📸 *Profile Picture Updated*\n\n👤 ${name} (+${phone})\n⏰ ${new Date().toLocaleString()}`,
                            message_thread_id: topicId,
                            parse_mode: 'Markdown'
                        }
                    );
                    
                    logger.info(`📸 Profile picture updated for ${name} (+${phone})`);
                } catch (error) {
                    logger.error(`❌ Failed to send profile picture for ${phone}:`, error);
                }
            }
        } catch (error) {
            logger.error('❌ Failed to handle profile picture update:', error);
        }
    }

    generateHash(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            const char = str.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash = hash & hash; // Convert to 32bit integer
        }
        return hash.toString();
    }

    async updateTopicName(topicId, name, phone) {
        try {
            const newTopicName = `👤 ${name} (+${phone})`;
            
            await this.telegramBot.editForumTopic(
                config.get('telegram.chatId'),
                topicId,
                { name: newTopicName }
            );
            
            logger.info(`📝 Topic name updated: ${topicId} -> ${newTopicName}`);
        } catch (error) {
            logger.error(`❌ Failed to update topic name for ${topicId}:`, error);
        }
    }

    async updateAllTopicNames() {
        let updated = 0;
        let failed = 0;

        for (const [whatsappJid, topicId] of this.chatMappings) {
            try {
                const phone = whatsappJid.split('@')[0];
                const name = this.contactMappings.get(phone) || phone;
                await this.updateTopicName(topicId, name, phone);
                updated++;
                
                // Small delay to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 200));
            } catch (error) {
                failed++;
                logger.error(`❌ Failed to update topic for ${whatsappJid}:`, error);
            }
        }

        return { updated, failed };
    }

    async syncMessage(msg, text) {
        if (!this.telegramBot || !config.get('telegram.features.topics')) return;

        try {
            // Handle status messages
            if (msg.key.remoteJid === 'status@broadcast') {
                if (config.get('telegram.features.statusSync')) {
                    await this.syncStatusMessage(msg, text);
                }
                return;
            }

            // Handle regular messages
            const senderJid = msg.key.participant || msg.key.remoteJid;
            const phone = senderJid.split('@')[0];
            
            // Add to queue for processing
            if (!this.messageQueue.has(senderJid)) {
                this.messageQueue.set(senderJid, []);
            }
            this.messageQueue.get(senderJid).push({ msg, text });
            
            // Process queue if not already processing
            if (!this.processingQueue.has(senderJid)) {
                await this.processMessageQueue(senderJid);
            }
        } catch (error) {
            logger.error('❌ Error syncing message:', error);
        }
    }

    async processMessageQueue(senderJid) {
        if (this.processingQueue.has(senderJid)) return;
        
        this.processingQueue.add(senderJid);
        
        try {
            const queue = this.messageQueue.get(senderJid) || [];
            
            while (queue.length > 0) {
                const { msg, text } = queue.shift();
                await this.processSingleMessage(msg, text, senderJid);
                
                // Small delay between messages to respect rate limits
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        } finally {
            this.processingQueue.delete(senderJid);
        }
    }

    async processSingleMessage(msg, text, senderJid) {
        const phone = senderJid.split('@')[0];
        let topicId = this.chatMappings.get(senderJid);
        
        // Create topic if doesn't exist or validate existing topic
        if (!topicId) {
            topicId = await this.createUserTopic(senderJid);
            if (!topicId) return;
        } else {
            // Validate topic still exists
            const isValid = await this.validateTopicExists(topicId);
            if (!isValid) {
                // Recreate topic
                topicId = await this.createUserTopic(senderJid);
                if (!topicId) return;
            }
        }

        // Format message
        const messageText = await this.formatWhatsAppMessage(msg, text, senderJid);
        
        // Send to Telegram
        await this.sendToTelegram(topicId, messageText, msg);
    }

    async syncStatusMessage(msg, text) {
        try {
            // Create status topic if doesn't exist
            if (!this.statusTopicId) {
                this.statusTopicId = await this.createStatusTopic();
                if (!this.statusTopicId) return;
            }

            const senderJid = msg.key.participant || msg.key.remoteJid;
            const phone = senderJid.split('@')[0];
            const name = this.contactMappings.get(phone) || phone;
            
            let statusText = `📱 *Status from ${name}* (+${phone})\n`;
            statusText += `⏰ ${new Date().toLocaleString()}\n\n`;
            
            if (text) {
                statusText += `💬 ${text}`;
            }

            // Handle media in status
            if (msg.message?.imageMessage || msg.message?.videoMessage) {
                statusText += msg.message.imageMessage ? '\n📸 *Image Status*' : '\n🎥 *Video Status*';
                
                try {
                    const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
                    const mediaType = msg.message.imageMessage ? 'image' : 'video';
                    const stream = await downloadContentFromMessage(msg.message[`${mediaType}Message`], mediaType);
                    
                    const chunks = [];
                    for await (const chunk of stream) {
                        chunks.push(chunk);
                    }
                    const buffer = Buffer.concat(chunks);
                    
                    if (mediaType === 'image') {
                        await this.telegramBot.sendPhoto(
                            config.get('telegram.chatId'),
                            buffer,
                            { 
                                caption: statusText,
                                message_thread_id: this.statusTopicId,
                                parse_mode: 'Markdown'
                            }
                        );
                    } else {
                        await this.telegramBot.sendVideo(
                            config.get('telegram.chatId'),
                            buffer,
                            { 
                                caption: statusText,
                                message_thread_id: this.statusTopicId,
                                parse_mode: 'Markdown'
                            }
                        );
                    }
                    return;
                } catch (error) {
                    logger.error('❌ Failed to download status media:', error);
                    statusText += '\n❌ *Failed to download media*';
                }
            }

            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                statusText,
                { 
                    message_thread_id: this.statusTopicId,
                    parse_mode: 'Markdown'
                }
            );

            logger.debug(`📱 Status synced from ${name} (+${phone})`);
        } catch (error) {
            logger.error('❌ Error syncing status message:', error);
        }
    }

    async createStatusTopic() {
        try {
            const topic = await this.telegramBot.createForumTopic(
                config.get('telegram.chatId'),
                '📱 WhatsApp Status'
            );
            
            const topicId = topic.message_thread_id;
            
            // Save to database
            await this.db.collection('bridge_mappings').updateOne(
                { type: 'status_topic' },
                { $set: { topicId, createdAt: new Date() } },
                { upsert: true }
            );
            
            // Send welcome message
            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                '📱 *WhatsApp Status Topic*\n\nAll WhatsApp status updates will appear here.\nYou can reply to any status to send a message to that contact.',
                { 
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );
            
            logger.info(`✅ Status topic created: ${topicId}`);
            return topicId;
        } catch (error) {
            logger.error('❌ Failed to create status topic:', error);
            return null;
        }
    }

    async createUserTopic(whatsappJid) {
        try {
            const phone = whatsappJid.split('@')[0];
            const name = this.contactMappings.get(phone) || phone;
            const topicName = `👤 ${name} (+${phone})`;
            
            const topic = await this.telegramBot.createForumTopic(
                config.get('telegram.chatId'),
                topicName
            );
            
            const topicId = topic.message_thread_id;
            
            // Store mappings
            this.chatMappings.set(whatsappJid, topicId);
            this.topicMappings.set(topicId, whatsappJid);
            
            // Save to database
            await this.saveChatMappingToDb(whatsappJid, topicId);
            
            // Send welcome message
            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                `👤 *Chat with ${name}*\n\n📱 Phone: +${phone}\n💬 You can reply here to send messages to WhatsApp`,
                { 
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );
            
            logger.info(`✅ Topic created for ${name}: ${topicId}`);
            return topicId;
        } catch (error) {
            logger.error(`❌ Failed to create topic for ${whatsappJid}:`, error);
            return null;
        }
    }

    async formatWhatsAppMessage(msg, text, senderJid) {
        const phone = senderJid.split('@')[0];
        const name = this.contactMappings.get(phone) || phone;
        const time = new Date(msg.messageTimestamp * 1000).toLocaleString();
        
        let messageText = `👤 *${name}* (+${phone})\n⏰ ${time}\n\n`;
        
        if (text) {
            messageText += `💬 ${text}`;
        }
        
        return messageText;
    }

    async sendToTelegram(topicId, messageText, msg) {
        try {
            // Handle different message types
            if (msg.message?.imageMessage) {
                await this.sendMediaToTelegram(topicId, messageText, msg, 'image');
            } else if (msg.message?.videoMessage) {
                await this.sendMediaToTelegram(topicId, messageText, msg, 'video');
            } else if (msg.message?.audioMessage) {
                await this.sendMediaToTelegram(topicId, messageText, msg, 'audio');
            } else if (msg.message?.documentMessage) {
                await this.sendMediaToTelegram(topicId, messageText, msg, 'document');
            } else if (msg.message?.stickerMessage) {
                await this.sendMediaToTelegram(topicId, messageText, msg, 'sticker');
            } else {
                await this.telegramBot.sendMessage(
                    config.get('telegram.chatId'),
                    messageText,
                    { 
                        message_thread_id: topicId,
                        parse_mode: 'Markdown'
                    }
                );
            }
        } catch (error) {
            logger.error('❌ Failed to send to Telegram:', error);
        }
    }

    async sendMediaToTelegram(topicId, messageText, msg, mediaType) {
        try {
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            const stream = await downloadContentFromMessage(msg.message[`${mediaType}Message`], mediaType);
            
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);
            
            const options = {
                caption: messageText,
                message_thread_id: topicId,
                parse_mode: 'Markdown'
            };
            
            switch (mediaType) {
                case 'image':
                    await this.telegramBot.sendPhoto(config.get('telegram.chatId'), buffer, options);
                    break;
                case 'video':
                    await this.telegramBot.sendVideo(config.get('telegram.chatId'), buffer, options);
                    break;
                case 'audio':
                    await this.telegramBot.sendAudio(config.get('telegram.chatId'), buffer, options);
                    break;
                case 'document':
                    const fileName = msg.message.documentMessage.fileName || 'document';
                    await this.telegramBot.sendDocument(config.get('telegram.chatId'), buffer, { ...options, filename: fileName });
                    break;
                case 'sticker':
                    await this.telegramBot.sendSticker(config.get('telegram.chatId'), buffer, { message_thread_id: topicId });
                    // Send caption separately for stickers
                    await this.telegramBot.sendMessage(config.get('telegram.chatId'), messageText, { message_thread_id: topicId, parse_mode: 'Markdown' });
                    break;
            }
        } catch (error) {
            logger.error(`❌ Failed to send ${mediaType} to Telegram:`, error);
            // Fallback to text message
            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                `${messageText}\n\n❌ *Failed to download ${mediaType}*`,
                { 
                    message_thread_id: topicId,
                    parse_mode: 'Markdown'
                }
            );
        }
    }

    async sendQRCode(qr) {
        if (!this.telegramBot) return;
        
        try {
            const qrBuffer = await qrcode.toBuffer(qr, { width: 512 });
            await this.telegramBot.sendPhoto(
                config.get('telegram.chatId'),
                qrBuffer,
                { caption: '📱 *WhatsApp QR Code*\n\nScan this QR code with WhatsApp to connect!', parse_mode: 'Markdown' }
            );
        } catch (error) {
            logger.error('❌ Failed to send QR code to Telegram:', error);
        }
    }

    async syncContacts() {
        if (!this.whatsappBot?.sock?.store?.contacts) {
            logger.warn('⚠️ WhatsApp contacts not available');
            return 0;
        }

        const contacts = Object.values(this.whatsappBot.sock.store.contacts);
        let synced = 0;

        for (const contact of contacts) {
            if (contact.id && !contact.id.endsWith('@g.us')) {
                const phone = contact.id.split('@')[0];
                const name = contact.name || contact.notify || phone;
                this.contactMappings.set(phone, name);
                await this.saveContactToDb(phone, name);
                synced++;
            }
        }

        await this.saveMappingsToDb();
        logger.info(`✅ Synced ${synced} contacts`);
        return synced;
    }

    async syncWhatsAppConnection() {
        if (!this.telegramBot) return;
        
        try {
            const user = this.whatsappBot.sock?.user;
            if (user) {
                await this.telegramBot.sendMessage(
                    config.get('telegram.chatId'),
                    `✅ *WhatsApp Connected*\n\n👤 User: ${user.name || 'Unknown'}\n📱 Number: ${user.id}\n⏰ ${new Date().toLocaleString()}`,
                    { parse_mode: 'Markdown' }
                );
                
                // Auto-sync contacts on connection
                setTimeout(() => this.syncContacts(), 2000);
            }
        } catch (error) {
            logger.error('❌ Failed to sync WhatsApp connection:', error);
        }
    }

    async logToTelegram(title, message) {
        if (!this.telegramBot) return;
        
        try {
            await this.telegramBot.sendMessage(
                config.get('telegram.chatId'),
                `🔔 *${title}*\n\n${message}\n⏰ ${new Date().toLocaleString()}`,
                { parse_mode: 'Markdown' }
            );
        } catch (error) {
            logger.error('❌ Failed to log to Telegram:', error);
        }
    }

    // Database operations
    async loadMappingsFromDb() {
        try {
            const mappings = await this.db.collection('bridge_mappings').find({}).toArray();
            
            for (const mapping of mappings) {
                if (mapping.type === 'chat') {
                    this.chatMappings.set(mapping.whatsappJid, mapping.telegramTopicId);
                    this.topicMappings.set(mapping.telegramTopicId, mapping.whatsappJid);
                } else if (mapping.type === 'contact') {
                    this.contactMappings.set(mapping.phone, mapping.name);
                } else if (mapping.type === 'status_topic') {
                    this.statusTopicId = mapping.topicId;
                }
            }
            
            logger.info(`✅ Loaded ${this.chatMappings.size} chat mappings and ${this.contactMappings.size} contacts from database`);
        } catch (error) {
            logger.error('❌ Failed to load mappings from database:', error);
        }
    }

    async saveChatMappingToDb(whatsappJid, telegramTopicId) {
        try {
            await this.db.collection('bridge_mappings').updateOne(
                { type: 'chat', whatsappJid },
                { 
                    $set: { 
                        type: 'chat',
                        whatsappJid,
                        telegramTopicId,
                        updatedAt: new Date()
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error('❌ Failed to save chat mapping to database:', error);
        }
    }

    async saveContactToDb(phone, name) {
        try {
            await this.db.collection('bridge_mappings').updateOne(
                { type: 'contact', phone },
                { 
                    $set: { 
                        type: 'contact',
                        phone,
                        name,
                        updatedAt: new Date()
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error('❌ Failed to save contact to database:', error);
        }
    }

    async saveMappingsToDb() {
        try {
            const operations = [];
            
            // Save chat mappings
            for (const [whatsappJid, telegramTopicId] of this.chatMappings) {
                operations.push({
                    updateOne: {
                        filter: { type: 'chat', whatsappJid },
                        update: { 
                            $set: { 
                                type: 'chat',
                                whatsappJid,
                                telegramTopicId,
                                updatedAt: new Date()
                            }
                        },
                        upsert: true
                    }
                });
            }
            
            // Save contact mappings
            for (const [phone, name] of this.contactMappings) {
                operations.push({
                    updateOne: {
                        filter: { type: 'contact', phone },
                        update: { 
                            $set: { 
                                type: 'contact',
                                phone,
                                name,
                                updatedAt: new Date()
                            }
                        },
                        upsert: true
                    }
                });
            }
            
            if (operations.length > 0) {
                await this.db.collection('bridge_mappings').bulkWrite(operations);
            }
            
            logger.info('✅ Mappings saved to database');
        } catch (error) {
            logger.error('❌ Failed to save mappings to database:', error);
        }
    }

    async shutdown() {
        if (this.telegramBot) {
            await this.telegramBot.stopPolling();
            logger.info('✅ Telegram bridge shutdown complete');
        }
    }
}

module.exports = TelegramBridge;