# 🚀 browser-socket

**Real TCP sockets in your browser. Connect to anything. Host anything.**

[![npm version](https://img.shields.io/npm/v/@gvibehacker/browser-socket-client.svg)](https://www.npmjs.com/package/@gvibehacker/browser-socket-client)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 🤯 What if your browser could...

### As a TCP Client:

- **Connect directly to databases** - Redis, MySQL, PostgreSQL, MongoDB
- **Talk to mail servers** - SMTP, IMAP, POP3
- **Access message queues** - RabbitMQ, Kafka, MQTT brokers
- **Control IoT devices** via raw TCP protocols
- **SSH into servers** (with an SSH client library)

### As a TCP Server:

- **Host a web server** that others can connect to
- **Run a database server** like Redis or SQLite
- **Create game servers** for multiplayer experiences
- **Build P2P applications** without WebRTC complexity
- **Accept webhooks** directly in the browser

**browser-socket** makes all of this possible by giving browsers real TCP networking superpowers!

## 🎯 Why This Changes Everything

Traditional browsers are limited to HTTP/WebSocket requests. With browser-socket, your browser becomes a **full network citizen** capable of:

- **Connecting to ANY TCP service** - databases, mail servers, game servers, IoT devices
- **Accepting incoming connections** like a real server
- **Speaking native protocols** - Redis RESP, MySQL protocol, SMTP, anything!
- **Multiplexing everything** through a single WebSocket
- **Zero configuration** - just connect and start building

## 🚀 Quick Start

### Installation

**Server (Node.js):**

```bash
npm install @gvibehacker/browser-socket-server
```

**Client (Browser):**

```bash
npm install @gvibehacker/browser-socket-client
```

### Basic Setup

1. **Start the WebSocket bridge server:**

```javascript
// Node.js server
import { WebSocketServer } from "ws";
import { Transport } from "@gvibehacker/browser-socket-server";

const wss = new WebSocketServer({ port: 8080 });
const transport = new Transport(wss);
console.log("WebSocket bridge running on :8080");
```

2. **Connect from the browser:**

```javascript
// Browser code
import { Net } from "@gvibehacker/browser-socket-client";

const net = new Net("ws://localhost:8080");

// Now you can create servers and sockets!
```

## 📖 API Documentation

### 📱 [Client API Reference](https://gvibehacker.github.io/browser-socket/docs/client/)
Complete documentation for the browser-side API including `Net`, `Socket`, and `NetServer` classes. Learn how to create TCP clients and servers in the browser.

### 🖥️ [Server API Reference](https://gvibehacker.github.io/browser-socket/docs/server/)  
Node.js server-side API documentation covering `Transport`, `Connection`, and `Socket` classes for WebSocket bridge implementation.

## 📚 Examples

### 🌉 [Server Bridge Setup](./examples/bridge)
**Essential setup guide** - Shows how to configure the Node.js WebSocket bridge server to forward TCP traffic between browsers and servers. Start here to get browser-socket working.

### 🌐 [Web Server Example](./examples/web-server) | [🚀 Live Demo](https://gvibehacker.github.io/browser-socket/examples/web-server/)

Run a fully functional HTTP server directly in your browser. Demonstrates how to accept incoming connections and serve web content from a browser tab.

### 🔍 [DNS Lookup Example](./examples/dns) | [🚀 Live Demo](https://gvibehacker.github.io/browser-socket/examples/dns/)

Perform DNS lookups from the browser using a WebAssembly-compiled Go DNS resolver. Shows how browser-socket enables complex networking protocols in the browser.

## 🏗 How It Works

browser-socket creates a bridge between your browser and the Node.js networking stack:

1. **Browser** ↔️ **WebSocket** ↔️ **Node.js Bridge** ↔️ **TCP Network**
2. All TCP streams are multiplexed through a single WebSocket connection
3. Binary protocol ensures minimal overhead
4. Stream IDs keep connections isolated

## 🔒 Security Considerations

- Always run behind authentication in production
- Use TLS/WSS for encrypted connections
- Implement proper access controls for exposed services
- Monitor and rate-limit connections

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## 🌟 Star Us!

If this blew your mind, give us a star! ⭐️

---

**Made with ❤️ by developers who believe browsers can do anything**
