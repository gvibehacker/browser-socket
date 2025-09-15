/**
 * @fileoverview Node.js WebSocket bridge server for browser TCP networking
 *
 * This module provides the server-side implementation of browser-socket,
 * enabling browsers to create TCP servers and clients through WebSocket
 * multiplexing. It acts as a bridge between browser WebSocket connections
 * and native Node.js TCP networking capabilities.
 *
 * The server handles binary protocol frames from browsers, manages multiple
 * TCP connections per WebSocket, and coordinates between browser requests
 * and the Node.js networking stack.
 *
 * @example Complete bridge server setup
 * ```javascript
 * import { WebSocketServer } from 'ws';
 * import { Transport } from '@gvibehacker/browser-socket-server';
 * import net from 'net';
 *
 * // Create WebSocket server for browser connections
 * const wss = new WebSocketServer({
 *   port: 8080,
 *   perMessageDeflate: false // Binary protocol works better without compression
 * });
 *
 * const transport = new Transport(wss);
 *
 * transport.on('connection', (connection) => {
 *   console.log('Browser connected via WebSocket');
 *
 *   // Handle browser TCP client requests
 *   connection.on('connect', (socket, addressInfo) => {
 *     console.log(`Browser wants to connect to ${addressInfo.address}:${addressInfo.port}`);
 *
 *     // Create actual TCP connection
 *     const tcpSocket = net.connect(addressInfo.port, addressInfo.address);
 *
 *     tcpSocket.on('connect', () => {
 *       // Send connection acknowledgment to browser
 *       socket.ack({
 *         address: tcpSocket.localAddress!,
 *         port: tcpSocket.localPort!,
 *         family: tcpSocket.localFamily!,
 *         remoteAddress: tcpSocket.remoteAddress!,
 *         remotePort: tcpSocket.remotePort!
 *       });
 *
 *       // Pipe data between browser and TCP server
 *       tcpSocket.on('data', (data) => socket.write(data));
 *       socket.readable.pipeTo(new WritableStream({
 *         write(chunk) {
 *           tcpSocket.write(Buffer.from(chunk));
 *         }
 *       }));
 *     });
 *
 *     tcpSocket.on('error', (err) => {
 *       socket.destroy(err.message);
 *     });
 *   });
 *
 *   // Handle browser TCP server requests
 *   connection.on('listen', (listenSocket, addressInfo) => {
 *     console.log(`Browser wants to create server on ${addressInfo.address}:${addressInfo.port}`);
 *
 *     // Create actual TCP server
 *     const tcpServer = net.createServer();
 *
 *     tcpServer.listen(addressInfo.port, addressInfo.address, () => {
 *       const addr = tcpServer.address() as net.AddressInfo;
 *       listenSocket.ack({
 *         address: addr.address,
 *         port: addr.port,
 *         family: addr.family,
 *         remoteAddress: '',
 *         remotePort: 0
 *       });
 *     });
 *
 *     // Handle incoming TCP connections
 *     tcpServer.on('connection', (tcpSocket) => {
 *       // Create new browser socket for this TCP client
 *       const browserSocket = listenSocket.connect(
 *         tcpSocket.remoteAddress!,
 *         tcpSocket.remotePort!
 *       );
 *
 *       // Pipe data between TCP client and browser
 *       tcpSocket.on('data', (data) => browserSocket.write(data));
 *       browserSocket.readable.pipeTo(new WritableStream({
 *         write(chunk) {
 *           tcpSocket.write(Buffer.from(chunk));
 *         }
 *       }));
 *
 *       // Handle connection lifecycle
 *       tcpSocket.on('end', () => browserSocket.end());
 *       tcpSocket.on('error', (err) => browserSocket.destroy(err.message));
 *     });
 *   });
 * });
 *
 * // Start the transport
 * transport.start();
 * console.log('Bridge server listening on port 8080');
 * ```
 */

import { EventEmitter } from "events";
import WebSocket from "ws";
import {
  FLAGS,
  Flag,
  encodeFrame,
  FrameParser,
  parseSynPayload,
  AddressInfo,
} from "./protocol";

/**
 * Events emitted by the Transport class
 */
type TransportEvents = {
  /** Emitted when a new browser WebSocket connection is established */
  connection: [Connection];
};

/**
 * Events emitted by the Connection class
 */
