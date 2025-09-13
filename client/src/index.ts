/**
 * @fileoverview Client-side WebSocket transport with binary wire protocol
 *
 * This module provides a browser-compatible TCP networking API that enables
 * browsers to create TCP servers and clients through WebSocket multiplexing.
 * All TCP sockets are multiplexed through a single WebSocket connection
 * to a Node.js bridge server.
 *
 * @example
 * ```javascript
 * // Connect to WebSocket bridge
 * const ws = new WebSocket('ws://localhost:8080');
 * const net = new Net(ws);
 *
 * // Create a TCP client
 * const socket = new net.Socket();
 * socket.connect(6379, 'localhost', () => {
 *   console.log('Connected to Redis');
 *   socket.write('PING\r\n');
 * });
 *
 * // Create a TCP server
 * const server = net.createServer((socket) => {
 *   socket.write('Hello from browser server!');
 *   socket.end();
 * });
 * server.listen(3000);
 * ```
 */

/**
 * Protocol flags for frame types in the binary wire protocol
 * @readonly
 * @enum {number}
 */
const FLAGS = {
  DATA: 0, // 0x00 - no flag set
  SYN: 1, // 0x01 - connect
  ACK: 2, // 0x02 - connected
  FIN: 4, // 0x04 - end of connection
  RST: 8, // 0x08 - forcibly close connection
  LISTEN: 16, // 0x10 - open a socket for listening
} as const;

const HEADER_SIZE = 8;

type FrameHeader = {
  length: number;
  flag: number;
  streamId: number;
  totalFrameSize: number;
};

type Frame = {
  flag: number;
  streamId: number;
  payload: Uint8Array;
};

type AddressInfo = {
  address: string;
  port: number;
  family: string;
  remoteAddress?: string;
  remotePort?: number;
};

type EventListener = (...args: any[]) => void;

function encodeFrame(
  flag: number,
  streamId: number,
  payload: Uint8Array
): Uint8Array {
  const length = payload.length;
  if (length > 0xffffff) {
    throw new Error("Payload too large: exceeds 24-bit length limit");
  }

  const header = new Uint8Array(HEADER_SIZE);

  // Write length (24 bits = 3 bytes)
  header[0] = (length >> 16) & 0xff;
  header[1] = (length >> 8) & 0xff;
  header[2] = length & 0xff;

  // Write flag (8 bits = 1 byte)
  header[3] = flag & 0xff;

  // Write stream ID (32 bits = 4 bytes, big-endian)
  header[4] = (streamId >>> 24) & 0xff;
  header[5] = (streamId >>> 16) & 0xff;
  header[6] = (streamId >>> 8) & 0xff;
  header[7] = streamId & 0xff;

  // Combine header and payload
  const frame = new Uint8Array(HEADER_SIZE + payload.length);
  frame.set(header, 0);
  frame.set(payload, HEADER_SIZE);
  return frame;
}

function decodeFrameHeader(buffer: Uint8Array): FrameHeader | null {
  if (buffer.length < HEADER_SIZE) {
    return null;
  }

  // Read length (24 bits)
  const length = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];

  // Read flag (8 bits)
  const flag = buffer[3];

  // Read stream ID (32 bits, big-endian)
  const streamId =
    (buffer[4] << 24) | (buffer[5] << 16) | (buffer[6] << 8) | buffer[7];

  return {
    length,
    flag,
    streamId: streamId >>> 0, // Convert to unsigned 32-bit
    totalFrameSize: HEADER_SIZE + length,
  };
}

function formatSynPayload(
  type: string,
  hostOrPath: string,
  port?: number
): string {
  if (type === "unix") {
    return `unix://${hostOrPath}`;
  } else if (type === "tcp") {
    // Handle IPv6 addresses
    if (hostOrPath.includes(":") && !hostOrPath.startsWith("[")) {
      return `[${hostOrPath}]:${port}`;
    }
    // Handle IPv4 or hostname
    return `${hostOrPath}:${port}`;
  }
  throw new Error(`Invalid address type: ${type}`);
}

class FrameParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private frames: Frame[] = [];

  addData(data: Uint8Array): Frame[] {
    // Ensure data is Uint8Array
    const dataArray = data instanceof ArrayBuffer ? new Uint8Array(data) : data;

    // Concatenate buffers
    const newBuffer = new Uint8Array(this.buffer.length + dataArray.length);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(dataArray, this.buffer.length);
    this.buffer = newBuffer;

    this.parseFrames();
    return this.frames.splice(0);
  }

  private parseFrames(): void {
    while (this.buffer.length >= HEADER_SIZE) {
      const header = decodeFrameHeader(this.buffer);
      if (!header) break;

      if (this.buffer.length < header.totalFrameSize) {
        // Not enough data for complete frame
        break;
      }

      const payload = this.buffer.slice(HEADER_SIZE, header.totalFrameSize);
      this.frames.push({
        flag: header.flag,
        streamId: header.streamId,
        payload,
      });

      this.buffer = this.buffer.slice(header.totalFrameSize);
    }
  }
}

