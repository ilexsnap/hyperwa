const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const fs = require('fs-extra');
const path = require('path');

const config = require('../config');
const logger = require('./logger');
const MessageHandler = require('./message-handler');
const TelegramBridge = require('../watg-bridge/bridge');
const { connectDb } = require('../utils/db');
const ModuleLoader = require('./module-loader');

class HyperWaBot {
    constructor() {
        this.sock = null;
        this.authPath = './auth_info';
        this.messageHandler = new MessageHandler(this);
        this.telegramBridge = null;
        this.isShuttingDown = false;
        this.db = null;
        this.moduleLoader = new ModuleLoader(this);
        this.qrCodeSent = false;
        this.lastContactSync = 0;
        this.contactSyncInterval = null;
    }

    async initialize() {
        logger.info('🔧 Initializing HyperWa Userbot...');
        
        // Connect to the database
        try {
            this.db = await connectDb();
            logger.info('✅ Database connected successfully!');
        } catch (error) {
            logger.error('❌ Failed to connect to database:', error);
            process.exit(1);
        }

        // Initialize Telegram bridge first (for QR code sending)
        if (config.get('telegram.enabled')) {
            try {
                this.telegramBridge = new TelegramBridge(this);
                await this.telegramBridge.initialize();
                logger.info('✅ Telegram bridge initialized');
            } catch (error) {
                logger.error('❌ Failed to initialize Telegram bridge:', error);
            }
        }

        // Load modules using the ModuleLoader
        await this.moduleLoader.loadModules();
        
        // Start WhatsApp connection
        await this.startWhatsApp();
        
        logger.info('✅ HyperWa Userbot initialized successfully!');
    }

    async startWhatsApp() {
        const { state, saveCreds } = await useMultiFileAuthState(this.authPath);
        const { version } = await fetchLatestBaileysVersion();

        try {
            this.sock = makeWASocket({
                auth: state,
                version,
                printQRInTerminal: false,
                logger: logger.child({ module: 'baileys' }),
                getMessage: async (key) => ({ conversation: 'Message not found' }),
                browser: ['HyperWa', 'Chrome', '3.0'],
                syncFullHistory: true,
                markOnlineOnConnect: true,
                emitOwnEvents: true,
                generateHighQualityLinkPreview: true,
                defaultQueryTimeoutMs: 60000,
            });

            const connectionTimeout = setTimeout(() => {
                if (!this.sock.user) {
                    logger.warn('❌ QR code scan timed out after 30 seconds');
                    logger.info('🔄 Retrying with new QR code...');
                    this.sock.end();
                    setTimeout(() => this.startWhatsApp(), 5000);
                }
            }, 30000);

            this.setupEventHandlers(saveCreds);
            await new Promise(resolve => this.sock.ev.on('connection.update', update => {
                if (update.connection === 'open') {
                    clearTimeout(connectionTimeout);
                    resolve();
                }
            }));
        } catch (error) {
            logger.error('❌ Failed to initialize WhatsApp socket:', error);
            logger.info('🔄 Retrying with new QR code...');
            setTimeout(() => this.startWhatsApp(), 5000);
        }
    }

