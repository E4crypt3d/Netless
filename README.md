# Netless LAN Chat

A private local chat server for your home or office network. No internet required, no data leaves your network.

## Features
- 🔒 **Private & Secure**: Self-signed HTTPS encryption.
- 🚀 **High Performance**: Real-time messaging and binary (file) broadcasting via WebSockets.
- 📱 **Multi-platform**: Works on any device with a modern web browser.

---

## Installation & Setup

### 🪟 Windows
1.  **Install Node.js**: Download and install from [nodejs.org](https://nodejs.org/).
2.  **Download Project**: Extract the project files to a folder.
3.  **Open Terminal**: Open PowerShell or Command Prompt in that folder.
4.  **Install Dependencies**:
    ```bash
    npm install
    ```
5.  **Start Server**:
    ```bash
    node server.js
    ```

### 📱 Termux (Android)
1.  **Install Termux**: Get it from F-Droid.
2.  **Update Packages**:
    ```bash
    pkg update && pkg upgrade
    ```
3.  **Install Node.js**:
    ```bash
    pkg install nodejs
    ```
    or
    ```
    pkg install nodejs-lts
    ```
4.  **Install Dependencies**:
    ```bash
    npm install
    ```
5.  **Start Server**:
    ```bash
    node server.js
    ```

### 🐧 Linux (Ubuntu/Debian)
1.  **Update & Install Node.js**:
    ```bash
    sudo apt update
    sudo apt install nodejs npm
    ```
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Start Server**:
    ```bash
    node server.js
    ```

### 🍎 macOS
1.  **Install Node.js**: Using [Homebrew](https://brew.sh/):
    ```bash
    brew install node
    ```
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Start Server**:
    ```bash
    node server.js
    ```

---

## How to Access
Once the server is running, it will display the access URLs in the terminal:
- **Local Access**: `https://localhost:3000`
- **Network Access**: `https://[YOUR-IP]:3000` (Use this for other devices on the same Wi-Fi)

> [!NOTE]
> Since the server uses a self-signed certificate for local encryption, your browser will show a "Your connection is not private" warning. Click **Advanced** -> **Proceed to localhost (unsafe)** to continue.
