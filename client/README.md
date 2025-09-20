# @gvibehacker/browser-socket-client

Browser-friendly TCP facade that mirrors Node.js `net`, backed by the browser-socket transport. It multiplexes every outbound or inbound TCP stream over a single WebSocket bridge so you can connect to databases, queues, or your own services directly from the browser.

## Install

```bash
npm install @gvibehacker/browser-socket-client
```

Load the ESM build in modern bundlers, the CJS build in Node-style environments, or the minified bundle from `dist/index.min.js` for `<script>` usage.

## Connect to a TCP Service

```ts
import { Net } from "@gvibehacker/browser-socket-client";

const net = new Net("ws://localhost:8080");
const socket = net.createConnection({ host: "example.com", port: 80 }, () => {
  console.log("connected from the browser");
  socket.write("GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
});

socket.on("data", (chunk) => {
  console.log("response", new TextDecoder().decode(chunk));
});

socket.on("end", () => console.log("closed"));
```

## Host a TCP Server in the Browser

```ts
import { Net } from "@gvibehacker/browser-socket-client";

const net = new Net("ws://localhost:8080");

const server = net.createServer((client) => {
  client.write("hello from the browser!\n");

  client.readable.pipeTo(
    new WritableStream({
      write(chunk) {
        client.write(chunk); // simple echo
      },
    })
  );
});

server.listen({ host: "0.0.0.0", port: 3000 }, () => {
  console.log("browser server ready");
});
```

## API Highlights

- `Net` manages the underlying WebSocket tunnel and exposes Node-compatible helpers (`createConnection`, `createServer`).
- `Socket` instances provide event emitter semantics (`data`, `end`, `error`) and WHATWG streams for modern piping.
- Automatic backpressure via window updates keeps streams responsive even with multiple concurrent connections.

Refer to the generated [Client API docs](./docs/index.html) for the full surface, including low-level helpers and TypeScript definitions under `dist/index.d.ts`.

## Development

- `npm run build` – roll up TypeScript to ESM, CJS, and browser bundles.
- `npm run dev` – watch mode for rapid iteration while working on demos.
- `npm run docs` – rebuild the Typedoc reference in `docs/`.

Pair with `@gvibehacker/browser-socket-server` or the Cloudflare Worker bridge to reach your target TCP services.
