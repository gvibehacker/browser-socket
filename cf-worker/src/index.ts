/**
 * @fileoverview Cloudflare Workers WebSocket transport with TCP connection handling
 *
 * This module provides the Cloudflare Workers implementation for browser-socket,
 * enabling browsers to create TCP connections through WebSocket multiplexing.
 * It handles the bridge between WebSocket connections from browsers and external
 * TCP services using Cloudflare's fetch API and WebSocket API.
 *
 * @example
 * ```javascript
 * // In a Cloudflare Worker
 * export default {
 *   async fetch(request, env, ctx) {
 *     if (request.headers.get('Upgrade') === 'websocket') {
 *       const pair = new WebSocketPair();
 *       const [client, server] = Object.values(pair);
 *
 *       // Create connection handler
 *       const connection = new Connection(server);
 *
 *       connection.addEventListener('connect', (event) => {
 *         const [socket, addressInfo] = event.data;
 *         // Handle TCP client connection requests from browser
 *         handleTcpConnection(socket, addressInfo);
 *       });
 *
 *       return new Response(null, {
 *         status: 101,
 *         webSocket: client,
 *       });
 *     }
 *     return new Response('Not found', { status: 404 });
 *   },
 * };
 * ```
 */

import {
  FLAGS,
  Flag,
  encodeFrame,
  FrameParser,
  parseSynPayload,
} from "./protocol";

/**
 * Manages a single WebSocket connection from a browser
 *
 * This class handles the multiplexed TCP streams over a single WebSocket
 * connection. It processes binary frames from the browser, manages socket
 * instances for each stream, and coordinates between browser requests and
 * external TCP services using Cloudflare Workers APIs.
 *
 * @example
 * ```javascript
 * // In a Cloudflare Worker
 * const pair = new WebSocketPair();
 * const [client, server] = Object.values(pair);
 * const connection = new Connection(server);
 *
 * connection.addEventListener('connect', (event) => {
 *   const [socket, addressInfo] = event.data;
 *   // Browser wants to connect to external TCP server
 *
 *   // Use Cloudflare's connect API for TCP connections
 *   const tcpSocket = connect({
 *     hostname: addressInfo.host,
 *     port: addressInfo.port
 *   });
 *
 *   // Acknowledge the connection
 *   socket.ack(new TextEncoder().encode(JSON.stringify({
 *     address: addressInfo.host,
 *     port: addressInfo.port,
 *     family: 'IPv4'
 *   })));
 *
 *   // Pipe data between browser socket and TCP connection
 *   socket.addEventListener('data', (event) => {
 *     const data = event.data;
 *     tcpSocket.writable.getWriter().write(data);
 *   });
 * });
 * ```
 */
export class Connection extends EventTarget {
  private ws: WebSocket;
  public sockets: Map<number, Socket> = new Map();
  private frameParser: FrameParser = new FrameParser();
  private closed: boolean = false;
  nextStreamId: number = 2; // Server uses even IDs (2, 4, 6...) for incoming connections

  /**
   * Creates a new Connection instance for a WebSocket
   * @param ws - WebSocket connection to the browser
   */
  constructor(ws: WebSocket) {
    super();
    this.ws = ws;

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
            const addressInfo = parseSynPayload(payload);
            // Client-initiated SYN (outbound connection request)
            const socket = new Socket(this, streamId);
            this.sockets.set(streamId, socket);
            this.dispatchEvent(
              new CustomEvent("connect", { detail: [socket, addressInfo] })
            );
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode(errorMessage)
            );
          }
          break;
        case FLAGS.DATA:
          socket = this.sockets.get(streamId);
          if (socket)
            socket.dispatchEvent(new MessageEvent("data", { data: payload }));
          else
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
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
            socket.dispatchEvent(new MessageEvent("end", { data: undefined }));
          } else
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
          break;
        case FLAGS.RST:
          socket = this.sockets.get(streamId);
          if (!socket) return;
          if (socket.ended && socket.remoteEnded) return;
          socket.dispatchEvent(new MessageEvent("error", { data: payload }));
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
      socket.dispatchEvent(
        new MessageEvent("error", { data: "Websocket closed" })
      );
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
 * @example
 * ```javascript
 * // Socket is typically created by Connection
 * connection.addEventListener('connect', (event) => {
 *   const [socket, addressInfo] = event.data;
 *
 *   // Acknowledge the connection
 *   socket.ack(new TextEncoder().encode(JSON.stringify({
 *     address: addressInfo.host,
 *     port: addressInfo.port,
 *     family: 'IPv4'
 *   })));
 *
 *   // Send data to browser
 *   socket.write('Hello from Cloudflare Worker');
 *
 *   // Handle data from browser
 *   socket.addEventListener('data', (event) => {
 *     const data = event.data;
 *     console.log('Received:', new TextDecoder().decode(data));
 *   });
 *
 *   // Handle connection end
 *   socket.addEventListener('end', () => {
 *     console.log('Browser closed connection');
 *   });
 * });
 * ```
 */