type ConnectionEvents = {
  /** Emitted when browser requests a TCP client connection */
  connect: [Socket, AddressInfo];
  /** Emitted when browser requests to create a TCP server */
  listen: [ListenSocket, AddressInfo];
};

/**
 * Events emitted by the ListenSocket class
 */
type ListenSocketEvents = {
  /** Emitted when the listen socket is closed */
  close: [];
};

/**
 * Internal class for managing readable stream data flow from browser.
 * @internal
 */
class ReadableStreamSource {
  remoteWindowSize: number = 0;
  private controller: ReadableStreamDefaultController<Buffer> | null = null;

  constructor(
    private ws: WebSocket,
    private streamId: number,
    private queueSize: number
  ) {
    this.remoteWindowSize = this.queueSize;
  }

  start(controller: ReadableStreamDefaultController<Buffer>): void {
    this.controller = controller;
  }

  pull(controller: ReadableStreamDefaultController<Buffer>): void {
    if (this.remoteWindowSize > this.queueSize / 2) return;
    const delta = controller.desiredSize! - this.remoteWindowSize;
    this.remoteWindowSize += delta;
    // send WINDOW_UPDATE
    const payload = Buffer.allocUnsafe(3);
    payload[0] = (delta >> 16) & 0xff;
    payload[1] = (delta >> 8) & 0xff;
    payload[2] = delta & 0xff;
    sendFrame(this.ws, FLAGS.WINDOW_UPDATE, this.streamId, payload);
  }

  cancel(): void {
    this.controller = null;
  }

