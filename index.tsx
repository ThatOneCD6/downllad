/**
 * HiddenDM Plugin for Kettu/Revenge
 * Create fake messages from any user in DMs
 * @author dylan
 */

// Plugin metadata
const manifest = {
    name: "HDM",
    version: "1.0.0",
    description: "Create fake messages from any user in DMs",
    authors: [
        {
            name: "cd",
            id: "1344436675492970616"
        }
    ]
};

// Storage for fake messages
const storage = {
    messages: {} as Record<string, any[]>,
    readStates: {} as Record<string, Record<string, boolean>>,

    addMessage(channelId: string, message: any) {
        if (!this.messages[channelId]) {
            this.messages[channelId] = [];
        }
        this.messages[channelId].push(message);
        this.save();
    },

    getMessages(channelId: string) {
        return this.messages[channelId] || [];
    },

    save() {
        // Save to storage (implementation depends on Kettu's storage API)
        try {
            // @ts-ignore
            window.revenge?.storage?.set("HiddenDM_messages", JSON.stringify(this.messages));
            // @ts-ignore
            window.revenge?.storage?.set("HiddenDM_readStates", JSON.stringify(this.readStates));
        } catch (e) {
            console.error("Failed to save HiddenDM data:", e);
        }
    },

    load() {
        try {
            // @ts-ignore
            const messagesData = window.revenge?.storage?.get("HiddenDM_messages");
            // @ts-ignore
            const readStatesData = window.revenge?.storage?.get("HiddenDM_readStates");
            
            if (messagesData) {
                this.messages = JSON.parse(messagesData);
            }
            if (readStatesData) {
                this.readStates = JSON.parse(readStatesData);
            }
        } catch (e) {
            console.error("Failed to load HiddenDM data:", e);
        }
    }
};

// Generate snowflake ID
function generateSnowflake(): string {
    return ((Date.now() - 1420070400000) * 4194304).toString();
}

// Inject fake message into Discord
function injectMessage(channelId: string, message: any) {
    try {
        // @ts-ignore
        const Dispatcher = window.revenge?.modules?.findByProps("dispatch");
        
        if (!Dispatcher) {
            console.error("Dispatcher not found");
            return false;
        }

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
            attachments: [],
            embeds: []
        };

        Dispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId: channelId,
            message: messageData,
            optimistic: false,
            isPushNotification: false,
            suppressNotifications: true
        });

        return true;
    } catch (e) {
        console.error("Failed to inject message:", e);
        return false;
    }
}

// Commands
const commands = [
    {
        name: "dm",
        description: "Create a fake message from any user",
        options: [
            {
                name: "user",
                description: "The user to impersonate",
                type: 6, // USER type
                required: true
            },
            {
                name: "message",
                description: "Message content",
                type: 3, // STRING type
                required: true
            }
        ],
        execute: async (args: any[], context: any) => {
            try {
                const userId = args[0]?.value;
                const content = args[1]?.value;
                const channelId = context.channel?.id;

                if (!userId || !content || !channelId) {
                    return { content: "❌ Missing required parameters" };
                }

                // @ts-ignore
                const UserStore = window.revenge?.modules?.findByProps("getUser");
                const user = UserStore?.getUser(userId);

                if (!user) {
                    return { content: "❌ User not found" };
                }

                const messageId = generateSnowflake();
                const timestamp = new Date().toISOString();

                const fakeMessage = {
                    id: messageId,
                    type: 0,
                    content: content,
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
                    attachments: [],
                    embeds: [],
                    reactions: [],
                    pinned: false
                };

                storage.addMessage(channelId, fakeMessage);
                injectMessage(channelId, fakeMessage);

                return { content: "✅ Fake message created!" };
            } catch (e) {
                console.error("Error in /dm command:", e);
                return { content: "❌ An error occurred" };
            }
        }
    },
    {
        name: "reply",
        description: "Reply to a fake message",
        options: [
            {
                name: "id",
                description: "ID of the fake message (use 'last' for most recent)",
                type: 3, // STRING type
                required: true
            },
            {
                name: "message",
                description: "Reply content",
                type: 3, // STRING type
                required: true
            }
        ],
        execute: async (args: any[], context: any) => {
            try {
                const messageId = args[0]?.value;
                const content = args[1]?.value;
                const channelId = context.channel?.id;

                if (!messageId || !content || !channelId) {
                    return { content: "❌ Missing required parameters" };
                }

                const fakeMessages = storage.getMessages(channelId);
                let targetMessage;

                if (messageId.toLowerCase() === "last" && fakeMessages.length > 0) {
                    targetMessage = fakeMessages[fakeMessages.length - 1];
                } else {
                    targetMessage = fakeMessages.find(m => m.id === messageId);
                }

                if (!targetMessage) {
                    return { content: "❌ Fake message not found" };
                }

                // @ts-ignore
                const MessageActions = window.revenge?.modules?.findByProps("sendMessage");
                
                if (MessageActions?.sendMessage) {
                    MessageActions.sendMessage(channelId, {
                        content: content,
                        messageReference: {
                            channel_id: channelId,
                            message_id: targetMessage.id
                        }
                    });
                    return { content: "✅ Reply sent!" };
                }

                return { content: "❌ Failed to send reply" };
            } catch (e) {
                console.error("Error in /reply command:", e);
                return { content: "❌ An error occurred" };
            }
        }
    }
];

// Plugin export
export default {
    ...manifest,
    
    onLoad() {
        console.log("[HiddenDM] Plugin loaded");
        storage.load();
        
        // Register commands
        commands.forEach(cmd => {
            try {
                // @ts-ignore
                window.revenge?.commands?.registerCommand(cmd);
            } catch (e) {
                console.error(`Failed to register command ${cmd.name}:`, e);
            }
        });

        // Patch message stores to include fake messages
        this.patchMessageStores();
    },

    onUnload() {
        console.log("[HiddenDM] Plugin unloaded");
        
        // Unregister commands
        commands.forEach(cmd => {
            try {
                // @ts-ignore
                window.revenge?.commands?.unregisterCommand(cmd.name);
            } catch (e) {
                console.error(`Failed to unregister command ${cmd.name}:`, e);
            }
        });
    },

    patchMessageStores() {
        try {
            // @ts-ignore
            const MessageStore = window.revenge?.modules?.findByProps("getMessage", "getMessages");
            
            if (!MessageStore) {
                console.error("[HiddenDM] MessageStore not found");
                return;
            }

            // Patch getMessage to return fake messages
            const originalGetMessage = MessageStore.getMessage;
            MessageStore.getMessage = function(channelId: string, messageId: string) {
                const result = originalGetMessage.call(this, channelId, messageId);
                if (!result) {
                    const fakeMessages = storage.getMessages(channelId);
                    return fakeMessages.find(m => m.id === messageId);
                }
                return result;
            };

            // Patch getMessages to include fake messages
            const originalGetMessages = MessageStore.getMessages;
            MessageStore.getMessages = function(channelId: string) {
                const result = originalGetMessages.call(this, channelId);
                const fakeMessages = storage.getMessages(channelId);
                
                if (fakeMessages.length > 0 && result) {
                    const allMessages = [...result, ...fakeMessages];
                    return allMessages.sort((a, b) => {
                        return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
                    });
                }
                
                return result;
            };

            console.log("[HiddenDM] Message stores patched successfully");
        } catch (e) {
            console.error("[HiddenDM] Failed to patch message stores:", e);
        }
    }
};
