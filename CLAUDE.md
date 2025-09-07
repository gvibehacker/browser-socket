# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

browser-socket is a WebSocket-based transport layer that allows browsers to communicate with Node.js TCP servers through WebSocket multiplexing. It enables browser code to create TCP servers and clients that run on the Node.js server side, with data flowing through a single WebSocket connection.

## Common Commands

### Server (`/server`)

- **Build**: `npm run build` - Builds the TypeScript server library with Rollup
- **Development**: `npm run dev` - Builds and watches for changes
- **Install deps**: `npm install`

### Client (`/client`)

- **Build**: `npm run build` - Builds the TypeScript client library with Rollup
- **Development**: `npm run dev` - Builds and watches for changes
- **Install deps**: `npm install`

### Runtime

- **Default WebSocket port**: 8080

## Architecture

### Core Components

**Server Side (`/server/src`)**:

- `index.ts` - Main transport layer with Transport and ConnectionHandler classes
- `protocol.ts` - Binary wire protocol implementation with frame encoding/decoding

**Client Side (`/client/src`)**:

- `index.ts` - Browser-compatible WebSocket transport with Node.js-like TCP API including Net class

### Wire Protocol

Binary protocol with 8-byte header + payload:

- Length (24 bits) + Flag (8 bits) + Stream ID (32 bits)
- Flags: DATA(0), SYN(1), ACK(2), FIN(4), RST(8), LISTEN(16)
- Stream IDs: Client uses odd numbers (1,3,5...), server uses even numbers (2,4,6...) - incremental and not reusable
- SYN from browser will have payload in the format of :1111, [::1]:1111, 0.0.0.0:1111, unix://my.sock
- ACK to SYN from server contains JSON payload with socket.address() (address, port, family) plus remoteAddress and remotePort
- LISTEN from browser will have payload in the format of [::1]:1111, 0.0.0.0:1111, unix://my.sock
- ACK to LISTEN from server contains server address info (JSON of Node.js server.address()) as payload
- SYN from server will have payload of: 3 bytes stream id (stream id used in LISTEN) + 2 bytes port (uint16) + variable length host string
- FIN/RST can have optional data payload

### Key Classes

- `Transport` - Server-side WebSocket handler
- `ConnectionHandler` - Manages multiplexed TCP connections per WebSocket
- `Net` - Client-side main class providing `net.createServer()` and `net.Socket()` API
- `FrameParser` - Handles binary frame parsing for both client and server

### Connection Flow

1. Browser connects WebSocket to Node.js server
2. Browser can call `net.createServer()` to listen on Node.js ports
3. Browser can call `new net.Socket().connect()` to connect to external TCP servers
4. All TCP data flows through WebSocket as binary frames with stream multiplexing

## Development Constraints

- No third-party libraries allowed (only built-in Node.js `ws` module)
- Write modular, concise code prioritizing readability over perfection
- Both client and server implement identical binary protocol
