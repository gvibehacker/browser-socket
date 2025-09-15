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

### Cloudflare Worker (`/cf-worker`)

- **Build**: `npm run build` - Builds the TypeScript Cloudflare Worker library with Rollup
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

**Cloudflare Worker (`/cf-worker/src`)**:

- `index.ts` - Cloudflare Workers WebSocket bridge with TCP connection handling using connect() API
- `protocol.ts` - binary wire protocol implementation

### Wire Protocol

Binary protocol with 8-byte header + payload:

- Length (24 bits) + Flag (8 bits) + Stream ID (32 bits)
- Flags: DATA(0), SYN(1), ACK(2), FIN(4), RST(8), LISTEN(16), WINDOW_UPDATE(32)
- Stream IDs: Client uses odd numbers (1,3,5...), server uses even numbers (2,4,6...) - incremental and not reusable
- SYN from browser will have payload of: 3 bytes initial window size + address format (:1111, [::1]:1111, 0.0.0.0:1111, unix:my.sock)
- ACK to SYN from server contains 3 bytes window size + JSON payload with socket.address() (address, port, family) plus remoteAddress and remotePort
- LISTEN from browser will have payload in the format of [::1]:1111, 0.0.0.0:1111, unix:my.sock
- ACK to LISTEN from server contains 3 bytes window size + server address info (JSON of Node.js server.address()) as payload
- SYN from server will have payload of: 3 bytes window size + 3 bytes stream id (stream id used in LISTEN) + 2 bytes port (uint16) + variable length host string
- WINDOW_UPDATE frame contains 3 bytes window size as payload
- FIN/RST can have optional data payload

#### Protocol Design Principles

- **Client-triggered actions should not trigger event emission** - Actions initiated by the client should not cause events to be emitted back to the client to prevent feedback loops
- **Invalid protocol format should trigger reset of stream** - Any malformed or invalid protocol data should immediately reset the affected stream to maintain protocol integrity
- **RST is a final state and should not trigger further actions** - Reset frames represent terminal state and should not generate replies or additional payload processing

### Key Classes

**Server Side:**

- `Transport` - Server-side WebSocket handler
- `Connection` - Manages multiplexed TCP connections per WebSocket
- `Socket` - Individual TCP stream within a WebSocket connection
- `ListenSocket` - TCP server socket for accepting incoming connections

**Client Side:**

- `Net` - Main class providing `net.createServer()` and `net.Socket()` API
- `Socket` - Browser-side TCP socket implementation
- `NetListener` - TCP server for accepting connections

**Cloudflare Worker:**

- `Connection` - WebSocket connection handler with CF Workers integration
- `Socket` - WebSocket stream with ReadableStream/WritableStream API

**Shared:**

- `FrameParser` - Handles binary frame parsing for all implementations

### Connection Flow

**Node.js Server Bridge:**

1. Browser connects WebSocket to Node.js server
2. Browser can call `net.createServer()` to listen on Node.js ports
3. Browser can call `new net.Socket().connect()` to connect to external TCP servers
4. All TCP data flows through WebSocket as binary frames with stream multiplexing

**Cloudflare Worker Bridge:**

1. Browser connects WebSocket to Cloudflare Worker endpoint
2. Browser can call `new net.Socket().connect()` to connect to external TCP servers
3. Worker uses `connect()` API to establish TCP connections to external services
4. All TCP data flows through WebSocket with ReadableStream/WritableStream piping

## Development Constraints

**General:**

- Write modular, concise code prioritizing readability over perfection
- All implementations use identical binary protocol for compatibility

**Node.js Server:**

- No third-party libraries allowed (only built-in Node.js `ws` module)
- Use native Node.js networking APIs (`net` module)

**Browser Client:**

- Vanilla JavaScript/TypeScript only
- Use Web APIs (WebSocket, ReadableStream, WritableStream)

**Cloudflare Worker:**

- Use Cloudflare Workers APIs (`connect()`, WebSocket, Streams)
- Leverage Web Standards (ReadableStream, WritableStream, WebSocketPair)
