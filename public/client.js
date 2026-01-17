
(() => {
    let socket;
    let currentUser = '';
    let isTyping = false, typingTimer = null;
    let isRecording = false, recCanceled = false, recStartPos = null;
    let mediaRecorder = null, audioChunks = [], recStartTime = 0, timerInt = null;
    let reactionMenu = null;

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const MAX_DOM_MESSAGES = isMobile ? 25 : 200;
    const BACKPRESSURE_LIMIT = isMobile ? 32 * 1024 : 512 * 1024;
    const SEND_TIMEOUT = 60000;

    const msgData = new Map();
    const objectUrls = new Set();
    const MAX_FILE = 15 * 1024 * 1024;
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

    function init() {
        let uid = localStorage.getItem('netless_uid') || ('u' + Date.now() + Math.random().toString(36).substr(2, 5));
        localStorage.setItem('netless_uid', uid);
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        try {
            socket = new WebSocket(`${protocol}//${location.host}`);
            socket.binaryType = 'arraybuffer';
            socket.onopen = () => { socket.send(JSON.stringify({ type: 'identify', uid })); statusLight.className = 'status-light online'; };
            socket.onmessage = (e) => { if (e.data instanceof ArrayBuffer) handleBinary(e.data); else handleJson(JSON.parse(e.data)); };
            socket.onclose = () => { statusLight.className = 'status-light'; setTimeout(init, 3000); };
        } catch (e) { console.error('Socket fail', e); }
        bindUI();
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
            case 'chat': appendChat(msg); break;
            case 'system': appendSystem(msg.text); break;
            case 'transfer_incoming':
                if (!document.getElementById(`m-${msg.meta.id}`)) {
                    if (msg.meta.type === 'voice') appendVoice({ ...msg.meta, loading: true });
                    else appendFile({ ...msg.meta, loading: true });
                    updateProgress(msg.meta.id, 0, "Receiving...");
                }
                break;
            case 'transfer_progress': updateProgress(msg.messageId, msg.percent); break;
            case 'typing_update':
                const box = document.getElementById('typing-box');
                const others = msg.users.filter(u => u !== currentUser);
                box.textContent = others.length ? `${others.join(', ')} typing...` : '';
                box.classList.toggle('hidden', !others.length);
                break;
            case 'name_updated': currentUser = msg.name; nameLabel.textContent = msg.name; break;
            case 'delete':
                const el = document.getElementById(`m-${msg.messageId}`);
                if (el) { const d = msgData.get(msg.messageId); if (d?.url) URL.revokeObjectURL(d.url); msgData.delete(msg.messageId); el.remove(); }
                break;
            case 'reaction': updateReaction(msg); break;
        }
    }

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
        btnRec.onpointercancel = (e) => { if (isRecording) { btnRec.releasePointerCapture(e.pointerId); cancelRec(); } };
        btnRec.oncontextmenu = (e) => e.preventDefault();
        fileIn.onchange = (e) => {
            const f = e.target.files[0]; if (!f) return;
            if (f.size > MAX_FILE) { alert('Max 15MB'); return; }
            const meta = { type: 'file', sender: currentUser, id: 'f' + Date.now(), timestamp: Date.now(), name: f.name, mime: f.type, size: f.size };
            appendFile({ ...meta, loading: true });
            const r = new FileReader();
            r.onload = (ev) => sendBin(meta, ev.target.result);
            r.readAsArrayBuffer(f);
            fileIn.value = '';
        };
        document.getElementById('edit-btn').onclick = () => { document.getElementById('user-info').classList.add('hidden'); const f = document.getElementById('edit-form'); f.classList.remove('hidden'); const i = document.getElementById('name-input'); i.value = currentUser; i.focus(); };
        document.getElementById('save-btn').onclick = () => { const v = document.getElementById('name-input').value.trim(); if (v && socket.readyState === 1) socket.send(JSON.stringify({ type: 'rename', name: v })); document.getElementById('edit-form').classList.add('hidden'); document.getElementById('user-info').classList.remove('hidden'); };
        window.onclick = () => closeReact();
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
                    const meta = { type: 'voice', sender: currentUser, id: 'v' + Date.now(), timestamp: Date.now(), mime: m, size: b.size };
                    appendVoice({ ...meta, loading: true });
                    await sendBin(meta, buf);
                }
                s.getTracks().forEach(t => t.stop());
            };
            mediaRecorder.start(); isRecording = true; recStartTime = Date.now();
            updateTimer(); timerInt = setInterval(updateTimer, 1000);
            btnRec.classList.add('active'); recWrap.classList.remove('hidden'); inputWrap.classList.add('hidden');
        } catch (e) { alert('Mic denied'); }
    }
    function cancelRec() { if (isRecording) { recCanceled = true; stopRec(); } }
    function stopRec() { if (isRecording) { clearInterval(timerInt); if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop(); isRecording = false; btnRec.classList.remove('active'); recWrap.classList.add('hidden'); inputWrap.classList.remove('hidden'); } }
    function sendText() { const v = input.value.trim(); if (!v || socket.readyState !== 1) return; socket.send(JSON.stringify({ type: 'chat', text: v })); input.value = ''; input.style.height = 'auto'; btnSend.classList.add('hidden'); btnRec.classList.remove('hidden'); }

    async function sendBin(meta, data) {
        if (socket.readyState !== 1) return;
        const start = Date.now();
        const mBuf = new TextEncoder().encode(JSON.stringify(meta));
        const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, mBuf.length);
        const pkg = new Blob([len, mBuf, data]);

        const trackUpload = () => {
            const now = Date.now();
            if (socket.readyState === 1 && socket.bufferedAmount > 0) {
                const uploaded = pkg.size - socket.bufferedAmount;
                const percent = Math.max(0, Math.min(99, Math.floor((uploaded / pkg.size) * 100)));
                updateProgress(meta.id, percent, "Uploading...");
                requestAnimationFrame(trackUpload);
            } else if (socket.readyState === 1 && socket.bufferedAmount === 0) {
                updateProgress(meta.id, 100, "Sent");
            }
        };

        while (socket.bufferedAmount > BACKPRESSURE_LIMIT) {
            if (Date.now() - start > SEND_TIMEOUT) return;
            await new Promise(r => setTimeout(r, 100));
        }

        socket.send(pkg);
        requestAnimationFrame(trackUpload);
    }

    function updateProgress(mid, percent, label) {
        const el = document.getElementById(`m-${mid}`);
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

        bar.style.width = percent + '%';
        badge.textContent = (label || "Broadcasting...") + ` ${percent}%`;

        if (percent >= 100) {
            setTimeout(() => {
                bar.parentElement?.remove();
                badge?.remove();
                el.classList.remove('is-loading');
            }, 1000);
        }
    }

    function handleBinary(buf) {
        const dv = new DataView(buf); const mLen = dv.getUint32(0);
        const meta = JSON.parse(new TextDecoder().decode(buf.slice(4, 4 + mLen)));
        const blob = new Blob([buf.slice(4 + mLen)], { type: meta.mime });
        const url = URL.createObjectURL(blob); objectUrls.add(url);

        const existing = document.getElementById(`m-${meta.id}`);
        if (existing) {
            const content = meta.type === 'voice' ? createVoiceContent(url) : createFileContent(meta, url);
            const placeholder = existing.querySelector('.placeholder-content');
            if (placeholder) existing.replaceChild(content, placeholder);
            existing.classList.remove('is-loading');
            msgData.set(meta.id, { reactions: {}, url: url });
        } else {
            msgData.set(meta.id, { reactions: {}, url: url });
            if (meta.type === 'voice') appendVoice({ ...meta, url }); else appendFile({ ...meta, url });
        }
        pruneMessages();
    }

    function createMsgBase(m) {
        const isMe = m.sender === currentUser;
        const div = document.createElement('div'); div.id = `m-${m.id}`; div.className = `message ${isMe ? 'msg-right' : 'msg-left'}`;
        if (m.loading) div.classList.add('is-loading');

        div.onclick = (e) => openReact(e, m.id);
        if (!msgData.has(m.id)) msgData.set(m.id, { reactions: {} });
        const n = document.createElement('span'); n.className = 'sender-name'; n.textContent = isMe ? 'You' : m.sender; n.style.color = getHashColor(m.sender); div.appendChild(n);

        if (m.size) {
            const sz = document.createElement('small'); sz.className = 'file-size'; sz.textContent = ` (${formatSize(m.size)})`; sz.style.opacity = '0.5'; sz.style.fontSize = '0.6rem';
            n.appendChild(sz);
        }

        const meta = document.createElement('div'); meta.className = 'message-meta';
        const t = document.createElement('span'); t.textContent = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); meta.appendChild(t);
        if (isMe) {
            const d = document.createElement('button'); d.className = 'delete-btn'; d.textContent = '✕'; d.onclick = (e) => { e.stopPropagation(); socket.send(JSON.stringify({ type: 'delete', messageId: m.id })); }; meta.appendChild(d);
        }
        div.appendChild(meta); return div;
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
        if (m.loading) {
            const p = document.createElement('div'); p.className = 'placeholder-content'; p.textContent = "Voice Note...";
            d.insertBefore(p, d.querySelector('.message-meta'));
        } else {
            d.insertBefore(createVoiceContent(m.url), d.querySelector('.message-meta'));
        }
        chat.appendChild(d); scrollChat();
    }
    function appendFile(m) {
        const d = createMsgBase(m);
        if (m.loading) {
            const p = document.createElement('div'); p.className = 'placeholder-content'; p.textContent = m.name;
            d.insertBefore(p, d.querySelector('.message-meta'));
        } else {
            d.insertBefore(createFileContent(m, m.url), d.querySelector('.message-meta'));
        }
        chat.appendChild(d); scrollChat();
    }

    function updateReaction(m) { const d = msgData.get(m.messageId); if (!d) return; const r = d.reactions; for (const s in r) r[s] = r[s].filter(u => u !== m.reactor); if (m.symbol) { if (!r[m.symbol]) r[m.symbol] = []; r[m.symbol].push(m.reactor); } renderReacts(m.messageId); }
    function renderReacts(mid) { const el = document.getElementById(`m-${mid}`); const d = msgData.get(mid); if (!el || !d) return; let l = el.querySelector('.reactions-list'); if (!l) { l = document.createElement('div'); l.className = 'reactions-list'; el.appendChild(l); } l.innerHTML = ''; for (const s in d.reactions) if (d.reactions[s].length > 0) { const p = document.createElement('div'); p.className = 'react-pill'; p.innerHTML = `${s} ${d.reactions[s].length > 1 ? `<small>${d.reactions[s].length}</small>` : ''}`; l.appendChild(p); } }
    function openReact(e, mid) { e.stopPropagation(); closeReact(); const b = document.createElement('div'); b.className = 'reaction-bar'; SYMBOLS.forEach(s => { const o = document.createElement('span'); o.className = 'react-opt'; o.textContent = s; o.onclick = (ev) => { ev.stopPropagation(); socket.send(JSON.stringify({ type: 'reaction', messageId: mid, reactor: currentUser, symbol: s })); closeReact(); }; b.appendChild(o); }); const r = e.currentTarget.getBoundingClientRect(); b.style.left = `${Math.max(10, Math.min(window.innerWidth - 200, r.left))}px`; b.style.top = `${r.top > 100 ? r.top - 50 : r.bottom + 10}px`; document.body.appendChild(b); reactionMenu = b; }
    function closeReact() { if (reactionMenu) { reactionMenu.remove(); reactionMenu = null; } }
    function handleTyping(t) { if (t !== isTyping) { isTyping = t; socket.send(JSON.stringify({ type: 'typing', isTyping: t })); } clearTimeout(typingTimer); if (t) typingTimer = setTimeout(() => handleTyping(false), 3000); }
    function appendSystem(t) { const d = document.createElement('div'); d.className = 'system-msg'; d.textContent = t; chat.appendChild(d); scrollChat(); }
    function scrollChat() { requestAnimationFrame(() => chat.scrollTop = chat.scrollHeight); }
    function updateTimer() { const d = Math.floor((Date.now() - recStartTime) / 1000); timer.textContent = `${Math.floor(d / 60)}:${(d % 60).toString().padStart(2, '0')}`; }
    function getHashColor(n) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return `hsl(${Math.abs(h % 360)}, 50%, 75%)`; }

    function pruneMessages() {
        const messages = Array.from(chat.querySelectorAll('.message'));
        if (messages.length <= MAX_DOM_MESSAGES) return;
        const toRemove = messages.slice(0, messages.length - MAX_DOM_MESSAGES);
        toRemove.forEach(el => {
            const mid = el.id.replace('m-', '');
            const data = msgData.get(mid);
            if (data?.url) { URL.revokeObjectURL(data.url); objectUrls.delete(data.url); }
            msgData.delete(mid);
            el.remove();
        });
    }

    init();
})();
