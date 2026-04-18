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

    function sanitizeFakeMessage(message) {
        const safeMessage = isPlainObject(message) ? { ...message } : {};
        const rawEmbeds = safeMessage.embeds;
        const rawAttachments = safeMessage.attachments;
        let payloadError = false;

        safeMessage.type = Number.isInteger(safeMessage.type) ? safeMessage.type : 0;
        safeMessage.flags = Number.isInteger(safeMessage.flags) ? safeMessage.flags : 0;
        safeMessage.message_flags = Number.isInteger(safeMessage.message_flags) ? safeMessage.message_flags : 0;

        if (rawEmbeds == null) {
            safeMessage.embeds = [];
        } else if (Array.isArray(rawEmbeds)) {
            const embeds = rawEmbeds
                .map((embed) => sanitizeEmbedObject(embed, "rich"))
                .filter(Boolean);

            if (embeds.length !== rawEmbeds.length) {
                payloadError = true;
            }

            safeMessage.embeds = payloadError ? [] : embeds;
        } else {
            payloadError = true;
            safeMessage.embeds = [];
        }

        if (rawAttachments == null) {
            safeMessage.attachments = [];
        } else if (Array.isArray(rawAttachments)) {
            const attachments = rawAttachments.filter(isPlainObject);
            if (attachments.length !== rawAttachments.length) {
                payloadError = true;
            }

            safeMessage.attachments = payloadError ? [] : attachments;
        } else {
            payloadError = true;
            safeMessage.attachments = [];
        }

        if (typeof safeMessage.content === "string") {
            safeMessage.content = payloadError ? "error" : safeMessage.content;
        } else if (safeMessage.content == null) {
            safeMessage.content = payloadError ? "error" : "";
        } else {
            safeMessage.content = payloadError ? "error" : String(safeMessage.content);
        }

        safeMessage.__hiddenDmFake = true;
        return safeMessage;
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
                        return sanitizeFakeMessage({
                            ...cleanMessage,
                            __hiddenDmFake: true,
                        });
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
        const safeMessage = sanitizeFakeMessage(message);
        store.messages[channelId] ??= [];
        store.messages[channelId].push(safeMessage);
        normalizeIndex();
        persistStore();

        const entry = store.messageIndex.find((item) => item.messageId === safeMessage.id);
        return {
            index: entry ? entry.index : -1,
            message: safeMessage,
        };
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

        const channelId = indexEntry.channelId;
        const channelMessages = store.messages[channelId];
        if (!Array.isArray(channelMessages)) return false;

        // If deleting index 0, delete all messages from that channel
        if (globalIndex === 0) {
            delete store.messages[channelId];
            normalizeIndex();
            persistStore();
            notifyMessageListChanged(channelId);
            return true;
        }

        // Otherwise, delete just the single message
        const nextMessages = channelMessages.filter((message) => message.id !== indexEntry.messageId);
        if (nextMessages.length === channelMessages.length) return false;

        if (nextMessages.length === 0) {
            delete store.messages[channelId];
        } else {
            store.messages[channelId] = nextMessages;
        }

        normalizeIndex();
        persistStore();
        notifyMessageListChanged(channelId);

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
        const dispatchMessageCreate = (safeMessage) => {
            state.dispatcher.dispatch({
                type: "MESSAGE_CREATE",
                channelId,
                message: {
                    ...safeMessage,
                    state: "SENT",
                    flags: safeMessage.flags || 0,
                    blocked: false,
                    pinned: false,
                    tts: false,
                    mention_everyone: false,
                    mentions: safeMessage.mentions || [],
                    mention_roles: safeMessage.mention_roles || [],
                    reactions: safeMessage.reactions || [],
                    attachments: safeMessage.attachments || [],
                    embeds: safeMessage.embeds || [],
                    _state: {
                        messageId: safeMessage.id,
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
        };

        try {
            if (!state.dispatcher?.dispatch) return false;
            dispatchMessageCreate(sanitizeFakeMessage(message));
            return true;
        } catch (error) {
            log("Failed to inject created message", error);

            try {
                if (!state.dispatcher?.dispatch) return false;

                dispatchMessageCreate(sanitizeFakeMessage({
                    ...message,
                    content: "error",
                    embeds: [],
                    attachments: [],
                }));

                return true;
            } catch (fallbackError) {
                log("Failed to inject fallback error message", fallbackError);
                return false;
            }
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

    function isPlainObject(value) {
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    }

    function coerceString(value) {
        if (typeof value === "string") {
            const trimmed = value.trim();
            return trimmed.length > 0 ? trimmed : undefined;
        }

        if (value == null) {
            return undefined;
        }

        const normalized = String(value).trim();
        return normalized.length > 0 ? normalized : undefined;
    }

    function decodeHtmlEntities(value) {
        if (typeof value !== "string" || value.indexOf("&") === -1) {
            return value;
        }

        return value
            .replace(/&amp;/gi, "&")
            .replace(/&quot;/gi, "\"")
            .replace(/&#39;|&apos;/gi, "'")
            .replace(/&lt;/gi, "<")
            .replace(/&gt;/gi, ">")
            .replace(/&#(\d+);/g, (_, code) => {
                const parsed = Number.parseInt(code, 10);
                return Number.isFinite(parsed) ? String.fromCharCode(parsed) : _;
            })
            .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
                const parsed = Number.parseInt(code, 16);
                return Number.isFinite(parsed) ? String.fromCharCode(parsed) : _;
            });
    }

    function pickFirstDefined(source, keys) {
        for (const key of keys) {
            if (source?.[key] != null) {
                return source[key];
            }
        }

        return undefined;
    }

    function extractFirstUrl(text) {
        if (typeof text !== "string") {
            return undefined;
        }

        const match = text.match(/https?:\/\/[^\s<>"']+/i);
        return match ? match[0] : undefined;
    }

    function parseHtmlMetaTagAttributes(html) {
        if (typeof html !== "string") {
            return {};
        }

        const attributes = {};
        const attributePattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
        let match;

        while ((match = attributePattern.exec(html)) !== null) {
            const attributeName = match[1]?.toLowerCase?.();
            const attributeValue = match[3] ?? match[4] ?? match[5] ?? "";
            if (!attributeName) {
                continue;
            }

            attributes[attributeName] = decodeHtmlEntities(attributeValue.trim());
        }

        return attributes;
    }

    function getMetaContentByNames(html, names) {
        if (typeof html !== "string") {
            return undefined;
        }

        const metaTagPattern = /<meta\b[^>]*>/gi;
        let match;

        while ((match = metaTagPattern.exec(html)) !== null) {
            const attributes = parseHtmlMetaTagAttributes(match[0]);
            const metaName = attributes.property || attributes.name;
            if (!metaName || !names.includes(metaName.toLowerCase())) {
                continue;
            }

            const content = coerceString(attributes.content);
            if (content) {
                return content;
            }
        }

        return undefined;
    }

    function getDocumentTitle(html) {
        if (typeof html !== "string") {
            return undefined;
        }

        const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        return match ? coerceString(decodeHtmlEntities(match[1].replace(/\s+/g, " "))) : undefined;
    }

    async function fetchTextWithTimeout(url, timeoutMs = 5000) {
        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => resolve(null), timeoutMs);
        });

        const fetchPromise = fetch(url)
            .then((response) => {
                if (!response?.ok) {
                    throw new Error(`Failed to fetch preview: ${response?.status || "unknown"}`);
                }

                return response.text();
            })
            .catch((error) => {
                log("Failed to fetch URL preview metadata", error);
                return null;
            });

        return Promise.race([fetchPromise, timeoutPromise]);
    }

    function hasExplicitPreviewPayload(parsed) {
        if (!isPlainObject(parsed)) {
            return false;
        }

        return Boolean(
            parsed.preview
            || parsed.previews
            || parsed.linkPreview
            || parsed.linkPreviews
            || parsed.link_preview
            || parsed.link_previews
            || parsed.customPreview
            || parsed.customPreviews
            || parsed.custom_preview
            || parsed.custom_previews
            || parsed.embed
            || parsed.embeds,
        );
    }

    async function buildAutoPreviewFromUrl(url) {
        const normalizedUrl = coerceString(url);
        if (!normalizedUrl) {
            return null;
        }

        const html = await fetchTextWithTimeout(normalizedUrl);
        if (!html) {
            return null;
        }

        const title = getMetaContentByNames(html, ["og:title", "twitter:title"]) || getDocumentTitle(html);
        const description = getMetaContentByNames(html, ["og:description", "twitter:description", "description"]);
        const image = getMetaContentByNames(html, ["og:image", "twitter:image", "twitter:image:src"]);
        const providerName = getMetaContentByNames(html, ["og:site_name"]);

        if (!title && !description && !image && !providerName) {
            return { url: normalizedUrl };
        }

        return {
            url: normalizedUrl,
            ...(title ? { title } : {}),
            ...(description ? { description } : {}),
            ...(image ? { image } : {}),
            ...(providerName ? { site_name: providerName } : {}),
        };
    }

    async function prepareContentForFakeMessage(content) {
        if (typeof content !== "string") {
            return content;
        }

        let parsed;
        try {
            parsed = JSON.parse(content);
        } catch {
            parsed = null;
        }

        if (isPlainObject(parsed)) {
            if (hasExplicitPreviewPayload(parsed)) {
                return content;
            }

            const messageContent = typeof parsed.content === "string"
                ? parsed.content
                : (parsed.content != null ? String(parsed.content) : "");
            const url = extractFirstUrl(messageContent);
            if (!url) {
                return content;
            }

            const autoPreview = await buildAutoPreviewFromUrl(url);
            if (!autoPreview) {
                return content;
            }

            return JSON.stringify({
                ...parsed,
                content: messageContent,
                preview: autoPreview,
            });
        }

        // Plain-text createfake messages should stay plain text.
        // Custom previews are only built from JSON payloads.
        return content;
    }

    function parseEmbedColor(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return Math.max(0, Math.min(0xFFFFFF, Math.trunc(value)));
        }

        if (typeof value !== "string") {
            return undefined;
        }

        const normalized = value.trim().replace(/^#/, "").replace(/^0x/i, "");
        if (!/^[\dA-Fa-f]{6}$/.test(normalized)) {
            return undefined;
        }

        return Number.parseInt(normalized, 16);
    }

    function normalizeEmbedAsset(value) {
        if (typeof value === "string") {
            const url = value.trim();
            return url ? { url, proxy_url: url, proxyUrl: url } : undefined;
        }

        if (!isPlainObject(value)) {
            return undefined;
        }

        const url = coerceString(value.url) || coerceString(value.proxy_url) || coerceString(value.proxyUrl);
        if (!url) {
            return undefined;
        }

        return {
            ...value,
            url,
            proxy_url: coerceString(value.proxy_url) || coerceString(value.proxyUrl) || url,
            proxyUrl: coerceString(value.proxyUrl) || coerceString(value.proxy_url) || url,
        };
    }

    function normalizeEmbedFields(value) {
        if (!Array.isArray(value)) {
            return undefined;
        }

        const fields = value
            .map((field) => {
                if (!isPlainObject(field)) {
                    return null;
                }

                const name = coerceString(field.name);
                if (!name || field.value == null) {
                    return null;
                }

                return {
                    ...field,
                    name,
                    value: String(field.value),
                    inline: Boolean(field.inline),
                };
            })
            .filter(Boolean);

        return fields.length > 0 ? fields : undefined;
    }

    function normalizeEmbedTimestamp(value) {
        if (value == null || value === "") {
            return undefined;
        }

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return undefined;
        }

        return date.toISOString();
    }

    function normalizeEmbedAuthor(value) {
        if (!isPlainObject(value)) {
            return undefined;
        }

        const name = coerceString(value.name);
        const url = coerceString(value.url);
        const iconUrl = coerceString(value.icon_url) || coerceString(value.iconUrl);

        if (!name && !url && !iconUrl) {
            return undefined;
        }

        return {
            ...value,
            ...(name ? { name } : {}),
            ...(url ? { url } : {}),
            ...(iconUrl ? { icon_url: iconUrl } : {}),
        };
    }

    function normalizeEmbedFooter(value) {
        if (!isPlainObject(value)) {
            return undefined;
        }

        const text = coerceString(value.text);
        const iconUrl = coerceString(value.icon_url) || coerceString(value.iconUrl);

        if (!text && !iconUrl) {
            return undefined;
        }

        return {
            ...value,
            ...(text ? { text } : {}),
            ...(iconUrl ? { icon_url: iconUrl } : {}),
        };
    }

    function normalizeEmbedProvider(value) {
        if (!isPlainObject(value)) {
            return undefined;
        }

        const name = coerceString(value.name);
        const url = coerceString(value.url);

        if (!name && !url) {
            return undefined;
        }

        return {
            ...value,
            ...(name ? { name } : {}),
            ...(url ? { url } : {}),
        };
    }

    function sanitizeEmbedObject(rawEmbed, fallbackType = "rich") {
        if (!isPlainObject(rawEmbed)) {
            return null;
        }

        const embed = {
            ...rawEmbed,
            type: coerceString(rawEmbed.type) || fallbackType,
        };

        const title = coerceString(rawEmbed.title);
        const description = coerceString(rawEmbed.description);
        const url = coerceString(rawEmbed.url);
        const timestamp = normalizeEmbedTimestamp(rawEmbed.timestamp);
        const color = parseEmbedColor(rawEmbed.color);
        const author = normalizeEmbedAuthor(rawEmbed.author);
        const footer = normalizeEmbedFooter(rawEmbed.footer);
        const provider = normalizeEmbedProvider(rawEmbed.provider);
        const image = normalizeEmbedAsset(rawEmbed.image);
        const thumbnail = normalizeEmbedAsset(rawEmbed.thumbnail);
        const video = normalizeEmbedAsset(rawEmbed.video);
        const fields = normalizeEmbedFields(rawEmbed.fields);

        if (title) embed.title = title; else delete embed.title;
        if (description) embed.description = description; else delete embed.description;
        if (url) embed.url = url; else delete embed.url;
        if (timestamp) embed.timestamp = timestamp; else delete embed.timestamp;
        if (color != null) embed.color = color; else delete embed.color;
        if (author) embed.author = author; else delete embed.author;
        if (footer) embed.footer = footer; else delete embed.footer;
        if (provider) embed.provider = provider; else delete embed.provider;
        if (image) embed.image = image; else delete embed.image;
        if (thumbnail) embed.thumbnail = thumbnail; else delete embed.thumbnail;
        if (video) embed.video = video; else delete embed.video;
        if (fields) embed.fields = fields; else delete embed.fields;

        return embed;
    }

    function extractInlineEmbed(parsed) {
        if (!isPlainObject(parsed)) {
            return null;
        }

        const embedKeys = [
            "title",
            "description",
            "url",
            "footer",
            "provider",
            "image",
            "thumbnail",
            "video",
            "fields",
            "color",
            "timestamp",
        ];
        const inlineEmbed = {};
        let hasInlineEmbedData = false;

        for (const key of embedKeys) {
            if (parsed[key] == null) {
                continue;
            }

            inlineEmbed[key] = parsed[key];
            hasInlineEmbedData = true;
        }

        if (!hasInlineEmbedData) {
            return null;
        }

        if (parsed.type != null) {
            inlineEmbed.type = parsed.type;
        }

        return inlineEmbed;
    }

    // Supports lightweight JSON preview helpers such as preview/linkPreview.
    function buildCustomPreviewEmbed(previewInput) {
        const preview = typeof previewInput === "string"
            ? { url: previewInput }
            : previewInput;

        if (!isPlainObject(preview)) {
            return null;
        }

        const rawEmbed = isPlainObject(preview.embed) ? { ...preview.embed } : {};
        const inferredType = coerceString(preview.type) || (coerceString(pickFirstDefined(preview, ["url", "link", "href"])) ? "article" : "rich");
        const embed = {
            ...rawEmbed,
            type: typeof rawEmbed.type === "string"
                ? rawEmbed.type
                : inferredType,
        };

        const url = coerceString(pickFirstDefined(preview, ["url", "link", "href"]));
        const title = coerceString(pickFirstDefined(preview, ["title", "name"]));
        const description = coerceString(pickFirstDefined(preview, ["description", "desc", "text", "body"]));
        const providerName = coerceString(
            pickFirstDefined(preview, ["provider_name", "providerName"]),
        ) || (typeof preview.provider === "string" ? coerceString(preview.provider) : undefined);
        const providerUrl = coerceString(pickFirstDefined(preview, ["provider_url", "providerUrl"]));
        const authorSource = isPlainObject(preview.author) ? preview.author : {};
        const authorName = coerceString(authorSource.name)
            || coerceString(pickFirstDefined(preview, ["author_name", "authorName"]));
        const authorUrl = coerceString(authorSource.url)
            || coerceString(pickFirstDefined(preview, ["author_url", "authorUrl"]));
        const authorIconUrl = coerceString(authorSource.icon_url)
            || coerceString(authorSource.iconUrl)
            || coerceString(pickFirstDefined(preview, ["author_icon_url", "authorIconUrl"]));
        const footerSource = isPlainObject(preview.footer) ? preview.footer : {};
        const footerText = coerceString(typeof preview.footer === "string" ? preview.footer : footerSource.text)
            || coerceString(pickFirstDefined(preview, ["footer_text", "footerText"]));
        const footerIconUrl = coerceString(footerSource.icon_url)
            || coerceString(footerSource.iconUrl)
            || coerceString(pickFirstDefined(preview, ["footer_icon_url", "footerIconUrl"]));
        const color = parseEmbedColor(preview.color);
        const timestamp = normalizeEmbedTimestamp(preview.timestamp);
        const previewImage = normalizeEmbedAsset(preview.image);
        const fullImage = normalizeEmbedAsset(preview.fullImage) || normalizeEmbedAsset(preview.full_image);
        const thumbnail = normalizeEmbedAsset(preview.thumbnail)
            || normalizeEmbedAsset(preview.thumb);
        const image = fullImage || previewImage;
        const video = normalizeEmbedAsset(preview.video);
        const fields = normalizeEmbedFields(preview.fields);

        if (url) embed.url = url;
        if (title) embed.title = title;
        if (description) embed.description = description;
        if (color != null) embed.color = color;
        if (timestamp) embed.timestamp = timestamp;
        if (fields) embed.fields = fields;

        if (providerName || providerUrl || isPlainObject(embed.provider)) {
            embed.provider = {
                ...(isPlainObject(embed.provider) ? embed.provider : {}),
                ...(providerName ? { name: providerName } : {}),
                ...(providerUrl ? { url: providerUrl } : {}),
            };

            if (!embed.provider.name && !embed.provider.url) {
                delete embed.provider;
            }
        }

        if (authorName || authorUrl || authorIconUrl || isPlainObject(embed.author)) {
            embed.author = {
                ...(isPlainObject(embed.author) ? embed.author : {}),
                ...(authorName ? { name: authorName } : {}),
                ...(authorUrl ? { url: authorUrl } : {}),
                ...(authorIconUrl ? { icon_url: authorIconUrl } : {}),
            };

            if (!embed.author.name && !embed.author.url && !embed.author.icon_url) {
                delete embed.author;
            }
        }

        if (footerText || footerIconUrl || isPlainObject(embed.footer)) {
            embed.footer = {
                ...(isPlainObject(embed.footer) ? embed.footer : {}),
                ...(footerText ? { text: footerText } : {}),
                ...(footerIconUrl ? { icon_url: footerIconUrl } : {}),
            };

            if (!embed.footer.text && !embed.footer.icon_url) {
                delete embed.footer;
            }
        }

        if (image) {
            embed.image = {
                ...(isPlainObject(embed.image) ? embed.image : {}),
                ...image,
            };
        }

        if (thumbnail) {
            embed.thumbnail = {
                ...(isPlainObject(embed.thumbnail) ? embed.thumbnail : {}),
                ...thumbnail,
            };
        }

        if (video) {
            embed.video = {
                ...(isPlainObject(embed.video) ? embed.video : {}),
                ...video,
            };
        }

        if (
            !embed.url
            && !embed.title
            && !embed.description
            && !embed.provider?.name
            && !embed.author?.name
            && !embed.image?.url
            && !embed.thumbnail?.url
        ) {
            return null;
        }

        return embed;
    }

    function extractPreviewEmbeds(parsed) {
        if (!isPlainObject(parsed)) {
            return [];
        }

        const previewValues = [];
        const previewKeys = [
            "preview",
            "previews",
            "linkPreview",
            "linkPreviews",
            "link_preview",
            "link_previews",
            "customPreview",
            "customPreviews",
            "custom_preview",
            "custom_previews",
        ];

        for (const key of previewKeys) {
            const value = parsed[key];
            if (Array.isArray(value)) {
                previewValues.push(...value);
            } else if (value != null) {
                previewValues.push(value);
            }
        }

        return previewValues
            .map(buildCustomPreviewEmbed)
            .filter(Boolean);
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

                const inlineEmbed = extractInlineEmbed(parsed);
                if (inlineEmbed) {
                    embeds.push(inlineEmbed);
                }

                if (isPlainObject(parsed.embed)) {
                    embeds.push(parsed.embed);
                } else if (Array.isArray(parsed.embed)) {
                    embeds.push(...parsed.embed.filter(isPlainObject));
                }

                if (Array.isArray(parsed.embeds)) {
                    embeds.push(...parsed.embeds.filter(isPlainObject));
                }
                if (Array.isArray(parsed.attachments)) {
                    attachments = parsed.attachments;
                }

                embeds.push(...extractPreviewEmbeds(parsed));

                delete overrides.content;
                delete overrides.type;
                delete overrides.title;
                delete overrides.description;
                delete overrides.url;
                delete overrides.footer;
                delete overrides.provider;
                delete overrides.image;
                delete overrides.thumbnail;
                delete overrides.video;
                delete overrides.fields;
                delete overrides.color;
                delete overrides.timestamp;
                delete overrides.embed;
                delete overrides.embeds;
                delete overrides.attachments;
                delete overrides.preview;
                delete overrides.previews;
                delete overrides.linkPreview;
                delete overrides.linkPreviews;
                delete overrides.link_preview;
                delete overrides.link_previews;
                delete overrides.customPreview;
                delete overrides.customPreviews;
                delete overrides.custom_preview;
                delete overrides.custom_previews;
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
                ...baseAuthor,
                ...overrideAuthor,
            },
        };

        const storedMessage = addMessage(channelId, fakeMessage);
        if (!injectCreatedMessage(channelId, storedMessage.message)) {
            notifyMessageListChanged(channelId);
        }

        return {
            ok: true,
            index: storedMessage.index,
            message: storedMessage.message,
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

    function generateSnowflakeFromTimestamp(isoTimestamp) {
        try {
            const date = new Date(isoTimestamp);
            const unixMillis = date.getTime();
            const safeUnixMillis = Math.max(Math.floor(unixMillis), DISCORD_EPOCH);
            state.snowflakeSequence = (state.snowflakeSequence + 1) % 4096;

            return (
                (BigInt(safeUnixMillis - DISCORD_EPOCH) << 22n)
                | BigInt(state.snowflakeSequence)
            ).toString();
        } catch {
            return generateSnowflake();
        }
    }

    async function importFakesFromJson(jsonText, silent = false) {
        try {
            const backupPayload = JSON.parse(jsonText);
            const importedRawStore = backupPayload?.version === 1 && backupPayload?.data
                ? backupPayload.data
                : (backupPayload?.messages || backupPayload?.messageIndex ? backupPayload : null);

            if (!importedRawStore) {
                if (!silent) {
                    showToast("No fake message backup was found.");
                }
                return;
            }

            let totalImported = 0;
            const store = getStore();

            // Import messages one by one
            if (importedRawStore.messages && typeof importedRawStore.messages === "object") {
                for (const [channelId, channelMessages] of Object.entries(importedRawStore.messages)) {
                    if (Array.isArray(channelMessages)) {
                        // Get existing message IDs to avoid duplicates
                        const existingIds = getStoredMessageIdSet(channelId);
                        
                        for (const message of channelMessages) {
                            // Parse the original timestamp to get the time
                            const originalDate = new Date(message.timestamp);
                            
                            // Create a new date with TODAY's date but the original TIME
                            const now = new Date();
                            let adjustedDate = new Date(
                                now.getFullYear(),
                                now.getMonth(),
                                now.getDate(),
                                originalDate.getHours(),
                                originalDate.getMinutes(),
                                originalDate.getSeconds(),
                                originalDate.getMilliseconds()
                            );
                            
                            // If the adjusted time is in the future, use yesterday instead
                            if (adjustedDate.getTime() > now.getTime()) {
                                adjustedDate = new Date(adjustedDate.getTime() - 24 * 60 * 60 * 1000);
                            }
                            
                            const adjustedTimestamp = adjustedDate.toISOString();
                            
                            // Generate a new snowflake ID that matches the adjusted timestamp
                            const newId = generateSnowflakeFromTimestamp(adjustedTimestamp);

                            // Skip if a message with this NEW ID already exists
                            if (existingIds.has(newId)) {
                                continue;
                            }

                            // Ensure the message has the internal marker, matching ID, and adjusted timestamp
                            const messageToAdd = {
                                ...message,
                                __hiddenDmFake: true,
                                id: newId,
                                nonce: newId,
                                timestamp: adjustedTimestamp,
                            };

                            // Add each message individually (this calls persistStore)
                            const storedMessage = addMessage(channelId, messageToAdd);
                            
                            // Inject to make it visible
                            if (!injectCreatedMessage(channelId, storedMessage.message)) {
                                notifyMessageListChanged(channelId);
                            }
                            
                            totalImported++;
                        }
                    }
                }
            }

            // Final persist to ensure everything is saved
            persistStore();
            
            if (!silent) {
                showToast(`Imported ${totalImported} fake messages from JSON.`);
            } else {
                log(`Silently imported ${totalImported} fake messages from JSON`);
            }
        } catch (error) {
            log("Failed to import fake messages", error);
            if (!silent) {
                showToast(`Import failed: ${error?.message || "Invalid JSON"}`);
            }
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

    async function createFakeMessageFromCommand(parsed) {
        try {
            const preparedContent = await prepareContentForFakeMessage(parsed.content);
            const result = createFakeMessage(parsed.channelId, parsed.userId, preparedContent, parsed.timestamp);
            if (!result?.ok) {
                showToast(result?.error || "Failed to create fake message.");
            }
        } catch (error) {
            log("Failed to create fake message from command", error);
            showToast("Failed to create fake message.");
        }
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

        if (command === "purgefakes") {
            const parts = splitPrefixCommand(trimmed, 2);
            if (!parts) {
                showToast(`Usage: ${buildCommandUsage("purgefakes", "<channel_id>")}`);
                return true;
            }

            const targetChannelId = parts[1].trim();
            if (!targetChannelId) {
                showToast("Channel ID is required.");
                return true;
            }

            const store = getStore();
            const channelMessages = store.messages[targetChannelId];
            
            if (!channelMessages || !Array.isArray(channelMessages) || channelMessages.length === 0) {
                showToast(`No fake messages found in channel ${targetChannelId}.`);
                return true;
            }

            const messageCount = channelMessages.length;
            
            // Remove all messages from the channel
            delete store.messages[targetChannelId];
            normalizeIndex();
            persistStore();
            notifyMessageListChanged(targetChannelId);
            
            showToast(`Purged ${messageCount} fake messages from channel ${targetChannelId}.`);
            return true;
        }

        if (command === "createfake") {
            const parsed = parseCreateFakeCommand(trimmed, rawCommand);
            if (parsed.error) {
                showToast(parsed.error);
                return true;
            }

            void createFakeMessageFromCommand(parsed);
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

    function restoreMessagesOnLoad() {
        // Wait for Discord to be fully loaded before restoring messages
        const attemptRestore = () => {
            // Check if required stores are available
            if (!state.dispatcher || !state.messageStore) {
                log("Discord stores not ready yet, retrying in 1 second...");
                setTimeout(attemptRestore, 1000);
                return;
            }

            const store = getStore();
            
            if (!store.messages || typeof store.messages !== "object") {
                return;
            }

            let restoredCount = 0;
            
            // Inject all stored messages one by one, silently
            for (const [channelId, channelMessages] of Object.entries(store.messages)) {
                if (Array.isArray(channelMessages)) {
                    for (const message of channelMessages) {
                        // Inject each message silently
                        if (!injectCreatedMessage(channelId, message)) {
                            notifyMessageListChanged(channelId);
                        }
                        restoredCount++;
                    }
                }
            }

            if (restoredCount > 0) {
                log(`Restored ${restoredCount} fake messages from storage`);
            }
        };

        // Start attempting after 3 seconds to give Discord time to initialize
        setTimeout(attemptRestore, 3500);
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
                
                // Install patches first so the message store hooks are ready
                installPatches();
                installPrefixCommands();

                // Restore all fake messages from storage silently after patches are installed
                restoreMessagesOnLoad();

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