/**
 * Represents a TCP socket connection that can be used as a client to connect
 * to remote servers or as a server-side socket when accepting sockets.
 *
 * @example
 * ```javascript
 * // TCP client usage
 * const socket = new net.Socket();
 * socket.connect(80, 'example.com', () => {
 *   console.log('Connected to web server');
 *   socket.write('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
 * });
 *
 * socket.on('data', (data) => {
 *   console.log('Received:', data.toString());
 * });
 *
 * socket.on('end', () => {
 *   console.log('Connection ended');
 * });
 * ```
 */
export class Socket {
  /** Reference to the parent Net instance */
  public net: Net;
  /** Unique stream identifier for this socket */
  public streamId: number;
  /** Whether the socket is currently connected */
  public connected: boolean = false;
  /** Whether the socket connection has ended */
  public ended: boolean = false;
  /** Whether the socket connection has ended by remote */
  public remoteEnded: boolean = false;
  /** Remote peer's IP address */
  public remoteAddress: string | null = null;
  /** Remote peer's port number */
  public remotePort: number | null = null;
  /** Complete address information for this socket */
  public addressInfo: AddressInfo | null = null;
  /** Event listeners for socket events */
  private listeners: Record<string, EventListener[]> = {
    data: [],
    end: [],
    error: [],
    connect: [],
  };

  /**
   * Creates a new Socket instance
   * @param net - The Net instance managing this socket
   * @param streamId - Optional stream ID (auto-generated if not provided)
   */
  constructor(net: Net, streamId?: number) {
    this.net = net;
    this.streamId = streamId || net.getNextStreamId();
  }

  /**
   * Returns the local address information for this socket
   * @returns Object with address, port, and family, or null if not connected
   * @example
   * ```javascript
   * const addr = socket.address();
   * console.log(`Local address: ${addr.address}:${addr.port}`);
   * ```
   */
  address(): { address: string; port: number; family: string } | null {
    if (!this.addressInfo) return null;
    // Return only address, port, family (not remoteAddress/remotePort)
    const { address, port, family } = this.addressInfo;
    return { address, port, family };
  }

  /**
   * Connects this socket to a remote server
   * @param port - Port number or Unix socket path (if starts with 'unix://')
   * @param host - Hostname or IP address (defaults to 'localhost')
   * @param callback - Optional callback executed when connection is established
   * @returns This socket instance for method chaining
   * @example
   * ```javascript
   * // Connect to TCP server
   * socket.connect(80, 'example.com', () => {
   *   console.log('Connected!');
   * });
   *
   * // Connect to Unix socket
   * socket.connect('unix:///tmp/my.sock');
   *
   * // Connect to Redis
   * socket.connect(6379, 'localhost', () => {
   *   socket.write('PING\r\n');
   * });
   * ```
   */
  connect(port: number | string, host?: string, callback?: () => void): this {
    this.net.sockets.set(this.streamId, this);

    if (callback) {
      this.on("connect", callback);
    }

    // Send SYN frame using new address format
    let payload: Uint8Array;
    if (typeof port === "string" && port.startsWith("unix://")) {
      payload = new TextEncoder().encode(port);
    } else {
      const addressStr = formatSynPayload(
        "tcp",
        host || "localhost",
        port as number
      );
      payload = new TextEncoder().encode(addressStr);
    }
    this.net.sendFrame(FLAGS.SYN, this.streamId, payload);

    return this;
  }

  /**
   * Sends data through this socket
   * @param data - Data to send (string or binary data)
   * @returns True if data was sent, false if socket is closed
   * @example
   * ```javascript
   * // Send text data
   * socket.write('Hello, world!');
   *
   * // Send binary data
   * const buffer = new Uint8Array([1, 2, 3, 4]);
   * socket.write(buffer);
   *
   * // Send HTTP request
   * socket.write('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
   * ```
   */
  write(data: string | Uint8Array): boolean {
    if (this.ended) return false;
    // Convert string to Uint8Array if needed
    const payload =
      typeof data === "string" ? new TextEncoder().encode(data) : data;
    this.net.sendFrame(FLAGS.DATA, this.streamId, payload);
    return true;
  }

