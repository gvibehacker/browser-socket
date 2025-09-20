# @gvibehacker/browser-socket-server

Node.js transport that bridges browser-socket clients to real TCP sockets. It accepts browser WebSocket connections, multiplexes streams over a single socket, and hands them to your Node runtime so you can connect to or host arbitrary TCP services on behalf of the browser.

## Install

```bash
npm install @gvibehacker/browser-socket-server
```

## Quick Start

```ts
import { Transport } from "@gvibehacker/browser-socket-server";
import { WebSocketServer } from "ws";
import net from "node:net";

const wss = new WebSocketServer({ port: 8080, perMessageDeflate: false });
const transport = new Transport(wss);

transport.on("connection", (connection) => {
  connection.on("connect", (socket, { address, port }) => {
    const upstream = net.connect(port, address);

    upstream.on("connect", () => {
      socket.ack({
        address: upstream.localAddress!,
        port: upstream.localPort!,
        family: upstream.localFamily!,
        remoteAddress: upstream.remoteAddress!,
        remotePort: upstream.remotePort!,
      });

      upstream.on("data", (chunk) => socket.write(chunk));
      socket.readable.pipeTo(
        new WritableStream({
          write(chunk) {
            upstream.write(Buffer.from(chunk));
          },
        })
      );
    });

    upstream.on("error", (err) => socket.destroy(err.message));
  });
});

transport.start();
console.log("Bridge listening on ws://localhost:8080");
```

## API Highlights

- `Transport` binds to an existing `ws` server and emits `connection` events per browser.
- `Connection` surfaces `connect` and `listen` events to map browser flows onto real TCP sockets.
- `Socket` objects expose Node-like methods (`ack`, `write`, `end`, `destroy`) plus WHATWG streams for piping.
- Flow control is handled by the binary protocol (24-bit length frames with window updates) so you can focus on wiring TCP endpoints.

See the generated [Server API docs](./docs/index.html) for the full surface area.

## Development

- `npm run build` – bundle TypeScript with Rollup and emit d.ts files.
- `npm run dev` – watch source files and rebuild incrementally.
- `npm run docs` – regenerate the HTML reference under `docs/`.

Pair this package with `@gvibehacker/browser-socket-client` in the browser or the Cloudflare Worker bridge for edge deployments.