  onData(data: Buffer): void {
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

/**
 * Internal class for managing writable stream data flow to browser.
 * @internal
 */
class WritableStreamSink implements UnderlyingSink<Buffer> {
  private controller: WritableStreamDefaultController | null = null;
  private waitingForCapacity: ((value: void) => void) | null = null;

  constructor(private socket: Socket, private availableWindowSize: number) {}

  start(controller: WritableStreamDefaultController): void {
    this.controller = controller;
  }

  async write(chunk: Buffer): Promise<void> {
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
 * WebSocket transport layer for browser TCP networking bridge.
 *
 * The Transport class serves as the main entry point for the bridge server,
 * managing WebSocket connections from browsers and creating Connection instances
 * to handle multiplexed TCP streams. It coordinates between browser networking
 * requests and the Node.js TCP stack.
 *
 * Each WebSocket connection from a browser gets its own Connection instance,
 * which can handle multiple simultaneous TCP connections through stream multiplexing.
 *
 * @example Basic bridge server
 * ```javascript
 * import { WebSocketServer } from 'ws';
 * import { Transport } from '@gvibehacker/browser-socket-server';
 * import net from 'net';
 *
 * const wss = new WebSocketServer({ port: 8080 });
 * const transport = new Transport(wss);
 *
 * transport.on('connection', (connection) => {
 *   console.log('New browser connected');
 *
 *   connection.on('connect', (socket, addr) => {
 *     // Browser wants to connect to external TCP server
 *     const tcpSocket = net.connect(addr.port, addr.address);
 *     tcpSocket.on('connect', () => {
 *       socket.ack({
 *         // connection details
 *       });
 *       // Set up data piping...
 *     });
 *   });
 *
 *   connection.on('listen', (listenSocket, addr) => {
 *     // Browser wants to create TCP server
 *     const server = net.createServer();
 *     server.listen(addr.port, addr.address, () => {
 *       listenSocket.ack({
 *         // server details
 *       });
 *     });
 *   });
 * });
 *
 * transport.start();
 * ```
 *
 * @example Advanced bridge with connection management
 * ```javascript
 * class BridgeServer {
 *   constructor() {
 *     this.activeConnections = new Set();
 *     this.setupTransport();
 *   }
 *
 *   setupTransport() {
 *     const wss = new WebSocketServer({ port: 8080 });
 *     const transport = new Transport(wss);
 *
 *     transport.on('connection', (connection) => {
 *       this.activeConnections.add(connection);
 *       console.log(`Browser connected. Total: ${this.activeConnections.size}`);
 *
 *       connection.ws.on('close', () => {
 *         this.activeConnections.delete(connection);
 *         console.log(`Browser disconnected. Remaining: ${this.activeConnections.size}`);
 *       });
 *
 *       this.setupConnectionHandlers(connection);
 *     });
 *
 *     transport.start();
 *   }
 *
 *   setupConnectionHandlers(connection) {
 *     // TCP client connection handling
 *     connection.on('connect', this.handleTcpConnect.bind(this));
 *     // TCP server creation handling
 *     connection.on('listen', this.handleTcpListen.bind(this));
 *   }
 *
 *   shutdown() {
 *     for (const connection of this.activeConnections) {
 *       connection.close();
 *     }
 *     this.activeConnections.clear();
 *   }
 * }
 * ```
 */
export class Transport extends EventEmitter<TransportEvents> {
  /**
   * Creates a new Transport instance for managing browser connections.
   *
   * @param wss - WebSocket server instance that will receive browser connections
   *
   * @example
   * ```javascript
   * import { WebSocketServer } from 'ws';
   * import { Transport } from '@gvibehacker/browser-socket-server';
   *
   * const wss = new WebSocketServer({ port: 8080 });
   * const transport = new Transport(wss);
   * ```
   */
  constructor(private wss: WebSocket.Server) {
    super();
  }

  /**
   * Starts accepting WebSocket connections from browsers.
   *
   * This method begins listening for WebSocket connections on the provided
   * WebSocket server and creates Connection instances for each new browser
   * that connects. Each Connection will emit 'connection' events that should
   * be handled to set up TCP networking logic.
   *
   * @example Basic startup
   * ```javascript
   * transport.start();
   * console.log('Bridge server ready for browser connections');
   * ```
   *
   * @example Startup with connection tracking
   * ```javascript
   * let connectionCount = 0;
   *
   * transport.on('connection', (connection) => {
   *   connectionCount++;
   *   console.log(`Browser #${connectionCount} connected`);
   *
   *   connection.ws.on('close', () => {
   *     connectionCount--;
   *     console.log(`Browser disconnected. Active: ${connectionCount}`);
   *   });
   * });
   *
   * transport.start();
   * ```
   */
  start(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      const conn = new Connection(ws);
      this.emit("connection", conn);
    });
  }
}

/**
 * Internal function to send binary protocol frames over WebSocket.
 * @internal
 */
function sendFrame(
  ws: WebSocket,
  flag: Flag,
  streamId: number,
  payload?: Buffer
): void {
  if (ws.readyState === WebSocket.OPEN) {
    const frame = encodeFrame(flag, streamId, payload || Buffer.alloc(0));
    ws.send(frame);
  }
}

/**
 * Manages a single WebSocket connection from a browser with multiplexed TCP streams.
 *
 * The Connection class handles the binary protocol communication with a browser,
 * managing multiple TCP connections that are multiplexed over a single WebSocket.
 * It processes incoming frames, manages socket lifecycle, and coordinates between
 * browser networking requests and Node.js TCP operations.
 *
 * Each Connection can handle multiple simultaneous TCP client connections and
 * TCP server instances created by the browser, with proper stream isolation
 * and flow control.
 *
 * @example TCP client proxy
 * ```javascript
 * transport.on('connection', (connection) => {
 *   connection.on('connect', (socket, addressInfo) => {
 *     console.log(`Proxying connection to ${addressInfo.address}:${addressInfo.port}`);
 *
 *     const tcpSocket = net.connect({
 *       host: addressInfo.address,
 *       port: addressInfo.port,
 *       timeout: 5000
 *     });
 *
 *     tcpSocket.on('connect', () => {
 *       console.log('TCP connection established');
 *       socket.ack({
 *         address: tcpSocket.localAddress!,
 *         port: tcpSocket.localPort!,
 *         family: tcpSocket.localFamily!,
 *         remoteAddress: tcpSocket.remoteAddress!,
 *         remotePort: tcpSocket.remotePort!
 *       });
 *
 *       // Bidirectional data piping
 *       tcpSocket.on('data', (data) => socket.write(data));
 *       socket.readable.pipeTo(new WritableStream({
 *         write(chunk) {
 *           tcpSocket.write(Buffer.from(chunk));
 *         },
 *         close() {
 *           tcpSocket.end();
 *         }
 *       }));
 *     });
 *
 *     tcpSocket.on('error', (err) => {
 *       console.error('TCP connection error:', err.message);
 *       socket.destroy(err.message);
 *     });
 *
 *     tcpSocket.on('timeout', () => {
 *       console.log('TCP connection timeout');
 *       socket.destroy('Connection timeout');
 *     });
 *   });
 * });
 * ```
 *
 * @example TCP server proxy with connection management
 * ```javascript
 * const activeServers = new Map();
 *
 * transport.on('connection', (connection) => {
 *   connection.on('listen', (listenSocket, addressInfo) => {
 *     console.log(`Creating server on ${addressInfo.address}:${addressInfo.port}`);
 *
 *     const tcpServer = net.createServer((tcpSocket) => {
 *       console.log(`TCP client connected from ${tcpSocket.remoteAddress}:${tcpSocket.remotePort}`);
 *
 *       // Create browser socket for this TCP client
 *       const browserSocket = listenSocket.connect(
 *         tcpSocket.remoteAddress!,
 *         tcpSocket.remotePort!,
 *         () => console.log('Browser socket established')
 *       );
 *
 *       // Handle data flow
 *       tcpSocket.on('data', (data) => {
 *         console.log(`TCP->Browser: ${data.length} bytes`);
 *         browserSocket.write(data);
 *       });
 *
 *       browserSocket.readable.pipeTo(new WritableStream({
 *         write(chunk) {
 *           console.log(`Browser->TCP: ${chunk.length} bytes`);
 *           tcpSocket.write(Buffer.from(chunk));
 *         }
 *       }));
 *
 *       // Connection lifecycle
 *       tcpSocket.on('end', () => {
 *         console.log('TCP client disconnected');
 *         browserSocket.end();
 *       });
 *
 *       tcpSocket.on('error', (err) => {
 *         console.error('TCP client error:', err.message);
 *         browserSocket.destroy(err.message);
 *       });
 *     });
 *
 *     tcpServer.listen(addressInfo.port, addressInfo.address, () => {
 *       const addr = tcpServer.address() as net.AddressInfo;
 *       console.log(`TCP server listening on ${addr.address}:${addr.port}`);
 *
 *       activeServers.set(listenSocket, tcpServer);
 *       listenSocket.ack({
 *         address: addr.address,
 *         port: addr.port,
 *         family: addr.family,
 *         remoteAddress: '',
 *         remotePort: 0
 *       });
 *     });
 *
 *     tcpServer.on('error', (err) => {
 *       console.error('TCP server error:', err.message);
 *       listenSocket.close();
 *     });
 *   });
 *
 *   // Cleanup on connection close
 *   connection.ws.on('close', () => {
 *     for (const [listenSocket, tcpServer] of activeServers) {
 *       if (connection.sockets.has(listenSocket.streamId)) {
 *         tcpServer.close();
 *         activeServers.delete(listenSocket);
 *       }
 *     }
 *   });
 * });
 * ```
 */
export class Connection extends EventEmitter<ConnectionEvents> {
  /** Map of active sockets indexed by stream ID */
  public readonly sockets: Map<number, Socket> = new Map();
  /** Frame parser for processing incoming WebSocket binary data */
  private frameParser: FrameParser = new FrameParser();
  /** Whether this connection has been closed */
  private closed: boolean = false;
  /** The underlying WebSocket connection to the browser */
  public readonly ws: WebSocket;
  /** Next available stream ID for server-initiated connections (even numbers) */
  public nextStreamId: number = 2; // Server uses even IDs (2, 4, 6...) for incoming connections

  /**
   * Creates a new Connection instance for managing a browser WebSocket.
   *
   * @param ws - WebSocket connection from the browser client
   *
   * @internal This constructor is typically not called directly. Use Transport.start() instead.
   */
  constructor(ws: WebSocket) {
    super();
    this.ws = ws;

    this.ws.on("message", this.handleMessage.bind(this));
    this.ws.on("close", this.handleClose.bind(this));
  }

  private handleMessage(data: Buffer): void {
    const frames = this.frameParser.addData(data);

    for (const frame of frames) {
      const { flag, streamId, payload } = frame;
      let socket: Socket | undefined;
      switch (flag) {
        case FLAGS.SYN:
          try {
            const [windowSize, addressInfo] = parseSynPayload(payload, true);
            const socket = new Socket(this, streamId, 65536, windowSize);
            this.sockets.set(streamId, socket);
            this.emit("connect", socket, addressInfo);
          } catch (error) {
            this.sockets.delete(streamId);
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from(
                error instanceof Error ? error.message : String(error)
              )
            );
          }
          break;
        case FLAGS.LISTEN:
          try {
            const [, addressInfo] = parseSynPayload(payload, false);
            const socket = new ListenSocket(this, streamId);
            this.sockets.set(streamId, socket as unknown as Socket);
            this.emit("listen", socket, addressInfo);
          } catch (error) {
            this.sockets.delete(streamId);
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from(
                error instanceof Error ? error.message : String(error)
              )
            );
          }
          break;
        case FLAGS.ACK:
          socket = this.sockets.get(streamId);
          if (!socket) {
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from("Invalid stream id")
            );
            break;
          }
          try {
            socket.incrementWriteWindow(
              (payload[0] << 16) | (payload[1] << 8) | payload[2]
            );
            socket.connectCallback?.(socket);
            socket.connectCallback = undefined;
          } catch (error) {
            this.sockets.delete(streamId);
            const err = error instanceof Error ? error.message : String(error);
            sendFrame(this.ws, FLAGS.RST, streamId, Buffer.from(err));
            socket.onError(err);
          }
          break;
        case FLAGS.DATA:
          socket = this.sockets.get(streamId);
          if (!socket) {
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from("Invalid stream id")
            );
            break;
          }
          if (socket.remoteEnded) {
            this.sockets.delete(streamId);
            const err = "Data after end";
            sendFrame(this.ws, FLAGS.RST, streamId, Buffer.from(err));
            socket.onError(err);
            break;
          }

          if (socket.readableSource.remoteWindowSize < payload.length) {
            this.sockets.delete(streamId);
            const err = "Data exceeding allowed window size";
            sendFrame(this.ws, FLAGS.RST, streamId, Buffer.from(err));
            socket.onError(err);
            break;
          }
          socket.readableSource.onData(payload);
          break;
        case FLAGS.FIN:
          socket = this.sockets.get(streamId);
          if (!socket) {
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from("Invalid stream id")
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
          if (socket instanceof ListenSocket) {
            (socket as ListenSocket).emit("close");
            this.sockets.delete(streamId);
            break;
          }

          if (socket.ended && socket.remoteEnded) break;
          const err =
            payload && payload.length > 0
              ? payload.toString()
              : "Connection reset";
          socket.onError(err);
          this.sockets.delete(streamId);
          break;
        case FLAGS.WINDOW_UPDATE:
          socket = this.sockets.get(streamId);
          if (!socket) {
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from("Invalid stream id")
            );
            break;
          }
          try {
            socket.incrementWriteWindow(
              (payload[0] << 16) | (payload[1] << 8) | payload[2]
            );
          } catch (error) {
            this.sockets.delete(streamId);
            const err = error instanceof Error ? error.message : String(error);
            sendFrame(this.ws, FLAGS.RST, streamId, Buffer.from(err));
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
   * Gracefully closes the WebSocket connection and all associated sockets.
   *
   * This method properly cleans up all active TCP connections managed by
   * this browser connection, ensuring no resources are leaked when the
   * browser disconnects or the server shuts down.
   *
   * @example Basic connection close
   * ```javascript
   * connection.close();
   * ```
   *
   * @example Cleanup with logging
   * ```javascript
   * console.log(`Closing connection with ${connection.sockets.size} active sockets`);
   * connection.close();
   * console.log('Connection closed and resources cleaned up');
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
}

/**
 * Represents a multiplexed TCP socket connection over WebSocket transport.
 *
 * The Socket class provides a Node.js-compatible interface for individual TCP
 * streams that are multiplexed over the WebSocket connection to the browser.
 * It supports both client-initiated connections (browser connects to TCP server)
 * and server-initiated connections (TCP client connects to browser's server).
 *
 * Each socket maintains its own flow control, handles data buffering, and
 * provides streaming APIs for efficient data transfer between browser and
 * Node.js TCP endpoints.
 *
 * @example HTTP proxy through browser connection
 * ```javascript
 * connection.on('connect', (socket, addressInfo) => {
 *   console.log(`Browser connecting to ${addressInfo.address}:${addressInfo.port}`);
 *
 *   // Connect to actual HTTP server
 *   const httpSocket = net.connect(addressInfo.port, addressInfo.address);
 *
 *   httpSocket.on('connect', () => {
 *     // Acknowledge connection to browser
 *     socket.ack({
 *       address: httpSocket.localAddress!,
 *       port: httpSocket.localPort!,
 *       family: httpSocket.localFamily!,
 *       remoteAddress: httpSocket.remoteAddress!,
 *       remotePort: httpSocket.remotePort!
 *     });
 *
 *     // Set up bidirectional streaming
 *     const writer = socket.writable.getWriter();
 *     httpSocket.on('data', async (data) => {
 *       try {
 *         await writer.write(data);
 *       } catch (err) {
 *         console.error('Error writing to browser:', err);
 *         httpSocket.destroy();
 *       }
 *     });
 *
 *     socket.readable.pipeTo(new WritableStream({
 *       write(chunk) {
 *         httpSocket.write(Buffer.from(chunk));
 *       },
 *       close() {
 *         httpSocket.end();
 *       },
 *       abort(reason) {
 *         httpSocket.destroy(reason);
 *       }
 *     }));
 *   });
 *
 *   httpSocket.on('error', (err) => {
 *     socket.destroy(`HTTP connection failed: ${err.message}`);
 *   });
 * });
 * ```
 *
 * @example WebSocket-to-TCP bridge with protocol detection
 * ```javascript
 * connection.on('connect', (socket, addressInfo) => {
 *   const tcpSocket = net.connect(addressInfo.port, addressInfo.address);
 *   let protocolDetected = false;
 *
 *   tcpSocket.on('connect', () => {
 *     socket.ack({
 *       // connection info
 *     });
 *
 *     // First, try to detect the protocol
 *     socket.readable.getReader().read().then(({ value }) => {
 *       const firstData = Buffer.from(value!);
 *
 *       if (firstData.toString().startsWith('GET ')) {
 *         console.log('HTTP protocol detected');
 *       } else if (firstData[0] === 0x16) {
 *         console.log('TLS protocol detected');
 *       } else {
 *         console.log('Unknown protocol, treating as raw TCP');
 *       }
 *
 *       // Forward the first data
 *       tcpSocket.write(firstData);
 *       protocolDetected = true;
 *
 *       // Continue with normal data flow
 *       socket.readable.pipeTo(new WritableStream({
 *         write(chunk) {
 *           tcpSocket.write(Buffer.from(chunk));
 *         }
 *       }));
 *     });
 *   });
 * });
 * ```
 */
export class Socket {
  private writableSink: WritableStreamSink;

  /** Initial window size for flow control */
  public readonly initialWindowSize: number;
  /** ReadableStream for receiving data from the browser */
  public readonly readable: ReadableStream<Buffer>;
  /** Internal readable stream source controller */
  public readonly readableSource: ReadableStreamSource;
  /** WritableStream for sending data to the browser */
  public readonly writable: WritableStream<Buffer>;
  /** Internal callback for connection acknowledgment */
  connectCallback?: (s: Socket) => void;
  /** Whether the local side has ended the connection */
  public ended: boolean = false;
  /** Whether the remote side (browser) has ended the connection */
  public remoteEnded: boolean = false;
  /** Remote peer's IP address (for server-initiated connections) */
  public remoteAddress: string | null = null;
  /** Remote peer's port number (for server-initiated connections) */
  public remotePort: number | null = null;

  /**
   * Creates a new Socket instance for TCP communication over WebSocket.
   *
   * @param connection - Parent Connection that manages this socket
   * @param streamId - Unique stream identifier for protocol multiplexing
   * @param initialWindowSize - Initial receive window size for flow control (default: 65536 bytes)
   * @param availableWriteWindowSize - Initial send window size from browser (default: 0)
   *
   * @internal This constructor is typically not called directly. Sockets are created by Connection.
   */
  constructor(
    private connection: Connection,
    private streamId: number,
    initialWindowSize: number = 65536,
    availableWriteWindowSize: number = 0
  ) {
    this.initialWindowSize = initialWindowSize;
    this.readableSource = new ReadableStreamSource(
      this.connection.ws,
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
   * @param addressInfo - Optional address information
   * @example
   * ```javascript
   * // Send ACK with address info for connection
   * socket.ack({
   *   address: 'example.com',
   *   port: 443,
   *   family: 'IPv4',
   *   remoteAddress: '1.2.3.4',
   *   remotePort: 54321
   * });
   *
   * // Send simple ACK
   * socket.ack();
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
      ? Buffer.from(JSON.stringify(addressInfo))
      : Buffer.alloc(0);

    const payload = Buffer.allocUnsafe(3 + addressPayload.length);

    // 3 bytes for listen stream ID
    payload[0] = (this.initialWindowSize >> 16) & 0xff;
    payload[1] = (this.initialWindowSize >> 8) & 0xff;
    payload[2] = this.initialWindowSize & 0xff;
    // Variable length host
    addressPayload.copy(payload, 3);

    sendFrame(this.connection.ws, FLAGS.ACK, this.streamId, payload);
  }

  /**
   * Writes data to the socket (sends to browser)
   * @param data - Data to send (Buffer or string)
   * @returns True if data was sent, false if socket is destroyed
   * @example
   * ```javascript
   * // Send string data
   * socket.write('Hello browser');
   *
   * // Send binary data
   * socket.write(Buffer.from([1, 2, 3, 4]));
   *
   * // Send HTTP response
   * socket.write('HTTP/1.1 200 OK\r\n');
   * socket.write('Content-Type: text/plain\r\n\r\n');
   * socket.write('Hello from server');
   * ```
   */
  write(data: Buffer | string): boolean {
    if (this.ended) return false;
    sendFrame(this.connection.ws, FLAGS.DATA, this.streamId, Buffer.from(data));
    return true;
  }

  /**
   * Ends the socket connection gracefully
   * @example
   * ```javascript
   * socket.end();
   * ```
   */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.remoteEnded) {
      this.connection.sockets.delete(this.streamId);
    }
    sendFrame(this.connection.ws, FLAGS.FIN, this.streamId);
  }

  /**
   * Forcefully destroys the socket connection
   * @param error - Optional error information (Error object, Buffer, or string)
   * @example
   * ```javascript
   * // Destroy with custom message
   * socket.destroy('Invalid request format');
   *
   * // Destroy without error
   * socket.destroy();
   * ```
   */
  destroy(error?: Buffer | string): void {
    if (this.ended && this.remoteEnded) return;
    this.ended = true;
    this.remoteEnded = true;
    this.connection.sockets.delete(this.streamId);

    let errorPayload: Buffer;
    if (error) {
      if (error instanceof Buffer) {
        errorPayload = error;
      } else {
        errorPayload = Buffer.from(error.toString());
      }
    } else {
      errorPayload = Buffer.alloc(0);
    }
    sendFrame(this.connection.ws, FLAGS.RST, this.streamId, errorPayload);
  }

  /**
   * Internal method to handle socket errors.
   * @internal
   */
  onError(error: string): void {
    const err = new Error(error);
    this.readableSource.onError(err);
    this.writableSink.onError(err);
  }

  /**
   * Internal method to update the write window size for flow control.
   * @internal
   */
  incrementWriteWindow(windowSize: number) {
    this.writableSink.addCapacity(windowSize);
  }
}

