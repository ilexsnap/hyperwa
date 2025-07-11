const logger = require('./logger');
const config = require('../config');
const rateLimiter = require('./rate-limiter');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');
const { downloadContentFromMessage } = require('@whiskeysockets/baileys');

class MessageHandler {
    constructor(bot) {
        this.bot = bot;
        this.commandHandlers = new Map();
        // Register the rvo command directly
        this.registerCommandHandler('rvo', {
            name: 'rvo',
            description: 'Reveal viewonce messages by replying to them',
            usage: '.rvo (reply to viewonce message)',
            permissions: 'public',
            execute: this.rvoCommand.bind(this)
        });
    }

    // RVO Command - Reveal ViewOnce messages
    async rvoCommand(msg, params, context) {
        try {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (!quotedMsg) {
                return await this.bot.sendMessage(context.sender, {
                    text: '❌ *RVO - Reveal ViewOnce*\n\n🔍 Please reply to a viewonce message to reveal it.\n\n💡 *How to use:*\n1. Reply to any viewonce message\n2. Type `.rvo`\n3. Get the revealed content!'
                });
            }

            const isViewOnce = quotedMsg.viewOnceMessage || quotedMsg.viewOnceMessageV2;
            if (!isViewOnce) {
                return await this.bot.sendMessage(context.sender, {
                    text: '❌ *Invalid Message*\n\n🚫 The replied message is not a viewonce message.\n\n💡 ViewOnce messages are those that disappear after being viewed once.'
                });
            }

            const processingMsg = await this.bot.sendMessage(context.sender, {
                text: '🔍 *Revealing ViewOnce Message*\n\n⏳ Processing...\n🔄 Downloading content...'
            });

            const viewOnceContent = quotedMsg.viewOnceMessage?.message || quotedMsg.viewOnceMessageV2?.message;
            
            if (viewOnceContent.imageMessage) {
                await this.handleViewOnceImage(viewOnceContent.imageMessage, context, processingMsg);
            } else if (viewOnceContent.videoMessage) {
                await this.handleViewOnceVideo(viewOnceContent.videoMessage, context, processingMsg);
            } else if (viewOnceContent.audioMessage) {
                await this.handleViewOnceAudio(viewOnceContent.audioMessage, context, processingMsg);
            } else {
                await this.bot.sock.sendMessage(context.sender, {
                    text: '❌ *Unsupported Content*\n\n🚫 This viewonce message type is not supported.\n\n📱 Supported types: Images, Videos, Audio',
                    edit: processingMsg.key
                });
            }

        } catch (error) {
            logger.error('Error in RVO command:', error);
            await this.bot.sendMessage(context.sender, {
                text: `❌ *RVO Failed*\n\n🚫 Error: ${error.message}\n\n🔧 Please try again or contact support if the issue persists.`
            });
        }
    }

    // Handle ViewOnce Image
    async handleViewOnceImage(imageMessage, context, processingMsg) {
        try {
            const imageBuffer = await this.downloadMedia(imageMessage);
            if (!imageBuffer) {
                throw new Error('Failed to download image');
            }

            await this.bot.sock.sendMessage(context.sender, {
                image: imageBuffer,
                caption: '🔍 *ViewOnce Image Revealed*\n\n✅ Successfully revealed the hidden image!\n⏰ ' + new Date().toLocaleTimeString()
            });

            await this.bot.sock.sendMessage(context.sender, {
                delete: processingMsg.key
            });

        } catch (error) {
            logger.error('Error handling viewonce image:', error);
            await this.bot.sock.sendMessage(context.sender, {
                text: `❌ *Image Reveal Failed*\n\n🚫 Error: ${error.message}\n\n🔧 The image could not be downloaded or processed.`,
                edit: processingMsg.key
            });
        }
    }

