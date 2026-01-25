# Netless

A local network chat app that runs on your LAN. Everything stays on your network - no internet needed, no data sent anywhere else.

## What it does
- Text chat with everyone on the same network
- Send files and voice messages
- React to messages with emojis
- See who's online
- Admin controls for moderation
- HTTPS encryption (self-signed cert)

## Setup

You need Node.js installed first. Get it from [nodejs.org](https://nodejs.org/) if you don't have it.

Then just:
```bash
npm install
node server.js
```

The server runs on port 3000. It'll show you the URLs to connect when it starts up.

### Termux (Android)
```bash
pkg update && pkg upgrade
pkg install nodejs
npm install
node server.js
```

## Using it

Open `https://localhost:3000` or `https://[your-ip]:3000` in your browser. Your browser will complain about the certificate being self-signed - that's expected. Just click through the warning.

Everyone on the same network can connect using your IP address.

## Admin stuff

Type `/admin netlessadmin` in the chat to get admin powers. You can then edit or delete any message using the buttons that appear.

## Details

- Built with Fastify and WebSockets
- Files are chunked for transfer (handles up to 100MB, but 15MB is more reliable)
- Automatically adjusts for mobile/low-resource devices
- Messages aren't saved to disk, only usernames are kept in `users.json`
- Uses backpressure handling so large transfers don't crash things
