/**
 * @fileoverview Cloudflare Workers WebSocket transport with TCP connection handling
 *
 * This module provides the Cloudflare Workers implementation for browser-socket,
 * enabling browsers to create TCP connections through WebSocket multiplexing.
 * It handles the bridge between WebSocket connections from browsers and external
 * TCP services using Cloudflare's connect API and WebSocket API.
 *
 * The implementation provides a complete bridge server that allows browsers to:
 * - Create TCP client connections to external services
 * - Handle multiplexed streams over a single WebSocket connection
 * - Perform TCP proxying with flow control and error handling
 * - Connect to services like Redis, PostgreSQL, HTTP servers, etc.
 *
 * @example Complete Cloudflare Worker Setup
 * ```javascript
 * // wrangler.toml
 * // name = "browser-socket-worker"
 * // compatibility_date = "2023-05-18"
 * // [env.production]
 * // vars = { ENVIRONMENT = "production" }
 *
 * import { Connection } from './src/index.js';
 *
 * export default {
 *   async fetch(request, env, ctx) {
 *     // Handle WebSocket upgrade for browser-socket connections
 *     if (request.headers.get('Upgrade') === 'websocket') {
 *       const pair = new WebSocketPair();
 *       const [client, server] = Object.values(pair);
 *
 *       // Create connection handler for multiplexed TCP streams
 *       const connection = new Connection(server);
 *
 *       // Handle browser TCP connection requests
 *       connection.addEventListener('connect', async (event) => {
 *         const [socket, addressInfo] = event.detail;
 *         
 *         try {
 *           // Use Cloudflare's connect API for TCP connections
 *           const tcpSocket = connect({
 *             hostname: addressInfo.host,
 *             port: addressInfo.port
 *           });
 *
 *           // Acknowledge successful connection to browser
 *           socket.ack({
 *             address: addressInfo.host,
 *             port: addressInfo.port,
 *             family: 'IPv4',
 *             remoteAddress: '0.0.0.0', // Worker IP not available
 *             remotePort: 0
 *           });
 *
 *           // Pipe data between browser socket and TCP connection
 *           socket.readable.pipeTo(tcpSocket.writable).catch(() => {
 *             socket.destroy('TCP write error');
 *           });
 *
 *           tcpSocket.readable.pipeTo(socket.writable).catch(() => {
 *             socket.destroy('TCP read error');
 *           });
 *
 *         } catch (error) {
 *           socket.destroy(`Connection failed: ${error.message}`);
 *         }
 *       });
 *
 *       return new Response(null, {
 *         status: 101,
 *         webSocket: client,
 *       });
 *     }
 *
 *     // Serve static assets or API endpoints
 *     return new Response('Browser Socket Worker', { status: 200 });
 *   },
 * };
 * ```
 *
 * @example Redis Connection Through Worker
 * ```javascript
 * // Browser-side code using the worker
 * const net = new Net('wss://your-worker.workers.dev');
 * 
 * const redis = new net.Socket();
 * redis.connect(6379, 'redis.example.com', () => {
 *   console.log('Connected to Redis through Cloudflare Worker');
 *   redis.write('PING\r\n');
 * });
 * 
 * redis.on('data', (data) => {
 *   console.log('Redis response:', data.toString());
 * });
 * ```
 */

import {
  FLAGS,
  Flag,
  encodeFrame,
  FrameParser,
  parseSynPayload,
} from "./protocol";

class ReadableStreamSource {
  remoteWindowSize: number = 0;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    private conn: Connection,
    private streamId: number,
    private queueSize: number
  ) {
    this.remoteWindowSize = this.queueSize;
  }

  start(controller: ReadableStreamDefaultController<Uint8Array>): void {
    this.controller = controller;
  }

  pull(controller: ReadableStreamDefaultController<Uint8Array>): void {
    if (this.remoteWindowSize > this.queueSize / 2) return;
    const delta = controller.desiredSize! - this.remoteWindowSize;
    this.remoteWindowSize += delta;
    // send WINDOW_UPDATE
    const payload = new Uint8Array(3);
    payload[0] = (delta >> 16) & 0xff;
    payload[1] = (delta >> 8) & 0xff;
    payload[2] = delta & 0xff;
    this.conn.sendFrame(FLAGS.WINDOW_UPDATE, this.streamId, payload);
  }

  cancel(): void {
    this.controller = null;
  }

  onData(data: Uint8Array): void {
    this.remoteWindowSize -= data.length;

    try {
      this.controller?.enqueue(data);
    } catch (error) {
      this.controller?.error(error);
    }
  }

  onEnd(): void {
    try {
      this.controller?.close();
    } catch (error) {
      // Controller might already be closed
    }
    this.controller = null;
  }

  onError(err: Error): void {
    try {
      this.controller?.error(err);
    } catch (e) {
      // Controller might already be errored/closed
    }
    this.controller = null;
  }
}

