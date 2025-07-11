const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');
const logger = require('../Core/logger');
const config = require('../config');

class ViewOnceToolsModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'viewonce-tools';
        
        // Module metadata required by the loader
        this.metadata = {
            description: 'Tools for revealing viewonce messages',
            version: '1.0.0',
            author: 'Bot Developer',
            category: 'Media Tools',
            dependencies: []
        };

        // Commands array required by the loader
        this.commands = [
            {
                name: 'rvo',
                description: 'Reveal viewonce messages by replying to them',
                usage: '.rvo (reply to viewonce message)',
                permissions: 'public',
                execute: this.rvoCommand.bind(this)
            }
        ];

        // Message hooks for auto-reveal feature
        this.messageHooks = {
            'message.any': this.handleAutoViewOnce.bind(this)
        };
    }

    // Initialize method called by the loader
    async init() {
        logger.info('🔧 Initializing ViewOnce Tools Module...');
        logger.info('✅ ViewOnce Tools Module initialized');
    }

    // RVO Command - Reveal ViewOnce messages
    async rvoCommand(msg, params, context) {
        try {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (!quotedMsg) {
                return await context.bot.sendMessage(context.sender, {
                    text: '❌ *RVO - Reveal ViewOnce*\n\n🔍 Please reply to a viewonce message to reveal it.\n\n💡 *How to use:*\n1. Reply to any viewonce message\n2. Type `.rvo`\n3. Get the revealed content!'
                });
            }

            // Check if quoted message is viewonce
            const isViewOnce = quotedMsg.viewOnceMessage || quotedMsg.viewOnceMessageV2;
            if (!isViewOnce) {
                return await context.bot.sendMessage(context.sender, {
                    text: '❌ *Invalid Message*\n\n🚫 The replied message is not a viewonce message.\n\n💡 ViewOnce messages are those that disappear after being viewed once.'
                });
            }

            const processingMsg = await context.bot.sendMessage(context.sender, {
                text: '🔍 *Revealing ViewOnce Message*\n\n⏳ Processing...\n🔄 Downloading content...'
            });

            // Extract the actual message from viewonce
            const viewOnceContent = quotedMsg.viewOnceMessage?.message || quotedMsg.viewOnceMessageV2?.message;
            
            if (viewOnceContent.imageMessage) {
                await this.handleViewOnceImage(viewOnceContent.imageMessage, context, processingMsg);
            } else if (viewOnceContent.videoMessage) {
                await this.handleViewOnceVideo(viewOnceContent.videoMessage, context, processingMsg);
            } else if (viewOnceContent.audioMessage) {
                await this.handleViewOnceAudio(viewOnceContent.audioMessage, context, processingMsg);
            } else {
                await context.bot.sock.sendMessage(context.sender, {
                    text: '❌ *Unsupported Content*\n\n🚫 This viewonce message type is not supported.\n\n📱 Supported types: Images, Videos, Audio',
                    edit: processingMsg.key
                });
            }

        } catch (error) {
            logger.error('Error in RVO command:', error);
            await context.bot.sendMessage(context.sender, {
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

            await context.bot.sock.sendMessage(context.sender, {
                image: imageBuffer,
                caption: '🔍 *ViewOnce Image Revealed*\n\n✅ Successfully revealed the hidden image!\n⏰ ' + new Date().toLocaleTimeString()
            });

            // Delete processing message
            await context.bot.sock.sendMessage(context.sender, {
                delete: processingMsg.key
            });

        } catch (error) {
            logger.error('Error handling viewonce image:', error);
            await context.bot.sock.sendMessage(context.sender, {
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

            await context.bot.sock.sendMessage(context.sender, {
                video: videoBuffer,
                caption: '🔍 *ViewOnce Video Revealed*\n\n✅ Successfully revealed the hidden video!\n⏰ ' + new Date().toLocaleTimeString()
            });

            // Delete processing message
            await context.bot.sock.sendMessage(context.sender, {
                delete: processingMsg.key
            });

        } catch (error) {
            logger.error('Error handling viewonce video:', error);
            await context.bot.sock.sendMessage(context.sender, {
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

            // Convert audio if needed
            const processedAudio = await this.processAudio(audioBuffer);

            await context.bot.sock.sendMessage(context.sender, {
                audio: processedAudio,
                mimetype: 'audio/mpeg',
                caption: '🔍 *ViewOnce Audio Revealed*\n\n✅ Successfully revealed the hidden audio!\n⏰ ' + new Date().toLocaleTimeString()
            });

            // Delete processing message
            await context.bot.sock.sendMessage(context.sender, {
                delete: processingMsg.key
            });

        } catch (error) {
            logger.error('Error handling viewonce audio:', error);
            await context.bot.sock.sendMessage(context.sender, {
                text: `❌ *Audio Reveal Failed*\n\n🚫 Error: ${error.message}\n\n🔧 The audio could not be downloaded or processed.`,
                edit: processingMsg.key
            });
        }
    }

    // Download media from WhatsApp
    async downloadMedia(mediaMessage) {
        try {
            const { downloadContentFromMessage } = require('@whiskeysockets/baileys');
            
            // Determine message type
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
                // Write buffer to temp file
                fs.writeFileSync(inputPath, audioBuffer);

                // Convert using ffmpeg if available
                exec(`ffmpeg -i "${inputPath}" -vn -ar 44100 -ac 2 -b:a 128k "${outputPath}"`, (error, stdout, stderr) => {
                    // Clean up input file
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

    // Auto ViewOnce Handler (called from message hooks)
    async handleAutoViewOnce(msg) {
        try {
            // Check if auto-reveal is enabled
            if (!config.get('features.autoRevealViewOnce', false)) {
                return;
            }

            const viewOnceMsg = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2;
            if (!viewOnceMsg) return;

            const content = viewOnceMsg.message;
            const sender = msg.key.remoteJid;
            const isGroup = sender.endsWith('@g.us');

            // Only auto-reveal in groups if enabled
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

    // Destroy method called when module is unloaded
    async destroy() {
        logger.info('🚫 ViewOnce Tools Module destroyed');
    }
}

module.exports = ViewOnceToolsModule;
