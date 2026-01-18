# Netless LAN Chat

A private, secure, and blazing-fast local chat server for your home or office network. No internet required, no data leaves your network.

## 🚀 Recent Updates & Features
- 👑 **Admin Mode**: New administrative controls for message moderation.
- ❤️ **Reactions**: React to any message with emojis.
- 👥 **Online List**: See who's currently connected to the chat.
- 📁 **Enhanced File Transfers**: Improved reliability with backpressure handling (up to 15MB).
- 🎤 **Voice Notes**: Send voice messages directly from your browser.
- 🛡️ **Self-Signed HTTPS**: End-to-end encryption within your local network.

---

## 🛠️ Installation & Setup

### 🪟 Windows
1.  **Install Node.js**: Download and install from [nodejs.org](https://nodejs.org/).
2.  **Open Terminal**: Open PowerShell or Command Prompt in the project folder.
3.  **Install & Start**:
    ```powershell
    npm install
    node server.js
    ```

### 📱 Termux (Android)
1.  **Setup Node.js**:
    ```bash
    pkg update && pkg upgrade
    pkg install nodejs
    ```
2.  **Install & Start**:
    ```bash
    npm install
    node server.js
    ```

### 🐧 Linux / 🍎 macOS
1.  **Install Node.js**: Use your package manager (e.g., `sudo apt install nodejs npm` or `brew install node`).
2.  **Install & Start**:
    ```bash
    npm install
    node server.js
    ```

---

## 🔑 Admin Mode
Gain administrative privileges to moderate the chat.

- **How to Activate**: Type `/admin netlessadmin` in the chat input.
- **Privileges**:
  - **Edit Messages**: Click the ✎ icon on any chat message.
  - **Delete Messages**: Click the ✕ icon to remove messages for all users.
- **Indicator**: You will receive an "ADMIN" badge next to your name once authenticated.

---

## 📡 Accessing the Chat
Once the server is running, it will display the access URLs:
- **Local Access**: `https://localhost:3000`
- **Network Access**: `https://[YOUR-IP]:3000` (Share this with others on the same Wi-Fi)

> [!IMPORTANT]
> **SSL Warning**: Since the server uses a self-signed certificate, your browser will show a security warning. This is **normal** for local encryption. Click **Advanced** -> **Proceed** to continue.

---

## ⚙️ Technical Notes
- **Payload Limit**: Support for up to 30MB total payload, with a recommended file limit of 15MB.
- **Resource Management**: Automatically detects low-resource environments (like Termux) to optimize memory and data transfer speeds.
- **Privacy**: Messages are broadcasted in real-time and not stored on the server's disk (only nicknames are persisted in `users.json`).