    setupEventHandlers(saveCreds) {
        this.sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                logger.info('📱 Scan QR code with WhatsApp:');
                qrcode.generate(qr, { small: true });

                if (this.telegramBridge && config.get('telegram.enabled') && config.get('telegram.botToken')) {
                    try {
                        await this.telegramBridge.sendQRCode(qr);
                        logger.info('✅ QR code sent to Telegram');
                    } catch (error) {
                        logger.error('❌ Failed to send QR code to Telegram:', error);
                    }
                }
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode || 0;
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect && !this.isShuttingDown) {
                    logger.warn('🔄 Connection closed, reconnecting...');
                    setTimeout(() => this.startWhatsApp(), 5000);
                } else {
                    logger.error('❌ Connection closed permanently. Please delete auth_info and restart.');
                    process.exit(1);
                }
            } else if (connection === 'open') {
                await this.onConnectionOpen();
            }
        });

        this.sock.ev.on('creds.update', saveCreds);
        
        // FIXED: Proper message handling
        this.sock.ev.on('messages.upsert', async (messageUpdate) => {
            try {
                // Handle regular messages
                await this.messageHandler.handleMessages(messageUpdate);
                
                // Handle bridge messages
                if (this.telegramBridge) {
                    await this.telegramBridge.handleWhatsAppMessages(messageUpdate);
                }
            } catch (error) {
                logger.error('❌ Error handling messages:', error);
            }
        });
        
        // FIXED: Enhanced event handlers for bridge functionality
        this.sock.ev.on('contacts.update', this.handleContactsUpdate.bind(this));
        this.sock.ev.on('contacts.upsert', this.handleContactsUpsert.bind(this));
        
        // FIXED: Call event handler
        this.sock.ev.on('call', this.handleCallEvents.bind(this));
        
        // FIXED: Profile picture updates
        this.sock.ev.on('contacts.update', this.handleProfilePictureUpdates.bind(this));
        
        // FIXED: Presence updates
        this.sock.ev.on('presence.update', this.handlePresenceUpdates.bind(this));
        
        // FIXED: Group updates
        this.sock.ev.on('groups.update', this.handleGroupUpdates.bind(this));
        
        logger.info('📱 WhatsApp event handlers set up');
    }

    async handleCallEvents(callEvents) {
        if (!this.telegramBridge || !config.get('telegram.features.callLogs')) return;
        
        try {
            for (const call of callEvents) {
                logger.info(`📞 Call event: ${call.status} from ${call.from}`);
                await this.telegramBridge.handleCallNotification(call);
            }
        } catch (error) {
            logger.error('❌ Failed to handle call events:', error);
        }
    }

    async handleContactsUpdate(contacts) {
        if (!config.get('telegram.features.autoUpdateContactNames')) return;
        
        try {
            for (const contact of contacts) {
                if (contact.id && contact.name) {
                    const phone = contact.id.split('@')[0];
                    const oldName = this.telegramBridge?.contactMappings.get(phone);
                    
                    if (contact.name !== phone && 
                        !contact.name.startsWith('+') && 
                        contact.name.length > 2 &&
                        oldName !== contact.name) {
                        
                        if (this.telegramBridge) {
                            await this.telegramBridge.saveContactMapping(phone, contact.name);
                            logger.info(`📞 Updated contact: ${phone} -> ${contact.name}`);
                            
                            // Auto update topic name if enabled
                            if (config.get('telegram.features.autoUpdateTopicNames')) {
                                await this.telegramBridge.updateSingleTopicName(contact.id, contact.name);
                            }
                        }
                    }
                }
            }
        } catch (error) {
            logger.error('❌ Failed to handle contact updates:', error);
        }
    }

    async handleContactsUpsert(contacts) {
        if (!this.telegramBridge) return;
        
        try {
            for (const contact of contacts) {
                if (contact.id && contact.name) {
                    const phone = contact.id.split('@')[0];
                    if (contact.name !== phone && 
                        !contact.name.startsWith('+') && 
                        contact.name.length > 2 &&
                        !this.telegramBridge.contactMappings.has(phone)) {
                        
                        await this.telegramBridge.saveContactMapping(phone, contact.name);
                        logger.info(`📞 New contact: ${phone} -> ${contact.name}`);
                    }
                }
            }
        } catch (error) {
            logger.error('❌ Failed to handle new contacts:', error);
        }
    }

    async handleProfilePictureUpdates(contacts) {
        if (!config.get('telegram.features.profilePicSync') || !this.telegramBridge) return;
        
        try {
            for (const contact of contacts) {
                if (contact.id && contact.imgUrl) {
                    await this.telegramBridge.handleProfilePictureUpdate(contact.id, contact.imgUrl);
                }
            }
        } catch (error) {
            logger.error('❌ Failed to handle profile picture updates:', error);
        }
    }

    async handlePresenceUpdates(presenceUpdate) {
        if (!config.get('telegram.features.presenceUpdates') || !this.telegramBridge) return;
        
        try {
            await this.telegramBridge.handlePresenceUpdate(presenceUpdate);
        } catch (error) {
            logger.error('❌ Failed to handle presence updates:', error);
        }
    }

    async handleGroupUpdates(groupUpdates) {
        if (!this.telegramBridge) return;
        
        try {
            for (const update of groupUpdates) {
                await this.telegramBridge.handleGroupUpdate(update);
            }
        } catch (error) {
            logger.error('❌ Failed to handle group updates:', error);
        }
    }

    async onConnectionOpen() {
        logger.info(`✅ Connected to WhatsApp! User: ${this.sock.user?.id || 'Unknown'}`);
        
        if (!config.get('bot.owner') && this.sock.user) {
            config.set('bot.owner', this.sock.user.id);
            logger.info(`👑 Owner set to: ${this.sock.user.id}`);
        }

        if (this.telegramBridge) {
            await this.telegramBridge.setupWhatsAppHandlers();
            
            // FIXED: Force contact sync on every connection
            logger.info('🔄 Starting contact sync...');
            await this.telegramBridge.syncContacts();
            
            // FIXED: Verify and recreate topics
            await this.telegramBridge.verifyAllTopics();
        }

        await this.sendStartupMessage();
        
        if (this.telegramBridge) {
            await this.telegramBridge.syncWhatsAppConnection();
        }

        // Start periodic contact sync
        this.startPeriodicContactSync();
    }

    startPeriodicContactSync() {
        // Clear existing interval
        if (this.contactSyncInterval) {
            clearInterval(this.contactSyncInterval);
        }

        // FIXED: More frequent contact sync (every 2 minutes)
        this.contactSyncInterval = setInterval(async () => {
            try {
                if (this.telegramBridge && this.sock?.user) {
                    logger.debug('🔄 Periodic contact sync...');
                    await this.telegramBridge.syncContacts();
                }
            } catch (error) {
                logger.error('❌ Periodic contact sync failed:', error);
            }
        }, 2 * 60 * 1000);

        logger.info('🔄 Started periodic contact sync (every 2 minutes)');
    }

    async sendStartupMessage() {
        const owner = config.get('bot.owner');
        if (!owner) return;

        const startupMessage = `🚀 *${config.get('bot.name')} v${config.get('bot.version')}* is now online!\n\n` +
                              `🔥 *HyperWa Features Active:*\n` +
                              `• 📱 Modular Architecture\n` +
                              `• 🤖 Telegram Bridge: ${config.get('telegram.enabled') ? '✅' : '❌'}\n` +
                              `• 🔧 Custom Modules: ${config.get('features.customModules') ? '✅' : '❌'}\n` +
                              `• 📊 Status Sync: ${config.get('telegram.features.statusSync') ? '✅' : '❌'}\n` +
                              `• 📞 Auto Contact Update: ${config.get('telegram.features.autoUpdateContactNames') ? '✅' : '❌'}\n` +
                              `• 📞 Call Logs: ${config.get('telegram.features.callLogs') ? '✅' : '❌'}\n` +
                              `Type *${config.get('bot.prefix')}help* for available commands!`;

        try {
            await this.sock.sendMessage(owner, { text: startupMessage });
            
            if (this.telegramBridge) {
                await this.telegramBridge.logToTelegram('🚀 HyperWa Bot Started', startupMessage);
            }
        } catch (error) {
            logger.error('Failed to send startup message:', error);
        }
    }

    async connect() {
        if (!this.sock) {
            await this.startWhatsApp();
        }
        return this.sock;
    }

    async sendMessage(jid, content) {
        if (!this.sock) {
            throw new Error('WhatsApp socket not initialized');
        }
        return await this.sock.sendMessage(jid, content);
    }

    async shutdown() {
        logger.info('🛑 Shutting down HyperWa Userbot...');
        this.isShuttingDown = true;
        
        if (this.contactSyncInterval) {
            clearInterval(this.contactSyncInterval);
        }
        
        if (this.telegramBridge) {
            await this.telegramBridge.shutdown();
        }
        
        if (this.sock) {
            await this.sock.end();
        }
        
        logger.info('✅ HyperWa Userbot shutdown complete');
    }
}

module.exports = { HyperWaBot };
