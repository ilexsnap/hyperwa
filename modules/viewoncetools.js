const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { tmpdir } = require('os');
const axios = require('axios');
const FormData = require('form-data');
const logger = require('../logger');
const config = require('../../config');

class ViewOnceToolsModule {
    constructor(bot) {
        this.bot = bot;
        this.name = 'viewoncetools';
        this.metadata = {
            description: 'Tools for handling viewonce messages and image enhancement.',
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
                execute: this.rvoCommand.bind(this),
                ui: {
                    processingText: '🔍 Revealing viewonce message...',
                    errorText: '❌ Failed to reveal viewonce message.'
                }
            },
            {
                name: 'remini',
                description: 'Enhance image quality using AI.',
                usage: '.remini (reply to an image)',
                permissions: 'public',
                execute: this.reminiCommand.bind(this),
                ui: {
                    processingText: '🎨 Enhancing image quality... This may take a moment.',
                    errorText: '❌ Failed to enhance image.'
                }
            },
            {
                name: 'enhance',
                description: 'Enhance image quality using AI (alias for .remini).',
                usage: '.enhance (reply to an image)',
                permissions: 'public',
                execute: this.reminiCommand.bind(this),
                ui: {
                    processingText: '🎨 Enhancing image quality... This may take a moment.',
                    errorText: '❌ Failed to enhance image.'
                }
            }
        ];
        this.messageHooks = {
            'beforeCommand': this.handleAutoViewOnce.bind(this)
        };
    }

    async init() {
        logger.info('🔧 Initializing ViewOnce Tools Module...');
        logger.info('✅ ViewOnce Tools Module initialized');
    }

    async destroy() {
        logger.info('🗑️ Destroying ViewOnce Tools Module...');
        logger.info('✅ ViewOnce Tools Module destroyed');
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
        } else if (viewOnceContent.audioMessage) {
            await this.handleViewOnceAudio(viewOnceContent.audioMessage, context);
        } else {
            await context.bot.sendMessage(context.sender, {
                text: '❌ Unsupported viewonce message type.'
            });
        }
    }

    async reminiCommand(msg, params, context) {
        const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;

        if (!quotedMsg || !quotedMsg.imageMessage) {
            return context.bot.sendMessage(context.sender, {
                text: '❌ Please reply to an image to enhance it.'
            });
        }

        const imageBuffer = await this.downloadMedia(quotedMsg.imageMessage);
        if (!imageBuffer) {
            throw new Error('Failed to download image');
        }

        const enhancedImageUrl = await this.enhanceImage(imageBuffer);

        await context.bot.sendMessage(context.sender, {
            image: { url: enhancedImageUrl },
            caption: '✨ Image enhanced successfully!'
        });
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

    async handleViewOnceAudio(audioMessage, context) {
        const audioBuffer = await this.downloadMedia(audioMessage);
        if (!audioBuffer) {
            throw new Error('Failed to download audio');
        }

        const processedAudio = await this.processAudio(audioBuffer);

        await context.bot.sendMessage(context.sender, {
            audio: processedAudio,
            caption: '🔍 ViewOnce Audio Revealed'
        });
    }

    async downloadMedia(mediaMessage) {
        try {
            const stream = await this.bot.sock.downloadMediaMessage({
                message: { [this.getMessageType(mediaMessage)]: mediaMessage }
            });
            return stream;
        } catch (error) {
            logger.error('Error downloading media:', error);
            return null;
        }
    }

    getMessageType(message) {
        if (message.imageMessage) return 'imageMessage';
        if (message.videoMessage) return 'videoMessage';
        if (message.audioMessage) return 'audioMessage';
        if (message.documentMessage) return 'documentMessage';
        return 'unknown';
    }

    async processAudio(audioBuffer) {
        return new Promise((resolve, reject) => {
            const inputPath = path.join(tmpdir(), `audio_${Date.now()}.ogg`);
            const outputPath = path.join(tmpdir(), `audio_${Date.now()}.mp3`);

            fs.writeFileSync(inputPath, audioBuffer);

            exec(`ffmpeg -i ${inputPath} -vn -ar 44100 -ac 2 -b:a 128k ${outputPath}`, (error, stdout, stderr) => {
                fs.unlinkSync(inputPath);

                if (error) {
                    logger.error('FFmpeg error:', error);
                    resolve(audioBuffer);
                    return;
                }

                try {
                    const convertedBuffer = fs.readFileSync(outputPath);
                    fs.unlinkSync(outputPath);
                    resolve(convertedBuffer);
                } catch (readError) {
                    logger.error('Error reading converted audio:', readError);
                    resolve(audioBuffer);
                }
            });
        });
    }

    async enhanceImage(imageBuffer) {
        const uploadUrl = await this.uploadImage(imageBuffer);

        const apiKey = config.get('api.neoxrKey') || 'demo';
        const response = await axios.post('https://api.neoxr.my.id/api/remini', {
            image: uploadUrl
        }, {
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            }
        });

        if (!response.data.status) {
            throw new Error('Enhancement API failed');
        }

        return response.data.data.url;
    }

    async uploadImage(imageBuffer) {
        const formData = new FormData();
        formData.append('file', imageBuffer, {
            filename: 'image.jpg',
            contentType: 'image/jpeg'
        });

        const response = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
            headers: {
                ...formData.getHeaders()
            }
        });

        if (response.data && response.data.data && response.data.data.url) {
            return response.data.data.url;
        }

        throw new Error('Upload failed');
    }

    async handleAutoViewOnce(msg) {
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