  /**
   * Closes the socket connection
   * @example
   * ```javascript
   * // Close without sending data
   * socket.end();
   * ```
   */
  end() {
    if (this.ended) return this;
    this.ended = true;
    this.net.sendFrame(FLAGS.FIN, this.streamId);
    if (this.remoteEnded) {
      this.net.sockets.delete(this.streamId);
    }
  }

  /**
   * Forcibly destroys the socket connection
   * @param error - Optional error that caused the destruction
   * @example
   * ```javascript
   * // Destroy with error
   * socket.destroy(new Error('Connection timeout'));
   *
   * // Destroy without error
   * socket.destroy();
   * ```
   */
  destroy(error?: Error): void {
    if (this.ended && this.remoteEnded) return;
    this.ended = true;
    this.remoteEnded = true;
    // Send RST frame with optional error message payload
    const payload = error
      ? new TextEncoder().encode(error.toString())
      : new Uint8Array(0);
    this.net.sendFrame(FLAGS.RST, this.streamId, payload);
    this.net.sockets.delete(this.streamId);
  }

  /**
   * Registers an event listener for socket events
   * @param event - Event name ('data', 'connect', 'end', 'error')
   * @param listener - Event handler function
   * @returns This socket instance for method chaining
   * @example
   * ```javascript
   * socket.on('connect', () => {
   *   console.log('Socket connected');
   * });
   *
   * socket.on('data', (data) => {
   *   console.log('Received data:', data.toString());
   * });
   *
   * socket.on('end', () => {
   *   console.log('Socket ended');
   * });
   *
   * socket.on('error', (error) => {
   *   console.error('Socket error:', error);
   * });
   * ```
   */
  on(event: string, listener: EventListener): this {
    if (this.listeners[event]) {
      this.listeners[event].push(listener);
    }
    return this;
  }

  emit(event: string, ...args: any[]): void {
    const listeners = this.listeners[event];
    if (listeners) {
      for (const listener of listeners) {
        listener(...args);
      }
    }
  }
}

/**
 * Represents a TCP server that can accept incoming sockets from clients.
 * Servers are created through the Net.createServer() method and can listen
 * on TCP ports or Unix sockets.
 *
 * @example
 * ```javascript
 * const server = net.createServer((socket) => {
 *   console.log('Client connected');
 *
 *   socket.on('data', (data) => {
 *     console.log('Received:', data.toString());
 *     socket.write('Echo: ' + data.toString());
 *   });
 *
 *   socket.on('end', () => {
 *     console.log('Client disconnected');
 *   });
 * });
 *
 * server.listen(3000, () => {
 *   console.log('Server listening on port 3000');
 * });
 * ```
 */
export class NetServer {
  private net: Net;
  private connectionListener: ((socket: Socket) => void) | null;
  private port: number | string | null = null;
  private listening: boolean = false;
  private listenStreamId: number | null = null;
  private addressInfo: AddressInfo | null = null;
  private listenCallback: (() => void) | null = null;

  /**
   * Creates a new NetServer instance
   * @param net - The Net instance managing this server
   * @param connectionListener - Optional callback for handling new sockets
   */
  constructor(net: Net, connectionListener?: (socket: Socket) => void) {
    this.net = net;
    this.connectionListener = connectionListener || null;
  }

  /**
   * Starts the server listening for sockets on the specified port
   * @param port - Port number or Unix socket path (if starts with 'unix://')
   * @param callback - Optional callback executed when server starts listening
   * @returns This server instance for method chaining
   * @example
   * ```javascript
   * // Listen on TCP port
   * server.listen(3000, () => {
   *   console.log('Server listening on port 3000');
   * });
   *
   * // Listen on Unix socket
   * server.listen('unix:///tmp/my-server.sock');
   *
   * // Listen on specific interface
   * server.listen(8080, () => {
   *   const addr = server.address();
   *   console.log(`Server listening on ${addr.address}:${addr.port}`);
   * });
   * ```
   */
  listen(port: number | string, callback?: () => void): this {
    this.port = port;
    this.listening = true;
    this.listenCallback = callback || null;

    // Send LISTEN frame using new address format
    let payload: Uint8Array;
    if (typeof port === "string" && port.startsWith("unix://")) {
      payload = new TextEncoder().encode(port);
    } else {
      payload = new TextEncoder().encode(`:${port}`);
    }
    // Use stream ID for LISTEN operations
    this.listenStreamId = this.net.getNextStreamId();
    this.net.servers.set(this.listenStreamId, this);
    this.net.sendFrame(FLAGS.LISTEN, this.listenStreamId, payload);

    // Don't call callback here - wait for ACK
    return this;
  }

