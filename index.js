// HiddenDM for Kettu - Create fake messages from any user
// Based on the original Enmity HiddenDM plugin

// Storage for fake messages with global index
const storage = {
    messages: {},
    messageIndex: [], // Global index: [{channelId, messageId, index}]
    
    addMessage(channelId, message) {
        if (!this.messages[channelId]) {
            this.messages[channelId] = [];
        }
        this.messages[channelId].push(message);
        
        // Add to global index
        const globalIndex = this.messageIndex.length;
        this.messageIndex.push({
            channelId: channelId,
            messageId: message.id,
            index: globalIndex
        });
        
        this.save();
        return globalIndex;
    },
    
    getMessages(channelId) {
        return this.messages[channelId] || [];
    },
    
    getAllMessages() {
        const all = [];
        Object.keys(this.messages).forEach(channelId => {
            this.messages[channelId].forEach(msg => {
                const indexEntry = this.messageIndex.find(e => e.messageId === msg.id);
                all.push({
                    ...msg,
                    channelId: channelId,
                    globalIndex: indexEntry ? indexEntry.index : -1
                });
            });
        });
        return all;
    },
    
    deleteByIndex(globalIndex) {
        const indexEntry = this.messageIndex[globalIndex];
        if (!indexEntry) return false;
        
        const { channelId, messageId } = indexEntry;
        const channelMessages = this.messages[channelId];
        
        if (channelMessages) {
            const msgIndex = channelMessages.findIndex(m => m.id === messageId);
            if (msgIndex !== -1) {
                channelMessages.splice(msgIndex, 1);
                if (channelMessages.length === 0) {
                    delete this.messages[channelId];
                }
                this.save();
                return true;
            }
        }
        return false;
    },
    
    save() {
        try {
            const data = JSON.stringify({
                messages: this.messages,
                messageIndex: this.messageIndex
            });
            window.vendetta.storage.set("HiddenDM_messages", data);
        } catch (e) {
            console.error("[HiddenDM] Save failed:", e);
        }
    },
    
    load() {
        try {
            const data = window.vendetta.storage.get("HiddenDM_messages");
            if (data) {
                const parsed = JSON.parse(data);
                this.messages = parsed.messages || {};
                this.messageIndex = parsed.messageIndex || [];
            }
        } catch (e) {
            console.error("[HiddenDM] Load failed:", e);
            this.messages = {};
            this.messageIndex = [];
        }
    }
};

// Generate Discord snowflake ID
function generateSnowflake() {
    return ((Date.now() - 1420070400000) * 4194304).toString();
}

// Inject message into Discord
function injectMessage(channelId, message, Dispatcher) {
    try {
        if (!Dispatcher || typeof Dispatcher.dispatch !== "function") {
            console.error("[HiddenDM] Dispatcher not available");
            return false;
        }

        Dispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: channelId,
            message: message,
            optimistic: false,
            suppressNotifications: true
        });

        return true;
    } catch (e) {
        console.error("[HiddenDM] Inject failed:", e);
        return false;
    }
}

// Main plugin export
let patches = [];
let Dispatcher, MessageStore, UserStore, MessageActions;

