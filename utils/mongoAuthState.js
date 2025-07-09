const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const fs = require("fs-extra");
const path = require("path");
const tar = require("tar");
const { connectDb } = require("./db");
const logger = require("../Core/logger");

const AUTH_DIR = "./auth_info";
const AUTH_TAR = "auth_info.tar";

async function useMongoAuthState() {
    try {
        const db = await connectDb();
        const coll = db.collection("auth");

        // Clean up any previous data
        await fs.remove(AUTH_DIR).catch(() => {});
        await fs.remove(AUTH_TAR).catch(() => {});

        // Try to restore session from MongoDB
        try {
            const session = await coll.findOne({ _id: "session" });
            
            if (session?.archive) {
                await fs.writeFile(AUTH_TAR, session.archive.buffer);
                await tar.x({ file: AUTH_TAR, C: "." });
                
                const credsPath = path.join(AUTH_DIR, "creds.json");
                if (await fs.pathExists(credsPath)) {
                    logger.info("✅ Session restored from MongoDB");
                    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
                    
                    const enhancedSaveCreds = async () => {
                        await saveCreds();
                        try {
                            await tar.c({ file: AUTH_TAR, cwd: ".", portable: true }, ["auth_info"]);
                            const data = await fs.readFile(AUTH_TAR);
                            await coll.updateOne(
                                { _id: "session" },
                                { $set: { archive: data, updatedAt: new Date() } },
                                { upsert: true }
                            );
                        } catch (err) {
                            logger.error("❌ Failed to backup auth state:", err);
                        } finally {
                            await fs.remove(AUTH_TAR).catch(() => {});
                        }
                    };
                    
                    return { state, saveCreds: enhancedSaveCreds };
                }
            }
        } catch (err) {
            logger.error("❌ Session restore failed:", err);
            await coll.deleteOne({ _id: "session" }).catch(() => {});
        }

        // Fallback to fresh auth state
        logger.info("ℹ️ Creating new auth state");
        const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
        
        const enhancedSaveCreds = async () => {
            await saveCreds();
            try {
                await tar.c({ file: AUTH_TAR, cwd: ".", portable: true }, ["auth_info"]);
                const data = await fs.readFile(AUTH_TAR);
                await coll.updateOne(
                    { _id: "session" },
                    { $set: { archive: data, createdAt: new Date() } },
                    { upsert: true }
                );
            } catch (err) {
                logger.error("❌ Failed to backup auth state:", err);
            } finally {
                await fs.remove(AUTH_TAR).catch(() => {});
            }
        };
        
        return { state, saveCreds: enhancedSaveCreds };
        
    } catch (error) {
        logger.error("❌ MongoDB auth state initialization failed:", error);
        throw error;
    }
}

module.exports = { useMongoAuthState };
