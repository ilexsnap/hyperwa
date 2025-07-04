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
                case '/config':
                    await this.handleConfig(msg.chat.id, args);
                    break;
                case '/settings':
                    await this.handleSettings(msg.chat.id);
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
            `Use /menu to see all available commands.`;
        await this.bridge.telegramBot.sendMessage(chatId, welcome, { parse_mode: 'Markdown' });
    }

    async handleStatus(chatId) {
        const status = `📊 *Bridge Status*\n\n` +
            `🔗 WhatsApp: ${this.bridge.whatsappBot?.sock ? '✅ Connected' : '❌ Disconnected'}\n` +
            `👤 User: ${this.bridge.whatsappBot?.sock?.user?.name || 'Unknown'}\n` +
            `💬 Chats: ${this.bridge.chatMappings.size}\n` +
            `👥 Users: ${this.bridge.userMappings.size}\n` +
            `📞 Contacts: ${this.bridge.contactMappings.size}\n` +
            `📱 Status Topic: ${this.bridge.statusTopicId ? '✅ Active' : '❌ Not Created'}`;
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
        const processingMsg = await this.bridge.telegramBot.sendMessage(chatId, '🔄 Syncing contacts...', { parse_mode: 'Markdown' });
        try {
            const syncedCount = await this.bridge.syncContacts();
            await this.bridge.saveMappingsToDb();
            await this.bridge.telegramBot.editMessageText(
                `✅ Synced ${syncedCount} contacts from WhatsApp`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        } catch (error) {
            await this.bridge.telegramBot.editMessageText(
                `❌ Failed to sync: ${error.message}`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        }
    }

    async handleContacts(chatId) {
        try {
            const contacts = [...this.bridge.contactMappings.entries()];
            if (contacts.length === 0) {
                await this.bridge.telegramBot.sendMessage(chatId, '📞 No contacts found', { parse_mode: 'Markdown' });
                return;
            }
            
            // Limit to first 50 contacts to avoid message length limits
            const contactList = contacts.slice(0, 50).map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
            const moreText = contacts.length > 50 ? `\n\n... and ${contacts.length - 50} more contacts` : '';
            
            await this.bridge.telegramBot.sendMessage(chatId, `📞 *Contacts* (${contacts.length} total)\n\n${contactList}${moreText}`, { parse_mode: 'Markdown' });
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

            const result = matches.map(([phone, name]) => `📱 ${name || 'Unknown'} (+${phone})`).join('\n');
            await this.bridge.telegramBot.sendMessage(chatId, `🔍 *Search Results* (${matches.length} found)\n\n${result}`, { parse_mode: 'Markdown' });
        } catch (error) {
            logger.error('❌ Failed to search contacts:', error);
            await this.bridge.telegramBot.sendMessage(chatId, `❌ Error: ${error.message}`, { parse_mode: 'Markdown' });
        }
    }

    async handleUpdateTopics(chatId) {
        const processingMsg = await this.bridge.telegramBot.sendMessage(chatId, '📝 Updating topic names...', { parse_mode: 'Markdown' });
        
        try {
            const result = await this.bridge.updateAllTopicNames();
            await this.bridge.telegramBot.editMessageText(
                `✅ Topic names updated!\n\n📝 Updated: ${result.updated}\n❌ Failed: ${result.failed}`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        } catch (error) {
            await this.bridge.telegramBot.editMessageText(
                `❌ Failed to update topics: ${error.message}`,
                {
                    chat_id: chatId,
                    message_id: processingMsg.message_id,
                    parse_mode: 'Markdown'
                }
            );
        }
    }

    async handleConfig(chatId, args) {
        if (args.length === 0) {
            await this.handleSettings(chatId);
            return;
        }

        if (args.length < 2) {
            await this.bridge.telegramBot.sendMessage(chatId,
                '❌ Usage: /config <setting> <true|false>\nUse /settings to see all available settings',
                { parse_mode: 'Markdown' });
            return;
        }

        const setting = args[0].toLowerCase();
        const value = args[1].toLowerCase() === 'true';

        const validSettings = [
            'statussync',
            'autoupdatecontactnames', 
            'autoupdatetopicnames',
            'replysupport',
            'profilepicsync',
            'topics',
            'mediasync'
        ];

        if (!validSettings.includes(setting)) {
            await this.bridge.telegramBot.sendMessage(chatId,
                `❌ Invalid setting. Valid options:\n${validSettings.join(', ')}`,
                { parse_mode: 'Markdown' });
            return;
        }

        // Map setting names to config paths
        const settingMap = {
            'statussync': 'telegram.features.statusSync',
            'autoupdatecontactnames': 'telegram.features.autoUpdateContactNames',
            'autoupdatetopicnames': 'telegram.features.autoUpdateTopicNames',
            'replysupport': 'telegram.features.replySupport',
            'profilepicsync': 'telegram.features.profilePicSync',
            'topics': 'telegram.features.topics',
            'mediasync': 'telegram.features.mediaSync'
        };

        const configPath = settingMap[setting];
        config.set(configPath, value);

        await this.bridge.telegramBot.sendMessage(chatId,
            `✅ Setting updated!\n\n⚙️ ${setting}: ${value ? 'Enabled' : 'Disabled'}`,
            { parse_mode: 'Markdown' });
    }

    async handleSettings(chatId) {
        const settingsText = `⚙️ *Bridge Settings*\n\n` +
            `📱 Status Sync: ${config.get('telegram.features.statusSync') ? '✅' : '❌'}\n` +
            `📝 Auto Update Contact Names: ${config.get('telegram.features.autoUpdateContactNames') ? '✅' : '❌'}\n` +
            `🏷️ Auto Update Topic Names: ${config.get('telegram.features.autoUpdateTopicNames') ? '✅' : '❌'}\n` +
            `💬 Reply Support: ${config.get('telegram.features.replySupport') ? '✅' : '❌'}\n` +
            `📸 Profile Pic Sync: ${config.get('telegram.features.profilePicSync') ? '✅' : '❌'}\n` +
            `📋 Topics: ${config.get('telegram.features.topics') ? '✅' : '❌'}\n` +
            `🔄 Media Sync: ${config.get('telegram.features.mediaSync') ? '✅' : '❌'}\n\n` +
            `💡 Use /config <setting> <true|false> to change settings\n` +
            `Example: /config statusSync true`;

        await this.bridge.telegramBot.sendMessage(chatId, settingsText, { parse_mode: 'Markdown' });
    }

    async handleMenu(chatId) {
        const message = `ℹ️ *Available Commands*\n\n` +
            `/start - Show bot info\n` +
            `/status - Show bridge status\n` +
            `/send <number> <msg> - Send WhatsApp message\n` +
            `/sync - Sync WhatsApp contacts\n` +
            `/contacts - View WhatsApp contacts\n` +
            `/searchcontact <name/phone> - Search contacts\n` +
            `/updatetopics - Update all topic names\n` +
            `/settings - View bridge settings\n` +
            `/config <setting> <value> - Change settings\n\n` +
            `💡 You can also reply in topics to send messages to WhatsApp!`;
        await this.bridge.telegramBot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    }

    async registerBotCommands() {
        try {
            await this.bridge.telegramBot.setMyCommands([
                { command: 'start', description: 'Show bot info' },
                { command: 'status', description: 'Show bridge status' },
                { command: 'send', description: 'Send WhatsApp message' },
                { command: 'sync', description: 'Sync WhatsApp contacts' },
                { command: 'contacts', description: 'View WhatsApp contacts' },
                { command: 'searchcontact', description: 'Search WhatsApp contacts' },
                { command: 'updatetopics', description: 'Update topic names' },
                { command: 'settings', description: 'View bridge settings' },
                { command: 'config', description: 'Change bridge settings' }
            ]);
            logger.info('✅ Telegram bot commands registered');
        } catch (error) {
            logger.error('❌ Failed to register Telegram bot commands:', error);
        }
    }
}

module.exports = TelegramCommands;