  handleListenAck(addressInfo: AddressInfo): void {
    this.addressInfo = addressInfo;
    if (this.listenCallback) {
      this.listenCallback();
      this.listenCallback = null;
    }
  }

  /**
   * Returns the server's address information
   * @returns AddressInfo object with server address details, or null if not listening
   * @example
   * ```javascript
   * const addr = server.address();
   * if (addr) {
   *   console.log(`Server bound to ${addr.address}:${addr.port}`);
   *   console.log(`Address family: ${addr.family}`);
   * }
   * ```
   */
  address(): AddressInfo | null {
    return this.addressInfo;
  }

  handleConnection(socket: Socket): void {
    if (this.connectionListener) {
      this.connectionListener(socket);
    }
  }

  /**
   * Stops the server from accepting new sockets and closes all existing sockets
   * @example
   * ```javascript
   * server.close();
   * ```
   */
  close(): void {
    if (this.listening && this.listenStreamId !== null) {
      this.net.servers.delete(this.listenStreamId);
      this.listening = false;

      // Send RST frame to close server
      const payload = new TextEncoder().encode(
        JSON.stringify({ closeServer: true, port: this.port })
      );
      this.net.sendFrame(FLAGS.RST, this.listenStreamId, payload);
    }
  }
}

/**
 * Main networking class that manages WebSocket transport and provides
 * TCP networking capabilities to the browser. This class handles
 * multiplexing multiple TCP sockets through a single WebSocket.
 *
 * @example
 * ```javascript
 * // Connect to WebSocket bridge server
 * const ws = new WebSocket('ws://localhost:8080');
 * const net = new Net(ws);
 *
 * // Wait for WebSocket to open
 * ws.onopen = () => {
 *   // Create TCP client
 *   const client = new net.Socket();
 *   client.connect(80, 'example.com');
 *
 *   // Create TCP server
 *   const server = net.createServer((socket) => {
 *     console.log('New connection');
 *   });
 *   server.listen(3000);
 * };
 * ```
 */
export class Net {
  private ws: WebSocket;
  public sockets: Map<number, Socket> = new Map();
  public servers: Map<number, NetServer> = new Map();
  private nextStreamId: number = 1;
  private frameParser: FrameParser = new FrameParser();
  public Socket: new () => Socket;

  /**
   * Creates a new Net instance connected to a WebSocket bridge server
   * @param ws - WebSocket connection to the bridge server
   * @example
   * ```javascript
   * const ws = new WebSocket('ws://localhost:8080');
   * const net = new Net(ws);
   *
   * ws.onopen = () => {
   *   console.log('Connected to bridge server');
   *   // Now you can create sockets and servers
   * };
   *
   * ws.onerror = (error) => {
   *   console.error('WebSocket error:', error);
   * };
   * ```
   */
  constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", this.handleMessage.bind(this));
    this.ws.addEventListener("close", this.handleClose.bind(this));

