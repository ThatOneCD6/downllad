const storage = {
    messages: {},
    messageIndex: [],
    
    addMessage(channelId, message) {
        if (!this.messages[channelId]) this.messages[channelId] = [];
        this.messages[channelId].push(message);
        const globalIndex = this.messageIndex.length;
        this.messageIndex.push({ channelId, messageId: message.id, index: globalIndex });
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
                all.push({ ...msg, channelId, globalIndex: indexEntry ? indexEntry.index : -1 });
            });
        });
        return all;
    },
    
    deleteByIndex(globalIndex) {
        const indexEntry = this.messageIndex[globalIndex];
        if (!indexEntry) return false;
        const channelMessages = this.messages[indexEntry.channelId];
        if (channelMessages) {
            const msgIndex = channelMessages.findIndex(m => m.id === indexEntry.messageId);
            if (msgIndex !== -1) {
                channelMessages.splice(msgIndex, 1);
                if (channelMessages.length === 0) delete this.messages[indexEntry.channelId];
                this.save();
                return true;
            }
        }
        return false;
    },
    
    save() {
        try {
            window.vendetta.storage.set("HiddenDM_messages", JSON.stringify({ messages: this.messages, messageIndex: this.messageIndex }));
        } catch (e) {}
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
            this.messages = {};
            this.messageIndex = [];
        }
    }
};

function generateSnowflake() {
    return ((Date.now() - 1420070400000) * 4194304).toString();
}

function injectMessage(channelId, message, Dispatcher) {
    try {
        if (Dispatcher && Dispatcher.dispatch) {
            const messageData = {
                ...message,
                state: "SENT",
                flags: message.flags || 0,
                blocked: false,
                pinned: false,
                tts: false,
                mention_everyone: false,
                mentions: [],
                mention_roles: [],
                reactions: [],
                attachments: message.attachments || [],
                embeds: message.embeds || [],
                _state: {
                    messageId: message.id,
                    channelId: channelId,
                    isOptimistic: false,
                    hasBeenEdited: false,
                    hasBeenDeleted: false
                }
            };
            
            Dispatcher.dispatch({
                type: "MESSAGE_CREATE",
                channelId: channelId,
                message: messageData,
                optimistic: false,
                suppressNotifications: true,
                suppressEmbeds: false,
                isRead: true,
                isAcknowledged: true
            });
            return true;
        }
    } catch (e) {}
    return false;
}

let patches = [];
let Dispatcher, MessageStore, UserStore;

