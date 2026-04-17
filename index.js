(() => {
    const COMMAND_OPTION_TYPES = {
        STRING: 3,
        INTEGER: 4,
    };

    const REINJECT_EVENTS = [
        "CHANNEL_SELECT",
        "LOAD_MESSAGES_SUCCESS",
        "MESSAGE_LOAD_COMPLETE",
        "MESSAGE_CACHE_UPDATE",
        "MESSAGE_HISTORY_LOAD",
        "MESSAGE_FETCH_COMPLETE",
        "STORE_UPDATE",
    ];

    const state = {
        patches: [],
        subscriptions: [],
        commandUnpatches: [],
        dispatcher: null,
        messageStore: null,
        userStore: null,
        selectedChannelStore: null,
        logger: vendetta.logger,
        storage: null,
    };

    function log(message, details) {
        if (details === undefined) {
            state.logger.log(`[HDM] ${message}`);
            return;
        }

        state.logger.log(`[HDM] ${message}`, details);
    }

    function getStore() {
        if (!state.storage) {
            state.storage = vendetta.plugin.storage;
            state.storage.messages ??= {};
            state.storage.messageIndex ??= [];
        }

        return state.storage;
    }

    function getStoredMessages(channelId) {
        return getStore().messages[channelId] || [];
    }

    function normalizeIndex() {
        const store = getStore();
        const normalized = [];
        const seen = new Set();

        if (Array.isArray(store.messageIndex)) {
            for (const entry of store.messageIndex) {
                const channelId = entry?.channelId;
                const messageId = entry?.messageId;
                if (!channelId || !messageId || seen.has(messageId)) continue;

                const channelMessages = store.messages[channelId];
                if (!Array.isArray(channelMessages)) continue;

                if (channelMessages.some((message) => message?.id === messageId)) {
                    seen.add(messageId);
                    normalized.push({ channelId, messageId });
                }
            }
        }

        for (const channelId of Object.keys(store.messages)) {
            const channelMessages = Array.isArray(store.messages[channelId]) ? store.messages[channelId] : [];
            for (const message of channelMessages) {
                if (!message?.id || seen.has(message.id)) continue;
                seen.add(message.id);
                normalized.push({ channelId, messageId: message.id });
            }
        }

        store.messageIndex = normalized.map((entry, index) => ({
            channelId: entry.channelId,
            messageId: entry.messageId,
            index,
        }));
    }

    function addMessage(channelId, message) {
        const store = getStore();
        store.messages[channelId] ??= [];
        store.messages[channelId].push(message);
        normalizeIndex();

        const entry = store.messageIndex.find((item) => item.messageId === message.id);
        return entry ? entry.index : -1;
    }

    function getAllMessages() {
        const all = [];
        const store = getStore();

        for (const channelId of Object.keys(store.messages)) {
            for (const message of store.messages[channelId]) {
                const indexEntry = store.messageIndex.find((entry) => entry.messageId === message.id);
                all.push({
                    ...message,
                    channelId,
                    globalIndex: indexEntry ? indexEntry.index : -1,
                });
            }
        }

        return all;
    }

    function deleteByIndex(globalIndex) {
        const store = getStore();
        const indexEntry = store.messageIndex[globalIndex];
        if (!indexEntry) return false;

        const channelMessages = store.messages[indexEntry.channelId];
        if (!Array.isArray(channelMessages)) return false;

        const nextMessages = channelMessages.filter((message) => message.id !== indexEntry.messageId);
        if (nextMessages.length === channelMessages.length) return false;

        if (nextMessages.length === 0) {
            delete store.messages[indexEntry.channelId];
        } else {
            store.messages[indexEntry.channelId] = nextMessages;
        }

        normalizeIndex();

        try {
            state.dispatcher?.dispatch?.({
                type: "MESSAGE_DELETE",
                channelId: indexEntry.channelId,
                id: indexEntry.messageId,
                messageId: indexEntry.messageId,
            });
        } catch (error) {
            log("Failed to dispatch message deletion", error);
        }

        return true;
    }

    function clearAll() {
        const store = getStore();
        store.messages = {};
        store.messageIndex = [];
    }

    function generateSnowflake() {
        return ((BigInt(Date.now() - 1420070400000) << 22n)).toString();
    }

    function snowflakeToTimestamp(snowflake) {
        const unixMillis = Number((BigInt(snowflake) >> 22n) + 1420070400000n);
        return new Date(unixMillis).toISOString();
    }

    function mergeMessages(existingMessages, fakeMessages) {
        const merged = Array.isArray(existingMessages) ? [...existingMessages] : [];
        const seen = new Set(merged.map((message) => message?.id));

        for (const fakeMessage of fakeMessages) {
            if (seen.has(fakeMessage.id)) continue;
            seen.add(fakeMessage.id);
            merged.push(fakeMessage);
        }

        merged.sort((left, right) => {
            const leftTs = new Date(left.timestamp).getTime();
            const rightTs = new Date(right.timestamp).getTime();
            return leftTs - rightTs;
        });

        return merged;
    }

    function summarizeContent(message) {
        if (typeof message.content === "string" && message.content.length > 0) {
            return message.content.replace(/\s+/g, " ").slice(0, 60);
        }

        if (Array.isArray(message.embeds) && message.embeds.length > 0) {
            return `[${message.embeds.length} embed${message.embeds.length === 1 ? "" : "s"}]`;
        }

        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
            return `[${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}]`;
        }

        return "[empty]";
    }

    function injectMessage(channelId, message) {
        try {
            if (!state.dispatcher?.dispatch) return false;

            const messageData = {
                ...message,
                state: "SENT",
                flags: message.flags || 0,
                blocked: false,
                pinned: false,
                tts: false,
                mention_everyone: false,
                mentions: message.mentions || [],
                mention_roles: message.mention_roles || [],
                reactions: message.reactions || [],
                attachments: message.attachments || [],
                embeds: message.embeds || [],
                _state: {
                    messageId: message.id,
                    channelId,
                    isOptimistic: false,
                    hasBeenEdited: false,
                    hasBeenDeleted: false,
                },
            };

            state.dispatcher.dispatch({
                type: "MESSAGE_CREATE",
                channelId,
                message: messageData,
                optimistic: false,
                suppressNotifications: true,
                suppressEmbeds: false,
                isRead: true,
                isAcknowledged: true,
            });

            return true;
        } catch (error) {
            log("Failed to inject message", error);
            return false;
        }
    }

    function parseContent(content) {
        let messageContent = content;
        let embeds = [];
        let attachments = [];
        let overrides = {};

        try {
            const parsed = JSON.parse(content);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                overrides = { ...parsed };

                if (typeof parsed.content === "string") {
                    messageContent = parsed.content;
                } else if (parsed.content != null) {
                    messageContent = String(parsed.content);
                } else {
                    messageContent = "";
                }

                if (Array.isArray(parsed.embeds)) {
                    embeds = parsed.embeds;
                }
                if (Array.isArray(parsed.attachments)) {
                    attachments = parsed.attachments;
                }
            }
        } catch {
            // Plain text content is still valid.
        }

        return { messageContent, embeds, attachments, overrides };
    }

    function createFakeMessage(channelId, userId, content, customTimestamp) {
        const user = state.userStore?.getUser?.(userId);
        if (!user) return null;

        const messageId = customTimestamp || generateSnowflake();
        let timestamp;

        try {
            timestamp = customTimestamp ? snowflakeToTimestamp(customTimestamp) : new Date().toISOString();
        } catch {
            return null;
        }
        const { messageContent, embeds, attachments, overrides } = parseContent(content);
        const baseAuthor = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator || "0000",
            avatar: user.avatar || "",
            bot: Boolean(user.bot),
            global_name: user.globalName || user.username,
        };
        const overrideAuthor = overrides.author && typeof overrides.author === "object" ? overrides.author : {};

        const fakeMessage = {
            type: 0,
            content: messageContent,
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
            thread: null,
            ...overrides,
            id: messageId,
            channel_id: channelId,
            timestamp,
            content: messageContent,
            attachments,
            embeds,
            nonce: overrides.nonce || messageId,
            author: {
                ...overrideAuthor,
                ...baseAuthor,
            },
        };

        const index = addMessage(channelId, fakeMessage);
        injectMessage(channelId, fakeMessage);

        return {
            index,
            message: fakeMessage,
        };
    }

    function reInjectChannel(channelId) {
        if (!channelId) return;

        const fakeMessages = getStoredMessages(channelId);
        if (fakeMessages.length === 0) return;

        for (const message of fakeMessages) {
            injectMessage(channelId, message);
        }
    }

    function registerCommands() {
        const registerCommand = vendetta.commands?.registerCommand;
        if (!registerCommand) {
            log("Command API was unavailable");
            return;
        }

        state.commandUnpatches.push(registerCommand({
            name: "createfake",
            description: "Create a fake message",
            options: [
                { name: "channel", description: "Channel ID", type: COMMAND_OPTION_TYPES.STRING, required: true },
                { name: "user", description: "User ID", type: COMMAND_OPTION_TYPES.STRING, required: true },
                { name: "timestamp", description: "Timestamp snowflake", type: COMMAND_OPTION_TYPES.STRING, required: false },
                { name: "content", description: "Message content or JSON payload", type: COMMAND_OPTION_TYPES.STRING, required: true },
            ],
            execute: (args) => {
                const channelId = args.find((arg) => arg.name === "channel")?.value;
                const userId = args.find((arg) => arg.name === "user")?.value;
                const timestamp = args.find((arg) => arg.name === "timestamp")?.value;
                const content = args.find((arg) => arg.name === "content")?.value;

                if (!channelId || !userId || !content) {
                    return { content: "Missing required arguments." };
                }

                const result = createFakeMessage(channelId, userId, content, timestamp);
                if (!result) {
                    return { content: "Failed to create a fake message." };
                }

                return { content: `Created fake message at index ${result.index}.` };
            },
        }));

        state.commandUnpatches.push(registerCommand({
            name: "listfakes",
            description: "List all fake messages",
            options: [],
            execute: () => {
                const messages = getAllMessages();
                if (messages.length === 0) {
                    return { content: "No fake messages saved." };
                }

                const lines = messages.map((message) => {
                    const author = message.author?.username || "unknown";
                    const preview = summarizeContent(message);
                    return `[${message.globalIndex}] ${message.channelId} - ${author} - ${preview}`;
                });

                return {
                    content: `**Fake Messages (${messages.length})**\n${lines.join("\n")}`,
                };
            },
        }));

        state.commandUnpatches.push(registerCommand({
            name: "delfakes",
            description: "Delete a fake message by index",
            options: [
                { name: "index", description: "Saved message index", type: COMMAND_OPTION_TYPES.INTEGER, required: true },
            ],
            execute: (args) => {
                const rawIndex = args.find((arg) => arg.name === "index")?.value;
                const index = Number(rawIndex);
                if (!Number.isInteger(index)) {
                    return { content: "Index must be a number." };
                }

                return deleteByIndex(index)
                    ? { content: `Deleted fake message ${index}.` }
                    : { content: `No fake message exists at index ${index}.` };
            },
        }));
    }

    function installPatches() {
        const after = vendetta.patcher?.after;
        if (!after) {
            log("Patcher API was unavailable");
            return;
        }

        state.dispatcher = vendetta.metro?.findByProps?.("dispatch", "_subscriptions");
        state.messageStore = vendetta.metro?.findByProps?.("getMessage", "getMessages");
        state.userStore = vendetta.metro?.findByProps?.("getUser", "getUsers");
        state.selectedChannelStore = vendetta.metro?.findByProps?.("getChannel", "getDMUserIds", "getLastSelectedChannelId");

        if (!state.dispatcher || !state.messageStore || !state.userStore) {
            log("Failed to find required Discord stores", {
                dispatcher: Boolean(state.dispatcher),
                messageStore: Boolean(state.messageStore),
                userStore: Boolean(state.userStore),
            });
            return;
        }

        state.patches.push(after("getMessage", state.messageStore, (args, result) => {
            if (result) return result;

            const channelId = args[0];
            const messageId = args[1];
            return getStoredMessages(channelId).find((message) => message.id === messageId);
        }));

        state.patches.push(after("getMessages", state.messageStore, (args, result) => {
            const channelId = args[0];
            if (!channelId || !result) return result;

            const fakeMessages = getStoredMessages(channelId);
            if (fakeMessages.length === 0) return result;

            if (Array.isArray(result)) {
                return mergeMessages(result, fakeMessages);
            }

            if (Array.isArray(result.messages)) {
                return {
                    ...result,
                    messages: mergeMessages(result.messages, fakeMessages),
                };
            }

            return result;
        }));

        if (typeof state.dispatcher.subscribe === "function") {
            for (const eventName of REINJECT_EVENTS) {
                const listener = (event) => {
                    if (!event?.channelId) return;
                    const delay = eventName === "STORE_UPDATE" ? 75 : 0;
                    setTimeout(() => reInjectChannel(event.channelId), delay);
                };

                state.dispatcher.subscribe(eventName, listener);
                state.subscriptions.push({ eventName, listener });
            }
        }

        const selectedChannelId = state.selectedChannelStore?.getLastSelectedChannelId?.();
        if (selectedChannelId) {
            setTimeout(() => reInjectChannel(selectedChannelId), 250);
        }
    }

    function cleanup() {
        for (const unpatch of state.commandUnpatches.splice(0)) {
            try {
                unpatch();
            } catch (error) {
                log("Failed to unregister command", error);
            }
        }

        for (const unpatch of state.patches.splice(0)) {
            try {
                unpatch();
            } catch (error) {
                log("Failed to remove patch", error);
            }
        }

        if (typeof state.dispatcher?.unsubscribe === "function") {
            for (const { eventName, listener } of state.subscriptions.splice(0)) {
                try {
                    state.dispatcher.unsubscribe(eventName, listener);
                } catch (error) {
                    log(`Failed to unsubscribe from ${eventName}`, error);
                }
            }
        } else {
            state.subscriptions = [];
        }

        delete window.HiddenDM;
    }

    return {
        onLoad() {
            try {
                getStore();
                normalizeIndex();
                installPatches();
                registerCommands();

                window.HiddenDM = {
                    createFakeMessage,
                    listFakes: getAllMessages,
                    deleteFake: deleteByIndex,
                    clearAll,
                    reInjectChannel,
                };

                log("Plugin loaded");
            } catch (error) {
                log("Plugin failed to load", error);
                cleanup();
            }
        },

        onUnload() {
            cleanup();
            log("Plugin unloaded");
        },
    };
})()