/**
 * Represents a TCP server listening socket managed by the browser.
 *
 * ListenSocket handles server-side socket operations when a browser creates
 * a TCP server. It manages incoming TCP client connections and creates new
 * Socket instances for each client that connects to the browser's server.
 *
 * @example Basic server socket management
 * ```javascript
 * connection.on('listen', (listenSocket, addressInfo) => {
 *   console.log(`Browser creating server on ${addressInfo.address}:${addressInfo.port}`);
 *   
 *   const tcpServer = net.createServer();
 *   
 *   tcpServer.listen(addressInfo.port, addressInfo.address, () => {
 *     const serverAddr = tcpServer.address() as net.AddressInfo;
 *     listenSocket.ack({
 *       address: serverAddr.address,
 *       port: serverAddr.port,
 *       family: serverAddr.family,
 *       remoteAddress: '',
 *       remotePort: 0
 *     });
 *   });
 *   
 *   tcpServer.on('connection', (tcpSocket) => {
 *     // Create browser socket for this TCP client
 *     const browserSocket = listenSocket.connect(
 *       tcpSocket.remoteAddress!,
 *       tcpSocket.remotePort!
 *     );
 *     
 *     // Handle connection...
 *   });
 * });
 * ```
 */
export class ListenSocket extends EventEmitter<ListenSocketEvents> {
  /** Internal callback for connection acknowledgment */
  connectCallback?: (s: Socket) => void;

