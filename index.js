// HiddenDM Plugin for Kettu
// Create fake messages from any user in DMs

const { storage } = vendetta.plugin;
const { findByProps } = vendetta.metro;
const { after } = vendetta.patcher;
const { showToast } = vendetta.ui.toasts;

// Storage manager
const fakeMessages = {
    get(channelId) {
        const data = storage.messages || {};
        return data[channelId] || [];
    },
    
    add(channelId, message) {
        if (!storage.messages) storage.messages = {};
        if (!storage.messages[channelId]) storage.messages[channelId] = [];
        storage.messages[channelId].push(message);
    },
    
    clear() {
        storage.messages = {};
    }
};

// Generate Discord snowflake ID
function generateSnowflake() {
    return ((Date.now() - 1420070400000) * 4194304).toString();
}

// Get Discord modules
let Dispatcher;
let MessageStore;
let UserStore;
let MessageActions;

const patches = [];

// Inject message into Discord
function injectMessage(channelId, message) {
    try {
        if (!Dispatcher) return false;
        
        Dispatcher.dispatch({
            type: "MESSAGE_CREATE",
            channelId,
            message: {
                ...message,
                state: "SENT",
                flags: 0
            },
            optimistic: false
        });
        
        return true;
    } catch (e) {
        console.error("[HiddenDM] Failed to inject:", e);
        return false;
    }
}

export default {
    onLoad() {
        try {
            // Find required modules
            Dispatcher = findByProps("dispatch", "_subscriptions");
            MessageStore = findByProps("getMessage", "getMessages");
            UserStore = findByProps("getUser", "getUsers");
            MessageActions = findByProps("sendMessage", "receiveMessage");
            
            if (!Dispatcher || !MessageStore || !UserStore) {
                showToast("HiddenDM: Failed to find modules");
                console.error("[HiddenDM] Missing modules");
                return;
            }
            
            // Patch getMessage
            patches.push(after("getMessage", MessageStore, (args, res) => {
                if (res) return res;
                const [channelId, messageId] = args;
                const fakes = fakeMessages.get(channelId);
                return fakes.find(m => m.id === messageId);
            }));
            
            // Patch getMessages  
            patches.push(after("getMessages", MessageStore, (args, res) => {
                const [channelId] = args;
                const fakes = fakeMessages.get(channelId);
                
                if (fakes.length > 0 && res) {
                    const all = [...res, ...fakes];
                    return all.sort((a, b) => 
                        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
                    );
                }
                
                return res;
            }));
            
            console.log("[HiddenDM] Loaded successfully");
            showToast("HiddenDM loaded!");
        } catch (e) {
            console.error("[HiddenDM] Load error:", e);
            showToast("HiddenDM failed to load");
        }
    },
    
    onUnload() {
        patches.forEach(p => p());
        patches.length = 0;
        console.log("[HiddenDM] Unloaded");
        showToast("HiddenDM unloaded");
    }
};
