(() => {
    const DISCORD_EPOCH = 1420070400000;
    const COMMAND_PREFIX = "--|-";
    const STORAGE_KEY = "__hiddenDmState";

    const state = {
        patches: [],
        dispatcher: null,
        messageStore: null,
        userStore: null,
        currentUserStore: null,
        selectedChannelStore: null,
        messageActions: null,
        logger: vendetta.logger,
        snowflakeSequence: 0,
        storage: null,
        storeData: null,
    };

    function log(message, details) {
        if (details === undefined) {
            state.logger.log(`[HDM] ${message}`);
            return;
        }

        state.logger.log(`[HDM] ${message}`, details);
    }

    function showToast(message) {
        try {
            vendetta.ui?.toasts?.showToast?.(message);
        } catch (error) {
            log(message, error);
        }
    }

    function createEmptyStore() {
        return {
            messages: {},
            messageIndex: [],
        };
    }

    function cloneJson(value, fallback) {
        try {
            return JSON.parse(JSON.stringify(value));
        } catch {
            return fallback;
        }
    }

    function sanitizeStore(rawStore) {
        const safeStore = createEmptyStore();
        if (!rawStore || typeof rawStore !== "object") {
            return safeStore;
        }

        if (rawStore.messages && typeof rawStore.messages === "object") {
            for (const [channelId, channelMessages] of Object.entries(rawStore.messages)) {
                if (!Array.isArray(channelMessages)) continue;
                safeStore.messages[channelId] = cloneJson(channelMessages, [])
                    .filter((message) => message && typeof message === "object")
                    .map((message) => {
                        const { __hiddenDmFake, __hiddenDmExport, ...cleanMessage } = message;
                        return {
                            ...cleanMessage,
                            __hiddenDmFake: true,
                        };
                    });
            }
        }

        if (Array.isArray(rawStore.messageIndex)) {
            safeStore.messageIndex = cloneJson(rawStore.messageIndex, []);
        }

        return safeStore;
    }

    function countMessagesInStore(store) {
        if (!store?.messages || typeof store.messages !== "object") return 0;

        let count = 0;
        for (const channelMessages of Object.values(store.messages)) {
            if (Array.isArray(channelMessages)) {
                count += channelMessages.length;
            }
        }

        return count;
    }

    function persistStore() {
        if (!state.storage || !state.storeData) return;

        const serialized = JSON.stringify(state.storeData);
        const messagesClone = cloneJson(state.storeData.messages, {});
        const indexClone = cloneJson(state.storeData.messageIndex, []);

        state.storage[STORAGE_KEY] = serialized;
        state.storage.messages = messagesClone;
        state.storage.messageIndex = indexClone;
    }

    function getStore() {
        if (!state.storage) {
            state.storage = vendetta.plugin.storage;
        }

        if (!state.storeData) {
            let loadedStore = null;

            if (typeof state.storage[STORAGE_KEY] === "string") {
                try {
                    loadedStore = JSON.parse(state.storage[STORAGE_KEY]);
                } catch (error) {
                    log("Failed to parse saved fake message state", error);
                }
            }

            if (!loadedStore) {
                loadedStore = {
                    messages: state.storage.messages,
                    messageIndex: state.storage.messageIndex,
                };
            }

            state.storeData = sanitizeStore(loadedStore);
            persistStore();
        }

        return state.storeData;
    }

    function getCurrentUser() {
        return state.currentUserStore?.getCurrentUser?.()
            || state.userStore?.getCurrentUser?.()
            || null;
    }

    function getClipboardApi() {
        return vendetta.metro?.common?.clipboard
            || vendetta.metro?.findByProps?.("setString", "getString")
            || null;
    }

    async function readClipboardText() {
        const clipboard = getClipboardApi();
        if (!clipboard?.getString) {
            throw new Error("Clipboard import is unavailable.");
        }

        const value = clipboard.getString();
        return typeof value?.then === "function" ? await value : value;
    }

    async function writeClipboardText(content) {
        const clipboard = getClipboardApi();
        if (!clipboard?.setString) {
            throw new Error("Clipboard export is unavailable.");
        }

        const value = clipboard.setString(content);
        if (typeof value?.then === "function") {
            await value;
        }
    }

    function applyStore(rawStore) {
        state.storeData = sanitizeStore(rawStore);
        normalizeIndex();
        persistStore();
        return state.storeData;
    }

    function getStoredMessages(channelId) {
        return getStore().messages[channelId] || [];
    }

    function isFakeMessage(message) {
        return Boolean(message?.__hiddenDmFake);
    }

    function getStoredMessageIdSet(channelId) {
        return new Set(getStoredMessages(channelId).map((message) => message.id));
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
        persistStore();

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
        persistStore();
        notifyMessageListChanged(indexEntry.channelId);

        return true;
    }

    function clearAll() {
        const store = getStore();
        store.messages = {};
        store.messageIndex = [];
        persistStore();
    }

    function generateSnowflake(unixMillis = Date.now()) {
        const safeUnixMillis = Math.max(Math.floor(unixMillis), DISCORD_EPOCH);
        state.snowflakeSequence = (state.snowflakeSequence + 1) % 4096;

        return (
            (BigInt(safeUnixMillis - DISCORD_EPOCH) << 22n)
            | BigInt(state.snowflakeSequence)
        ).toString();
    }

    function parseUnixTimestamp(timestampInput) {
        if (timestampInput == null || timestampInput === "") {
            const unixMillis = Date.now();
            return {
                unixMillis,
                isoTimestamp: new Date(unixMillis).toISOString(),
            };
        }

        const normalized = String(timestampInput).trim();
        if (!/^-?\d+$/.test(normalized)) {
            throw new Error("Timestamp must be Unix seconds or milliseconds.");
        }

        let unixMillis = Number(normalized);
        if (!Number.isFinite(unixMillis)) {
            throw new Error("Timestamp was not a valid number.");
        }

        if (Math.abs(unixMillis) < 1000000000000) {
            unixMillis *= 1000;
        }

        const date = new Date(unixMillis);
        if (Number.isNaN(date.getTime())) {
            throw new Error("Timestamp could not be converted to a date.");
        }

        return {
            unixMillis,
            isoTimestamp: date.toISOString(),
        };
    }

    function mergeMessages(existingMessages, fakeMessages, channelId) {
        const storedIds = getStoredMessageIdSet(channelId);
        const merged = Array.isArray(existingMessages)
            ? existingMessages.filter((message) => !isFakeMessage(message) || storedIds.has(message?.id))
            : [];
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
            const normalized = message.content.replace(/\s+/g, " ");
            // Don't truncate command prefix messages
            if (normalized.startsWith(COMMAND_PREFIX)) {
                return normalized;
            }
            return normalized.slice(0, 60);
        }

        if (Array.isArray(message.embeds) && message.embeds.length > 0) {
            return `[${message.embeds.length} embed${message.embeds.length === 1 ? "" : "s"}]`;
        }

        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
            return `[${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}]`;
        }

        return "[empty]";
    }

    function injectCreatedMessage(channelId, message) {
        try {
            if (!state.dispatcher?.dispatch) return false;

            state.dispatcher.dispatch({
                type: "MESSAGE_CREATE",
                channelId,
                message: {
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
                },
                optimistic: false,
                suppressNotifications: true,
                suppressEmbeds: false,
                isRead: true,
                isAcknowledged: true,
            });

            return true;
        } catch (error) {
            log("Failed to inject created message", error);
            return false;
        }
    }

    function injectTransientExportMessage(channelId, jsonContent) {
        const currentUser = getCurrentUser();
        if (!channelId) {
            return { error: "Open the target DM before exporting as a transient message." };
        }

        if (!currentUser?.id) {
            return { error: "Could not resolve your current user." };
        }

        const unixMillis = Date.now();
        const message = {
            id: generateSnowflake(unixMillis),
            type: 0,
            content: jsonContent,
            timestamp: new Date(unixMillis).toISOString(),
            channel_id: channelId,
            edited_timestamp: null,
            tts: false,
            mention_everyone: false,
            mentions: [],
            mention_roles: [],
            attachments: [],
            embeds: [],
            reactions: [],
            pinned: false,
            state: "SENT",
            flags: 0,
            nonce: generateSnowflake(unixMillis + 1),
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
            __hiddenDmExport: true,
            author: {
                id: currentUser.id,
                username: currentUser.username || "you",
                discriminator: currentUser.discriminator || "0000",
                avatar: currentUser.avatar || "",
                bot: Boolean(currentUser.bot),
                global_name: currentUser.globalName || currentUser.username || "you",
            },
        };

        if (!injectCreatedMessage(channelId, message)) {
            return { error: "Failed to inject export message." };
        }

        return { ok: true };
    }

    function notifyMessageListChanged(channelId) {
        try {
            state.messageStore?.emitChange?.();
        } catch (error) {
            log("Failed to emit message store change", error);
        }

        try {
            state.dispatcher?.dispatch?.({
                type: "MESSAGE_STORE_UPDATE",
                channelId,
            });
        } catch (error) {
            log("Failed to dispatch message store update", error);
        }
    }

    function notifyChannelsChanged(channelIds) {
        for (const channelId of channelIds) {
            if (channelId) {
                notifyMessageListChanged(channelId);
            }
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
        if (!channelId) {
            return { error: "Missing channel ID." };
        }

        if (!userId) {
            return { error: "Missing user ID." };
        }

        if (typeof content !== "string" || content.trim().length === 0) {
            return { error: "Missing message content." };
        }

        const user = state.userStore?.getUser?.(userId);

        let parsedTimestamp;

        try {
            parsedTimestamp = parseUnixTimestamp(customTimestamp);
        } catch (error) {
            return { error: error?.message || "Invalid timestamp." };
        }

        const timestamp = parsedTimestamp.isoTimestamp;
        const messageId = generateSnowflake(parsedTimestamp.unixMillis);
        const { messageContent, embeds, attachments, overrides } = parseContent(content);
        const baseAuthor = {
            id: user?.id || userId,
            username: user?.username || `user-${String(userId).slice(-4)}`,
            discriminator: user?.discriminator || "0000",
            avatar: user?.avatar || "",
            bot: Boolean(user?.bot),
            global_name: user?.globalName || user?.username || `user-${String(userId).slice(-4)}`,
        };
        const overrideAuthor = overrides.author && typeof overrides.author === "object" ? overrides.author : {};

        const fakeMessage = {
            type: 0,
            content: messageContent,
            __hiddenDmFake: true,
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
        if (!injectCreatedMessage(channelId, fakeMessage)) {
            notifyMessageListChanged(channelId);
        }

        return {
            ok: true,
            index,
            message: fakeMessage,
        };
    }

    function showListDialog(messages) {
        const showConfirmationAlert = vendetta.ui?.alerts?.showConfirmationAlert;
        if (typeof showConfirmationAlert !== "function") return;

        const content = messages.length === 0
            ? "No fake messages saved."
            : messages.map((message) => {
                const author = message.author?.username || "unknown";
                const preview = summarizeContent(message);
                return `[${message.globalIndex}] ${message.channelId} - ${author} - ${preview}`;
            }).join("\n");

        showConfirmationAlert({
            title: `Fake Messages (${messages.length})`,
            content,
            confirmText: "Close",
            onConfirm: () => {},
        });
    }

    function serializeStoreForExport() {
        const store = getStore();
        const cleanData = {
            messages: {},
            messageIndex: [],
        };

        // Clean messages by removing internal markers
        if (store.messages && typeof store.messages === "object") {
            for (const [channelId, channelMessages] of Object.entries(store.messages)) {
                if (!Array.isArray(channelMessages)) continue;
                cleanData.messages[channelId] = channelMessages.map((message) => {
                    const { __hiddenDmFake, __hiddenDmExport, ...cleanMessage } = message;
                    return cleanMessage;
                });
            }
        }

        // Clean messageIndex
        if (Array.isArray(store.messageIndex)) {
            cleanData.messageIndex = cloneJson(store.messageIndex, []);
        }

        return JSON.stringify({
            version: 1,
            exportedAt: new Date().toISOString(),
            data: cleanData,
        }, null, 2);
    }

    async function exportFakes(mode = "clipboard", channelId) {
        try {
            const store = getStore();
            const jsonContent = serializeStoreForExport();
            await writeClipboardText(jsonContent);

            if (mode === "dm") {
                const injected = injectTransientExportMessage(channelId, jsonContent);
                if (!injected?.ok) {
                    showToast(injected?.error || "Failed to export fake messages as a DM.");
                    return;
                }

                showToast(`Exported ${countMessagesInStore(store)} fake messages as JSON and copied them to clipboard.`);
                return;
            }

            showToast(`Copied ${countMessagesInStore(store)} fake messages as JSON to clipboard.`);
        } catch (error) {
            log("Failed to export fake messages", error);
            showToast(error?.message || "Failed to export fake messages.");
        }
    }

    async function importFakesFromJson(jsonText) {
        try {
            const backupPayload = JSON.parse(jsonText);
            const importedRawStore = backupPayload?.version === 1 && backupPayload?.data
                ? backupPayload.data
                : (backupPayload?.messages || backupPayload?.messageIndex ? backupPayload : null);

            if (!importedRawStore) {
                showToast("No fake message backup was found.");
                return;
            }

            const previousStore = getStore();
            const previousChannelIds = Object.keys(previousStore.messages || {});
            const nextStore = applyStore(importedRawStore);
            const nextChannelIds = Object.keys(nextStore.messages || {});

            notifyChannelsChanged(new Set([...previousChannelIds, ...nextChannelIds]));
            showToast(`Imported ${countMessagesInStore(nextStore)} fake messages from JSON.`);
        } catch (error) {
            log("Failed to import fake messages", error);
            showToast(`Import failed: ${error?.message || "Invalid JSON"}`);
        }
    }

    function splitPrefixCommand(input, expectedParts) {
        const parts = [];
        let rest = input.trim();

        for (let index = 0; index < expectedParts - 1; index++) {
            const nextSpace = rest.indexOf(" ");
            if (nextSpace === -1) return null;

            parts.push(rest.slice(0, nextSpace));
            rest = rest.slice(nextSpace + 1).trimStart();
            if (!rest) return null;
        }

        parts.push(rest);
        return parts;
    }

    function buildCommandUsage(name, args = "") {
        return `${COMMAND_PREFIX}${name}${args ? ` ${args}` : ""}`;
    }

    function parseCreateFakeCommand(trimmed, rawCommand) {
        let rest = trimmed.slice(rawCommand.length).trimStart();
        if (!rest) {
            return { error: `Usage: ${buildCommandUsage("createfake", "<channel> <user_id> [unix_timestamp] <content>")}` };
        }

        const nextToken = () => {
            const spaceIndex = rest.indexOf(" ");
            if (spaceIndex === -1) {
                const token = rest;
                rest = "";
                return token;
            }

            const token = rest.slice(0, spaceIndex);
            rest = rest.slice(spaceIndex + 1).trimStart();
            return token;
        };

        const channelId = nextToken();
        const userId = nextToken();

        if (!channelId || !userId || !rest) {
            return { error: `Usage: ${buildCommandUsage("createfake", "<channel> <user_id> [unix_timestamp] <content>")}` };
        }

        let timestamp;
        let content = rest;
        const firstSpace = rest.indexOf(" ");

        if (firstSpace !== -1) {
            const maybeTimestamp = rest.slice(0, firstSpace);
            const maybeContent = rest.slice(firstSpace + 1).trimStart();

            if (/^-?\d{9,}$/.test(maybeTimestamp) && maybeContent) {
                timestamp = maybeTimestamp;
                content = maybeContent;
            }
        }

        return {
            channelId,
            userId,
            timestamp,
            content,
        };
    }

    function handlePrefixCommand(rawContent, channelId) {
        const trimmed = rawContent.trim();
        if (!trimmed.startsWith(COMMAND_PREFIX)) return false;

        const [rawCommand] = trimmed.split(/\s+/, 1);
        const command = rawCommand.slice(COMMAND_PREFIX.length).toLowerCase();

        if (command === "listfakes") {
            showListDialog(getAllMessages());
            return true;
        }

        if (command === "delfakes") {
            const parts = splitPrefixCommand(trimmed, 2);
            if (!parts) {
                showToast(`Usage: ${buildCommandUsage("delfakes", "<index>")}`);
                return true;
            }

            const index = Number(parts[1]);
            if (!Number.isInteger(index)) {
                showToast("Fake message index must be a number.");
                return true;
            }

            if (!deleteByIndex(index)) {
                showToast(`No fake message exists at index ${index}.`);
            }

            return true;
        }

        if (command === "createfake") {
            const parsed = parseCreateFakeCommand(trimmed, rawCommand);
            if (parsed.error) {
                showToast(parsed.error);
                return true;
            }

            const result = createFakeMessage(parsed.channelId, parsed.userId, parsed.content, parsed.timestamp);
            if (!result?.ok) {
                showToast(result?.error || "Failed to create fake message.");
            }

            return true;
        }

        if (command === "exportfakes") {
            const mode = trimmed.slice(rawCommand.length).trim().toLowerCase();
            void exportFakes(mode === "dm" ? "dm" : "clipboard", channelId);
            return true;
        }

        if (command === "importfakes") {
            const inlineJson = trimmed.slice(rawCommand.length).trim();
            if (inlineJson) {
                // Check if it's a URL
                if (inlineJson.startsWith("http://") || inlineJson.startsWith("https://")) {
                    showToast("Fetching fake messages from URL...");
                    void fetch(inlineJson)
                        .then((response) => {
                            if (!response.ok) {
                                throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
                            }
                            return response.text();
                        })
                        .then(importFakesFromJson)
                        .catch((error) => {
                            log("Failed to fetch fake message import JSON from URL", error);
                            showToast(error?.message || "URL import failed.");
                        });
                } else {
                    void importFakesFromJson(inlineJson);
                }
            } else {
                void readClipboardText().then(importFakesFromJson).catch((error) => {
                    log("Failed to read fake message import JSON from clipboard", error);
                    showToast(error?.message || "Clipboard import failed.");
                });
            }
            return true;
        }

        return false;
    }

    function installPrefixCommands() {
        const instead = vendetta.patcher?.instead;
        if (!instead || !state.messageActions?.sendMessage) {
            log("Prefix command patch could not be installed");
            return;
        }

        state.patches.push(instead("sendMessage", state.messageActions, (args, original) => {
            const [channelId, message] = args;
            const content = message?.content;

            if (typeof content === "string" && handlePrefixCommand(content, channelId)) {
                return;
            }

            return original.apply(state.messageActions, args);
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
        state.currentUserStore = vendetta.metro?.findByProps?.("getCurrentUser", "getUser");
        state.selectedChannelStore = vendetta.metro?.findByProps?.("getChannel", "getDMUserIds", "getLastSelectedChannelId");
        state.messageActions = vendetta.metro?.findByProps?.("sendMessage");

        if (!state.dispatcher || !state.messageStore || !state.userStore) {
            log("Failed to find required Discord stores", {
                dispatcher: Boolean(state.dispatcher),
                messageStore: Boolean(state.messageStore),
                userStore: Boolean(state.userStore),
            });
            return;
        }

        state.patches.push(after("getMessage", state.messageStore, (args, result) => {
            const channelId = args[0];
            const messageId = args[1];
            const storedMessage = getStoredMessages(channelId).find((message) => message.id === messageId);

            if (storedMessage) return storedMessage;
            if (isFakeMessage(result)) return undefined;
            return result;
        }));

        state.patches.push(after("getMessages", state.messageStore, (args, result) => {
            const channelId = args[0];
            if (!channelId || !result) return result;

            const fakeMessages = getStoredMessages(channelId);
            if (fakeMessages.length === 0) return result;

            if (Array.isArray(result)) {
                return mergeMessages(result, fakeMessages, channelId);
            }

            if (Array.isArray(result.messages)) {
                return {
                    ...result,
                    messages: mergeMessages(result.messages, fakeMessages, channelId),
                };
            }

            return result;
        }));

        const selectedChannelId = state.selectedChannelStore?.getLastSelectedChannelId?.();
        if (selectedChannelId) {
            setTimeout(() => notifyMessageListChanged(selectedChannelId), 250);
        }
    }

    function cleanup() {
        for (const unpatch of state.patches.splice(0)) {
            try {
                unpatch();
            } catch (error) {
                log("Failed to remove patch", error);
            }
        }

        delete window.HiddenDM;
    }

    return {
        onLoad() {
            try {
                getStore();
                normalizeIndex();
                persistStore();
                installPatches();
                installPrefixCommands();

                window.HiddenDM = {
                    createFakeMessage,
                    listFakes: getAllMessages,
                    deleteFake: deleteByIndex,
                    clearAll,
                    refreshChannel: notifyMessageListChanged,
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