  /**
   * Creates a new ListenSocket instance.
   *
   * @param connection - Parent Connection managing this listen socket
   * @param streamId - Unique stream identifier for this listen socket
   *
   * @internal This constructor is typically not called directly. ListenSockets are created by Connection.
   */
  constructor(private connection: Connection, private streamId: number) {
    super();
  }

  /**
   * Creates a new server-initiated connection to the browser
   *
   * This method is used when a TCP client connects to a server that was
   * created by the browser. It creates a new socket stream and sends
   * a SYN frame to the browser to establish the connection.
   *
   * @param remoteAddress - IP address of the connecting TCP client
   * @param remotePort - Port number of the connecting TCP client
   * @returns New Socket instance for the connection
   * @example
   * ```javascript
   * // When TCP client connects to browser's server
   * tcpServer.on('connection', (tcpSocket) => {
   *   const browserSocket = listenSocket.connect(
   *     tcpSocket.remoteAddress,
   *     tcpSocket.remotePort
   *   );
   *
   *   // Pipe data between TCP client and browser
   *   tcpSocket.on('data', (data) => browserSocket.write(data));
   *   browserSocket.on('data', (data) => tcpSocket.write(data));
   *
   *   // Handle connection lifecycle
   *   tcpSocket.on('end', () => browserSocket.end());
   *   browserSocket.on('end', () => tcpSocket.end());
   * });
   * ```
   */
  connect(
    remoteAddress: string,
    remotePort: number,
    callback?: () => void
  ): Socket {
    // For server-initiated connections from a listening socket
    const newStreamId = this.connection.nextStreamId;
    this.connection.nextStreamId += 2; // Skip by 2 to maintain even numbers
    const newSocket = new Socket(this.connection, newStreamId);
    newSocket.remoteAddress = remoteAddress;
    newSocket.remotePort = remotePort;
    newSocket.connectCallback = callback;
    this.connection.sockets.set(newStreamId, newSocket);

    const payload = this.createServerSynPayload(
      this.streamId, // This is the listen stream ID
      remoteAddress,
      remotePort,
      newSocket.initialWindowSize
    );
    sendFrame(this.connection.ws, FLAGS.SYN, newStreamId, payload);

    return newSocket;
  }

