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
        this.name = 'viewonce';
    }

    async initialize() {
        logger.info('🔧 Initializing ViewOnce Tools Module...');
        
        // Register RVO command
        this.bot.messageHandler.registerCommandHandler('rvo', {
            execute: this.rvoCommand.bind(this),
            permissions: 'public',
            description: 'Reveal viewonce messages by replying to them'
        });

        // Register Remini command  
        this.bot.messageHandler.registerCommandHandler('remini', {
            execute: this.reminiCommand.bind(this),
            permissions: 'public',
            description: 'Enhance image quality using AI'
        });

        // Register enhance command (alias for remini)
        this.bot.messageHandler.registerCommandHandler('enhance', {
            execute: this.reminiCommand.bind(this),
            permissions: 'public',
            description: 'Enhance image quality using AI'
        });

        logger.info('✅ ViewOnce Tools Module initialized');
    }

    // RVO Command - Reveal ViewOnce messages
    async rvoCommand(msg, params, context) {
        try {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (!quotedMsg) {
                return this.bot.sendMessage(context.sender, {
                    text: '❌ Please reply to a viewonce message to reveal it.'
                });
            }

            // Check if quoted message is viewonce
            const isViewOnce = quotedMsg.viewOnceMessage || quotedMsg.viewOnceMessageV2;
            if (!isViewOnce) {
                return this.bot.sendMessage(context.sender, {
                    text: '❌ The replied message is not a viewonce message.'
                });
            }

            await this.bot.sendMessage(context.sender, {
                text: '🔍 Revealing viewonce message...'
            });

            // Extract the actual message from viewonce
            const viewOnceContent = quotedMsg.viewOnceMessage?.message || quotedMsg.viewOnceMessageV2?.message;
            
            if (viewOnceContent.imageMessage) {
                await this.handleViewOnceImage(viewOnceContent.imageMessage, context);
            } else if (viewOnceContent.videoMessage) {
                await this.handleViewOnceVideo(viewOnceContent.videoMessage, context);
            } else if (viewOnceContent.audioMessage) {
                await this.handleViewOnceAudio(viewOnceContent.audioMessage, context);
            } else {
                await this.bot.sendMessage(context.sender, {
                    text: '❌ Unsupported viewonce message type.'
                });
            }

        } catch (error) {
            logger.error('Error in RVO command:', error);
            await this.bot.sendMessage(context.sender, {
                text: '❌ Failed to reveal viewonce message: ' + error.message
            });
        }
    }

    // Remini Command - AI Image Enhancement
    async reminiCommand(msg, params, context) {
        try {
            const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
            
            if (!quotedMsg || !quotedMsg.imageMessage) {
                return this.bot.sendMessage(context.sender, {
                    text: '❌ Please reply to an image to enhance it.'
                });
            }

            await this.bot.sendMessage(context.sender, {
                text: '🎨 Enhancing image quality... This may take a moment.'
            });

            // Download the image
            const imageBuffer = await this.downloadMedia(quotedMsg.imageMessage);
            if (!imageBuffer) {
                throw new Error('Failed to download image');
            }

            // Upload and enhance image
            const enhancedImageUrl = await this.enhanceImage(imageBuffer);
            
            // Send enhanced image
            await this.bot.sendMessage(context.sender, {
                image: { url: enhancedImageUrl },
                caption: '✨ Image enhanced successfully!'
            });

        } catch (error) {
            logger.error('Error in Remini command:', error);
            await this.bot.sendMessage(context.sender, {
                text: '❌ Failed to enhance image: ' + error.message
            });
        }
    }

    // Handle ViewOnce Image
    async handleViewOnceImage(imageMessage, context) {
        try {
            const imageBuffer = await this.downloadMedia(imageMessage);
            if (!imageBuffer) {
                throw new Error('Failed to download image');
            }

            await this.bot.sendMessage(context.sender, {
                image: imageBuffer,
                caption: '🔍 ViewOnce Image Revealed'
            });

        } catch (error) {
            logger.error('Error handling viewonce image:', error);
            throw error;
        }
    }

    // Handle ViewOnce Video
    async handleViewOnceVideo(videoMessage, context) {
        try {
            const videoBuffer = await this.downloadMedia(videoMessage);
            if (!videoBuffer) {
                throw new Error('Failed to download video');
            }

            await this.bot.sendMessage(context.sender, {
                video: videoBuffer,
                caption: '🔍 ViewOnce Video Revealed'
            });

        } catch (error) {
            logger.error('Error handling viewonce video:', error);
            throw error;
        }
    }

    // Handle ViewOnce Audio
    async handleViewOnceAudio(audioMessage, context) {
        try {
            const audioBuffer = await this.downloadMedia(audioMessage);
            if (!audioBuffer) {
                throw new Error('Failed to download audio');
            }

            // Convert audio if needed
            const processedAudio = await this.processAudio(audioBuffer);

            await this.bot.sendMessage(context.sender, {
                audio: processedAudio,
                caption: '🔍 ViewOnce Audio Revealed'
            });

        } catch (error) {
            logger.error('Error handling viewonce audio:', error);
            throw error;
        }
    }

    // Download media from WhatsApp
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

    // Get message type
    getMessageType(message) {
        if (message.imageMessage) return 'imageMessage';
        if (message.videoMessage) return 'videoMessage';
        if (message.audioMessage) return 'audioMessage';
        if (message.documentMessage) return 'documentMessage';
        return 'unknown';
    }

    // Process audio (convert if needed)
    async processAudio(audioBuffer) {
        return new Promise((resolve, reject) => {
            const inputPath = path.join(tmpdir(), `audio_${Date.now()}.ogg`);
            const outputPath = path.join(tmpdir(), `audio_${Date.now()}.mp3`);

            // Write buffer to temp file
            fs.writeFileSync(inputPath, audioBuffer);

            // Convert using ffmpeg
            exec(`ffmpeg -i ${inputPath} -vn -ar 44100 -ac 2 -b:a 128k ${outputPath}`, (error, stdout, stderr) => {
                // Clean up input file
                fs.unlinkSync(inputPath);

                if (error) {
                    logger.error('FFmpeg error:', error);
                    resolve(audioBuffer); // Return original if conversion fails
                    return;
                }

                try {
                    const convertedBuffer = fs.readFileSync(outputPath);
                    fs.unlinkSync(outputPath); // Clean up output file
                    resolve(convertedBuffer);
                } catch (readError) {
                    logger.error('Error reading converted audio:', readError);
                    resolve(audioBuffer); // Return original if read fails
                }
            });
        });
    }

    // Upload image to external service and enhance
    async enhanceImage(imageBuffer) {
        try {
            // First upload the image
            const uploadUrl = await this.uploadImage(imageBuffer);
            
            // Then enhance it using API
            const apiKey = config.get('api.neoxrKey') || 'demo'; // Add to config
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

        } catch (error) {
            logger.error('Error enhancing image:', error);
            throw new Error('Image enhancement service unavailable');
        }
    }

    // Upload image to temporary hosting
    async uploadImage(imageBuffer) {
        try {
            const formData = new FormData();
            formData.append('file', imageBuffer, {
                filename: 'image.jpg',
                contentType: 'image/jpeg'
            });

            // Using a free image hosting service (you can replace with your preferred service)
            const response = await axios.post('https://tmpfiles.org/api/v1/upload', formData, {
                headers: {
                    ...formData.getHeaders()
                }
            });

            if (response.data && response.data.data && response.data.data.url) {
                return response.data.data.url;
            }

            throw new Error('Upload failed');

        } catch (error) {
            logger.error('Error uploading image:', error);
            throw new Error('Image upload failed');
        }
    }

    // Auto ViewOnce Handler (called from message handler)
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

        } catch (error) {
            logger.error('Error in auto viewonce handler:', error);
        }
    }
}

module.exports = ViewOnceToolsModule;