class WritableStreamSink implements UnderlyingSink<Uint8Array> {
  private controller: WritableStreamDefaultController | null = null;
  private waitingForCapacity: ((value: void) => void) | null = null;

  constructor(private socket: Socket, private availableWindowSize: number) {}

  start(controller: WritableStreamDefaultController): void {
    this.controller = controller;
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.socket.ended) {
      throw new Error("Socket is closed");
    }

    // Wait for available window space if needed
    while (this.availableWindowSize < chunk.length) {
      if (this.socket.ended) {
        throw new Error("Socket is closed");
      }

      // Wait for capacity to be added
      await new Promise<void>((resolve) => {
        this.waitingForCapacity = resolve;
      });
    }

    // Send the data through the socket's write method
    this.availableWindowSize -= chunk.length;
    this.socket.write(chunk);
  }

  close(): void {
    this.socket.end();
    this.waitingForCapacity?.();
    this.waitingForCapacity = null;
  }

  abort(reason?: any): void {
    this.socket.destroy(String(reason?.message || reason));
    this.waitingForCapacity?.();
    this.waitingForCapacity = null;
  }

  addCapacity(windowSize: number): void {
    this.availableWindowSize += windowSize;
    this.waitingForCapacity?.();
    this.waitingForCapacity = null;
  }

  onError(error: Error): void {
    try {
      this.controller?.error(error);
    } catch (e) {
      // Controller might already be errored/closed
    }
    this.controller = null;
    this.waitingForCapacity?.();
    this.waitingForCapacity = null;
  }
}

/**
 * Manages a single WebSocket connection from a browser
 *
 * This class handles the multiplexed TCP streams over a single WebSocket
 * connection. It processes binary frames from the browser, manages socket
 * instances for each stream, and coordinates between browser requests and
 * external TCP services using Cloudflare Workers APIs.
 *
 * The Connection class is the core of the Cloudflare Workers bridge,
 * responsible for:
 * - Parsing incoming WebSocket frames from browsers
 * - Managing multiple concurrent TCP streams over one WebSocket
 * - Handling connection lifecycle (SYN, ACK, FIN, RST frames)
 * - Implementing flow control with window updates
 * - Coordinating with Cloudflare's connect API for TCP connections
 *
 * @example Basic Connection Setup
 * ```javascript
 * // In a Cloudflare Worker fetch handler
 * const pair = new WebSocketPair();
 * const [client, server] = Object.values(pair);
 * const connection = new Connection(server);
 *
 * connection.addEventListener('connect', async (event) => {
 *   const [socket, addressInfo] = event.detail;
 *   console.log(`Browser wants to connect to ${addressInfo.host}:${addressInfo.port}`);
 *   
 *   // Use Cloudflare's connect API for TCP connections
 *   const tcpSocket = connect({
 *     hostname: addressInfo.host,
 *     port: addressInfo.port
 *   });
 *
 *   // Send acknowledgment with connection details
 *   socket.ack({
 *     address: addressInfo.host,
 *     port: addressInfo.port,
 *     family: 'IPv4',
 *     remoteAddress: '0.0.0.0', // Worker IP not available
 *     remotePort: 0
 *   });
 *
 *   // Establish bidirectional data flow
 *   socket.readable.pipeTo(tcpSocket.writable);
 *   tcpSocket.readable.pipeTo(socket.writable);
 * });
 *
 * return new Response(null, { status: 101, webSocket: client });
 * ```
 *
 * @example Advanced Connection with Error Handling
 * ```javascript
 * const connection = new Connection(webSocket);
 *
 * connection.addEventListener('connect', async (event) => {
 *   const [socket, addressInfo] = event.detail;
 *   
 *   try {
 *     // Validate connection request
 *     if (!addressInfo.host || !addressInfo.port) {
 *       socket.destroy('Invalid address information');
 *       return;
 *     }
 *
 *     // Connect with timeout
 *     const controller = new AbortController();
 *     const timeoutId = setTimeout(() => controller.abort(), 10000);
 *
 *     const tcpSocket = connect({
 *       hostname: addressInfo.host,
 *       port: addressInfo.port
 *     }, { signal: controller.signal });
 *
 *     clearTimeout(timeoutId);
 *
 *     // Send success response
 *     socket.ack({
 *       address: addressInfo.host,
 *       port: addressInfo.port,
 *       family: 'IPv4',
 *       remoteAddress: '0.0.0.0',
 *       remotePort: 0
 *     });
 *
 *     // Handle connection errors
 *     tcpSocket.closed.catch((error) => {
 *       socket.destroy(`TCP connection failed: ${error.message}`);
 *     });
 *
 *     // Pipe data with error handling
 *     socket.readable.pipeTo(tcpSocket.writable).catch(() => {
 *       socket.destroy('Write stream error');
 *     });
 *
 *     tcpSocket.readable.pipeTo(socket.writable).catch(() => {
 *       socket.destroy('Read stream error');
 *     });
 *
 *   } catch (error) {
 *     socket.destroy(`Connection error: ${error.message}`);
 *   }
 * });
 * ```
 */