    // Make Socket available as a constructor
    const netInstance = this;
    this.Socket = class {
      constructor() {
        return new Socket(netInstance);
      }
    } as any;
  }

  /**
   * Creates a new TCP server that can accept incoming sockets
   * @param connectionListener - Optional callback for handling new sockets
   * @returns NetServer instance
   * @example
   * ```javascript
   * // HTTP-like server
   * const server = net.createServer((socket) => {
   *   socket.write('HTTP/1.1 200 OK\r\n');
   *   socket.write('Content-Type: text/plain\r\n\r\n');
   *   socket.write('Hello from browser server!');
   *   socket.end();
   * });
   *
   * // Echo server
   * const echoServer = net.createServer((socket) => {
   *   socket.on('data', (data) => {
   *     socket.write(data); // Echo back received data
   *   });
   * });
   *
   * server.listen(3000);
   * ```
   */
  createServer(connectionListener?: (socket: Socket) => void): NetServer {
    return new NetServer(this, connectionListener);
  }

  private handleMessage(event: MessageEvent): void {
    // Handle both ArrayBuffer and Blob data
    if (event.data instanceof ArrayBuffer) {
      this.processFrames(new Uint8Array(event.data));
    } else if (event.data instanceof Blob) {
      event.data.arrayBuffer().then((buffer) => {
        this.processFrames(new Uint8Array(buffer));
      });
    } else {
      // Fallback for string data (shouldn't happen with binary protocol)
      this.processFrames(new TextEncoder().encode(event.data));
    }
  }

  private processFrames(data: Uint8Array): void {
    const frames = this.frameParser.addData(data);
    for (const frame of frames) {
      const { flag, streamId, payload } = frame;

      let socket: Socket | undefined;
      switch (flag) {
        case FLAGS.SYN:
          // Incoming connection from server - payload is 3-byte listen stream ID + 2-byte port + variable length host
          if (payload.length >= 5) {
            // Extract 3-byte listen stream ID
            const listenStreamId =
              (payload[0] << 16) | (payload[1] << 8) | payload[2];

            // Extract 2-byte port (uint16)
            const remotePort = (payload[3] << 8) | payload[4];

            // Extract variable length host
            const remoteAddress =
              payload.length > 5
                ? new TextDecoder().decode(payload.slice(5))
                : "";

            const targetServer = this.servers.get(listenStreamId);
            if (targetServer) {
              socket = new Socket(this, streamId);
              // Set remote address and port
              socket.remoteAddress = remoteAddress;
              socket.remotePort = remotePort;
              this.sockets.set(streamId, socket);
              // Send ACK to acknowledge the connection
              this.sendFrame(FLAGS.ACK, streamId);
              targetServer.handleConnection(socket);
            } else {
              this.sendFrame(
                FLAGS.RST,
                streamId,
                new TextEncoder().encode("No server listening on this stream")
              );
            }
          } else {
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid SYN payload format")
            );
          }
          break;

        case FLAGS.ACK:
          // Check if this is ACK for LISTEN or regular connection
          const server = this.servers.get(streamId);
          if (server) {
            // ACK for LISTEN - payload contains server address info
            if (payload.length > 0) {
              try {
                const addressInfo = JSON.parse(
                  new TextDecoder().decode(payload)
                );
                server.handleListenAck(addressInfo);
              } catch (error) {
                this.sendFrame(
                  FLAGS.RST,
                  streamId,
                  new TextEncoder().encode(
                    "Failed to parse server address info"
                  )
                );
              }
            }
          } else {
            // ACK for regular connection
            socket = this.sockets.get(streamId);
            if (socket) {
              // Parse address info if present in payload
              if (payload.length > 0) {
                try {
                  const addressInfo = JSON.parse(
                    new TextDecoder().decode(payload)
                  );
                  socket.addressInfo = addressInfo;
                  // Set remoteAddress and remotePort from the payload
                  if (addressInfo.remoteAddress)
                    socket.remoteAddress = addressInfo.remoteAddress;
                  if (addressInfo.remotePort)
                    socket.remotePort = addressInfo.remotePort;
                } catch (error) {
                  this.sendFrame(
                    FLAGS.RST,
                    streamId,
                    new TextEncoder().encode(
                      "Failed to parse socket address info"
                    )
                  );
                  this.sockets.delete(streamId);
                }
              }
              socket.connected = true;
              socket.emit("connect");
            } else {
              this.sendFrame(
                FLAGS.RST,
                streamId,
                new TextEncoder().encode("Invalid stream id")
              );
            }
          }
          break;

        case FLAGS.DATA:
          // Data received
          socket = this.sockets.get(streamId);
          if (socket && !socket.remoteEnded) {
            socket.emit("data", data);
          } else
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
          break;

        case FLAGS.FIN:
          // Connection ended
          socket = this.sockets.get(streamId);
          if (socket) {
            if (socket.remoteEnded) return;
            socket.remoteEnded = true;
            if (socket.ended) {
              this.sockets.delete(streamId);
            }
            socket.emit("end");
          } else
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
          break;

        case FLAGS.RST:
          // Connection reset/error - RST can have optional data payload
          socket = this.sockets.get(streamId);
          if (!socket) return;
          if (socket.ended && socket.remoteEnded) return;
          socket.ended = true;
          socket.remoteEnded = true;
          this.sockets.delete(streamId);
          const errorMsg =
            payload.length > 0
              ? new TextDecoder().decode(payload)
              : "Connection reset";
          socket.emit("error", errorMsg);
          break;
      }
    }
  }

  private handleClose(): void {
    for (const socket of this.sockets.values()) {
      if (socket.ended && socket.remoteEnded) continue;
      socket.ended = true;
      socket.remoteEnded = true;
      socket.emit("error", "Connection reset");
    }
    this.sockets.clear();
    this.servers.clear();
  }

  sendFrame(flag: number, streamId: number, payload?: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const frame = encodeFrame(flag, streamId, payload || new Uint8Array(0));
      this.ws.send(frame);
    }
  }

  getNextStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId += 2; // Skip by 2 to maintain odd numbers
    return id;
  }
}
