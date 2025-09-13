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
} from "./protocol";

/**
 * Event interface for Socket instances
 */
type SocketEvents = {
  /** Emitted when data is received from the remote peer */
  data: [Buffer];
  /** Emitted when the connection is ended gracefully */
  end: [];
  /** Emitted when an error occurs */
  error: [Error];
};

/**
 * Event interface for Connection instances
 */
type ConnectionEvents = {
  /** Emitted when browser requests to connect to a TCP server */
  connect: [Socket, AddressInfo];
  /** Emitted when browser requests to create a TCP server */
  listen: [Socket, AddressInfo];
};

/**
 * Event interface for Transport instances
 */
type TransportEventMap = {
  /** Emitted when a new browser WebSocket connection is established */
  connection: [Connection];
};

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
export class Transport extends EventEmitter<TransportEventMap> {
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
export class Connection extends EventEmitter<ConnectionEvents> {
  public sockets: Map<number, Socket> = new Map();
  private frameParser: FrameParser = new FrameParser();
  private closed: boolean = false;
  ws: WebSocket;
  nextStreamId: number = 2; // Server uses even IDs (2, 4, 6...) for incoming connections

  /**
   * Creates a new Connection instance for a WebSocket
   * @param ws - WebSocket connection to the browser
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
            const addressInfo = parseSynPayload(payload);
            // Client-initiated SYN (outbound connection request)
            const socket = new Socket(this, streamId);
            this.sockets.set(streamId, socket);
            this.emit("connect", socket, addressInfo);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            sendFrame(this.ws, FLAGS.RST, streamId, Buffer.from(errorMessage));
          }
          break;
        case FLAGS.LISTEN:
          try {
            const addressInfo = parseSynPayload(payload);
            const socket = new Socket(this, streamId);
            this.sockets.set(streamId, socket);
            this.emit("listen", socket, addressInfo);
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            sendFrame(this.ws, FLAGS.RST, streamId, Buffer.from(errorMessage));
          }
          break;
        case FLAGS.DATA:
          socket = this.sockets.get(streamId);
          if (socket) socket.emit("data", data);
          else
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from("Invalid stream id")
            );
          break;
        case FLAGS.FIN:
          socket = this.sockets.get(streamId);
          if (socket) {
            if (socket.remoteEnded) return;
            socket.remoteEnded = true;
            if (socket.ended) {
              this.sockets.delete(streamId);
            }
            socket.emit("end");
          } else
            sendFrame(
              this.ws,
              FLAGS.RST,
              streamId,
              Buffer.from("Invalid stream id")
            );
          break;
        case FLAGS.RST:
          socket = this.sockets.get(streamId);
          if (!socket) return;
          if (socket.ended && socket.remoteEnded) return;
          const error = new Error(
            payload && payload.length > 0
              ? payload.toString()
              : "Connection reset"
          );
          socket.emit("error", error);
          this.sockets.delete(streamId);
          break;
      }
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets.values()) {
      if (socket.ended && socket.remoteEnded) continue;
      socket.emit("error", new Error("Websocket closed"));
    }
    this.sockets.clear();
  }

  /**
   * Closes the WebSocket connection and all associated sockets
   * @example
   * ```javascript
   * connection.close();
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
export class Socket extends EventEmitter<SocketEvents> {
  private connection: Connection;
  private streamId: number;
  ended: boolean = false;
  remoteEnded: boolean = false;
  remoteAddress: string | null = null;
  remotePort: number | null = null;

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
    const payload = addressInfo
      ? Buffer.from(JSON.stringify(addressInfo))
      : Buffer.alloc(0);
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
    const newStreamId = this.connection.nextStreamId;
    this.connection.nextStreamId += 2; // Skip by 2 to maintain even numbers
    const newSocket = new Socket(this.connection, newStreamId);
    newSocket.remoteAddress = remoteAddress;
    newSocket.remotePort = remotePort;
    this.connection.sockets.set(newStreamId, newSocket);

    const payload = this.createServerSynPayload(
      this.streamId, // This is the listen stream ID
      remoteAddress,
      remotePort
    );
    sendFrame(this.connection.ws, FLAGS.SYN, newStreamId, payload);

    return newSocket;
  }

  private createServerSynPayload(
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