export default {
    onLoad() {
        try {
            console.log("[HiddenDM] Loading...");
            
            // Load saved messages
            storage.load();
            
            // Find Discord modules
            const { findByProps } = window.vendetta.metro;
            
            Dispatcher = findByProps("dispatch", "_subscriptions");
            MessageStore = findByProps("getMessage", "getMessages");
            UserStore = findByProps("getUser", "getUsers");
            MessageActions = findByProps("sendMessage", "receiveMessage");
            
            if (!Dispatcher) {
                console.error("[HiddenDM] Dispatcher not found");
                return;
            }
            
            if (!MessageStore) {
                console.error("[HiddenDM] MessageStore not found");
                return;
            }
            
            if (!UserStore) {
                console.error("[HiddenDM] UserStore not found");
                return;
            }
            
            // Patch getMessage to return fake messages
            const { after } = window.vendetta.patcher;
            
            patches.push(after("getMessage", MessageStore, (args, result) => {
                try {
                    const [channelId, messageId] = args;
                    
                    // If real message exists, return it
                    if (result) return result;
                    
                    // Check for fake message
                    const fakeMessages = storage.getMessages(channelId);
                    const fakeMsg = fakeMessages.find(m => m.id === messageId);
                    
                    if (fakeMsg) {
                        console.log("[HiddenDM] Returning fake message:", messageId);
                        return fakeMsg;
                    }
                } catch (e) {
                    console.error("[HiddenDM] getMessage patch error:", e);
                }
                
                return result;
            }));
            
            // Patch getMessages to include fake messages
            patches.push(after("getMessages", MessageStore, (args, result) => {
                try {
                    const [channelId] = args;
                    
                    if (!result || !channelId) return result;
                    
                    const fakeMessages = storage.getMessages(channelId);
                    
                    if (fakeMessages.length > 0) {
                        // Merge real and fake messages
                        const allMessages = [...result, ...fakeMessages];
                        
                        // Sort by timestamp
                        allMessages.sort((a, b) => {
                            const timeA = new Date(a.timestamp).getTime();
                            const timeB = new Date(b.timestamp).getTime();
                            return timeA - timeB;
                        });
                        
                        console.log(`[HiddenDM] Merged ${fakeMessages.length} fake messages into channel ${channelId}`);
                        return allMessages;
                    }
                } catch (e) {
                    console.error("[HiddenDM] getMessages patch error:", e);
                }
                
                return result;
            }));
            
            // Subscribe to channel switches to reinject messages
            if (Dispatcher && typeof Dispatcher.subscribe === "function") {
                Dispatcher.subscribe("CHANNEL_SELECT", (event) => {
                    try {
                        if (event.channelId) {
                            const fakeMessages = storage.getMessages(event.channelId);
                            if (fakeMessages.length > 0) {
                                console.log(`[HiddenDM] Reinjecting ${fakeMessages.length} messages for channel ${event.channelId}`);
                                fakeMessages.forEach(msg => {
                                    injectMessage(event.channelId, msg, Dispatcher);
                                });
                            }
                        }
                    } catch (e) {
                        console.error("[HiddenDM] CHANNEL_SELECT error:", e);
                    }
                });
            }
            
            console.log("[HiddenDM] Loaded successfully!");
            
            // Register commands
            this.registerCommands();
            
            // Expose API for creating fake messages
            window.HiddenDM = {
                createFakeMessage(channelId, userId, content, customTimestamp) {
                    try {
                        const user = UserStore.getUser(userId);
                        if (!user) {
                            console.error("[HiddenDM] User not found:", userId);
                            return null;
                        }
                        
                        // Use custom timestamp if provided (in snowflake format)
                        let messageId, timestamp;
                        if (customTimestamp) {
                            messageId = customTimestamp;
                            // Convert snowflake to ISO timestamp
                            const ms = parseInt(customTimestamp) / 4194304 + 1420070400000;
                            timestamp = new Date(ms).toISOString();
                        } else {
                            messageId = generateSnowflake();
                            timestamp = new Date().toISOString();
                        }
                        
                        // Parse content if it's JSON
                        let messageContent = content;
                        let embeds = [];
                        let attachments = [];
                        
                        try {
                            const parsed = JSON.parse(content);
                            if (parsed.content) messageContent = parsed.content;
                            if (parsed.embeds) embeds = parsed.embeds;
                            if (parsed.attachments) attachments = parsed.attachments;
                        } catch (e) {
                            // Not JSON, check if content contains URLs for link preview
                            const urlRegex = /(https?:\/\/[^\s]+)/g;
                            const urls = content.match(urlRegex);
                            
                            if (urls && urls.length > 0) {
                                // Create embed for first URL (Discord link preview style)
                                const firstUrl = urls[0];
                                
                                // Check if it's an image URL
                                const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
                                const isImage = imageExtensions.some(ext => firstUrl.toLowerCase().includes(ext));
                                
                                if (isImage) {
                                    embeds.push({
                                        type: "image",
                                        url: firstUrl,
                                        image: {
                                            url: firstUrl,
                                            proxy_url: firstUrl,
                                            width: 0,
                                            height: 0
                                        }
                                    });
                                } else {
                                    // Create a rich embed for non-image URLs
                                    embeds.push({
                                        type: "link",
                                        url: firstUrl,
                                        title: firstUrl,
                                        description: "Link preview"
                                    });
                                }
                            }
                        }
                        
                        const fakeMessage = {
                            id: messageId,
                            type: 0,
                            content: messageContent,
                            channel_id: channelId,
                            author: {
                                id: user.id,
                                username: user.username,
                                discriminator: user.discriminator || "0000",
                                avatar: user.avatar || "",
                                bot: user.bot || false,
                                global_name: user.globalName || user.username
                            },
                            timestamp: timestamp,
                            edited_timestamp: null,
                            tts: false,
                            mention_everyone: false,
                            mentions: [],
                            mention_roles: [],
                            attachments: attachments,
                            embeds: embeds,
                            reactions: [],
                            pinned: false,
                            state: "SENT",
                            flags: 0
                        };
                        
                        const globalIndex = storage.addMessage(channelId, fakeMessage);
                        injectMessage(channelId, fakeMessage, Dispatcher);
                        
                        console.log("[HiddenDM] Created fake message:", messageId, "at index:", globalIndex);
                        return { message: fakeMessage, index: globalIndex };
                    } catch (e) {
                        console.error("[HiddenDM] createFakeMessage error:", e);
                        return null;
                    }
                },
                
                listFakes() {
                    const all = storage.getAllMessages();
                    console.log(`[HiddenDM] Total fake messages: ${all.length}`);
                    all.forEach(msg => {
                        console.log(`[${msg.globalIndex}] Channel: ${msg.channelId}, ID: ${msg.id}, From: ${msg.author.username}, Content: ${msg.content.substring(0, 50)}...`);
                    });
                    return all;
                },
                
                deleteFake(index) {
                    const success = storage.deleteByIndex(index);
                    if (success) {
                        console.log(`[HiddenDM] Deleted fake message at index ${index}`);
                    } else {
                        console.error(`[HiddenDM] Failed to delete message at index ${index}`);
                    }
                    return success;
                },
                
                clearAll() {
                    storage.messages = {};
                    storage.messageIndex = [];
                    storage.save();
                    console.log("[HiddenDM] Cleared all fake messages");
                }
            };
            
        } catch (e) {
            console.error("[HiddenDM] Fatal load error:", e);
        }
    },
    
    registerCommands() {
        try {
            const { commands } = window.vendetta;
            
            if (!commands || !commands.registerCommand) {
                console.warn("[HiddenDM] Commands API not available");
                return;
            }
            
            // Command: createfake
            commands.registerCommand({
                name: "createfake",
                description: "Create a fake message",
                options: [
                    {
                        name: "channel",
                        description: "Channel ID",
                        type: 3, // STRING
                        required: true
                    },
                    {
                        name: "user",
                        description: "User ID",
                        type: 3, // STRING
                        required: true
                    },
                    {
                        name: "timestamp",
                        description: "Timestamp (snowflake format, optional)",
                        type: 3, // STRING
                        required: false
                    },
                    {
                        name: "content",
                        description: "Message content (text or JSON). URLs with images will show previews!",
                        type: 3, // STRING
                        required: true
                    }
                ],
                execute: (args, ctx) => {
                    try {
                        const channelId = args.find(a => a.name === "channel")?.value;
                        const userId = args.find(a => a.name === "user")?.value;
                        const timestamp = args.find(a => a.name === "timestamp")?.value;
                        const content = args.find(a => a.name === "content")?.value;
                        
                        if (!channelId || !userId || !content) {
                            return { content: "❌ Missing required parameters" };
                        }
                        
                        const result = window.HiddenDM.createFakeMessage(channelId, userId, content, timestamp);
                        
                        if (result) {
                            return { content: `✅ Created fake message at index ${result.index}` };
                        } else {
                            return { content: "❌ Failed to create fake message" };
                        }
                    } catch (e) {
                        console.error("[HiddenDM] createfake command error:", e);
                        return { content: "❌ Error: " + e.message };
                    }
                }
            });
            
            // Command: listfakes
            commands.registerCommand({
                name: "listfakes",
                description: "List all fake messages",
                options: [],
                execute: (args, ctx) => {
                    try {
                        const all = window.HiddenDM.listFakes();
                        
                        if (all.length === 0) {
                            return { content: "No fake messages found" };
                        }
                        
                        let response = `**Fake Messages (${all.length} total):**\n`;
                        all.forEach(msg => {
                            response += `\`[${msg.globalIndex}]\` Channel: \`${msg.channelId}\`, From: **${msg.author.username}**, Content: ${msg.content.substring(0, 30)}...\n`;
                        });
                        
                        return { content: response };
                    } catch (e) {
                        console.error("[HiddenDM] listfakes command error:", e);
                        return { content: "❌ Error: " + e.message };
                    }
                }
            });
            
            // Command: delfakes
            commands.registerCommand({
                name: "delfakes",
                description: "Delete a fake message by index",
                options: [
                    {
                        name: "index",
                        description: "Message index (from listfakes)",
                        type: 4, // INTEGER
                        required: true
                    }
                ],
                execute: (args, ctx) => {
                    try {
                        const index = args.find(a => a.name === "index")?.value;
                        
                        if (index === undefined) {
                            return { content: "❌ Missing index parameter" };
                        }
                        
                        const success = window.HiddenDM.deleteFake(index);
                        
                        if (success) {
                            return { content: `✅ Deleted fake message at index ${index}` };
                        } else {
                            return { content: `❌ Failed to delete message at index ${index}` };
                        }
                    } catch (e) {
                        console.error("[HiddenDM] delfakes command error:", e);
                        return { content: "❌ Error: " + e.message };
                    }
                }
            });
            
            console.log("[HiddenDM] Commands registered");
        } catch (e) {
            console.error("[HiddenDM] Command registration error:", e);
        }
    },
    
    onUnload() {
        try {
            // Unpatch everything
            patches.forEach(unpatch => unpatch());
            patches = [];
            
            // Remove API
            delete window.HiddenDM;
            
            console.log("[HiddenDM] Unloaded");
        } catch (e) {
            console.error("[HiddenDM] Unload error:", e);
        }
    }
};
