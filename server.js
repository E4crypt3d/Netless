
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

const isLowResource = process.env.PREFIX?.includes('com.termux') || os.arch().startsWith('arm');
const BACKPRESSURE_THRESHOLD = isLowResource ? 128 * 1024 : 1024 * 1024;
const FRAGMENT_SIZE = isLowResource ? 16 * 1024 : 64 * 1024;
const SEND_TIMEOUT = 15000; // 15s timeout for a single client send

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

async function sendInFragments(ws, buffer) {
    const total = buffer.byteLength;
    const start = Date.now();
    for (let offset = 0; offset < total; offset += FRAGMENT_SIZE) {
        if (ws.readyState !== WebSocket.OPEN || (Date.now() - start > SEND_TIMEOUT)) break;
        const isLast = (offset + FRAGMENT_SIZE) >= total;
        const chunk = buffer.slice(offset, isLast ? total : offset + FRAGMENT_SIZE);
        while (ws.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            if (Date.now() - start > SEND_TIMEOUT) return;
            await new Promise(r => setTimeout(r, 40));
        }
        await new Promise(res => ws.send(chunk, { fin: isLast, binary: true, compress: false }, res));
        if (!isLast) await new Promise(res => setImmediate(res));
    }
}

async function processBinaryQueue() {
    if (isProcessingBinary || binaryBroadcastQueue.length === 0) return;
    isProcessingBinary = true;
    let payload = binaryBroadcastQueue.shift();
    const targets = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);
    for (const client of targets) {
        await sendInFragments(client, payload);
        await new Promise(res => setImmediate(res));
    }
    payload = null;
    isProcessingBinary = false;
    setImmediate(processBinaryQueue);
}

function broadcastBinarySafely(data) {
    binaryBroadcastQueue.push(data);
    while (binaryBroadcastQueue.length > 1) binaryBroadcastQueue.shift();
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
                if (!users[msg.uid]) { users[msg.uid] = generateRandomName(); saveUsers(users); }
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
                broadcast({ type: 'chat', id: 'm-' + Date.now(), sender: info.username, text: msg.text, timestamp: Date.now() });
            } else if (msg.type === 'typing') {
                info.isTyping = msg.isTyping;
                broadcastTypingStatus();
            } else if (msg.type === 'rename') {
                const old = info.username;
                const next = msg.name.trim().substring(0, 15);
                if (next && next !== old) {
                    const users = getUsers();
                    info.username = next; users[info.uid] = next; saveUsers(users);
                    broadcast({ type: 'system', text: `${old} is now ${next}` });
                    ws.send(JSON.stringify({ type: 'name_updated', name: next }));
                    broadcastTypingStatus();
                }
            } else if (msg.type === 'delete' || msg.type === 'reaction') {
                broadcast(msg);
            }
        } catch (e) { }
    });
    ws.on('close', () => {
        const info = clients.get(ws);
        if (info) { broadcast({ type: 'system', text: `${info.username} left` }); clients.delete(ws); broadcastTypingStatus(); }
    });
});

async function broadcastTypingStatus() {
    const users = Array.from(clients.values()).filter(c => c.isTyping).map(c => c.username);
    await broadcast({ type: 'typing_update', users });
}

async function broadcast(data, exclude = null) {
    const payload = JSON.stringify(data);
    const targets = Array.from(wss.clients).filter(c => c !== exclude && c.readyState === WebSocket.OPEN);
    for (const client of targets) {
        const start = Date.now();
        while (client.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            if (Date.now() - start > 5000) break;
            await new Promise(r => setTimeout(r, 30));
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
    console.log(`\nNETLESS: LAN Chat Server - [Mode: ${isLowResource ? 'TERMUX' : 'NORMAL'}]`);
    addresses.forEach(ip => console.log(`LAN: https://${ip}:${PORT}`));
});