export class Connection extends EventTarget {
  public sockets: Map<number, Socket> = new Map();
  private frameParser: FrameParser = new FrameParser();
  private closed: boolean = false;
  nextStreamId: number = 2; // Server uses even IDs (2, 4, 6...) for incoming connections

  /**
   * Creates a new Connection instance for a WebSocket
   * 
   * Initializes the connection handler for managing multiplexed TCP streams
   * over a single WebSocket connection from a browser. Sets up message and
   * close event handlers for the WebSocket.
   * 
   * @param ws - WebSocket connection to the browser
   * 
   * @example
   * ```javascript
   * // Create connection in Cloudflare Worker
   * const pair = new WebSocketPair();
   * const [client, server] = Object.values(pair);
   * const connection = new Connection(server);
   * 
   * // Return client WebSocket to browser
   * return new Response(null, { 
   *   status: 101, 
   *   webSocket: client 
   * });
   * ```
   */
  constructor(private ws: WebSocket) {
    super();
    ws.addEventListener("message", this.handleMessage.bind(this) as any);
    ws.addEventListener("close", this.handleClose.bind(this));
  }

  private handleMessage(event: MessageEvent): void {
    const frames = this.frameParser.addData(new Uint8Array(event.data));

    for (const frame of frames) {
      const { flag, streamId, payload } = frame;
      let socket: Socket | undefined;
      switch (flag) {
        case FLAGS.SYN:
          try {
            const [windowSize, addressInfo] = parseSynPayload(payload);
            // Client-initiated SYN (outbound connection request)
            const socket = new Socket(this, streamId, 65536, windowSize);
            this.sockets.set(streamId, socket);
            this.dispatchEvent(
              new CustomEvent("connect", { detail: [socket, addressInfo] })
            );
          } catch (error) {
            const err = String((error as Error)?.message || error);
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
          }
          break;
        case FLAGS.DATA:
          socket = this.sockets.get(streamId);
          if (!socket) {
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
            break;
          }
          if (socket.remoteEnded) {
            const err = "Data after end";
            this.sockets.delete(streamId);
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
            break;
          }

          if (socket.readableSource.remoteWindowSize < payload.length) {
            const err = "Data exceeding allowed window size";
            this.sockets.delete(streamId);
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
            break;
          }
          socket.readableSource.onData(payload);
          break;
        case FLAGS.FIN:
          socket = this.sockets.get(streamId);
          if (!socket) {
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
            break;
          }
          if (socket.remoteEnded) break;
          socket.remoteEnded = true;
          if (socket.ended) {
            this.sockets.delete(streamId);
          }
          socket.readableSource.onEnd();
          break;
        case FLAGS.RST:
          socket = this.sockets.get(streamId);
          if (!socket) break;
          if (socket.ended && socket.remoteEnded) break;
          this.sockets.delete(streamId);
          socket.onError(new TextDecoder().decode(payload));
          break;
        case FLAGS.WINDOW_UPDATE:
          socket = this.sockets.get(streamId);
          if (!socket) {
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
            break;
          }
          try {
            socket.incrementWriteWindow(
              (payload[0] << 16) | (payload[1] << 8) | payload[2]
            );
          } catch (error) {
            const err = String((error as Error)?.message || error);
            this.sockets.delete(streamId);
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
          }
          break;
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets.values()) {
      if (socket.ended && socket.remoteEnded) continue;
      socket.onError("Websocket closed");
    }
    this.sockets.clear();
  }

  /**
   * Closes the WebSocket connection and all associated sockets
   * 
   * Gracefully shuts down the connection by destroying all active sockets,
   * clearing the socket map, and closing the underlying WebSocket. This
   * ensures proper cleanup when the Worker is terminating or the browser
   * connection needs to be closed.
   * 
   * @example
   * ```javascript
   * // Close connection when Worker is done
   * connection.close();
   * ```
   * 
   * @example
   * ```javascript
   * // Close connection with cleanup in Worker
   * export default {
   *   async fetch(request, env, ctx) {
   *     const connection = new Connection(webSocket);
   *     
   *     // Handle connection cleanup on context cancellation
   *     ctx.waitUntil(new Promise((resolve) => {
   *       connection.addEventListener('close', resolve);
   *     }));
   * 
   *     // Ensure cleanup on termination
   *     addEventListener('beforeunload', () => {
   *       connection.close();
   *     });
   * 
   *     return response;
   *   }
   * };
   * ```
   */
  close(): void {
    if (this.closed) return;
    for (const socket of this.sockets.values()) {
      socket.destroy();
    }
    this.sockets.clear();
    this.ws.close();
  }

  sendFrame(flag: Flag, streamId: number, payload?: Uint8Array): void {
    if (this.ws.readyState === 1) {
      // WebSocket.OPEN = 1
      const frame = encodeFrame(flag, streamId, payload || new Uint8Array(0));
      this.ws.send(frame);
    }
  }
}

/**
 * Represents a multiplexed socket connection within a WebSocket
 *
 * This class provides a socket-like interface for individual TCP
 * streams multiplexed over the WebSocket connection. It handles sending
 * and receiving data, connection lifecycle, and coordinating with the
 * browser-side socket implementation in Cloudflare Workers.
 *
 * The Socket class implements the Web Streams API (ReadableStream/WritableStream)
 * to provide seamless integration with Cloudflare Workers' connect API and
 * other streaming APIs. It manages flow control, handles stream lifecycle,
 * and provides methods for acknowledgment and data transmission.
 *
 * Key features:
 * - ReadableStream/WritableStream API for easy piping
 * - Flow control with window size management
 * - Graceful connection lifecycle handling
 * - Error propagation and cleanup
 * - Compatible with Cloudflare's connect() API
 *
 * @example Basic Socket Usage
 * ```javascript
 * // Socket is typically created by Connection
 * connection.addEventListener('connect', async (event) => {
 *   const [socket, addressInfo] = event.detail;
 *
 *   // Acknowledge the connection with address details
 *   socket.ack({
 *     address: addressInfo.host,
 *     port: addressInfo.port,
 *     family: 'IPv4',
 *     remoteAddress: '0.0.0.0',
 *     remotePort: 0
 *   });
 *
 *   // Connect to external TCP service
 *   const tcpSocket = connect({
 *     hostname: addressInfo.host,
 *     port: addressInfo.port
 *   });
 *
 *   // Pipe streams between browser and TCP service
 *   socket.readable.pipeTo(tcpSocket.writable);
 *   tcpSocket.readable.pipeTo(socket.writable);
 * });
 * ```
 *
 * @example HTTP Proxy Through Worker
 * ```javascript
 * connection.addEventListener('connect', async (event) => {
 *   const [socket, addressInfo] = event.detail;
 *   
 *   if (addressInfo.port === 80 || addressInfo.port === 443) {
 *     // Proxy HTTP/HTTPS connections
 *     const tcpSocket = connect({
 *       hostname: addressInfo.host,
 *       port: addressInfo.port
 *     });
 *
 *     socket.ack({
 *       address: addressInfo.host,
 *       port: addressInfo.port,
 *       family: 'IPv4',
 *       remoteAddress: '0.0.0.0',
 *       remotePort: 0
 *     });
 *
 *     // Handle HTTP proxy
 *     socket.readable.pipeTo(tcpSocket.writable).catch(() => {
 *       socket.destroy('HTTP proxy write error');
 *     });
 *
 *     tcpSocket.readable.pipeTo(socket.writable).catch(() => {
 *       socket.destroy('HTTP proxy read error');
 *     });
 *   } else {
 *     socket.destroy('Port not allowed');
 *   }
 * });
 * ```
 *
 * @example Manual Data Handling
 * ```javascript
 * connection.addEventListener('connect', async (event) => {
 *   const [socket, addressInfo] = event.detail;
 *   
 *   socket.ack({
 *     address: addressInfo.host,
 *     port: addressInfo.port,
 *     family: 'IPv4',
 *     remoteAddress: '0.0.0.0',
 *     remotePort: 0
 *   });
 *
 *   // Read data from browser manually
 *   const reader = socket.readable.getReader();
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     
 *     // Process data from browser
 *     console.log('Received from browser:', new TextDecoder().decode(value));
 *   }
 *
 *   // Write data to browser manually
 *   const writer = socket.writable.getWriter();
 *   await writer.write(new TextEncoder().encode('Hello from Worker'));
 *   await writer.close();
 * });
 * ```
 */
export class Socket {
  readable: ReadableStream;
  readableSource: ReadableStreamSource;
  writable: WritableStream;
  private writableSink: WritableStreamSink;
  ended: boolean = false;
  remoteEnded: boolean = false;
  remoteAddress: string | null = null;
  remotePort: number | null = null;

