
const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.resolve(__dirname, 'users.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const CERT_DIR = path.resolve(__dirname, 'certs');

// Threshold for WebSocket backpressure (512KB)
const BACKPRESSURE_THRESHOLD = 512 * 1024;
// Internal fragmentation size (32KB) - Optimized for Android TCP windows
const FRAGMENT_SIZE = 32 * 1024;

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}));

let credentials = {};
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');

function generateCerts() {
    const attrs = [{ name: 'commonName', value: 'netless.lan' }];
    const pems = selfsigned.generate(attrs, { days: 365, keySize: 2048, algorithm: 'sha256' });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    return { key: pems.private, cert: pems.cert };
}

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    credentials = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
} else {
    credentials = generateCerts();
}

const server = https.createServer(credentials, app);
const wss = new WebSocket.Server({
    server,
    maxPayload: 20 * 1024 * 1024
});

function getUsers() {
    try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { return {}; }
}

function saveUsers(users) {
    try { fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); } catch (e) { console.error('Save failed', e); }
}

function generateRandomName() {
    const adj = ['Swift', 'Quiet', 'Bright', 'Bold', 'Calm', 'Deep', 'Fast', 'Kind', 'Zesty', 'Solar'];
    const noun = ['Panda', 'Eagle', 'River', 'Mountain', 'Cloud', 'Stone', 'Leaf', 'Star', 'Falcon', 'Tide'];
    return `${adj[Math.floor(Math.random() * adj.length)]}${noun[Math.floor(Math.random() * noun.length)]}`;
}

app.use(compression());
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

const clients = new Map();
const binaryBroadcastQueue = [];
let isProcessingBinary = false;

/**
 * Sends a buffer using WebSocket fragmentation (RFC 6455).
 * Fragmentation is internal; browsers reassemble it before firing 'onmessage'.
 */
async function sendInFragments(ws, buffer) {
    for (let offset = 0; offset < buffer.byteLength; offset += FRAGMENT_SIZE) {
        const isLast = (offset + FRAGMENT_SIZE) >= buffer.byteLength;
        const chunk = buffer.slice(offset, offset + FRAGMENT_SIZE);

        // Block until buffer drains - prevents heap-overflow freezes on Termux
        while (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            await new Promise(r => setTimeout(r, 20));
        }

        await new Promise(res => ws.send(chunk, {
            fin: isLast,
            binary: true,
            compress: false
        }, res));

        // Yield to allow system I/O and event loop breathing
        if (!isLast) await new Promise(res => setImmediate(res));
    }
}

async function processBinaryQueue() {
    if (isProcessingBinary || binaryBroadcastQueue.length === 0) return;
    isProcessingBinary = true;

    const data = binaryBroadcastQueue.shift();
    const targetClients = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);

    for (const client of targetClients) {
        await sendInFragments(client, data);
        await new Promise(resolve => setImmediate(resolve));
    }

    isProcessingBinary = false;
    processBinaryQueue();
}

function broadcastBinarySafely(data) {
    binaryBroadcastQueue.push(data);
    if (binaryBroadcastQueue.length > 5) binaryBroadcastQueue.shift();
    processBinaryQueue();
}

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            broadcastBinarySafely(Buffer.isBuffer(data) ? data : Buffer.from(data));
            return;
        }

        try {
            const msg = JSON.parse(data.toString());
            if (msg.type === 'identify') {
                const users = getUsers();
                if (!users[msg.uid]) {
                    users[msg.uid] = generateRandomName();
                    saveUsers(users);
                }
                const username = users[msg.uid];
                clients.set(ws, { uid: msg.uid, username, isTyping: false });
                ws.send(JSON.stringify({ type: 'identity_confirmed', username }));
                broadcast({ type: 'system', text: `${username} joined` }, ws);
                return;
            }

            const info = clients.get(ws);
            if (!info) return;

            if (msg.type === 'chat') {
                info.isTyping = false;
                broadcastTypingStatus();
                broadcast({
                    type: 'chat',
                    id: 'm-' + Date.now() + Math.random().toString(36).substr(2, 5),
                    sender: info.username,
                    text: msg.text,
                    timestamp: Date.now()
                });
            } else if (msg.type === 'typing') {
                info.isTyping = msg.isTyping;
                broadcastTypingStatus();
            } else if (msg.type === 'rename') {
                const oldName = info.username;
                const newName = msg.name.trim().substring(0, 15);
                if (newName && newName !== oldName) {
                    const users = getUsers();
                    info.username = newName;
                    users[info.uid] = newName;
                    saveUsers(users);
                    broadcast({ type: 'system', text: `${oldName} is now ${newName}` });
                    ws.send(JSON.stringify({ type: 'name_updated', name: newName }));
                    broadcastTypingStatus();
                }
            } else if (msg.type === 'delete' || msg.type === 'reaction') {
                broadcast(msg);
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        const info = clients.get(ws);
        if (info) {
            broadcast({ type: 'system', text: `${info.username} left` });
            clients.delete(ws);
            broadcastTypingStatus();
        }
    });
});

async function broadcastTypingStatus() {
    const typingUsers = Array.from(clients.values()).filter(c => c.isTyping).map(c => c.username);
    await broadcast({ type: 'typing_update', users: typingUsers });
}

/**
 * Async broadcast for JSON to prevent event-loop stalls during fan-out.
 */
async function broadcast(data, exclude = null) {
    const payload = JSON.stringify(data);
    const targets = Array.from(wss.clients).filter(c => c !== exclude && c.readyState === WebSocket.OPEN);

    for (const client of targets) {
        // Backpressure check - delay rather than skip for critical messages
        while (client.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            await new Promise(r => setTimeout(r, 20));
        }
        client.send(payload);
        await new Promise(res => setImmediate(res));
    }
}

setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

const interfaces = os.networkInterfaces();
const addresses = [];
for (let k in interfaces) {
    for (let k2 in interfaces[k]) {
        let addr = interfaces[k][k2];
        if (addr.family === 'IPv4' && !addr.internal) addresses.push(addr.address);
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nNETLESS: LAN Chat Server (Fragmentation Mode)`);
    console.log(`Local: https://localhost:${PORT}`);
    addresses.forEach(ip => console.log(`LAN:   https://${ip}:${PORT}`));
});
