const config = require('../config');
const { MongoClient } = require('mongodb');
const logger = require('../Core/logger');

const MONGO_URI = config.get('mongo.uri');
const DB_NAME = config.get('mongo.dbName');
const OPTIONS = {
    connectTimeoutMS: 10000,
    socketTimeoutMS: 30000,
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 10,
    retryWrites: true,
    ...config.get('mongo.options')
};

let client;
let isConnected = false;

async function connectDb() {
    if (!client) {
        client = new MongoClient(MONGO_URI, OPTIONS);
    }

    try {
        if (!isConnected) {
            await client.connect();
            isConnected = true;
            await client.db(DB_NAME).command({ ping: 1 });
            logger.info('✅ MongoDB connection established');
        }
        return client.db(DB_NAME);
    } catch (error) {
        isConnected = false;
        logger.error('❌ MongoDB connection failed:', error.message);
        throw error;
    }
}

async function closeConnection() {
    if (client && isConnected) {
        await client.close();
        isConnected = false;
    }
}

process.on('SIGINT', async () => {
    await closeConnection();
    process.exit(0);
});

module.exports = { connectDb, closeConnection };