  /**
   * Creates a new Socket instance
   * 
   * Initializes a new multiplexed socket with ReadableStream and WritableStream
   * interfaces for handling TCP data over WebSocket transport. Sets up flow
   * control with the specified window sizes.
   * 
   * @param connection - Parent Connection instance managing the WebSocket
   * @param streamId - Unique stream identifier for this socket (even numbers for server-side)
   * @param initialWindowSize - Initial window size for flow control on readable stream
   * @param availableWriteWindowSize - Available window size for writing to browser
   * 
   * @example
   * ```javascript
   * // Socket is typically created internally by Connection
   * // when handling SYN frames from browser
   * const socket = new Socket(connection, streamId, 65536, 32768);
   * ```
   */
  constructor(
    private connection: Connection,
    private streamId: number,
    private initialWindowSize: number,
    availableWriteWindowSize: number
  ) {
    this.readableSource = new ReadableStreamSource(
      this.connection,
      this.streamId,
      initialWindowSize
    );
    this.readable = new ReadableStream(this.readableSource, {
      highWaterMark: initialWindowSize,
      size: (chunk) => chunk.length,
    });
    this.writableSink = new WritableStreamSink(this, availableWriteWindowSize);
    this.writable = new WritableStream(this.writableSink, {
      highWaterMark: 0,
    });
  }

