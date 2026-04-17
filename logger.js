// Console Logger Plugin for Kettu/Vendetta
// Logs all Vendetta API availability and plugin loading info to Discord webhook

const WEBHOOK_URL = "https://discord.com/api/webhooks/1494741519888814103/U7zQnqnD2ebxrNbmG8H8qAGDGdswsv5FqgrvRuxHO0IxhLUNz1ty60_2xqD2HA40vXVc";

function sendToWebhook(title, content, isError = false) {
    try {
        fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                embeds: [{
                    title: title,
                    description: "```\n" + content + "\n```",
                    color: isError ? 15158332 : 3447003,
                    timestamp: new Date().toISOString()
                }]
            })
        }).catch(e => console.error("Webhook send failed:", e));
    } catch (e) {
        console.error("Webhook error:", e);
    }
}

// Send immediate test
try {
    fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            content: "🔴 **LOGGER PLUGIN FILE LOADED** - onLoad() about to execute"
        })
    });
} catch (e) {}

export default {
    onLoad() {
        // Immediate notification
        fetch(WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: "🟢 **onLoad() CALLED** - Plugin is executing"
            })
        }).catch(() => {});
        
        let log = "";
        
        log += "=== LOGGER PLUGIN STARTED ===\n";
        log += "Timestamp: " + new Date().toISOString() + "\n\n";
        
        // Check if window.vendetta exists
        log += "[1] Checking window.vendetta...\n";
        log += "window.vendetta exists: " + !!window.vendetta + "\n";
        
        if (window.vendetta) {
            log += "window.vendetta keys: " + Object.keys(window.vendetta).join(", ") + "\n\n";
            
            // Check metro
            log += "[2] Checking window.vendetta.metro...\n";
            log += "metro exists: " + !!window.vendetta.metro + "\n";
            if (window.vendetta.metro) {
                log += "metro keys: " + Object.keys(window.vendetta.metro).join(", ") + "\n";
                log += "findByProps exists: " + !!window.vendetta.metro.findByProps + "\n\n";
            }
            
            // Check patcher
            log += "[3] Checking window.vendetta.patcher...\n";
            log += "patcher exists: " + !!window.vendetta.patcher + "\n";
            if (window.vendetta.patcher) {
                log += "patcher keys: " + Object.keys(window.vendetta.patcher).join(", ") + "\n";
                log += "after exists: " + !!window.vendetta.patcher.after + "\n\n";
            }
            
            // Check storage
            log += "[4] Checking window.vendetta.storage...\n";
            log += "storage exists: " + !!window.vendetta.storage + "\n";
            if (window.vendetta.storage) {
                log += "storage keys: " + Object.keys(window.vendetta.storage).join(", ") + "\n\n";
            }
            
            // Check commands
            log += "[5] Checking window.vendetta.commands...\n";
            log += "commands exists: " + !!window.vendetta.commands + "\n";
            if (window.vendetta.commands) {
                log += "commands keys: " + Object.keys(window.vendetta.commands).join(", ") + "\n";
                log += "registerCommand exists: " + !!window.vendetta.commands.registerCommand + "\n\n";
            }
            
            sendToWebhook("Kettu Logger - Vendetta API Check", log);
            
            // Try to find Discord stores
            let storeLog = "[6] Attempting to find Discord stores...\n";
            try {
                const findByProps = window.vendetta.metro.findByProps;
                
                storeLog += "Finding Dispatcher...\n";
                const Dispatcher = findByProps("dispatch", "_subscriptions");
                storeLog += "Dispatcher found: " + !!Dispatcher + "\n";
                if (Dispatcher) {
                    storeLog += "Dispatcher keys: " + Object.keys(Dispatcher).slice(0, 10).join(", ") + "\n";
                }
                
                storeLog += "\nFinding MessageStore...\n";
                const MessageStore = findByProps("getMessage", "getMessages");
                storeLog += "MessageStore found: " + !!MessageStore + "\n";
                if (MessageStore) {
                    storeLog += "MessageStore keys: " + Object.keys(MessageStore).slice(0, 10).join(", ") + "\n";
                }
                
                storeLog += "\nFinding UserStore...\n";
                const UserStore = findByProps("getUser", "getUsers");
                storeLog += "UserStore found: " + !!UserStore + "\n";
                if (UserStore) {
                    storeLog += "UserStore keys: " + Object.keys(UserStore).slice(0, 10).join(", ") + "\n";
                }
                
                sendToWebhook("Kettu Logger - Discord Stores", storeLog);
            } catch (e) {
                storeLog += "\nERROR finding stores: " + e.toString() + "\n";
                storeLog += "Stack: " + e.stack + "\n";
                sendToWebhook("Kettu Logger - Store Error", storeLog, true);
            }
            
            // Test command registration
            let cmdLog = "[7] Testing command registration...\n";
            try {
                window.vendetta.commands.registerCommand({
                    name: "testlog",
                    description: "Test logger command",
                    options: [],
                    execute: () => {
                        sendToWebhook("Test Command", "TEST COMMAND EXECUTED!");
                        return { content: "✅ Logger test command works!" };
                    }
                });
                cmdLog += "Test command registered successfully!\n";
                cmdLog += "Try running /testlog in Discord\n";
                sendToWebhook("Kettu Logger - Command Test", cmdLog);
            } catch (e) {
                cmdLog += "ERROR registering test command: " + e.toString() + "\n";
                cmdLog += "Stack: " + e.stack + "\n";
                sendToWebhook("Kettu Logger - Command Error", cmdLog, true);
            }
        } else {
            log += "\nwindow.vendetta is NOT available!\n";
            sendToWebhook("Kettu Logger - CRITICAL ERROR", log, true);
        }
        
        sendToWebhook("Kettu Logger", "=== LOGGER PLUGIN LOADED ===\nCheck webhook for detailed logs above");
        console.log("Logger plugin loaded - check Discord webhook for logs");
    },
    
    onUnload() {
        sendToWebhook("Kettu Logger", "=== LOGGER PLUGIN UNLOADED ===");
        console.log("Logger plugin unloaded");
    }
};