  /**
   * Sends an acknowledgment frame to the browser
   * @param addressInfo - Optional address information
   * @example
   * ```javascript
   * // Send ACK with address info for connection
   * socket.ack({
   *   address: 'example.com',
   *   port: 443,
   *   family: 'IPv4',
   *   remoteAddress: '1.2.3.4',
   *   remotePort: 54321
   * });
   *
   * // Send simple ACK
   * socket.ack();
   * ```
   */
  ack(addressInfo?: {
    address: string;
    port: number;
    family: string;
    remoteAddress: string;
    remotePort: number;
  }): void {
    const payload = addressInfo
      ? Buffer.from(JSON.stringify(addressInfo))
      : Buffer.alloc(0);
    sendFrame(this.connection.ws, FLAGS.ACK, this.streamId, payload);
  }

  /**
   * Close the socket connection
   * @example
   * ```javascript
   * socket.close();
   * ```
   */
  close(): void {
    if (!this.connection.sockets.delete(this.streamId)) return;
    sendFrame(this.connection.ws, FLAGS.RST, this.streamId, Buffer.alloc(0));
  }

  /**
   * Internal method to create SYN payload for server-initiated connections.
   * @internal
   */
  private createServerSynPayload(
    listenStreamId: number,
    remoteAddress: string,
    remotePort: number,
    windowSize: number
  ): Buffer {
    const hostBuffer = Buffer.from(remoteAddress);
    const payload = Buffer.allocUnsafe(3 + 3 + 2 + hostBuffer.length);

    // 3 bytes for listen stream ID
    payload[0] = (listenStreamId >> 16) & 0xff;
    payload[1] = (listenStreamId >> 8) & 0xff;
    payload[2] = listenStreamId & 0xff;

    // 3 bytes for window size
    payload[3] = (windowSize >> 16) & 0xff;
    payload[4] = (windowSize >> 8) & 0xff;
    payload[5] = windowSize & 0xff;

    // 2 bytes for port (uint16)
    payload.writeUInt16BE(remotePort, 6);
    // Variable length host
    hostBuffer.copy(payload, 8);

    return payload;
  }
}
