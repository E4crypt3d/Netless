
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
const ADMIN_PASS = "netlessadmin";

const isLowResource = process.env.PREFIX?.includes('com.termux') || os.arch().startsWith('arm');
const BACKPRESSURE_THRESHOLD = isLowResource ? 64 * 1024 : 1024 * 1024;
const SEND_TIMEOUT = 60000;

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
    maxPayload: 30 * 1024 * 1024
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

async function processBinaryQueue() {
    if (isProcessingBinary || binaryBroadcastQueue.length === 0) return;
    isProcessingBinary = true;

    let { payload, meta } = binaryBroadcastQueue.shift();
    const targets = Array.from(wss.clients).filter(c => c.readyState === WebSocket.OPEN);

    broadcastJson({ type: 'transfer_incoming', meta });

    for (const client of targets) {
        if (client.readyState !== WebSocket.OPEN) continue;

        let clientWaitStart = Date.now();
        while (client.bufferedAmount > BACKPRESSURE_THRESHOLD) {
            if (Date.now() - clientWaitStart > 10000) break;
            await new Promise(r => setTimeout(r, 100));
        }

        client.send(payload, { binary: true, compress: false });
        await new Promise(res => setImmediate(res));
    }

    broadcastJson({ type: 'transfer_progress', messageId: meta.id, percent: 100 });

    payload = null;
    isProcessingBinary = false;
    setImmediate(processBinaryQueue);
}

function broadcastBinarySafely(data) {
    try {
        const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const mLen = dv.getUint32(0);
        const meta = JSON.parse(new TextDecoder().decode(data.slice(4, 4 + mLen)));

        binaryBroadcastQueue.push({ payload: data, meta });
        data = null;

        while (binaryBroadcastQueue.length > 2) binaryBroadcastQueue.shift();
        processBinaryQueue();
    } catch (e) {
        console.error("Binary metadata extraction failed", e);
    }
}

async function broadcastJson(data, exclude = null) {
    const payload = JSON.stringify(data);
    for (const client of wss.clients) {
        if (client !== exclude && client.readyState === WebSocket.OPEN) {
            if (client.bufferedAmount < BACKPRESSURE_THRESHOLD) {
                client.send(payload);
            }
        }
    }
}

function broadcastOnlineUsers() {
    const users = Array.from(clients.values()).map(c => ({
        username: c.username,
        isAdmin: c.isAdmin
    }));
    broadcastJson({ type: 'online_users', users });
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
                clients.set(ws, { uid: msg.uid, username, isTyping: false, isAdmin: false });
                ws.send(JSON.stringify({ type: 'identity_confirmed', username }));
                broadcastJson({ type: 'system', text: `${username} joined` }, ws);
                broadcastOnlineUsers();
                return;
            }

            const info = clients.get(ws);
            if (!info) return;

            if (msg.type === 'chat') {
                if (msg.text.startsWith('/admin')) {
                    if (msg.text.startsWith('/admin ')) {
                        const pass = msg.text.substring(7).trim();
                        if (pass === ADMIN_PASS) {
                            info.isAdmin = true;
                            ws.send(JSON.stringify({ type: 'admin_status', isAdmin: true }));
                            broadcastJson({ type: 'system', text: `${info.username} is now an ADMIN` });
                            broadcastOnlineUsers();
                        }
                    }
                    return;
                }

                info.isTyping = false;
                broadcastTypingStatus();
                const msgId = msg.id || 'm-' + Date.now();
                broadcastJson({
                    type: 'chat',
                    id: msgId,
                    sender: info.username,
                    isAdmin: info.isAdmin,
                    text: msg.text,
                    timestamp: Date.now()
                });
            } else if (msg.type === 'typing') {
                info.isTyping = msg.isTyping;
                broadcastTypingStatus();
            } else if (msg.type === 'rename') {
                const old = info.username;
                const next = msg.name.trim().substring(0, 15);
                if (next && next !== old) {
                    const users = getUsers();
                    info.username = next; users[info.uid] = next; saveUsers(users);
                    broadcastJson({ type: 'system', text: `${old} is now ${next}` });
                    ws.send(JSON.stringify({ type: 'name_updated', name: next }));
                    broadcastTypingStatus();
                    broadcastOnlineUsers();
                }
            } else if (msg.type === 'delete') {
                broadcastJson(msg);
            } else if (msg.type === 'edit') {
                if (info.isAdmin) {
                    broadcastJson({
                        type: 'edit_broadcast',
                        messageId: msg.messageId,
                        newText: msg.newText
                    });
                }
            } else if (msg.type === 'reaction') {
                broadcastJson(msg);
            }
        } catch (e) { }
    });

    ws.on('close', () => {
        const info = clients.get(ws);
        if (info) {
            broadcastJson({ type: 'system', text: `${info.username} left` });
            clients.delete(ws);
            broadcastTypingStatus();
            broadcastOnlineUsers();
        }
    });
});

function broadcastTypingStatus() {
    const users = Array.from(clients.values()).filter(c => c.isTyping).map(c => c.username);
    broadcastJson({ type: 'typing_update', users });
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
