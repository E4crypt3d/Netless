const express = require('express');
const https = require('https');
const WebSocket = require('ws');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');
const os = require('os');
const { exec, spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const USERS_FILE = path.resolve(__dirname, 'users.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const CERT_DIR = path.resolve(__dirname, 'certs');
const ADMIN_PASS = "netlessadmin";

const IS_TERMUX = process.env.PREFIX?.includes('com.termux') ||
    fs.existsSync('/data/data/com.termux/files/usr/bin/bash') ||
    os.userInfo().homedir.includes('com.termux');
const isLowResource = IS_TERMUX || os.arch().startsWith('arm');
const BACKPRESSURE_THRESHOLD = isLowResource ? 64 * 1024 : 1024 * 1024;
const SEND_TIMEOUT = 60000;

class TermuxOptimizer {
    constructor() {
        this.wakelockActive = false;
        this.notificationActive = false;
        this.keepAliveInterval = null;

        if (IS_TERMUX) {
            console.log('🔋 Termux detected - enabling battery optimization bypass...');
            this.setupOptimizations();
        }
    }

    setupOptimizations() {
        this.tryDisableBatteryOptimization();
        this.setupWakelock();
        this.setupNotification();
        this.startKeepAlive();
        this.increasePriority();
    }

    tryDisableBatteryOptimization() {
        const commands = [
            'termux-battery-optimization -i',
            'settings put global app_standby_enabled 0',
            'dumpsys deviceidle whitelist +com.termux'
        ];

        commands.forEach(cmd => {
            exec(cmd, (error) => {
                if (!error) console.log(`✓ ${cmd.split(' ')[0]} executed`);
            });
        });
    }

    setupWakelock() {
        exec('which termux-wake-lock', (err, stdout) => {
            if (!err && stdout.includes('termux-wake-lock')) {
                exec('termux-wake-lock NetlessServer', (err) => {
                    if (!err) {
                        this.wakelockActive = true;
                        console.log('✓ Wakelock acquired');

                        process.on('exit', () => {
                            exec('termux-wake-unlock NetlessServer');
                        });
                    }
                });
            } else {
                console.log('⚠ termux-wake-lock not found, using fallback');
            }
        });
    }

    setupNotification() {
        exec('which termux-notification', (err, stdout) => {
            if (!err && stdout.includes('termux-notification')) {
                const notifCmd = [
                    'termux-notification',
                    '--id', 'netless_server',
                    '--title', 'Netless LAN Chat',
                    '--content', `Server running on port ${PORT}`,
                    '--ongoing',
                    '--priority', 'max',
                    '--button1', 'Stop',
                    '--button1-action', `pkill -f "node ${__filename}" && termux-notification --id netless_server --cancel`
                ].join(' ');

                exec(notifCmd, (err) => {
                    if (!err) {
                        this.notificationActive = true;
                        console.log('✓ Persistent notification created');
                    }
                });
            }
        });
    }

    startKeepAlive() {
        this.keepAliveInterval = setInterval(() => {
            try {
                fs.appendFileSync('/tmp/netless_keepalive.log',
                    `${new Date().toISOString()}\n`);
            } catch (e) { }

            const dgram = require('dgram');
            const socket = dgram.createSocket('udp4');
            socket.bind(() => {
                socket.close();
            });

            if (this.notificationActive) {
                exec(`termux-notification --id netless_server --content "Active: ${new Date().toLocaleTimeString()}"`,
                    () => { });
            }

            console.log(`[KeepAlive] ${new Date().toLocaleTimeString()}`);
        }, 15000); // 15 seconds
    }

    increasePriority() {
        try {
            if (process.setPriority) {
                process.setPriority(10); // High priority
            }
            if (os.platform() !== 'win32') {
                process.setuid?.(process.getuid?.());
            }
        } catch (e) {
        }
    }

    cleanup() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
        }

        if (this.wakelockActive) {
            exec('termux-wake-unlock NetlessServer', () => { });
        }

        if (this.notificationActive) {
            exec('termux-notification --id netless_server --cancel', () => { });
        }
    }
}

const termuxOptimizer = new TermuxOptimizer();

process.on('exit', () => termuxOptimizer.cleanup());
process.on('SIGINT', () => {
    termuxOptimizer.cleanup();
    process.exit();
});
process.on('SIGTERM', () => {
    termuxOptimizer.cleanup();
    process.exit();
});

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

// Auto-restart mechanism for Termux if process gets killed
if (IS_TERMUX) {
    process.on('uncaughtException', (err) => {
        console.error('Uncaught exception, restarting:', err.message);
        setTimeout(() => {
            require('child_process').exec(`node "${__filename}"`, {
                cwd: __dirname,
                detached: true,
                stdio: 'ignore'
            });
        }, 1000);
    });
}

const interfaces = os.networkInterfaces();
const addresses = [];
for (let k in interfaces) {
    for (let k2 in interfaces[k]) {
        let addr = interfaces[k][k2];
        if (addr.family === 'IPv4' && !addr.internal) addresses.push(addr.address);
    }
}

server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 NETLESS: LAN Chat Server - [Mode: ${IS_TERMUX ? 'TERMUX' : 'NORMAL'}]`);
    console.log(`📱 Battery optimization bypass: ${IS_TERMUX ? 'ACTIVE' : 'Not needed'}`);
    addresses.forEach(ip => console.log(`🌐 LAN: https://${ip}:${PORT}`));
    console.log(`🔒 HTTPS with self-signed cert (accept warning in browser)`);

    // Extra Termux instructions
    if (IS_TERMUX) {
        console.log('\n📋 For best Termux experience:');
        console.log('1. Keep Termux in foreground or use "Termux:Widget"');
        console.log('2. If killed, it will auto-restart');
        console.log('3. Notification shows server status');
    }
});