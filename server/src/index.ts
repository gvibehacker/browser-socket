/**
 * @fileoverview Server-side WebSocket transport with TCP connection handling
 * 
 * This module provides the Node.js server implementation for browser-socket,
 * enabling browsers to create TCP servers and clients through WebSocket
 * multiplexing. It handles the bridge between WebSocket connections from
 * browsers and native TCP networking on the Node.js side.
 * 
 * @example
 * ```javascript
 * import { WebSocketServer } from 'ws';
 * import { Transport } from '@gvibehacker/browser-socket-server';
 * 
 * // Create WebSocket server
 * const wss = new WebSocketServer({ port: 8080 });
 * const transport = new Transport(wss);
 * 
 * transport.start();
 * transport.on('connection', (connection) => {
 *   console.log('Browser connected');
 *   
 *   connection.on('connect', (socket, addressInfo) => {
 *     // Handle TCP client connection requests from browser
 *     connectToTcpServer(socket, addressInfo);
 *   });
 *   
 *   connection.on('listen', (socket, addressInfo) => {
 *     // Handle TCP server creation requests from browser
 *     createTcpServer(socket, addressInfo);
 *   });
 * });
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
  Frame,
} from "./protocol";

/**
 * Event interface for Socket instances
 */
export interface SocketEvents {
  /** Emitted when data is received from the remote peer */
  data: (data: Buffer) => void;
  /** Emitted when the connection is ended gracefully */
  end: () => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
  /** Emitted when the connection is closed */
  close: () => void;
  /** Emitted when an ACK frame is received */
  ack: (payload: Buffer) => void;
  /** Emitted when a new connection is established (server sockets) */
  connection: (socket: Socket) => void;
}

/**
 * Event interface for Connection instances
 */
export interface ConnectionEvents {
  /** Emitted when browser requests to connect to a TCP server */
  connect: (socket: Socket, addressInfo: AddressInfo) => void;
  /** Emitted when browser requests to create a TCP server */
  listen: (socket: Socket, addressInfo: AddressInfo) => void;
  /** Emitted when an error occurs */
  error: (error: Error) => void;
  /** Emitted when the WebSocket connection ends */
  end: () => void;
}

/**
 * Event interface for Transport instances
 */
export interface TransportEvents {
  /** Emitted when a new browser WebSocket connection is established */
  connection: (connection: Connection) => void;
}

export declare interface Socket {
  on<K extends keyof SocketEvents>(event: K, listener: SocketEvents[K]): this;
  emit<K extends keyof SocketEvents>(
    event: K,
    ...args: Parameters<SocketEvents[K]>
  ): boolean;
}

export declare interface Connection {
  on<K extends keyof ConnectionEvents>(
    event: K,
    listener: ConnectionEvents[K]
  ): this;
  emit<K extends keyof ConnectionEvents>(
    event: K,
    ...args: Parameters<ConnectionEvents[K]>
  ): boolean;
}

export declare interface Transport {
  on<K extends keyof TransportEvents>(
    event: K,
    listener: TransportEvents[K]
  ): this;
  emit<K extends keyof TransportEvents>(
    event: K,
    ...args: Parameters<TransportEvents[K]>
  ): boolean;
}

/**
 * Main transport layer that manages WebSocket connections from browsers
 * 
 * This class creates a bridge between browser WebSocket connections and
 * the Node.js TCP networking stack. It listens for new WebSocket connections
 * and creates Connection instances to handle the multiplexed TCP streams.
 * 
 * @example
 * ```javascript
 * import { WebSocketServer } from 'ws';
 * import { Transport } from '@gvibehacker/browser-socket-server';
 * 
 * // Create transport with existing WebSocket server
 * const wss = new WebSocketServer({ port: 8080 });
 * const transport = new Transport(wss);
 * 
 * // Handle new browser connections
 * transport.on('connection', (connection) => {
 *   console.log('Browser connected');
 *   
 *   // Handle connection events
 *   connection.on('connect', (socket, addressInfo) => {
 *     // Browser wants to connect to a TCP server
 *     handleTcpConnect(socket, addressInfo);
 *   });
 *   
 *   connection.on('listen', (socket, addressInfo) => {
 *     // Browser wants to create a TCP server
 *     handleTcpListen(socket, addressInfo);
 *   });
 * });
 * 
 * // Start accepting connections
 * transport.start();
 * ```
 */
