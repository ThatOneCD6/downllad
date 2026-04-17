// Console Logger Plugin for Kettu/Vendetta
// Logs all Vendetta API availability and plugin loading info

module.exports = {
    onLoad() {
        console.log("=== LOGGER PLUGIN STARTED ===");
        console.log("Timestamp:", new Date().toISOString());
        
        // Check if window.vendetta exists
        console.log("\n[1] Checking window.vendetta...");
        console.log("window.vendetta exists:", !!window.vendetta);
        
        if (window.vendetta) {
            console.log("window.vendetta keys:", Object.keys(window.vendetta));
            
            // Check metro
            console.log("\n[2] Checking window.vendetta.metro...");
            console.log("metro exists:", !!window.vendetta.metro);
            if (window.vendetta.metro) {
                console.log("metro keys:", Object.keys(window.vendetta.metro));
                console.log("findByProps exists:", !!window.vendetta.metro.findByProps);
            }
            
            // Check patcher
            console.log("\n[3] Checking window.vendetta.patcher...");
            console.log("patcher exists:", !!window.vendetta.patcher);
            if (window.vendetta.patcher) {
                console.log("patcher keys:", Object.keys(window.vendetta.patcher));
                console.log("after exists:", !!window.vendetta.patcher.after);
            }
            
            // Check storage
            console.log("\n[4] Checking window.vendetta.storage...");
            console.log("storage exists:", !!window.vendetta.storage);
            if (window.vendetta.storage) {
                console.log("storage keys:", Object.keys(window.vendetta.storage));
            }
            
            // Check commands
            console.log("\n[5] Checking window.vendetta.commands...");
            console.log("commands exists:", !!window.vendetta.commands);
            if (window.vendetta.commands) {
                console.log("commands keys:", Object.keys(window.vendetta.commands));
                console.log("registerCommand exists:", !!window.vendetta.commands.registerCommand);
            }
            
            // Try to find Discord stores
            console.log("\n[6] Attempting to find Discord stores...");
            try {
                const findByProps = window.vendetta.metro.findByProps;
                
                console.log("Finding Dispatcher...");
                const Dispatcher = findByProps("dispatch", "_subscriptions");
                console.log("Dispatcher found:", !!Dispatcher);
                if (Dispatcher) {
                    console.log("Dispatcher keys:", Object.keys(Dispatcher).slice(0, 10));
                }
                
                console.log("Finding MessageStore...");
                const MessageStore = findByProps("getMessage", "getMessages");
                console.log("MessageStore found:", !!MessageStore);
                if (MessageStore) {
                    console.log("MessageStore keys:", Object.keys(MessageStore).slice(0, 10));
                }
                
                console.log("Finding UserStore...");
                const UserStore = findByProps("getUser", "getUsers");
                console.log("UserStore found:", !!UserStore);
                if (UserStore) {
                    console.log("UserStore keys:", Object.keys(UserStore).slice(0, 10));
                }
            } catch (e) {
                console.error("ERROR finding stores:", e);
                console.error("Stack:", e.stack);
            }
            
            // Test command registration
            console.log("\n[7] Testing command registration...");
            try {
                window.vendetta.commands.registerCommand({
                    name: "testlog",
                    description: "Test logger command",
                    options: [],
                    execute: () => {
                        console.log("TEST COMMAND EXECUTED!");
                        return { content: "✅ Logger test command works!" };
                    }
                });
                console.log("Test command registered successfully!");
            } catch (e) {
                console.error("ERROR registering test command:", e);
                console.error("Stack:", e.stack);
            }
        } else {
            console.error("window.vendetta is NOT available!");
        }
        
        console.log("\n=== LOGGER PLUGIN LOADED ===");
        console.log("Check console for detailed info above");
    },
    
    onUnload() {
        console.log("=== LOGGER PLUGIN UNLOADED ===");
    }
};