    // Handle ViewOnce Video
    async handleViewOnceVideo(videoMessage, context, processingMsg) {
        try {
            const videoBuffer = await this.downloadMedia(videoMessage);
            if (!videoBuffer) {
                throw new Error('Failed to download video');
            }

            await this.bot.sock.sendMessage(context.sender, {
                video: videoBuffer,
                caption: '🔍 *ViewOnce Video Revealed*\n\n✅ Successfully revealed the hidden video!\n⏰ ' + new Date().toLocaleTimeString()
            });

            await this.bot.sock.sendMessage(context.sender, {
                delete: processingMsg.key
            });

        } catch (error) {
            logger.error('Error handling viewonce video:', error);
            await this.bot.sock.sendMessage(context.sender, {
                text: `❌ *Video Reveal Failed*\n\n🚫 Error: ${error.message}\n\n🔧 The video could not be downloaded or processed.`,
                edit: processingMsg.key
            });
        }
    }

    // Handle ViewOnce Audio
    async handleViewOnceAudio(audioMessage, context, processingMsg) {
        try {
            const audioBuffer = await this.downloadMedia(audioMessage);
            if (!audioBuffer) {
                throw new Error('Failed to download audio');
            }

            const processedAudio = await this.processAudio(audioBuffer);

            await this.bot.sock.sendMessage(context.sender, {
                audio: processedAudio,
                mimetype: 'audio/mpeg',
                caption: '🔍 *ViewOnce Audio Revealed*\n\n✅ Successfully revealed the hidden audio!\n⏰ ' + new Date().toLocaleTimeString()
            });

            await this.bot.sock.sendMessage(context.sender, {
                delete: processingMsg.key
            });

        } catch (error) {
            logger.error('Error handling viewonce audio:', error);
            await this.bot.sock.sendMessage(context.sender, {
                text: `❌ *Audio Reveal Failed*\n\n🚫 Error: ${error.message}\n\n🔧 The audio could not be downloaded or processed.`,
                edit: processingMsg.key
            });
        }
    }

    // Download media from WhatsApp
    async downloadMedia(mediaMessage) {
        try {
            let messageType;
            if (mediaMessage.imageMessage) messageType = 'image';
            else if (mediaMessage.videoMessage) messageType = 'video';
            else if (mediaMessage.audioMessage) messageType = 'audio';
            else if (mediaMessage.documentMessage) messageType = 'document';
            else throw new Error('Unknown media type');

            const stream = await downloadContentFromMessage(mediaMessage, messageType);
            
            const chunks = [];
            for await (const chunk of stream) {
                chunks.push(chunk);
            }
            
            return Buffer.concat(chunks);
        } catch (error) {
            logger.error('Error downloading media:', error);
            return null;
        }
    }

