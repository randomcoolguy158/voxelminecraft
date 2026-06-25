'use strict';
const WebSocket = require('ws');
const http      = require('http');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const PORT          = 8080;
const SAVE_INTERVAL = 30000;
const DATA_FILE     = path.join(__dirname, 'world_data.json');

// ── World state ───────────────────────────────────────────────────────────────
let worldData = { seeds: null, placedBlocks: {}, removedKeys: [] };

function loadWorld() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            worldData = { ...worldData, ...JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) };
            console.log(`[World] Loaded. Placed: ${Object.keys(worldData.placedBlocks).length}, Removed: ${worldData.removedKeys.length}`);
        }
    } catch(e) { console.error('[World] Load failed:', e.message); }
}
function saveWorld() {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(worldData, null, 2)); }
    catch(e) { console.error('[World] Save failed:', e.message); }
}
loadWorld();
setInterval(saveWorld, SAVE_INTERVAL);

// ── Players ───────────────────────────────────────────────────────────────────
// id -> { id, ws, name, x, y, z, yaw, pitch, health, hunger, hotbar, storage, lastSeen }
const players = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function gk(x, y, z) { return `${Math.round(x)},${Math.round(y)},${Math.round(z)}`; }

function send(ws, msg) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg, excludeId = null) {
    const raw = JSON.stringify(msg);
    for (const [id, p] of players) {
        if (id === excludeId) continue;
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(raw);
    }
}

const VALID_TYPES = new Set([
    'grass','dirt','wood','leaves','planks','stone','coal_ore','iron_ore',
    'diamond_ore','sand','water','glass','wool','crafting_table','furnace',
    'chest','torch','bed'
]);

// ── HTTP server (serves index.html) ───────────────────────────────────────────
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(404); res.end('Not found'); return; }
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end(); }
});

// ── WebSocket server ───────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    const id = uuidv4();
    let player = null;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        switch (msg.type) {

            case 'join': {
                const name = String(msg.name || 'Player').slice(0, 20).replace(/[<>&"]/g, '');
                player = {
                    id, ws, name,
                    x: Number(msg.x) || 0,
                    y: Number(msg.y) || 10,
                    z: Number(msg.z) || 0,
                    yaw: 0, pitch: 0,
                    health:  Number(msg.health)  || 10,
                    hunger:  Number(msg.hunger)  || 10,
                    hotbar:  Array.isArray(msg.hotbar)  ? msg.hotbar  : [],
                    storage: Array.isArray(msg.storage) ? msg.storage : [],
                    lastSeen: Date.now()
                };
                players.set(id, player);

                // First player establishes world seeds
                if (!worldData.seeds && msg.seeds && typeof msg.seeds === 'object') {
                    worldData.seeds = msg.seeds;
                    saveWorld();
                }

                // Build list of currently connected players for the new joiner
                const others = [];
                for (const [pid, p] of players) {
                    if (pid === id) continue;
                    others.push({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, yaw: p.yaw });
                }

                send(ws, {
                    type: 'init', playerId: id,
                    seeds:        worldData.seeds,
                    placedBlocks: worldData.placedBlocks,
                    removedKeys:  worldData.removedKeys,
                    players: others
                });

                broadcast({ type: 'player_join', id, name, x: player.x, y: player.y, z: player.z, yaw: 0 }, id);
                console.log(`[+] ${name} joined. Online: ${players.size}`);
                break;
            }

            case 'move': {
                if (!player) return;
                // Sanity: reject teleports > 50 units per tick
                if (Math.abs(Number(msg.x) - player.x) > 50 || Math.abs(Number(msg.z) - player.z) > 50) return;
                player.x = Number(msg.x); player.y = Number(msg.y); player.z = Number(msg.z);
                player.yaw = Number(msg.yaw); player.pitch = Number(msg.pitch);
                player.lastSeen = Date.now();
                broadcast({ type: 'player_move', id, x: player.x, y: player.y, z: player.z, yaw: player.yaw }, id);
                break;
            }

            case 'place': {
                if (!player) return;
                const btype = msg.blockType;
                if (!VALID_TYPES.has(btype)) return;
                const key = gk(msg.x, msg.y, msg.z);
                if (worldData.placedBlocks[key]) return; // already exists — reject
                // Remove from removedKeys if present
                const ri = worldData.removedKeys.indexOf(key);
                if (ri !== -1) worldData.removedKeys.splice(ri, 1);
                worldData.placedBlocks[key] = {
                    type: btype,
                    x: Math.round(msg.x), y: Math.round(msg.y), z: Math.round(msg.z)
                };
                broadcast({ type: 'block_placed', x: msg.x, y: msg.y, z: msg.z, blockType: btype, playerId: id }, null);
                break;
            }

            case 'break': {
                if (!player) return;
                const key = gk(msg.x, msg.y, msg.z);
                if (worldData.placedBlocks[key]) {
                    delete worldData.placedBlocks[key];
                } else {
                    if (!worldData.removedKeys.includes(key)) worldData.removedKeys.push(key);
                }
                broadcast({ type: 'block_broken', x: msg.x, y: msg.y, z: msg.z, playerId: id }, null);
                break;
            }

            case 'state': {
                if (!player) return;
                player.health  = Number(msg.health)  || player.health;
                player.hunger  = Number(msg.hunger)  || player.hunger;
                player.hotbar  = Array.isArray(msg.hotbar)  ? msg.hotbar  : player.hotbar;
                player.storage = Array.isArray(msg.storage) ? msg.storage : player.storage;
                player.lastSeen = Date.now();
                break;
            }
        }
    });

    ws.on('close', () => {
        if (!player) return;
        players.delete(id);
        broadcast({ type: 'player_leave', id }, id);
        console.log(`[-] ${player.name} left. Online: ${players.size}`);
    });

    ws.on('error', (e) => console.error(`[WS Error] ${id}:`, e.message));
});

// ── AFK kick every 5 s ────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    for (const [pid, p] of players) {
        if (now - p.lastSeen > 30000) {
            p.ws.terminate();
            players.delete(pid);
            broadcast({ type: 'player_leave', id: pid });
            console.log(`[Kick] AFK: ${p.name}`);
        }
    }
}, 5000);

process.on('SIGINT', () => { console.log('\n[Server] Saving & shutting down...'); saveWorld(); process.exit(0); });

server.listen(PORT, () => {
    console.log(`[Server] http://localhost:${PORT}  |  ws://localhost:${PORT}`);
});