export class Transport extends EventEmitter {
  private wss: WebSocket.Server;

  /**
   * Creates a new Transport instance
   * @param wss - WebSocket server instance to listen on
   */
  constructor(wss: WebSocket.Server) {
    super();
    this.wss = wss;
  }

  /**
   * Starts accepting WebSocket connections from browsers
   * 
   * This method begins listening for WebSocket connections and creates
   * Connection instances for each new browser that connects.
   * 
   * @example
   * ```javascript
   * transport.start();
   * console.log('Transport started, ready for browser connections');
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
 * Manages a single WebSocket connection from a browser
 * 
 * This class handles the multiplexed TCP streams over a single WebSocket
 * connection. It processes binary frames from the browser, manages socket
 * instances for each stream, and coordinates between browser requests and
 * the Node.js TCP networking stack.
 * 
 * @example
 * ```javascript
 * // Connection is typically created by Transport
 * transport.on('connection', (connection) => {
 *   connection.on('connect', (socket, addressInfo) => {
 *     // Browser wants to connect to external TCP server
 *     const tcpSocket = net.connect(addressInfo.port, addressInfo.host);
 *     
 *     tcpSocket.on('connect', () => {
 *       socket.ack(Buffer.from(JSON.stringify({
 *         address: tcpSocket.localAddress,
 *         port: tcpSocket.localPort,
 *         family: tcpSocket.localFamily
 *       })));
 *     });
 *     
 *     // Pipe data between browser socket and TCP socket
 *     tcpSocket.on('data', (data) => socket.write(data));
 *     socket.on('data', (data) => tcpSocket.write(data));
 *   });
 *   
 *   connection.on('listen', (socket, addressInfo) => {
 *     // Browser wants to create TCP server
 *     const server = net.createServer();
 *     server.listen(addressInfo.port, addressInfo.host);
 *     
 *     server.on('listening', () => {
 *       socket.ack(Buffer.from(JSON.stringify(server.address())));
 *     });
 *     
 *     server.on('connection', (tcpSocket) => {
 *       const newSocket = socket.connect(
 *         tcpSocket.remoteAddress, 
 *         tcpSocket.remotePort
 *       );
 *       // Handle the new connection...
 *     });
 *   });
 * });
 * ```
 */
export class Connection extends EventEmitter {
  private ws: WebSocket;
  public sockets: Map<number, Socket> = new Map();
  private frameParser: FrameParser = new FrameParser();
  private nextStreamId: number = 2; // Server uses even IDs (2, 4, 6...) for incoming connections
  private closed: boolean = false;

  /**
   * Creates a new Connection instance for a WebSocket
   * @param ws - WebSocket connection to the browser
   */
  constructor(ws: WebSocket) {
    super();
    this.ws = ws;

    this.ws.on("message", this.handleMessage.bind(this));
    this.ws.on("close", this.handleClose.bind(this));
    this.ws.on("error", (error: Error) => this.emit("error", error));
  }

