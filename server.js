
const fastify = require('fastify');
const path = require('path');
const fs = require('fs');
const os = require('os');
const selfsigned = require('selfsigned');

const USERS_FILE = path.resolve(__dirname, 'users.json');
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const CERT_DIR = path.resolve(__dirname, 'certs');
const ADMIN_PASS = "f00t=ba11";

if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, JSON.stringify({}));

function getLocalIPs() {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
        }
    }
    return ips;
}

const ADJECTIVES = ["Quantum", "Neon", "Spectral", "Cyber", "Zenith", "Silent", "Hidden", "Azure", "Golden", "Iron", "Vivid", "Primal", "Void", "Coded", "Lunar", "Alpha", "Omega", "Sonic", "Static"];
const NOUNS = ["Cipher", "Falcon", "Nomad", "Shadow", "Ray", "Pulse", "Cortex", "Zenith", "Spark", "Orbit", "Echo", "Atlas", "Sentry", "Vector", "Ghost", "Titan", "Vanguard", "Apex", "Wraith"];

function generateCoolName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
    return `${adj} ${noun}`;
}

const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');
let credentials = {};

if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    credentials = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
} else {
    console.log("[SSL] Generating Root-Level LAN Certificate...");
    const ips = getLocalIPs();
    const altNames = ips.map(ip => ({ type: 7, ip }));
    altNames.push({ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' });

    const pems = selfsigned.generate([{ name: 'commonName', value: 'NetlessLAN' }], {
        days: 365,
        keySize: 2048,
        algorithm: 'sha256',
        extensions: [
            { name: 'basicConstraints', cA: true },
            { name: 'subjectAltName', altNames }
        ]
    });
    fs.writeFileSync(keyPath, pems.private);
    fs.writeFileSync(certPath, pems.cert);
    credentials = { key: pems.private, cert: pems.cert };
}

const app = fastify({
    logger: false,
    https: credentials,
    disableRequestLogging: true,
    keepAliveTimeout: 120000,
    connectionTimeout: 60000
});

app.register(require('@fastify/websocket'), {
    options: {
        maxPayload: 100 * 1024 * 1024, // 100MB max support
        clientTracking: true,
        perMessageDeflate: false
    }
});

const clients = new Map();

function broadcast(data, exclude = null) {
    const payload = JSON.stringify(data);
    for (const [conn] of clients.entries()) {
        if (conn !== exclude && conn.socket.readyState === 1) {
            try { conn.socket.send(payload); } catch (e) { }
        }
    }
}

function sendOnlineList() {
    const uniqueUsers = new Map();
    for (const info of clients.values()) {
        if (!uniqueUsers.has(info.uid)) {
            uniqueUsers.set(info.uid, {
                username: info.username,
                isAdmin: info.isAdmin
            });
        }
    }
    broadcast({ type: 'online_users', users: Array.from(uniqueUsers.values()) });
}

app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (connection, req) => {
        req.socket.setNoDelay(true);
        connection.socket.isAlive = true;
        connection.socket.on('pong', () => { connection.socket.isAlive = true; });

        connection.socket.on('message', (data, isBinary) => {
            if (isBinary) {
                try {
                    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
                    const mLen = dv.getUint32(0);
                    const meta = JSON.parse(new TextDecoder().decode(data.slice(4, 4 + mLen)));

                    // Only broadcast "incoming" signal on the very first chunk to avoid spamming clients
                    if (meta.chunkIndex === 0) {
                        broadcast({ type: 'transfer_incoming', meta }, connection);
                    }

                    // Efficiently relay binary data
                    for (const [client] of clients) {
                        if (client !== connection && client.socket.readyState === 1) {
                            try { client.socket.send(data, { binary: true }); } catch (e) {
                                clients.delete(client);
                                client.socket.terminate();
                            }
                        }
                    }

                    // Completion signal only on the last chunk
                    if (meta.chunkIndex === (meta.totalChunks - 1)) {
                        broadcast({ type: 'transfer_progress', messageId: meta.id, percent: 100 });
                    }
                } catch (e) {
                    console.error("[BINARY RELAY ERR]", e);
                }
                return;
            }

            try {
                const msg = JSON.parse(data.toString());
                const info = clients.get(connection);

                if (msg.type === 'identify') {
                    for (const [conn, existing] of clients.entries()) {
                        if (existing.uid === msg.uid && conn !== connection) {
                            try { conn.socket.terminate(); } catch (e) { }
                            clients.delete(conn);
                        }
                    }

                    const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}');
                    if (!users[msg.uid]) {
                        users[msg.uid] = generateCoolName();
                    }
                    fs.writeFileSync(USERS_FILE, JSON.stringify(users));

                    const username = users[msg.uid];
                    clients.set(connection, { uid: msg.uid, username, isAdmin: false, isTyping: false });

                    connection.socket.send(JSON.stringify({ type: 'identity_confirmed', username }));
                    broadcast({ type: 'system', text: `${username} joined` }, connection);
                    sendOnlineList();
                    return;
                }

                if (!info) return;

                switch (msg.type) {
                    case 'chat':
                        if (msg.text.startsWith('/admin ') && msg.text.endsWith(ADMIN_PASS)) {
                            info.isAdmin = true;
                            connection.socket.send(JSON.stringify({ type: 'admin_status', isAdmin: true }));
                            broadcast({ type: 'system', text: `${info.username} promoted to Admin` });
                            sendOnlineList();
                        } else {
                            broadcast({
                                type: 'chat',
                                id: msg.id || 'm-' + Date.now(),
                                sender: info.username,
                                isAdmin: info.isAdmin,
                                text: msg.text,
                                timestamp: Date.now()
                            });
                        }
                        info.isTyping = false;
                        updateTyping();
                        break;
                    case 'delete':
                        if (info.isAdmin || msg.sender === info.username) broadcast(msg);
                        break;
                    case 'edit':
                        if (info.isAdmin) {
                            broadcast({ type: 'edit_broadcast', messageId: msg.messageId, newText: msg.newText });
                        }
                        break;
                    case 'reaction':
                        broadcast({ type: 'reaction', messageId: msg.messageId, reactor: info.username, symbol: msg.symbol });
                        break;
                    case 'typing':
                        info.isTyping = msg.isTyping;
                        updateTyping();
                        break;
                    case 'rename':
                        const old = info.username;
                        const next = msg.name.trim().substring(0, 15);
                        if (next && next !== old) {
                            const users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}');
                            info.username = next;
                            users[info.uid] = next;
                            fs.writeFileSync(USERS_FILE, JSON.stringify(users));
                            broadcast({ type: 'system', text: `${old} is now ${next}` });
                            connection.socket.send(JSON.stringify({ type: 'name_updated', name: next }));
                            sendOnlineList();
                        }
                        break;
                }
            } catch (e) { console.error("[WS MSG ERR]", e); }
        });

        connection.socket.on('close', () => {
            const info = clients.get(connection);
            if (info) {
                broadcast({ type: 'system', text: `${info.username} disconnected` });
                clients.delete(connection);
                sendOnlineList();
                updateTyping();
            }
        });
    });
});

function updateTyping() {
    const typingUsers = Array.from(clients.values())
        .filter(c => c.isTyping)
        .map(c => c.username);
    broadcast({ type: 'typing_update', users: typingUsers });
}

app.register(require('@fastify/static'), {
    root: PUBLIC_DIR,
    prefix: '/'
});

setInterval(() => {
    for (const [conn] of clients.entries()) {
        if (conn.socket.isAlive === false) {
            clients.delete(conn);
            return conn.socket.terminate();
        }
        conn.socket.isAlive = false;
        try { conn.socket.ping(); } catch (e) { }
    }
}, 20000);

const PORT = 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) { console.error(err); process.exit(1); }
    const ips = getLocalIPs();
    console.log(`\nNETLESS FRAGMENTED LAN\n========================`);
    ips.forEach(ip => console.log(`LINK: https://${ip}:${PORT}`));
});