  /**
   * Sends an acknowledgment frame to the browser
   * 
   * Acknowledges a connection request from the browser, indicating that
   * the TCP connection has been established successfully. The address
   * information is sent back to the browser to confirm connection details.
   * 
   * @param addressInfo - Optional address information for the established connection
   * @param addressInfo.address - Target host address
   * @param addressInfo.port - Target host port
   * @param addressInfo.family - IP family ('IPv4' or 'IPv6')
   * @param addressInfo.remoteAddress - Worker's remote address (usually '0.0.0.0')
   * @param addressInfo.remotePort - Worker's remote port (usually 0)
   * 
   * @example Basic ACK
   * ```javascript
   * // Acknowledge connection with address details
   * socket.ack({
   *   address: 'example.com',
   *   port: 443,
   *   family: 'IPv4',
   *   remoteAddress: '0.0.0.0',  // Worker IP not available
   *   remotePort: 0
   * });
   * ```
   * 
   * @example ACK Without Address Info
   * ```javascript
   * // Send simple acknowledgment
   * socket.ack();
   * ```
   * 
   * @example Connection Flow
   * ```javascript
   * connection.addEventListener('connect', async (event) => {
   *   const [socket, addressInfo] = event.detail;
   *   
   *   try {
   *     const tcpSocket = connect({
   *       hostname: addressInfo.host,
   *       port: addressInfo.port
   *     });
   * 
   *     // Send ACK to confirm successful connection
   *     socket.ack({
   *       address: addressInfo.host,
   *       port: addressInfo.port,
   *       family: 'IPv4',
   *       remoteAddress: '0.0.0.0',
   *       remotePort: 0
   *     });
   * 
   *     // Proceed with data piping...
   *   } catch (error) {
   *     socket.destroy(`Failed to connect: ${error.message}`);
   *   }
   * });
   * ```
   */
  ack(addressInfo?: {
    address: string;
    port: number;
    family: string;
    remoteAddress: string;
    remotePort: number;
  }): void {
    if (this.ended || this.remoteEnded) return;
    const addressPayload = addressInfo
      ? new TextEncoder().encode(JSON.stringify(addressInfo))
      : new Uint8Array(0);

    const payload = new Uint8Array(3 + addressPayload.length);
    payload.set(addressPayload, 3);
    payload[0] = (this.initialWindowSize >> 16) & 0xff;
    payload[1] = (this.initialWindowSize >> 8) & 0xff;
    payload[2] = this.initialWindowSize & 0xff;

    this.connection.sendFrame(FLAGS.ACK, this.streamId, payload);
  }