  private handleMessage(data: Buffer): void {
    try {
      const frames = this.frameParser.addData(data);

      for (const frame of frames) {
        const { flag, streamId, payload } = frame;

        switch (flag) {
          case FLAGS.SYN:
            this.handleSyn(streamId, payload);
            break;
          case FLAGS.LISTEN:
            this.handleListen(streamId, payload);
            break;
          case FLAGS.DATA:
            this.handleData(streamId, payload);
            break;
          case FLAGS.FIN:
            this.handleEnd(streamId, payload);
            break;
          case FLAGS.RST:
            this.handleReset(streamId, payload);
            break;
        }
      }
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleSyn(streamId: number, payload: Buffer): void {
    try {
      const addressInfo = parseSynPayload(payload);

      // Client-initiated SYN (outbound connection request)
      const socket = new Socket(this, streamId);
      this.sockets.set(streamId, socket);
      this.emit("connect", socket, addressInfo);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.sendFrame(FLAGS.RST, streamId, Buffer.from(errorMessage));
    }
  }

  private handleListen(streamId: number, payload: Buffer): void {
    try {
      const addressInfo = parseSynPayload(payload);
      const socket = new Socket(this, streamId);
      this.sockets.set(streamId, socket);
      this.emit("listen", socket, addressInfo);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.sendFrame(FLAGS.RST, streamId, Buffer.from(errorMessage));
    }
  }

  private handleData(streamId: number, data: Buffer): void {
    const socket = this.sockets.get(streamId);
    if (socket) {
      socket.emit("data", data);
    }
  }

  private handleEnd(streamId: number, payload: Buffer): void {
    const socket = this.sockets.get(streamId);
    if (socket) {
      if (payload && payload.length > 0) {
        socket.emit("data", payload);
      }
      socket.emit("end");
      this.sockets.delete(streamId);
    }
  }

  private handleReset(streamId: number, payload: Buffer): void {
    const socket = this.sockets.get(streamId);
    if (socket) {
      const error = new Error(
        payload && payload.length > 0 ? payload.toString() : "Connection reset"
      );
      socket.emit("error", error);
      socket.emit("close");
      this.sockets.delete(streamId);
    }
  }

  private handleClose(): void {
    this.closed = true;

    // Clean up all sockets
    for (const socket of this.sockets.values()) {
      socket.emit("close");
    }
    this.sockets.clear();

    this.emit("end");
  }

  /**
   * Closes the WebSocket connection and all associated sockets
   * @param callback - Optional callback executed when connection is closed
   * @example
   * ```javascript
   * connection.close(() => {
   *   console.log('Connection closed');
   * });
   * ```
   */
  close(callback?: () => void): void {
    if (this.closed) {
      if (callback) callback();
      return;
    }

    // Close all sockets
    for (const socket of this.sockets.values()) {
      socket.destroy();
    }

    // Close the WebSocket
    if (callback) {
      this.ws.once("close", callback);
    }
    this.ws.close();
  }

  /**
   * Sends a binary frame to the browser
   * @param flag - Protocol flag indicating frame type
   * @param streamId - Stream identifier
   * @param payload - Optional payload data
   * @example
   * ```javascript
   * // Send ACK frame with address info
   * const addressInfo = { address: '127.0.0.1', port: 3000 };
   * connection.sendFrame(FLAGS.ACK, streamId, Buffer.from(JSON.stringify(addressInfo)));
   * 
   * // Send data frame
   * connection.sendFrame(FLAGS.DATA, streamId, Buffer.from('Hello browser'));
   * ```
   */
  sendFrame(flag: Flag, streamId: number, payload?: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const frame = encodeFrame(flag, streamId, payload || Buffer.alloc(0));
      this.ws.send(frame);
    }
  }

  /**
   * Generates the next available stream ID for server-initiated connections
   * @returns Next even-numbered stream ID
   * @example
   * ```javascript
   * const streamId = connection.getNextStreamId(); // Returns 2, 4, 6, 8...
   * ```
   */
  getNextStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId += 2; // Skip by 2 to maintain even numbers
    return id;
  }

  createServerSynPayload(
    listenStreamId: number,
    remoteAddress: string,
    remotePort: number
  ): Buffer {
    const hostBuffer = Buffer.from(remoteAddress);
    const payload = Buffer.allocUnsafe(3 + 2 + hostBuffer.length);

    // 3 bytes for listen stream ID
    payload[0] = (listenStreamId >> 16) & 0xff;
    payload[1] = (listenStreamId >> 8) & 0xff;
    payload[2] = listenStreamId & 0xff;
    // 2 bytes for port (uint16)
    payload.writeUInt16BE(remotePort, 3);
    // Variable length host
    hostBuffer.copy(payload, 5);

    return payload;
  }
}

/**
 * Represents a multiplexed socket connection within a WebSocket
 * 
 * This class provides a Node.js socket-like interface for individual TCP
 * streams multiplexed over the WebSocket connection. It handles sending
 * and receiving data, connection lifecycle, and coordinating with the
 * browser-side socket implementation.
 * 
 * @example
 * ```javascript
 * // Socket is typically created by Connection
 * connection.on('connect', (socket, addressInfo) => {
 *   // Acknowledge the connection
 *   socket.ack(Buffer.from(JSON.stringify({
 *     address: '127.0.0.1',
 *     port: 3000,
 *     family: 'IPv4'
 *   })));
 *   
 *   // Send data to browser
 *   socket.write('Hello from server');
 *   
 *   // Handle data from browser
 *   socket.on('data', (data) => {
 *     console.log('Received:', data.toString());
 *   });
 *   
 *   // Handle connection end
 *   socket.on('end', () => {
 *     console.log('Browser closed connection');
 *   });
 * });
 * 
 * // For server sockets accepting connections
 * connection.on('listen', (socket, addressInfo) => {
 *   // When TCP client connects to our server
 *   tcpServer.on('connection', (tcpSocket) => {
 *     // Create new browser socket for this connection
 *     const browserSocket = socket.connect(
 *       tcpSocket.remoteAddress,
 *       tcpSocket.remotePort
 *     );
 *     
 *     // Pipe data between TCP socket and browser
 *     tcpSocket.pipe(browserSocket);
 *     browserSocket.on('data', (data) => tcpSocket.write(data));
 *   });
 * });
 * ```
 */
export class Socket extends EventEmitter {
  private connection: Connection;
  private streamId: number;
  private destroyed: boolean = false;
  public remoteAddress: string | null = null;
  public remotePort: number | null = null;

