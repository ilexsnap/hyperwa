const logger = require('../Core/logger');
const config = require('../config');

class TelegramCommands {
    constructor(bridge) {
        this.bridge = bridge;
    }

    async handleCommand(msg) {
        const text = msg.text;
        if (!text || !text.startsWith('/')) return;

        const [command, ...args] = text.split(' ');

        try {
            switch (command.toLowerCase()) {
                case '/start':
                    await this.handleStart(msg.chat.id);
                    break;
                case '/status':
                    await this.handleStatus(msg.chat.id);
                    break;
                case '/send':
                    await this.handleSend(msg.chat.id, args);
                    break;
                case '/sync':
                    await this.handleSync(msg.chat.id);
                    break;
                case '/contacts':
                    await this.handleContacts(msg.chat.id);
                    break;
                case '/searchcontact':
                    await this.handleSearchContact(msg.chat.id, args);
                    break;
                case '/updatetopics':
                    await this.handleUpdateTopics(msg.chat.id);
                    break;
                case '/settings':
                    await this.handleSettings(msg.chat.id);
                    break;
                case '/whatsapp':
                    await this.handleWhatsAppSettings(msg.chat.id);
                    break;
                case '/bridge':
                    await this.handleBridgeSettings(msg.chat.id);
                    break;
                case '/config':
                    await this.handleConfig(msg.chat.id, args);
                    break;
                default:
                    await this.handleMenu(msg.chat.id);
            }
        } catch (error) {
            logger.error(`❌ Error handling command ${command}:`, error);
            await this.bridge.telegramBot.sendMessage(
                msg.chat.id,
                `❌ Command error: ${error.message}`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handleStart(chatId) {
        const isReady = !!this.bridge.telegramBot;
        const welcome = `🤖 *WhatsApp-Telegram Bridge*\n\n` +
            `Status: ${isReady ? '✅ Ready' : '⏳ Initializing...'}\n` +
            `Linked Chats: ${this.bridge.chatMappings.size}\n` +
            `Contacts: ${this.bridge.contactMappings.size}\n` +
            `Users: ${this.bridge.userMappings.size}\n\n` +
            `Use /settings to configure the bot`;
        await this.bridge.telegramBot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${this.bridge.whatsappBot?.sock?.user?.name || 'Unknown'}\n` +
            `💬 Chats: ${this.bridge.chatMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}\n\n` +
            `🔧 *Features Status:*\n` +
            `• Status Sync: ${config.get('telegram.features.statusSync') ? '✅' : '❌'}\n` +
            `• Profile Pic Sync: ${config.get('telegram.features.profilePicSync') ? '✅' : '❌'}\n` +
            `• Auto Update Contacts: ${config.get('telegram.features.autoUpdateContactNames') ? '✅' : '❌'}\n` +
            `• Auto Update Topics: ${config.get('telegram.features.autoUpdateTopicNames') ? '✅' : '❌'}\n` +
            `• Read Receipts: ${config.get('telegram.features.readReceipts') ? '✅' : '❌'}`;
        await this.bridge.telegramBot.sendMessage(chatId, status, { parse_mode: 'Markdown' });
    }

    async handleSend(chatId, args) {
        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /send <number> <message>\nExample: /send 1234567890 Hello!',
                { parse_mode: 'Markdown' });
            return;
        }

        const number = args[0];
        const message = args.slice(1).join(' ');

        try {
            const jid = number.includes('@') ? number : `${number}@s.whatsapp.net`;
            const result = await this.bridge.whatsappBot.sendMessage(jid, { text: message });
            await this.bridge.telegramBot.sendMessage(chatId,
                result?.key?.id ? `✅ Message sent to ${number}` : `⚠️ Message sent but no confirmation`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error sending: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSync(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...', { parse_mode: 'Markdown' });
        try {
            const result = await this.bridge.syncContacts();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Synced ${result.synced} new contacts (Total: ${result.total})`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to sync: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleContacts(chatId) {
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            if (contacts.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, '📞 No contacts found', { parse_mode: 'Markdown' });
                return;
            }
            
            const contactList = contacts
                .slice(0, 50) // Limit to first 50 contacts
                .map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`)
                .join('\n');
            
            const message = `📞 *Contacts (${contacts.length} total, showing first 50)*\n\n${contactList}`;
            await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to list contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSearchContact(chatId, args) {
        if (args.length < 1) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /searchcontact <name or phone>\nExample: /searchcontact John',
                { parse_mode: 'Markdown' });
            return;
        }

        const query = args.join(' ').toLowerCase();
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            const matches = contacts.filter(([phone, name]) =>
                name?.toLowerCase().includes(query) || phone.includes(query)
            );

            if (matches.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, `❌ No contacts found for "${query}"`, { parse_mode: 'Markdown' });
                return;
            }

            const result = matches
                .slice(0, 20) // Limit to 20 results
                .map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`)
                .join('\n');
            await this.bridge.telegramBot.sendMessage(chatId, `🔍 *Search Results (${matches.length} found)*\n\n${result}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to search contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleUpdateTopics(chatId) {
        await this.bridge.telegramBot.sendMessage(chatId, '📝 Updating topic names...', { parse_mode: 'Markdown' });
        try {
            const updatedCount = await this.bridge.updateTopicNames();
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Updated ${updatedCount} topic names`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Failed to update topics: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleSettings(chatId) {
        const settingsMenu = `⚙️ *Settings Panel*\n\n` +
            `Choose a category to configure:\n\n` +
            `🤖 /whatsapp - WhatsApp Bot Settings\n` +
            `🌉 /bridge - Bridge Settings\n` +
            `🔧 /config - View/Edit Configuration\n\n` +
            `📊 Current Status:\n` +
            `• WhatsApp: ${this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
            `• Bridge: ${config.get('telegram.enabled') ? '✅ Active' : '❌ Inactive'}\n` +
            `• Contacts: ${this.bridge.contactMappings.size} synced`;

        await this.bridge.telegramBot.sendMessage(chatId, settingsMenu, { parse_mode: 'Markdown' });
    }

    async handleWhatsAppSettings(chatId) {
        const whatsappSettings = `🤖 *WhatsApp Bot Settings*\n\n` +
            `📱 *Connection Status:* ${this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 *User:* ${this.bridge.whatsappBot?.sock?.user?.name || 'Not connected'}\n` +
            `🔢 *User ID:* ${this.bridge.whatsappBot?.sock?.user?.id || 'N/A'}\n\n` +
            `⚙️ *Available Commands:*\n` +
            `• /sync - Force sync contacts\n` +
            `• /send <number> <message> - Send message\n` +
            `• /contacts - View all contacts\n` +
            `• /searchcontact <query> - Search contacts\n\n` +
            `🔧 *Configuration:*\n` +
            `• Bot Name: ${config.get('bot.name')}\n` +
            `• Bot Version: ${config.get('bot.version')}\n` +
            `• Prefix: ${config.get('bot.prefix')}`;

        await this.bridge.telegramBot.sendMessage(chatId, whatsappSettings, { parse_mode: 'Markdown' });
    }

    async handleBridgeSettings(chatId) {
        const bridgeSettings = `🌉 *Bridge Settings*\n\n` +
            `🔗 *Status:* ${config.get('telegram.enabled') ? '✅ Active' : '❌ Inactive'}\n` +
            `💬 *Mapped Chats:* ${this.bridge.chatMappings.size}\n` +
            `👥 *Users:* ${this.bridge.userMappings.size}\n` +
            `📞 *Contacts:* ${this.bridge.contactMappings.size}\n\n` +
            `🎛️ *Feature Status:*\n` +
            `• 📊 Status Sync: ${config.get('telegram.features.statusSync') ? '✅' : '❌'}\n` +
            `• 📸 Profile Pic Sync: ${config.get('telegram.features.profilePicSync') ? '✅' : '❌'}\n` +
            `• 🔄 Auto Update Contacts: ${config.get('telegram.features.autoUpdateContactNames') ? '✅' : '❌'}\n` +
            `• 📝 Auto Update Topics: ${config.get('telegram.features.autoUpdateTopicNames') ? '✅' : '❌'}\n` +
            `• 📖 Read Receipts: ${config.get('telegram.features.readReceipts') ? '✅' : '❌'}\n` +
            `• 👁️ Presence Updates: ${config.get('telegram.features.presenceUpdates') ? '✅' : '❌'}\n` +
            `• 🔄 Bi-Directional: ${config.get('telegram.features.biDirectional') ? '✅' : '❌'}\n\n` +
            `⚙️ *Management Commands:*\n` +
            `• /updatetopics - Update all topic names\n` +
            `• /sync - Sync WhatsApp contacts\n` +
            `• /config <feature> <true/false> - Toggle features`;

        await this.bridge.telegramBot.sendMessage(chatId, bridgeSettings, { parse_mode: 'Markdown' });
    }

    async handleConfig(chatId, args) {
        if (args.length === 0) {
            const configInfo = `🔧 *Configuration*\n\n` +
                `Usage: /config <feature> <value>\n\n` +
                `📊 *Available Features:*\n` +
                `• statusSync - Sync WhatsApp status updates\n` +
                `• profilePicSync - Sync profile picture updates\n` +
                `• autoUpdateContactNames - Auto update contact names\n` +
                `• autoUpdateTopicNames - Auto update topic names\n` +
                `• readReceipts - Send read receipts\n` +
                `• presenceUpdates - Send presence updates\n` +
                `• biDirectional - Enable bi-directional messaging\n\n` +
                `📝 *Examples:*\n` +
                `• /config statusSync true\n` +
                `• /config profilePicSync false\n` +
                `• /config autoUpdateContactNames true`;

            await this.bridge.telegramBot.sendMessage(chatId, configInfo, { parse_mode: 'Markdown' });
            return;
        }

        if (args.length !== 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /config <feature> <true/false>',
                { parse_mode: 'Markdown' });
            return;
        }

        const [feature, value] = args;
        const boolValue = value.toLowerCase() === 'true';

        const validFeatures = [
            'statusSync',
            'profilePicSync', 
            'autoUpdateContactNames',
            'autoUpdateTopicNames',
            'readReceipts',
            'presenceUpdates',
            'biDirectional'
        ];

        if (!validFeatures.includes(feature)) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Invalid feature. Valid features: ${validFeatures.join(', ')}`,
                { parse_mode: 'Markdown' });
            return;
        }

        try {
            config.set(`telegram.features.${feature}`, boolValue);
            await this.bridge.telegramBot.sendMessage(chatId,
                `✅ Set ${feature} to ${boolValue ? '✅ enabled' : '❌ disabled'}`,
                { parse_mode: 'Markdown' });
        } catch (error) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Failed to update config: ${error.message}`,
                { parse_mode: 'Markdown' });
        }
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `🏠 *Main Commands:*\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/settings - Open settings panel\n\n` +
            `🤖 *WhatsApp Commands:*\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/contacts - View WhatsApp contacts\n` +
            `/searchcontact <name/phone> - Search contacts\n\n` +
            `🌉 *Bridge Commands:*\n` +
            `/whatsapp - WhatsApp bot settings\n` +
            `/bridge - Bridge configuration\n` +
            `/updatetopics - Update topic names\n` +
            `/config <feature> <value> - Configure features`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'settings', description: 'Open settings panel' },
                { command: 'whatsapp', description: 'WhatsApp bot settings' },
                { command: 'bridge', description: 'Bridge configuration' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'contacts', description: 'View WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'updatetopics', description: 'Update topic names' },
                { command: 'config', description: 'Configure features' }
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

module.exports = TelegramCommands;
