# @gvibehacker/browser-socket-cloudflare-worker

Cloudflare Workers transport for browser-socket. It terminates WebSocket connections from browsers, multiplexes every TCP stream, and proxies them through Cloudflare's `connect()` API so you can expose TCP services from the edge.

## Install

```bash
npm install @gvibehacker/browser-socket-cloudflare-worker
```

Add it to an existing Wrangler project or scaffold a new worker and import the connection handler in your `src/index.ts`.

## Worker Setup

```ts
import { Connection } from "@gvibehacker/browser-socket-cloudflare-worker";

export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("browser-socket worker", { status: 200 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const connection = new Connection(server);

    connection.addEventListener("connect", async (event) => {
      const [socket, { host, port }] = event.detail;
      const tcp = connect({ hostname: host, port });

      socket.ack({ address: host, port, family: "IPv4", remoteAddress: "0.0.0.0", remotePort: 0 });
      socket.readable.pipeTo(tcp.writable).catch(() => socket.destroy("tcp write error"));
      tcp.readable.pipeTo(socket.writable).catch(() => socket.destroy("tcp read error"));
    });

    return new Response(null, { status: 101, webSocket: client });
  },
};
```

Deploy with Wrangler and point your browser client at the worker URL:

```bash
npm run build
npm run deploy
```

## API Highlights

- `Connection` wraps a worker-side WebSocket and emits DOM-style events (`connect`, `listen`, `close`).
- `Socket` instances expose either WHATWG streams or helper methods (`ack`, `write`, `destroy`) to coordinate TCP flow control.
- Protocol helpers (`encodeFrame`, `parseSynPayload`, frame constants) are exported for advanced integrations or tooling.

See the generated [Cloudflare Worker API docs](./docs/index.html) for all types and event signatures.

## Development

- `npm run build` – bundle TypeScript for worker deployment.
- `npm run dev` / `npm run start` – run the worker locally with Wrangler.
- `npm run docs` – rebuild the Typedoc reference.

Combine this transport with `@gvibehacker/browser-socket-client` in the browser and, optionally, the Node bridge for hybrid routing.