  /**
   * Creates a new Socket instance
   * @param connection - Parent Connection instance
   * @param streamId - Unique stream identifier for this socket
   */
  constructor(connection: Connection, streamId: number) {
    super();
    this.connection = connection;
    this.streamId = streamId;
  }

  /**
   * Sends an acknowledgment frame to the browser
   * @param payload - Optional payload data (typically address information)
   * @example
   * ```javascript
   * // Send ACK with address info for connection
   * socket.ack(Buffer.from(JSON.stringify({
   *   address: '127.0.0.1',
   *   port: 3000,
   *   family: 'IPv4',
   *   remoteAddress: '192.168.1.100',
   *   remotePort: 54321
   * })));
   * 
   * // Send simple ACK
   * socket.ack();
   * ```
   */
  ack(payload?: Buffer): void {
    if (this.destroyed) return;
    this.connection.sendFrame(
      FLAGS.ACK,
      this.streamId,
      payload || Buffer.alloc(0)
    );
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
    if (this.destroyed) return false;
    this.connection.sendFrame(FLAGS.DATA, this.streamId, Buffer.from(data));
    return true;
  }

  /**
   * Ends the socket connection gracefully, optionally sending final data
   * @param data - Optional final data to send before closing
   * @example
   * ```javascript
   * // End without data
   * socket.end();
   * 
   * // End with final message
   * socket.end('Goodbye!');
   * 
   * // End with binary data
   * socket.end(Buffer.from([0xFF, 0x00]));
   * ```
   */
  end(data?: Buffer | string): void {
    if (this.destroyed) return;

    if (data) {
      this.write(data);
    }

    this.connection.sendFrame(FLAGS.FIN, this.streamId);
    this.connection.sockets.delete(this.streamId);
    this.destroyed = true;
  }

  /**
   * Forcefully destroys the socket connection
   * @param error - Optional error information (Error object, Buffer, or string)
   * @example
   * ```javascript
   * // Destroy with error
   * socket.destroy(new Error('Connection timeout'));
   * 
   * // Destroy with custom message
   * socket.destroy('Invalid request format');
   * 
   * // Destroy without error
   * socket.destroy();
   * ```
   */
  destroy(error?: Error | Buffer | string): void {
    if (this.destroyed) return;

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

    this.connection.sendFrame(FLAGS.RST, this.streamId, errorPayload);
    this.connection.sockets.delete(this.streamId);
    this.destroyed = true;

    if (error && !(error instanceof Buffer)) {
      this.emit(
        "error",
        error instanceof Error ? error : new Error(error.toString())
      );
    }
    this.emit("close");
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
  connect(remoteAddress: string, remotePort: number): Socket {
    // For server-initiated connections from a listening socket
    const newStreamId = this.connection.getNextStreamId();
    const newSocket = new Socket(this.connection, newStreamId);
    newSocket.remoteAddress = remoteAddress;
    newSocket.remotePort = remotePort;
    this.connection.sockets.set(newStreamId, newSocket);

    const payload = this.connection.createServerSynPayload(
      this.streamId, // This is the listen stream ID
      remoteAddress,
      remotePort
    );
    this.connection.sendFrame(FLAGS.SYN, newStreamId, payload);

    return newSocket;
  }
}