export default {
    onLoad() {
        try {
            storage.load();
            const findByProps = window.vendetta.metro.findByProps;
            const after = window.vendetta.patcher.after;
            
            Dispatcher = findByProps("dispatch", "_subscriptions");
            MessageStore = findByProps("getMessage", "getMessages");
            UserStore = findByProps("getUser", "getUsers");
            
            if (!Dispatcher || !MessageStore || !UserStore) return;
            
            patches.push(after("getMessage", MessageStore, (args, result) => {
                if (result) return result;
                const fakes = storage.getMessages(args[0]);
                return fakes.find(m => m.id === args[1]);
            }));
            
            patches.push(after("getMessages", MessageStore, (args, result) => {
                if (!result || !args[0]) return result;
                const fakes = storage.getMessages(args[0]);
                if (fakes.length > 0) {
                    const all = [...result, ...fakes];
                    all.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
                    return all;
                }
                return result;
            }));
            
            if (Dispatcher.subscribe) {
                const events = [
                    "CHANNEL_SELECT",
                    "LOAD_MESSAGES_SUCCESS",
                    "MESSAGE_LOAD_COMPLETE",
                    "MESSAGE_CACHE_UPDATE",
                    "MESSAGE_HISTORY_LOAD",
                    "MESSAGE_FETCH_COMPLETE",
                    "STORE_UPDATE"
                ];
                
                events.forEach(eventName => {
                    Dispatcher.subscribe(eventName, (event) => {
                        const channelId = event.channelId;
                        if (channelId) {
                            const fakes = storage.getMessages(channelId);
                            if (fakes.length > 0) {
                                setTimeout(() => {
                                    fakes.forEach(msg => injectMessage(channelId, msg, Dispatcher));
                                }, eventName === "STORE_UPDATE" ? 75 : 0);
                            }
                        }
                    });
                });
            }
            
            this.registerCommands();
            
            window.HiddenDM = {
                createFakeMessage(channelId, userId, content, customTimestamp) {
                    try {
                        const user = UserStore.getUser(userId);
                        if (!user) return null;
                        
                        let messageId, timestamp;
                        if (customTimestamp) {
                            messageId = customTimestamp;
                            timestamp = new Date(parseInt(customTimestamp) / 4194304 + 1420070400000).toISOString();
                        } else {
                            messageId = generateSnowflake();
                            timestamp = new Date().toISOString();
                        }
                        
                        let messageContent = content;
                        let embeds = [];
                        let attachments = [];
                        
                        try {
                            const parsed = JSON.parse(content);
                            if (parsed.content) messageContent = parsed.content;
                            if (parsed.embeds) embeds = parsed.embeds;
                            if (parsed.attachments) attachments = parsed.attachments;
                        } catch (e) {}
                        
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
                            timestamp,
                            edited_timestamp: null,
                            tts: false,
                            mention_everyone: false,
                            mentions: [],
                            mention_roles: [],
                            attachments,
                            embeds,
                            reactions: [],
                            pinned: false,
                            state: "SENT",
                            flags: 0,
                            nonce: messageId,
                            webhook_id: null,
                            application: null,
                            activity: null,
                            application_id: null,
                            message_flags: 0,
                            sticker_items: [],
                            referenced_message: null,
                            interaction: null,
                            components: [],
                            thread: null
                        };
                        
                        const globalIndex = storage.addMessage(channelId, fakeMessage);
                        injectMessage(channelId, fakeMessage, Dispatcher);
                        return { message: fakeMessage, index: globalIndex };
                    } catch (e) {
                        return null;
                    }
                },
                listFakes() { return storage.getAllMessages(); },
                deleteFake(index) { return storage.deleteByIndex(index); },
                clearAll() { storage.messages = {}; storage.messageIndex = []; storage.save(); }
            };
        } catch (e) {}
    },
    
    registerCommands() {
        try {
            const commands = window.vendetta.commands;
            if (!commands || !commands.registerCommand) return;
            
            commands.registerCommand({
                name: "createfake",
                description: "Create a fake message",
                options: [
                    { name: "channel", description: "Channel ID", type: 3, required: true },
                    { name: "user", description: "User ID", type: 3, required: true },
                    { name: "timestamp", description: "Timestamp (snowflake)", type: 3, required: false },
                    { name: "content", description: "Message content (text or JSON)", type: 3, required: true }
                ],
                execute: (args) => {
                    const channelId = args.find(a => a.name === "channel").value;
                    const userId = args.find(a => a.name === "user").value;
                    const timestamp = args.find(a => a.name === "timestamp")?.value;
                    const content = args.find(a => a.name === "content").value;
                    const result = window.HiddenDM.createFakeMessage(channelId, userId, content, timestamp);
                    return result ? { content: "✅ Created at index " + result.index } : { content: "❌ Failed" };
                }
            });
            
            commands.registerCommand({
                name: "listfakes",
                description: "List all fake messages",
                options: [],
                execute: () => {
                    const all = window.HiddenDM.listFakes();
                    if (all.length === 0) return { content: "No fake messages" };
                    let response = "**Fake Messages (" + all.length + "):**\n";
                    all.forEach(msg => response += "[" + msg.globalIndex + "] " + msg.channelId + " - " + msg.author.username + "\n");
                    return { content: response };
                }
            });
            
            commands.registerCommand({
                name: "delfakes",
                description: "Delete a fake message by index",
                options: [{ name: "index", description: "Message index", type: 4, required: true }],
                execute: (args) => {
                    const index = args.find(a => a.name === "index").value;
                    const success = window.HiddenDM.deleteFake(index);
                    return { content: success ? "✅ Deleted " + index : "❌ Failed" };
                }
            });
        } catch (e) {}
    },
    
    onUnload() {
        try {
            patches.forEach(p => p());
            patches = [];
            delete window.HiddenDM;
        } catch (e) {}
    }
};
