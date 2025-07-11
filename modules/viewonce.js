const fs = require('fs');
const path = require('path');
const config = require('../../config');

class ViewOnceToolsModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'viewonce';
        this.metadata = {
            description: 'Tools for handling viewonce messages (images and videos).',
            version: '1.0.0',
            author: 'Your Name',
            category: 'utility'
        };
        this.commands = [
            {
                name: 'rvo',
                description: 'Reveal viewonce messages by replying to them.',
                usage: '.rvo (reply to a viewonce message)',
                permissions: 'public',
                ui: {
                    processingText: '🔍 Revealing viewonce message...',
                    errorText: '❌ Failed to reveal viewonce message.'
                },
                execute: this.rvoCommand.bind(this)
            }
        ];
        this.messageHooks = {
            'beforeCommand': this.handleAutoViewOnce.bind(this)
        };
    }

    async init() {
        console.log('ViewOnce Tools Module initialized');
    }

    async destroy() {
        console.log('ViewOnce Tools Module destroyed');
    }

    async rvoCommand(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        if (!quotedMsg) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Please reply to a viewonce message to reveal it.'
            });
        }

        const isViewOnce = quotedMsg.viewOnceMessage || quotedMsg.viewOnceMessageV2;
        if (!isViewOnce) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ The replied message is not a viewonce message.'
            });
        }

        const viewOnceContent = quotedMsg.viewOnceMessage?.message || quotedMsg.viewOnceMessageV2?.message;

        if (viewOnceContent.imageMessage) {
            await this.handleViewOnceImage(viewOnceContent.imageMessage, context);
        } else if (viewOnceContent.videoMessage) {
            await this.handleViewOnceVideo(viewOnceContent.videoMessage, context);
        } else {
            await context.bot.sendMessage(context.sender, {
                text: '❌ Unsupported viewonce message type (only images and videos supported).'
            });
        }
    }

    async handleViewOnceImage(imageMessage, context) {
        const imageBuffer = await this.downloadMedia(imageMessage);
        if (!imageBuffer) {
            throw new Error('Failed to download image');
        }

        await context.bot.sendMessage(context.sender, {
            image: imageBuffer,
            caption: '🔍 ViewOnce Image Revealed'
        });
    }

    async handleViewOnceVideo(videoMessage, context) {
        const videoBuffer = await this.downloadMedia(videoMessage);
        if (!videoBuffer) {
            throw new Error('Failed to download video');
        }

        await context.bot.sendMessage(context.sender, {
            video: videoBuffer,
            caption: '🔍 ViewOnce Video Revealed'
        });
    }

    async downloadMedia(mediaMessage) {
        try {
            const stream = await this.bot.sock.downloadMediaMessage({
                message: { [this.getMessageType(mediaMessage)]: mediaMessage }
            });
            return stream;
        } catch (error) {
            console.error('Error downloading media:', error);
            return null;
        }
    }

    getMessageType(message) {
        if (message.imageMessage) return 'imageMessage';
        if (message.videoMessage) return 'videoMessage';
        return 'unknown';
    }

    async handleAutoViewOnce(msg) {
        let autoReveal;
        try {
            autoReveal = config.get('features.autoRevealViewOnce', false);
        } catch (error) {
            console.error('Error accessing config:', error);
            return;
        }

        if (!autoReveal) {
            return;
        }

        const viewOnceMsg = msg.message?.viewOnceMessage || msg.message?.viewOnceMessageV2;
        if (!viewOnceMsg) return;

        const content = viewOnceMsg.message;
        const sender = msg.key.remoteJid;
        const isGroup = sender.endsWith('@g.us');

        let autoRevealInGroups;
        try {
            autoRevealInGroups = config.get('features.autoRevealViewOnceInGroups', false);
        } catch (error) {
            console.error('Error accessing config:', error);
            return;
        }

        if (isGroup && !autoRevealInGroups) {
            return;
        }

        console.log(`Auto-revealing viewonce message from ${msg.key.participant || sender}`);

        if (content.imageMessage) {
            const imageBuffer = await this.downloadMedia(content.imageMessage);
            if (imageBuffer) {
                await this.bot.sendMessage(sender, {
                    image: imageBuffer,
                    caption: '🔍 ViewOnce Image Auto-Revealed'
                });
            }
        } else if (content.videoMessage) {
            const videoBuffer = await this.downloadMedia(content.videoMessage);
            if (videoBuffer) {
                await this.bot.sendMessage(sender, {
                    video: videoBuffer,
                    caption: '🔍 ViewOnce Video Auto-Revealed'
                });
            }
        }
    }
}

module.exports = ViewOnceToolsModule;