  /**
   * Writes data to the socket (sends to browser)
   * 
   * Sends data directly to the browser through the WebSocket using DATA frames.
   * This method provides immediate data transmission without flow control,
   * making it suitable for simple data sending scenarios.
   * 
   * Note: For proper flow control and backpressure handling, prefer using
   * the WritableStream interface (socket.writable.getWriter().write()).
   * 
   * @param data - Data to send (Uint8Array or string)
   * @returns True if data was sent, false if socket is destroyed
   * 
   * @example Send String Data
   * ```javascript
   * // Send text data to browser
   * socket.write('Hello from Cloudflare Worker');
   * socket.write('Server response data');
   * ```
   * 
   * @example Send Binary Data
   * ```javascript
   * // Send binary data to browser
   * const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
   * socket.write(binaryData);
   * ```
   * 
   * @example HTTP Response Proxy
   * ```javascript
   * connection.addEventListener('connect', async (event) => {
   *   const [socket, addressInfo] = event.detail;
   *   
   *   socket.ack({
   *     address: addressInfo.host,
   *     port: addressInfo.port,
   *     family: 'IPv4',
   *     remoteAddress: '0.0.0.0',
   *     remotePort: 0
   *   });
   * 
   *   // Send HTTP response directly
   *   socket.write('HTTP/1.1 200 OK\r\n');
   *   socket.write('Content-Type: text/plain\r\n');
   *   socket.write('Content-Length: 26\r\n\r\n');
   *   socket.write('Hello from Cloudflare Worker');
   *   socket.end();
   * });
   * ```
   */
  write(data: Uint8Array | string): boolean {
    if (this.ended) return false;
    this.connection.sendFrame(
      FLAGS.DATA,
      this.streamId,
      typeof data === "string" ? new TextEncoder().encode(data) : data
    );
    return true;
  }