    // Process audio (convert if needed)
    async processAudio(audioBuffer) {
        return new Promise((resolve, reject) => {
            const inputPath = path.join(tmpdir(), `audio_${Date.now()}.ogg`);
            const outputPath = path.join(tmpdir(), `audio_${Date.now()}.mp3`);

            try {
                fs.writeFileSync(inputPath, audioBuffer);

                exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 128k "${outputPath}"`, (error, stdout, stderr) => {
                    try {
                        fs.unlinkSync(inputPath);
                    } catch (cleanupError) {
                        logger.warn('Failed to cleanup input file:', cleanupError);
                    }

                    if (error) {
                        logger.warn('FFmpeg not available or conversion failed, returning original audio');
                        resolve(audioBuffer);
                        return;
                    }

                    try {
                        const convertedBuffer = fs.readFileSync(outputPath);
                        fs.unlinkSync(outputPath);
                        resolve(convertedBuffer);
                    } catch (readError) {
                        logger.warn('Error reading converted audio, returning original');
                        resolve(audioBuffer);
                    }
                });
            } catch (writeError) {
                logger.warn('Error writing audio file, returning original');
                resolve(audioBuffer);
            }
        });
    }

    // Auto ViewOnce Handler
    async handleAutoViewOnce(msg) {
        try {
            if (!config.get('features.autoRevealViewOnce', false)) {
                return;
            }

            const viewOnceMsg = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2;
            if (!viewOnceMsg) return;

            const content = viewOnceMsg.message;
            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');

            if (isGroup && !config.get('features.autoRevealViewOnceInGroups', false)) {
                return;
            }

            logger.info(`🔍 Auto-revealing viewonce message from ${msg.key.participant || sender}`);

            if (content.imageMessage) {
                const imageBuffer = await this.downloadMedia(content.imageMessage);
                if (imageBuffer) {
                    await this.bot.sendMessage(sender, {
                        image: imageBuffer,
                        caption: '🔍 *ViewOnce Image Auto-Revealed*\n\n✅ Automatically revealed by bot\n⏰ ' + new Date().toLocaleTimeString()
                    });
                }
            } else if (content.videoMessage) {
                const videoBuffer = await this.downloadMedia(content.videoMessage);
                if (videoBuffer) {
                    await this.bot.sendMessage(sender, {
                        video: videoBuffer,
                        caption: '🔍 *ViewOnce Video Auto-Revealed*\n\n✅ Automatically revealed by bot\n⏰ ' + new Date().toLocaleTimeString()
                    });
                }
            } else if (content.audioMessage) {
                const audioBuffer = await this.downloadMedia(content.audioMessage);
                if (audioBuffer) {
                    const processedAudio = await this.processAudio(audioBuffer);
                    await this.bot.sendMessage(sender, {
                        audio: processedAudio,
                        mimetype: 'audio/mpeg',
                        caption: '🔍 *ViewOnce Audio Auto-Revealed*\n\n✅ Automatically revealed by bot\n⏰ ' + new Date().toLocaleTimeString()
                    });
                }
            }

        } catch (error) {
            logger.error('Error in auto viewonce handler:', error);
        }
    }

    async handleMessages({ messages, type }) {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                await this.processMessage(msg);
            } catch (error) {
                logger.error('Error processing message:', error);
            }
        }
    }

    async processMessage(msg) {
        // Handle status messages
        if (msg.key.remoteJid === 'status@broadcast') {
            return this.handleStatusMessage(msg);
        }

        // Handle ViewOnce messages (auto-reveal if enabled)
        if (msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2) {
            const viewOnceModule = this.bot.moduleLoader.getModule('viewonce-tools');
            if (viewOnceModule) {
                await viewOnceModule.handleAutoViewOnce(msg);
            }
        }

        // Extract text from message (including captions)
        const text = this.extractText(msg);
        
        // Check if it's a command (only for text messages, not media with captions)
        const prefix = config.get('bot.prefix');
        const isCommand = text && text.startsWith(prefix) && !this.hasMedia(msg);
        
        if (isCommand) {
            await this.handleCommand(msg, text);
        } else {
            // Handle non-command messages (including media)
            await this.handleNonCommandMessage(msg, text);
        }

        // FIXED: ALWAYS sync to Telegram if bridge is active (this was the main issue)
        if (this.bot.telegramBridge) {
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

    // New method to check if message has media
    hasMedia(msg) {
        return !!(
            msg.message?.imageMessage ||
            msg.message?.videoMessage ||
            msg.message?.audioMessage ||
            msg.message?.documentMessage ||
            msg.message?.stickerMessage ||
            msg.message?.locationMessage ||
            msg.message?.contactMessage
        );
    }

    async handleStatusMessage(msg) {
        if (config.get('features.autoViewStatus')) {
            try {
                await this.bot.sock.readMessages([msg.key]);
                await this.bot.sock.sendMessage(msg.key.remoteJid, {
                    react: { key: msg.key, text: '❤️' }
                });
                logger.debug(`❤️ Liked status from ${msg.key.participant}`);
            } catch (error) {
                logger.error('Error handling status:', error);
            }
        }
        
        // Also sync status messages to Telegram
        if (this.bot.telegramBridge) {
            const text = this.extractText(msg);
            await this.bot.telegramBridge.syncMessage(msg, text);
        }
    }

async handleCommand(msg, text) {
    const sender = msg.key.remoteJid;
    const participant = msg.key.participant || sender;
    const prefix = config.get('bot.prefix');

    const args = text.slice(prefix.length).trim().split(/\s+/);
    const command = args[0].toLowerCase();
    const params = args.slice(1);

if (!this.checkPermissions(msg, command)) {
    if (config.get('features.sendPermissionError', false)) {
        return this.bot.sendMessage(sender, {
            text: '❌ You don\'t have permission to use this command.'
        });
    }
    return; // silently ignore
}


    const userId = participant.split('@')[0];
    if (config.get('features.rateLimiting')) {
        const canExecute = await rateLimiter.checkCommandLimit(userId);
        if (!canExecute) {
            const remainingTime = await rateLimiter.getRemainingTime(userId);
            return this.bot.sendMessage(sender, {
                text: `⏱️ Rate limit exceeded. Try again in ${Math.ceil(remainingTime / 1000)} seconds.`
            });
        }
    }

    const handler = this.commandHandlers.get(command);
    const respondToUnknown = config.get('features.respondToUnknownCommands', false);

    if (handler) {
        try {
            await handler.execute(msg, params, {
                bot: this.bot,
                sender,
                participant,
                isGroup: sender.endsWith('@g.us')
            });

            logger.info(`✅ Command executed: ${command} by ${participant}`);

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('📝 Command Executed',
                    `Command: ${command}\nUser: ${participant}\nChat: ${sender}`);
            }

        } catch (error) {
            logger.error(`❌ Command failed: ${command}`, error);

            await this.bot.sendMessage(sender, {
                text: `❌ Command failed: ${error.message}`
            });

            if (this.bot.telegramBridge) {
                await this.bot.telegramBridge.logToTelegram('❌ Command Error',
                    `Command: ${command}\nError: ${error.message}\nUser: ${participant}`);
            }
        }

    } else if (respondToUnknown) {
        await this.bot.sendMessage(sender, {
            text: `❓ Unknown command: ${command}\nType *${prefix}menu* for available commands.`
        });
    }
}

    async handleNonCommandMessage(msg, text) {
        // Log media messages for debugging
        if (this.hasMedia(msg)) {
            const mediaType = this.getMediaType(msg);
            logger.debug(`📎 Media message received: ${mediaType} from ${msg.key.participant || msg.key.remoteJid}`);
        } else if (text) {
            logger.debug('💬 Text message received:', text.substring(0, 50));
        }
    }

    getMediaType(msg) {
        if (msg.message?.imageMessage) return 'image';
        if (msg.message?.videoMessage) return 'video';
        if (msg.message?.audioMessage) return 'audio';
        if (msg.message?.documentMessage) return 'document';
        if (msg.message?.stickerMessage) return 'sticker';
        if (msg.message?.locationMessage) return 'location';
        if (msg.message?.contactMessage) return 'contact';
        return 'unknown';
    }

checkPermissions(msg, commandName) {
    const participant = msg.key.participant || msg.key.remoteJid;
    const userId = participant.split('@')[0];
    const ownerId = config.get('bot.owner').split('@')[0]; // Convert full JID to userId
    const isOwner = userId === ownerId || msg.key.fromMe;

    const admins = config.get('bot.admins') || [];

    const mode = config.get('features.mode');
    if (mode === 'private' && !isOwner && !admins.includes(userId)) return false;

    const blockedUsers = config.get('security.blockedUsers') || [];
    if (blockedUsers.includes(userId)) return false;

    const handler = this.commandHandlers.get(commandName);
    if (!handler) return false;

    const permission = handler.permissions || 'public';

    switch (permission) {
        case 'owner':
            return isOwner;

        case 'admin':
            return isOwner || admins.includes(userId);

        case 'public':
            return true;

        default:
            if (Array.isArray(permission)) {
                return permission.includes(userId);
            }
            return false;
    }
}


    extractText(msg) {
        return msg.message?.conversation || 
               msg.message?.extendedTextMessage?.text || 
               msg.message?.imageMessage?.caption ||
               msg.message?.videoMessage?.caption || 
               msg.message?.documentMessage?.caption ||
               msg.message?.audioMessage?.caption ||
               '';
    }
}

module.exports = MessageHandler;