export class Socket extends EventTarget {
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
      ? new TextEncoder().encode(JSON.stringify(addressInfo))
      : new Uint8Array(0);
    this.connection.sendFrame(FLAGS.ACK, this.streamId, payload);
  }

  /**
   * Writes data to the socket (sends to browser)
   * @param data - Data to send (Uint8Array or string)
   * @returns True if data was sent, false if socket is destroyed
   * @example
   * ```javascript
   * // Send string data
   * socket.write('Hello browser');
   *
   * // Send binary data
   * socket.write(new Uint8Array([1, 2, 3, 4]));
   *
   * // Send HTTP response
   * socket.write('HTTP/1.1 200 OK\r\n');
   * socket.write('Content-Type: text/plain\r\n\r\n');
   * socket.write('Hello from Cloudflare Worker');
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
    this.connection.sendFrame(FLAGS.FIN, this.streamId);
  }

  /**
   * Forcefully destroys the socket connection
   * @param error - Optional error information (Error object, Uint8Array, or string)
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

  /**
   * Creates a new server-initiated connection to the browser
   *
   * This method is used when an external TCP client connects through
   * Cloudflare Workers. It creates a new socket stream and sends
   * a SYN frame to the browser to establish the connection.
   *
   * @param remoteAddress - IP address of the connecting TCP client
   * @param remotePort - Port number of the connecting TCP client
   * @returns New Socket instance for the connection
   * @example
   * ```javascript
   * // When handling incoming connections in Cloudflare Workers
   * const browserSocket = listenSocket.connect(
   *   '192.168.1.100',
   *   54321
   * );
   *
   * // Handle data from browser
   * browserSocket.addEventListener('data', (event) => {
   *   const data = event.data;
   *   // Forward to external service
   *   externalService.write(data);
   * });
   *
   * // Handle connection lifecycle
   * browserSocket.addEventListener('end', () => {
   *   console.log('Browser connection ended');
   * });
   * ```
   */
  connect(remoteAddress: string, remotePort: number): Socket {
    // For server-initiated connections from a listening socket
    const newStreamId = this.connection.nextStreamId;
    this.connection.nextStreamId += 2;
    const newSocket = new Socket(this.connection, newStreamId);
    newSocket.remoteAddress = remoteAddress;
    newSocket.remotePort = remotePort;
    this.connection.sockets.set(newStreamId, newSocket);

    const payload = this.createServerSynPayload(
      this.streamId, // This is the listen stream ID
      remoteAddress,
      remotePort
    );
    this.connection.sendFrame(FLAGS.SYN, newStreamId, payload);

    return newSocket;
  }

  private createServerSynPayload(
    listenStreamId: number,
    remoteAddress: string,
    remotePort: number
  ): Uint8Array {
    const hostBuffer = new TextEncoder().encode(remoteAddress);
    const payload = new Uint8Array(3 + 2 + hostBuffer.length);

    // 3 bytes for listen stream ID
    payload[0] = (listenStreamId >> 16) & 0xff;
    payload[1] = (listenStreamId >> 8) & 0xff;
    payload[2] = listenStreamId & 0xff;
    // 2 bytes for port (uint16)
    const view = new DataView(payload.buffer);
    view.setUint16(3, remotePort, false); // false = big-endian
    // Variable length host
    payload.set(hostBuffer, 5);

    return payload;
  }
}