  /**
   * Ends the socket connection gracefully
   * 
   * Sends a FIN frame to the browser to indicate that no more data
   * will be sent from the worker. The connection remains open for
   * receiving data from the browser until the browser also sends FIN.
   * 
   * @example Basic Connection End
   * ```javascript
   * // End the connection after sending data
   * socket.write('Final message');
   * socket.end();
   * ```
   * 
   * @example HTTP Response End
   * ```javascript
   * connection.addEventListener('connect', async (event) => {
   *   const [socket, addressInfo] = event.detail;
   *   
   *   socket.ack({
   *     address: addressInfo.host,
   *     port: addressInfo.port,
   *     family: 'IPv4',
   *     remoteAddress: '0.0.0.0',
   *     remotePort: 0
   *   });
   * 
   *   // Send complete HTTP response and end
   *   socket.write('HTTP/1.1 200 OK\r\n');
   *   socket.write('Content-Type: application/json\r\n\r\n');
   *   socket.write(JSON.stringify({ message: 'Success' }));
   *   socket.end(); // Graceful connection termination
   * });
   * ```
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.remoteEnded) {
      this.connection.sockets.delete(this.streamId);
    }
    this.connection.sendFrame(FLAGS.FIN, this.streamId);
  }

  /**
   * Forcefully destroys the socket connection
   * 
   * Immediately terminates the socket connection by sending an RST frame
   * to the browser. This is used for error conditions or when the connection
   * needs to be aborted immediately. Unlike end(), this does not wait for
   * graceful shutdown and closes the connection immediately.
   * 
   * @param error - Optional error information (Error object, Uint8Array, or string)
   * 
   * @example Destroy With Error
   * ```javascript
   * // Destroy connection due to timeout
   * socket.destroy(new Error('Connection timeout'));
   * 
   * // Destroy with custom error message
   * socket.destroy('Invalid request format');
   * ```
   * 
   * @example Destroy Without Error
   * ```javascript
   * // Destroy connection cleanly
   * socket.destroy();
   * ```
   * 
   * @example Connection Validation
   * ```javascript
   * connection.addEventListener('connect', async (event) => {
   *   const [socket, addressInfo] = event.detail;
   *   
   *   // Validate connection request
   *   const allowedHosts = ['api.example.com', 'db.example.com'];
   *   if (!allowedHosts.includes(addressInfo.host)) {
   *     socket.destroy('Host not allowed');
   *     return;
   *   }
   * 
   *   const allowedPorts = [80, 443, 3306, 5432];
   *   if (!allowedPorts.includes(addressInfo.port)) {
   *     socket.destroy(`Port ${addressInfo.port} not allowed`);
   *     return;
   *   }
   * 
   *   // Proceed with connection...
   *   socket.ack({
   *     address: addressInfo.host,
   *     port: addressInfo.port,
   *     family: 'IPv4',
   *     remoteAddress: '0.0.0.0',
   *     remotePort: 0
   *   });
   * });
   * ```
   * 
   * @example TCP Connection Error Handling
   * ```javascript
   * connection.addEventListener('connect', async (event) => {
   *   const [socket, addressInfo] = event.detail;
   *   
   *   try {
   *     const tcpSocket = connect({
   *       hostname: addressInfo.host,
   *       port: addressInfo.port
   *     });
   * 
   *     socket.ack({
   *       address: addressInfo.host,
   *       port: addressInfo.port,
   *       family: 'IPv4',
   *       remoteAddress: '0.0.0.0',
   *       remotePort: 0
   *     });
   * 
   *     // Handle TCP connection errors
   *     tcpSocket.closed.catch((error) => {
   *       socket.destroy(`TCP error: ${error.message}`);
   *     });
   * 
   *     // Pipe with error handling
   *     socket.readable.pipeTo(tcpSocket.writable).catch((error) => {
   *       socket.destroy(`Write error: ${error.message}`);
   *     });
   * 
   *     tcpSocket.readable.pipeTo(socket.writable).catch((error) => {
   *       socket.destroy(`Read error: ${error.message}`);
   *     });
   * 
   *   } catch (error) {
   *     socket.destroy(`Connection failed: ${error.message}`);
   *   }
   * });
   * ```
   */
  destroy(error?: Error | Uint8Array | string): void {
    if (this.ended && this.remoteEnded) return;
    this.ended = true;
    this.remoteEnded = true;
    this.connection.sockets.delete(this.streamId);

    let errorPayload: Uint8Array;
    if (error) {
      if (error instanceof Uint8Array) {
        errorPayload = error;
      } else {
        errorPayload = new TextEncoder().encode(error.toString());
      }
    } else {
      errorPayload = new Uint8Array(0);
    }

    this.connection.sendFrame(FLAGS.RST, this.streamId, errorPayload);
  }

  onError(error: string): void {
    const err = new Error(error);
    this.readableSource.onError(err);
    this.writableSink.onError(err);
  }

  incrementWriteWindow(windowSize: number) {
    this.writableSink.addCapacity(windowSize);
  }
}
