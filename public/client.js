
(() => {
    let socket;
    let currentUser = '';
    let isTyping = false;
    let typingTimer = null;
    let isRecording = false;
    let recCanceled = false; // New flag for cancellation
    let recStartPos = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let recStartTime = 0;
    let timerInt = null;
    let reactionMenu = null;
    const msgData = new Map();
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

            socket.onopen = () => {
                socket.send(JSON.stringify({ type: 'identify', uid }));
                statusLight.className = 'status-light online';
            };

            socket.onmessage = (e) => {
                if (e.data instanceof ArrayBuffer) handleBinary(e.data);
                else handleJson(JSON.parse(e.data));
            };

            socket.onclose = () => {
                statusLight.className = 'status-light';
                setTimeout(init, 3000);
            };
        } catch (e) {
            console.error('Socket fail', e);
        }

        bindUI();
    }

    function handleJson(msg) {
        switch (msg.type) {
            case 'identity_confirmed':
                currentUser = msg.username;
                nameLabel.textContent = msg.username;
                break;
            case 'chat':
                appendChat(msg);
                break;
            case 'system':
                appendSystem(msg.text);
                break;
            case 'typing_update':
                const typingBox = document.getElementById('typing-box');
                const others = msg.users.filter(u => u !== currentUser);
                typingBox.textContent = others.length ? `${others.join(', ')} is typing...` : '';
                typingBox.classList.toggle('hidden', !others.length);
                break;
            case 'name_updated':
                currentUser = msg.name;
                nameLabel.textContent = msg.name;
                break;
            case 'delete':
                const el = document.getElementById(`m-${msg.messageId}`);
                if (el) el.remove();
                break;
            case 'reaction':
                updateReaction(msg);
                break;
        }
    }

    function bindUI() {
        input.oninput = () => {
            const hasText = input.value.trim().length > 0;
            btnSend.classList.toggle('hidden', !hasText);
            btnRec.classList.toggle('hidden', hasText);
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 120) + 'px';
            handleTyping(hasText);
        };

        input.onkeydown = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(); }
        };

        btnSend.onclick = sendText;

        // Force label click to trigger input for mobile compatibility
        document.getElementById('attach-label').onclick = (e) => {
            e.preventDefault();
            fileIn.click();
        };

        // Improved Pointer Events for mobile recording
        btnRec.onpointerdown = (e) => {
            e.preventDefault();
            btnRec.setPointerCapture(e.pointerId); // Crucial for mobile hold/release
            recStartPos = e.clientX;
            recCanceled = false;
            startRec();
        };

        btnRec.onpointermove = (e) => {
            if (!isRecording) return;
            // Swipe left 60px to cancel
            if (recStartPos - e.clientX > 60) cancelRec();
        };

        btnRec.onpointerup = (e) => {
            if (isRecording) {
                btnRec.releasePointerCapture(e.pointerId);
                stopRec();
            }
        };

        btnRec.onpointercancel = (e) => {
            if (isRecording) {
                btnRec.releasePointerCapture(e.pointerId);
                cancelRec();
            }
        };

        // Prevent context menu on hold
        btnRec.oncontextmenu = (e) => e.preventDefault();

        fileIn.onchange = (e) => {
            const f = e.target.files[0];
            if (!f) return;
            if (f.size > MAX_FILE) { alert('Max 15MB'); return; }
            const r = new FileReader();
            r.onload = (ev) => sendBin({ type: 'file', sender: currentUser, id: 'f' + Date.now(), timestamp: Date.now(), name: f.name, mime: f.type }, ev.target.result);
            r.readAsArrayBuffer(f);
            fileIn.value = '';
        };

        document.getElementById('edit-btn').onclick = () => {
            document.getElementById('user-info').classList.add('hidden');
            const form = document.getElementById('edit-form');
            form.classList.remove('hidden');
            const inpt = document.getElementById('name-input');
            inpt.value = currentUser;
            inpt.focus();
        };

        document.getElementById('save-btn').onclick = () => {
            const val = document.getElementById('name-input').value.trim();
            if (val && socket.readyState === 1) socket.send(JSON.stringify({ type: 'rename', name: val }));
            document.getElementById('edit-form').classList.add('hidden');
            document.getElementById('user-info').classList.remove('hidden');
        };

        window.onclick = () => closeReact();
    }

    async function startRec() {
        if (isRecording) return;
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(m => MediaRecorder.isTypeSupported(m)) || '';
            mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
            audioChunks = [];
            mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                // Check if it was canceled during the recording process
                if (audioChunks.length > 0 && !recCanceled && (Date.now() - recStartTime > 600)) {
                    const blob = new Blob(audioChunks, { type: mime });
                    const buf = await blob.arrayBuffer();
                    sendBin({ type: 'voice', sender: currentUser, id: 'v' + Date.now(), timestamp: Date.now(), mime }, buf);
                }
                stream.getTracks().forEach(t => t.stop());
            };
            mediaRecorder.start();
            isRecording = true;
            recStartTime = Date.now();
            updateTimer();
            timerInt = setInterval(updateTimer, 1000);
            btnRec.classList.add('active');
            recWrap.classList.remove('hidden');
            inputWrap.classList.add('hidden');
        } catch (e) { alert('Mic access denied'); }
    }

    function cancelRec() {
        if (!isRecording) return;
        recCanceled = true;
        stopRec();
        appendSystem('Voice note cancelled');
    }

    function stopRec() {
        if (!isRecording) return;
        clearInterval(timerInt);
        if (mediaRecorder?.state !== 'inactive') mediaRecorder.stop();
        isRecording = false;
        btnRec.classList.remove('active');
        recWrap.classList.add('hidden');
        inputWrap.classList.remove('hidden');
    }

    function sendText() {
        const val = input.value.trim();
        if (!val || socket.readyState !== 1) return;
        socket.send(JSON.stringify({ type: 'chat', text: val }));
        input.value = '';
        input.style.height = 'auto';
        btnSend.classList.add('hidden');
        btnRec.classList.remove('hidden');
    }

    function sendBin(meta, data) {
        if (socket.readyState !== 1) return;
        const mBuf = new TextEncoder().encode(JSON.stringify(meta));
        const len = new Uint8Array(4);
        new DataView(len.buffer).setUint32(0, mBuf.length);
        const pkg = new Uint8Array(4 + mBuf.length + data.byteLength);
        pkg.set(len, 0); pkg.set(mBuf, 4); pkg.set(new Uint8Array(data), 4 + mBuf.length);
        socket.send(pkg.buffer);
    }

    function handleBinary(buf) {
        const dv = new DataView(buf);
        const mLen = dv.getUint32(0);
        const meta = JSON.parse(new TextDecoder().decode(buf.slice(4, 4 + mLen)));
        const data = buf.slice(4 + mLen);
        const url = URL.createObjectURL(new Blob([data], { type: meta.mime }));
        if (meta.type === 'voice') appendVoice({ ...meta, url });
        else appendFile({ ...meta, url });
    }

    function createMsgBase(m) {
        const isMe = m.sender === currentUser;
        const div = document.createElement('div');
        div.id = `m-${m.id}`;
        div.className = `message ${isMe ? 'msg-right' : 'msg-left'}`;
        div.onclick = (e) => openReact(e, m.id);
        msgData.set(m.id, { reactions: {} });

        const name = document.createElement('span');
        name.className = 'sender-name';
        name.textContent = isMe ? 'You' : m.sender;
        name.style.color = getHashColor(m.sender);
        div.appendChild(name);

        const meta = document.createElement('div');
        meta.className = 'message-meta';
        const t = document.createElement('span');
        t.textContent = new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        meta.appendChild(t);
        if (isMe) {
            const d = document.createElement('button');
            d.className = 'delete-btn'; d.textContent = '✕';
            d.onclick = (e) => { e.stopPropagation(); socket.send(JSON.stringify({ type: 'delete', messageId: m.id })); };
            meta.appendChild(d);
        }
        div.appendChild(meta);
        return div;
    }

    function appendChat(m) {
        const div = createMsgBase(m);
        const p = document.createElement('p'); p.textContent = m.text;
        div.insertBefore(p, div.querySelector('.message-meta'));
        chat.appendChild(div); scrollChat();
    }

    function appendVoice(m) {
        const div = createMsgBase(m);
        const aud = document.createElement('audio');
        aud.src = m.url; aud.controls = true;
        aud.onloadedmetadata = () => { if (aud.duration === Infinity) { aud.currentTime = 1e101; aud.ontimeupdate = function () { this.ontimeupdate = () => { }; aud.currentTime = 0; }; } };
        div.insertBefore(aud, div.querySelector('.message-meta'));
        chat.appendChild(div); scrollChat();
    }

    function appendFile(m) {
        const div = createMsgBase(m);
        if (m.mime.startsWith('image/')) {
            const img = document.createElement('img'); img.src = m.url;
            img.onclick = (e) => { e.stopPropagation(); window.open(m.url); };
            div.insertBefore(img, div.querySelector('.message-meta'));
        } else {
            const a = document.createElement('a'); a.className = 'file-card';
            a.href = m.url; a.download = m.name; a.innerHTML = `<span>📎 ${m.name}</span>`;
            a.onclick = (e) => e.stopPropagation();
            div.insertBefore(a, div.querySelector('.message-meta'));
        }
        chat.appendChild(div); scrollChat();
    }

    function updateReaction(m) {
        const data = msgData.get(m.messageId);
        if (!data) return;
        const reactions = data.reactions;
        for (const s in reactions) reactions[s] = reactions[s].filter(u => u !== m.reactor);
        if (m.symbol) {
            if (!reactions[m.symbol]) reactions[m.symbol] = [];
            reactions[m.symbol].push(m.reactor);
        }
        renderReacts(m.messageId);
    }

    function renderReacts(mid) {
        const el = document.getElementById(`m-${mid}`);
        const data = msgData.get(mid);
        if (!el || !data) return;
        let list = el.querySelector('.reactions-list');
        if (!list) { list = document.createElement('div'); list.className = 'reactions-list'; el.appendChild(list); }
        list.innerHTML = '';
        for (const s in data.reactions) {
            if (data.reactions[s].length > 0) {
                const p = document.createElement('div'); p.className = 'react-pill';
                p.innerHTML = `${s} ${data.reactions[s].length > 1 ? `<small>${data.reactions[s].length}</small>` : ''}`;
                list.appendChild(p);
            }
        }
    }

    function openReact(e, mid) {
        e.stopPropagation(); closeReact();
        const bar = document.createElement('div'); bar.className = 'reaction-bar';
        SYMBOLS.forEach(s => {
            const o = document.createElement('span'); o.className = 'react-opt'; o.textContent = s;
            o.onclick = (ev) => {
                ev.stopPropagation();
                socket.send(JSON.stringify({ type: 'reaction', messageId: mid, reactor: currentUser, symbol: s }));
                closeReact();
            };
            bar.appendChild(o);
        });
        const r = e.currentTarget.getBoundingClientRect();
        bar.style.left = `${Math.max(10, Math.min(window.innerWidth - 200, r.left))}px`;
        bar.style.top = `${r.top > 100 ? r.top - 50 : r.bottom + 10}px`;
        document.body.appendChild(bar);
        reactionMenu = bar;
    }

    function closeReact() { if (reactionMenu) { reactionMenu.remove(); reactionMenu = null; } }

    function handleTyping(t) {
        if (t !== isTyping) { isTyping = t; socket.send(JSON.stringify({ type: 'typing', isTyping: t })); }
        clearTimeout(typingTimer);
        if (t) typingTimer = setTimeout(() => handleTyping(false), 3000);
    }

    function appendSystem(t) {
        const d = document.createElement('div'); d.className = 'system-msg'; d.textContent = t;
        chat.appendChild(d); scrollChat();
    }

    function scrollChat() { requestAnimationFrame(() => chat.scrollTop = chat.scrollHeight); }
    function updateTimer() { const d = Math.floor((Date.now() - recStartTime) / 1000); timer.textContent = `${Math.floor(d / 60)}:${(d % 60).toString().padStart(2, '0')}`; }
    function getHashColor(n) { let h = 0; for (let i = 0; i < n.length; i++) h = n.charCodeAt(i) + ((h << 5) - h); return `hsl(${Math.abs(h % 360)}, 50%, 75%)`; }

    init();
})();
