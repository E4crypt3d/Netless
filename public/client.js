
(() => {
    let socket;
    let currentUser = '';
    let iAmAdmin = false;
    let isTyping = false, typingTimer = null;
    let isRecording = false, recCanceled = false, recStartPos = null;
    let mediaRecorder = null, audioChunks = [], recStartTime = 0, timerInt = null;
    let reactionMenu = null;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

    // FRAGMENTATION SETTINGS (1MB chunks)
    const CHUNK_SIZE = 1024 * 1024;
    const MAX_DOM_MESSAGES = isMobile ? 40 : 300;
    const BACKPRESSURE_LIMIT = isMobile ? 4 * 1024 * 1024 : 16 * 1024 * 1024;
    const SEND_TIMEOUT = 600000;

    const msgData = new Map(); // Stores message data including incoming chunks
    const objectUrls = new Set();
    const MAX_FILE = 100 * 1024 * 1024;
    const SYMBOLS = ['❤️', '⭐', '🔥', '😂', '❓'];

    const chat = document.getElementById('chat-area');
    const input = document.getElementById('msg-input');
    const btnSend = document.getElementById('btn-send');
    const btnRec = document.getElementById('btn-rec');
    const recWrap = document.getElementById('rec-wrap');
    const inputWrap = document.getElementById('text-input-wrap');
    const timer = document.getElementById('timer');
    const nameLabel = document.getElementById('display-name');
    const fileIn = document.getElementById('file-input');
    const statusLight = document.getElementById('status-light');
    const networkInfo = document.getElementById('network-info');
    const onlineToggle = document.getElementById('online-toggle');
    const onlineContainer = document.getElementById('online-list-container');
    const onlineList = document.getElementById('online-users-list');

    const TICK_CLOCK = `<svg class="tick-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4A8,8 0 0,0 12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22C6.47,22 2,17.5 2,12A10,10 0 0,1 12,2M12.5,7V12.25L17,14.92L16.25,16.15L11,13V7H12.5Z" /></svg>`;
    const TICK_SINGLE = `<svg class="tick-icon" viewBox="0 0 24 24"><path fill="currentColor" d="M21,7L9,19L3.5,13.5L4.91,12.09L9,16.17L19.59,5.59L21,7Z" /></svg>`;
    const TICK_DOUBLE = `<svg class="tick-icon delivered" viewBox="0 0 24 24"><path fill="currentColor" d="M0.41,13.41L6,19L7.41,17.58L1.83,12M22.24,5.58L11.66,16.17L7.5,12L6.07,13.41L11.66,19L23.66,7M18,7L16.59,5.58L10.24,11.93L11.66,13.34L18,7Z" /></svg>`;

    function init() {
        if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;

        let uid = localStorage.getItem('netless_uid') || ('u' + Date.now() + Math.random().toString(36).substr(2, 5));
        localStorage.setItem('netless_uid', uid);

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${location.host}/ws`;

        try {
            socket = new WebSocket(wsUrl);
            socket.binaryType = 'arraybuffer';

            socket.onopen = () => {
                socket.send(JSON.stringify({ type: 'identify', uid }));
                statusLight.className = 'status-light online';
                networkInfo.textContent = "Netless Active";
            };

            socket.onmessage = (e) => {
                if (e.data instanceof ArrayBuffer) handleBinary(e.data);
                else handleJson(JSON.parse(e.data));
            };

            socket.onclose = (ev) => {
                statusLight.className = 'status-light';
                networkInfo.textContent = "Offline - Connecting...";
                setTimeout(init, 1000);
            };

            socket.onerror = (err) => console.error("[WS] Error", err);
        } catch (e) { console.error('Socket init error:', e); }
    }

    function formatSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function handleJson(msg) {
        switch (msg.type) {
            case 'identity_confirmed': currentUser = msg.username; nameLabel.textContent = msg.username; break;
            case 'admin_status':
                iAmAdmin = msg.isAdmin;
                nameLabel.innerHTML = `${currentUser} <span class="admin-badge-small">ADMIN</span>`;
                break;
            case 'online_users':
                networkInfo.textContent = `${msg.users.length} Nearby`;
                onlineList.innerHTML = '';
                msg.users.forEach(u => {
                    const item = document.createElement('div');
                    item.className = 'online-user-item';
                    item.innerHTML = `<div class="status-dot"></div><span>${u.username}</span>${u.isAdmin ? '<span class="admin-badge-small">ADMIN</span>' : ''}`;
                    onlineList.appendChild(item);
                });
                break;
            case 'chat':
                if (!document.getElementById(msg.id)) appendChat(msg);
                else updateMsgStatus(msg.id, 'delivered');
                break;
            case 'system': appendSystem(msg.text); break;
            case 'transfer_incoming':
                if (!document.getElementById(msg.meta.id)) {
                    msgData.set(msg.meta.id, { reactions: {}, chunks: [], meta: msg.meta, lastUpdate: 0 });
                    if (msg.meta.type === 'voice') appendVoice({ ...msg.meta, loading: true });
                    else appendFile({ ...msg.meta, loading: true });
                }
                break;
            case 'transfer_progress':
                updateProgress(msg.messageId, msg.percent, msg.percent < 100 ? "Syncing" : "Delivered", true);
                if (msg.percent >= 100) updateMsgStatus(msg.messageId, 'delivered');
                break;
            case 'typing_update':
                const box = document.getElementById('typing-box');
                const others = msg.users.filter(u => u !== currentUser);
                box.textContent = others.length ? `${others.join(', ')} typing...` : '';
                box.classList.toggle('hidden', !others.length);
                break;
            case 'name_updated': currentUser = msg.name; nameLabel.textContent = msg.name; break;
            case 'delete':
                const delEl = document.getElementById(msg.messageId);
                if (delEl) {
                    const d = msgData.get(msg.messageId);
                    if (d?.url) { URL.revokeObjectURL(d.url); objectUrls.delete(d.url); }
                    msgData.delete(msg.messageId); delEl.remove();
                }
                break;
            case 'edit_broadcast':
                const editEl = document.getElementById(msg.messageId);
                if (editEl) {
                    const p = editEl.querySelector('p');
                    if (p) {
                        p.textContent = msg.newText;
                        if (!editEl.querySelector('.edited-label')) {
                            const lbl = document.createElement('small');
                            lbl.className = 'edited-label'; lbl.textContent = '(updated by admin)';
                            p.appendChild(lbl);
                        }
                    }
                }
                break;
            case 'reaction': updateReaction(msg); break;
        }
    }

    /**
     * FRAGMENTED BINARY SEND (CHUNKING)
     */
    async function sendBin(meta, data) {
        if (socket.readyState !== 1) return;

        const totalSize = data.byteLength;
        const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);
        let lastUiUpdate = 0;

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, totalSize);
            const slice = data.slice(start, end);

            const chunkMeta = {
                ...meta,
                chunkIndex: i,
                totalChunks,
                chunkSize: slice.byteLength
            };

            const mBuf = new TextEncoder().encode(JSON.stringify(chunkMeta));
            const len = new Uint8Array(4);
            new DataView(len.buffer).setUint32(0, mBuf.length);

            // Send as Blob to avoid extra memory allocation of ArrayBuffer
            const pkg = new Blob([len, mBuf, slice]);

            // Responsive Backpressure
            while (socket.readyState === 1 && socket.bufferedAmount > BACKPRESSURE_LIMIT) {
                await new Promise(r => setTimeout(r, 50));
            }

            if (socket.readyState === 1) {
                socket.send(pkg);

                // Throttle UI updates to 10 FPS during transfer to keep main thread fluid
                const now = Date.now();
                if (now - lastUiUpdate > 100 || i === totalChunks - 1) {
                    const percent = Math.floor(((i + 1) / totalChunks) * 100);
                    updateProgress(meta.id, percent, "Uploading");
                    lastUiUpdate = now;
                }
            } else break;
        }

        if (socket.readyState === 1) {
            updateProgress(meta.id, 100, "Sent");
            updateMsgStatus(meta.id, 'sent');
        }
    }

    /**
     * FRAGMENTED BINARY RECEIVE (REASSEMBLY)
     */
    function handleBinary(buf) {
        try {
            const dv = new DataView(buf);
            const mLen = dv.getUint32(0);
            const chunkMeta = JSON.parse(new TextDecoder().decode(buf.slice(4, 4 + mLen)));
            const slice = buf.slice(4 + mLen);

            const mid = chunkMeta.id;
            if (!msgData.has(mid)) {
                msgData.set(mid, { reactions: {}, chunks: [], meta: chunkMeta, lastUpdate: 0 });
            }

            const entry = msgData.get(mid);
            entry.chunks[chunkMeta.chunkIndex] = slice;

            const receivedChunks = entry.chunks.filter(x => x).length;
            const now = Date.now();

            // Throttle receiving progress UI
            if (now - entry.lastUpdate > 150 || receivedChunks === chunkMeta.totalChunks) {
                const percent = Math.floor((receivedChunks / chunkMeta.totalChunks) * 100);
                updateProgress(mid, percent, "Receiving");
                entry.lastUpdate = now;
            }

            if (receivedChunks === chunkMeta.totalChunks) {
                const finalBlob = new Blob(entry.chunks, { type: chunkMeta.mime });
                const url = URL.createObjectURL(finalBlob);
                objectUrls.add(url);
                entry.url = url;
                entry.chunks = []; // Immediate GC

                const existing = document.getElementById(mid);
                if (existing) {
                    const content = chunkMeta.type === 'voice' ? createVoiceContent(url) : createFileContent(chunkMeta, url);
                    const placeholder = existing.querySelector('.placeholder-content');
                    if (placeholder) existing.replaceChild(content, placeholder);
                    existing.classList.remove('is-loading');
                } else {
                    if (chunkMeta.type === 'voice') appendVoice({ ...chunkMeta, url });
                    else appendFile({ ...chunkMeta, url });
                }
                pruneMessages();
            }
        } catch (e) { console.error("[BINARY RECV ERR]", e); }
    }

    function pruneMessages() {
        const messages = Array.from(chat.querySelectorAll('.message'));
        if (messages.length <= MAX_DOM_MESSAGES) return;
        const toRemove = messages.slice(0, messages.length - MAX_DOM_MESSAGES);
        toRemove.forEach(el => {
            const mid = el.id;
            const data = msgData.get(mid);
            if (data?.url) { URL.revokeObjectURL(data.url); objectUrls.delete(data.url); }
            msgData.delete(mid);
            el.remove();
        });
    }

    function updateProgress(mid, percent, label, force = false) {
        const el = document.getElementById(mid);
        if (!el) return;
        let bar = el.querySelector('.progress-bar-fill');
        let badge = el.querySelector('.progress-badge');
        if (!bar) {
            const container = document.createElement('div');
            container.className = 'progress-container';
            bar = document.createElement('div');
            bar.className = 'progress-bar-fill';
            container.appendChild(bar);
            el.appendChild(container);
            badge = document.createElement('div');
            badge.className = 'progress-badge';
            el.appendChild(badge);
        }

        // Use requestAnimationFrame for smooth UI
        requestAnimationFrame(() => {
            bar.style.width = percent + '%';
            badge.textContent = `${label} ${percent}%`;
            if (percent >= 100) {
                setTimeout(() => {
                    bar.parentElement?.remove();
                    badge?.remove();
                    el.classList.remove('is-loading');
                }, 1000);
            }
        });
    }

    function createMsgBase(m) {
        const isMe = m.sender === currentUser;
        const div = document.createElement('div'); div.id = m.id; div.className = `message ${isMe ? 'msg-right' : 'msg-left'}`;
        if (m.loading) div.classList.add('is-loading');
        div.onclick = (e) => openReact(e, m.id);
        if (!msgData.has(m.id)) msgData.set(m.id, { reactions: {}, chunks: [], lastUpdate: 0 });

        const n = document.createElement('span'); n.className = 'sender-name';
        n.innerHTML = `${isMe ? 'You' : m.sender}${m.isAdmin ? ' <span class="admin-badge-small">ADMIN</span>' : ''}`;
        n.style.color = getHashColor(m.sender); div.appendChild(n);

        if (m.size) {
            const sz = document.createElement('small'); sz.className = 'file-size'; sz.textContent = ` (${formatSize(m.size)})`;
            sz.style.opacity = '0.5'; sz.style.fontSize = '0.6rem';
            n.appendChild(sz);
        }

        const meta = document.createElement('div'); meta.className = 'message-meta';
        const t = document.createElement('span'); t.className = 'timestamp'; t.textContent = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); meta.appendChild(t);

        if (isMe || iAmAdmin) {
            const d = document.createElement('button'); d.className = 'delete-btn'; d.textContent = '✕';
            d.onclick = (e) => {
                e.stopPropagation();
                socket.send(JSON.stringify({ type: 'delete', messageId: m.id, sender: m.sender }));
            };
            meta.insertBefore(d, meta.firstChild);

            if (iAmAdmin && m.type === 'chat') {
                const editBtn = document.createElement('button');
                editBtn.className = 'edit-btn-inline'; editBtn.innerHTML = '✎';
                editBtn.onclick = (e) => { e.stopPropagation(); editMessage(m.id); };
                meta.insertBefore(editBtn, meta.firstChild);
            }
        }
        if (isMe) {
            const ticks = document.createElement('span');
            ticks.className = 'status-ticks';
            ticks.innerHTML = m.status === 'pending' ? TICK_CLOCK : (m.status === 'sent' ? TICK_SINGLE : TICK_DOUBLE);
            meta.appendChild(ticks);
        }
        div.appendChild(meta); return div;
    }

    function updateMsgStatus(mid, status) {
        const el = document.getElementById(mid);
        if (!el) return;
        const ticks = el.querySelector('.status-ticks');
        if (ticks) {
            ticks.innerHTML = status === 'delivered' ? TICK_DOUBLE : (status === 'sent' ? TICK_SINGLE : TICK_CLOCK);
        }
    }

    function createVoiceContent(url) {
        const a = document.createElement('audio'); a.src = url; a.controls = true;
        a.onloadedmetadata = () => { if (a.duration === Infinity) { a.currentTime = 1e101; a.ontimeupdate = function () { this.ontimeupdate = () => { }; a.currentTime = 0; }; } };
        return a;
    }

    function createFileContent(m, url) {
        if (m.mime && m.mime.startsWith('image/')) {
            const i = document.createElement('img'); i.src = url; i.onclick = (e) => { e.stopPropagation(); window.open(url); }; return i;
        } else {
            const a = document.createElement('a'); a.className = 'file-card'; a.href = url; a.download = m.name; a.innerHTML = `<span>📎 ${m.name}</span>`; a.onclick = (e) => e.stopPropagation(); return a;
        }
    }

    function appendChat(m) { const d = createMsgBase(m); const p = document.createElement('p'); p.textContent = m.text; d.insertBefore(p, d.querySelector('.message-meta')); chat.appendChild(d); scrollChat(); }
    function appendVoice(m) {
        const d = createMsgBase(m);
        const p = document.createElement('div'); p.className = 'placeholder-content'; p.textContent = "Voice Memo Processing...";
        d.insertBefore(m.loading ? p : createVoiceContent(m.url), d.querySelector('.message-meta'));
        chat.appendChild(d); scrollChat();
    }
    function appendFile(m) {
        const d = createMsgBase(m);
        const p = document.createElement('div'); p.className = 'placeholder-content'; p.textContent = m.name;
        d.insertBefore(m.loading ? p : createFileContent(m, m.url), d.querySelector('.message-meta'));
        chat.appendChild(d); scrollChat();
    }

    function updateReaction(m) { const d = msgData.get(m.messageId); if (!d) return; const r = d.reactions; for (const s in r) r[s] = r[s].filter(u => u !== m.reactor); if (m.symbol) { if (!r[m.symbol]) r[m.symbol] = []; r[m.symbol].push(m.reactor); } renderReacts(m.messageId); }
    function renderReacts(mid) { const el = document.getElementById(mid); const d = msgData.get(mid); if (!el || !d) return; let l = el.querySelector('.reactions-list'); if (!l) { l = document.createElement('div'); l.className = 'reactions-list'; el.appendChild(l); } l.innerHTML = ''; for (const s in d.reactions) if (d.reactions[s].length > 0) { const p = document.createElement('div'); p.className = 'react-pill'; p.innerHTML = `${s} ${d.reactions[s].length > 1 ? `<small>${d.reactions[s].length}</small>` : ''}`; l.appendChild(p); } }
    function openReact(e, mid) { e.stopPropagation(); closeReact(); const b = document.createElement('div'); b.className = 'reaction-bar'; SYMBOLS.forEach(s => { const o = document.createElement('span'); o.className = 'react-opt'; o.textContent = s; o.onclick = (ev) => { ev.stopPropagation(); socket.send(JSON.stringify({ type: 'reaction', messageId: mid, reactor: currentUser, symbol: s })); closeReact(); }; b.appendChild(o); }); const r = e.currentTarget.getBoundingClientRect(); b.style.left = `${Math.max(10, Math.min(window.innerWidth - 200, r.left))}px`; b.style.top = `${r.top > 100 ? r.top - 50 : r.bottom + 10}px`; document.body.appendChild(b); reactionMenu = b; }
    function closeReact() { if (reactionMenu) { reactionMenu.remove(); reactionMenu = null; } }
    function handleTyping(t) { if (t !== isTyping) { isTyping = t; if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'typing', isTyping: t })); } clearTimeout(typingTimer); if (t) typingTimer = setTimeout(() => handleTyping(false), 3000); }
    function appendSystem(t) { const d = document.createElement('div'); d.className = 'system-msg'; d.textContent = t; chat.appendChild(d); scrollChat(); }
    function scrollChat() { requestAnimationFrame(() => chat.scrollTop = chat.scrollHeight); }
    function updateTimer() { const d = Math.floor((Date.now() - recStartTime) / 1000); timer.textContent = `${Math.floor(d / 60)}:${(d % 60).toString().padStart(2, '0')}`; }
    function getHashColor(n) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return `hsl(${Math.abs(h % 360)}, 60%, 75%)`; }

    function bindUI() {
        input.oninput = () => {
            const t = input.value.trim().length > 0;
            btnSend.classList.toggle('hidden', !t); btnRec.classList.toggle('hidden', t);
            input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            handleTyping(t);
        };
        input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); } };
        btnSend.onclick = sendText;
        document.getElementById('attach-label').onclick = (e) => { e.preventDefault(); fileIn.click(); };
        btnRec.onpointerdown = (e) => { e.preventDefault(); btnRec.setPointerCapture(e.pointerId); recStartPos = e.clientX; recCanceled = false; startRec(); };
        btnRec.onpointermove = (e) => { if (isRecording && recStartPos - e.clientX > 60) cancelRec(); };
        btnRec.onpointerup = (e) => { if (isRecording) { btnRec.releasePointerCapture(e.pointerId); stopRec(); } };
        fileIn.onchange = (e) => {
            const f = e.target.files[0]; if (!f) return;
            if (f.size > MAX_FILE) { alert('File too large. Max 100MB for LAN.'); return; }
            const meta = { type: 'file', sender: currentUser, id: 'm-f' + Date.now(), timestamp: Date.now(), name: f.name, mime: f.type, size: f.size };
            appendFile({ ...meta, loading: true, status: 'pending' });
            const r = new FileReader();
            r.onload = (ev) => sendBin(meta, ev.target.result);
            r.readAsArrayBuffer(f);
            fileIn.value = '';
        };
        document.getElementById('edit-btn').onclick = () => { document.getElementById('user-info').classList.add('hidden'); const f = document.getElementById('edit-form'); f.classList.remove('hidden'); const i = document.getElementById('name-input'); i.value = currentUser; i.focus(); };
        document.getElementById('save-btn').onclick = () => { const v = document.getElementById('name-input').value.trim(); if (v && socket.readyState === 1) socket.send(JSON.stringify({ type: 'rename', name: v })); document.getElementById('edit-form').classList.add('hidden'); document.getElementById('user-info').classList.remove('hidden'); };
        onlineToggle.onclick = (e) => { e.stopPropagation(); onlineContainer.classList.toggle('hidden'); };
        window.onclick = () => { closeReact(); onlineContainer.classList.add('hidden'); };
    }

    async function startRec() {
        if (isRecording) return;
        try {
            const s = await navigator.mediaDevices.getUserMedia({ audio: true });
            const m = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(x => MediaRecorder.isTypeSupported(x)) || '';
            mediaRecorder = new MediaRecorder(s, { mimeType: m }); audioChunks = [];
            mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                if (audioChunks.length > 0 && !recCanceled && (Date.now() - recStartTime > 600)) {
                    const b = new Blob(audioChunks, { type: m });
                    const buf = await b.arrayBuffer();
                    const meta = { type: 'voice', sender: currentUser, id: 'm-v' + Date.now(), timestamp: Date.now(), mime: m, size: b.size };
                    appendVoice({ ...meta, loading: true, status: 'pending' });
                    await sendBin(meta, buf);
                }
                s.getTracks().forEach(t => t.stop());
            };
            mediaRecorder.start(); isRecording = true; recStartTime = Date.now();
            updateTimer(); timerInt = setInterval(updateTimer, 1000);
            btnRec.classList.add('active'); recWrap.classList.remove('hidden'); inputWrap.classList.add('hidden');
        } catch (e) { alert('Mic access required.'); }
    }
    function stopRec() { if (isRecording) { clearInterval(timerInt); if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop(); isRecording = false; btnRec.classList.remove('active'); recWrap.classList.add('hidden'); inputWrap.classList.remove('hidden'); } }
    function cancelRec() { if (isRecording) { recCanceled = true; stopRec(); } }

    function sendText() {
        const v = input.value.trim();
        if (!v || socket.readyState !== 1) return;
        const id = 'm-' + Date.now();
        const msg = { type: 'chat', text: v, sender: currentUser, id, timestamp: Date.now(), status: 'pending' };
        appendChat(msg);
        socket.send(JSON.stringify({ type: 'chat', text: v, id }));
        updateMsgStatus(id, 'sent');
        input.value = ''; input.style.height = 'auto'; btnSend.classList.add('hidden'); btnRec.classList.remove('hidden');
    }

    bindUI();
    init();
})();
