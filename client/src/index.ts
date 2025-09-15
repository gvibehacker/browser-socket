/**
 * @fileoverview Browser-compatible TCP networking API over WebSocket transport
 *
 * This module provides a Node.js-compatible TCP networking API that enables
 * browsers to create TCP servers and clients through WebSocket multiplexing.
 * All TCP connections are tunneled through a single WebSocket connection
 * to a Node.js bridge server using a custom binary wire protocol.
 *
 * The API closely mirrors Node.js's 'net' module, allowing familiar patterns
 * for TCP networking while running entirely in the browser environment.
 *
 * @example Basic client connection
 * ```javascript
 * const ws = new WebSocket('ws://localhost:8080');
 * const net = new Net(ws);
 *
 * ws.onopen = () => {
 *   const socket = new net.Socket();
 *   socket.connect('example.com:80', () => {
 *     console.log('Connected to web server');
 *     socket.write('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n');
 *   });
 * };
 * ```
 *
 * @example TCP server in browser
 * ```javascript
 * const ws = new WebSocket('ws://localhost:8080');
 * const net = new Net(ws);
 *
 * ws.onopen = () => {
 *   const server = net.createServer((clientSocket) => {
 *     console.log('Client connected from', clientSocket.remoteAddress);
 *     clientSocket.write('Welcome to browser server!\n');
 *
 *     clientSocket.readable.pipeTo(new WritableStream({
 *       write(chunk) {
 *         console.log('Received:', new TextDecoder().decode(chunk));
 *         clientSocket.write('Echo: ');
 *         clientSocket.write(chunk);
 *       }
 *     }));
 *   });
 *
 *   server.listen(3000, () => {
 *     console.log('Server listening on port 3000');
 *   });
 * };
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
  WINDOW_UPDATE: 32, // 0x20 - window size update
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

class ReadableStreamSource {
  remoteWindowSize: number = 0;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(
    private net: Net,
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
    this.net.sendFrame(FLAGS.WINDOW_UPDATE, this.streamId, payload);
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
 * Represents a TCP socket connection with streaming capabilities.
 *
 * This class provides both client and server-side socket functionality,
 * supporting modern Web Streams API for data handling. Each socket maintains
 * separate readable and writable streams for bidirectional communication.
 *
 * The socket automatically handles flow control through window size management
 * and provides address information for both local and remote endpoints.
 *
 * @example Client socket with streams
 * ```javascript
 * const socket = new net.Socket();
 * socket.connect('redis.example.com:6379', async () => {
 *   console.log('Connected to Redis server');
 *
 *   // Send Redis PING command
 *   const writer = socket.writable.getWriter();
 *   await writer.write(new TextEncoder().encode('PING\r\n'));
 *   writer.releaseLock();
 *
 *   // Read response using streams
 *   const reader = socket.readable.getReader();
 *   const { value } = await reader.read();
 *   console.log('Redis response:', new TextDecoder().decode(value));
 *   reader.releaseLock();
 * });
 * ```
 *
 * @example Server-side socket handling
 * ```javascript
 * const server = net.createServer((socket) => {
 *   console.log(`Client connected: ${socket.remoteAddress}:${socket.remotePort}`);
 *
 *   // Echo server using transform stream
 *   socket.readable
 *     .pipeThrough(new TransformStream({
 *       transform(chunk, controller) {
 *         const text = new TextDecoder().decode(chunk);
 *         const echo = `Echo: ${text}`;
 *         controller.enqueue(new TextEncoder().encode(echo));
 *       }
 *     }))
 *     .pipeTo(socket.writable);
 * });
 * ```
 */
export class Socket {
  /** Whether the local side has ended the connection */
  public ended: boolean = false;
  /** Whether the remote side has ended the connection */
  public remoteEnded: boolean = false;
  /** Remote peer's IP address (available after connection) */
  remoteAddress: string | null = null;
  /** Remote peer's port number (available after connection) */
  remotePort: number | null = null;
  /** Complete address information including local and remote details */
  addressInfo: AddressInfo | null = null;

  /** Internal callback for connection establishment */
  connectCallback?: (s: Socket) => void;
  /** ReadableStream for receiving data from the remote peer */
  public readonly readable: ReadableStream<Uint8Array>;
  /** Internal readable stream source controller */
  public readableSource: ReadableStreamSource;
  /** WritableStream for sending data to the remote peer */
  public readonly writable: WritableStream<Uint8Array>;
  /** Internal writable stream sink controller */
  private writableSink: WritableStreamSink;
  /** Unique stream identifier for this socket connection */
  private streamId: number;

  /**
   * Creates a new Socket instance for TCP communication.
   *
   * @param net - The Net instance that manages this socket's lifecycle
   * @param streamId - Unique stream identifier (auto-generated if not provided)
   * @param initialWindowSize - Initial receive window size for flow control (default: 65536 bytes)
   * @param availableWriteWindowSize - Initial send window size from remote peer (default: 0)
   *
   * @example
   * ```javascript
   * // Create a client socket (most common usage)
   * const socket = new net.Socket();
   *
   * // Advanced: Create with specific window size
   * const socketWithLargeBuffer = new net.Socket();
   * ```
   */
  constructor(
    private net: Net,
    streamId?: number,
    private initialWindowSize: number = 65536,
    availableWriteWindowSize: number = 0
  ) {
    this.streamId = streamId || net.getNextStreamId();
    this.readableSource = new ReadableStreamSource(
      this.net,
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
   * Returns the local address information for this socket.
   *
   * @returns Local address information or null if socket is not connected
   * @returns address - Local IP address
   * @returns port - Local port number
   * @returns family - Address family ('IPv4', 'IPv6', or 'Unix')
   *
   * @example
   * ```javascript
   * socket.connect('example.com:80', () => {
   *   const local = socket.address();
   *   if (local) {
   *     console.log(`Connected from ${local.address}:${local.port}`);
   *     console.log(`Address family: ${local.family}`);
   *   }
   * });
   * ```
   */
  address(): { address: string; port: number; family: string } | null {
    if (!this.addressInfo) return null;
    // Return only address, port, family (not remoteAddress/remotePort)
    const { address, port, family } = this.addressInfo;
    return { address, port, family };
  }

  /**
   * Establishes a connection to a remote TCP server or Unix socket.
   *
   * Supports multiple address formats for maximum flexibility. The connection
   * is asynchronous and the callback will be invoked when the connection is
   * successfully established.
   *
   * @param addr - Target address in one of several supported formats:
   *   - TCP IPv4: 'hostname:port' or 'ip:port' (e.g., 'example.com:80', '192.168.1.1:8080')
   *   - TCP IPv6: '[ipv6]:port' (e.g., '[::1]:8080', '[2001:db8::1]:443')
   *   - Unix socket: 'unix:/path/to/socket' (e.g., 'unix:/tmp/app.sock')
   * @param callback - Function called when connection is successfully established
   *
   * @example TCP connection
   * ```javascript
   * const socket = new net.Socket();
   * socket.connect('redis.example.com:6379', (connectedSocket) => {
   *   console.log('Connected to Redis!');
   *   console.log('Remote:', connectedSocket.remoteAddress, connectedSocket.remotePort);
   *
   *   // Send Redis command
   *   socket.write('INFO\r\n');
   * });
   * ```
   *
   * @example Unix socket connection
   * ```javascript
   * socket.connect('unix:/var/run/docker.sock', () => {
   *   console.log('Connected to Docker daemon');
   *   socket.write('GET /version HTTP/1.1\r\nHost: docker\r\n\r\n');
   * });
   * ```
   *
   * @example IPv6 connection
   * ```javascript
   * socket.connect('[2001:db8::1]:443', () => {
   *   console.log('Connected via IPv6');
   * });
   * ```
   */
  connect(addr: string, callback: (s: Socket) => void): void {
    this.net.sockets.set(this.streamId, this);
    this.connectCallback = callback;
    // Send SYN frame with window size + address format
    const addressPayload = new TextEncoder().encode(addr);

    // Prepend 3-byte window size to the payload
    const payload = new Uint8Array(3 + addressPayload.length);
    payload[0] = (this.initialWindowSize >> 16) & 0xff;
    payload[1] = (this.initialWindowSize >> 8) & 0xff;
    payload[2] = this.initialWindowSize & 0xff;
    payload.set(addressPayload, 3);

    this.net.sendFrame(FLAGS.SYN, this.streamId, payload);
  }

  /**
   * Sends data through this socket connection.
   *
   * This is a convenience method for simple data transmission. For more advanced
   * use cases with backpressure handling, consider using the writable stream directly.
   *
   * @param data - Data to transmit (string will be UTF-8 encoded)
   * @returns true if data was queued for transmission, false if socket is closed
   *
   * @example Text transmission
   * ```javascript
   * // Send simple text
   * socket.write('Hello, server!');
   *
   * // Send structured data
   * socket.write(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
   *
   * // Send protocol commands
   * socket.write('GET /api/users HTTP/1.1\r\nHost: api.example.com\r\n\r\n');
   * ```
   *
   * @example Binary transmission
   * ```javascript
   * // Send raw bytes
   * const binaryData = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
   * socket.write(binaryData);
   *
   * // Send file data
   * const fileBytes = await file.arrayBuffer();
   * socket.write(new Uint8Array(fileBytes));
   * ```
   *
   * @example Error handling
   * ```javascript
   * if (!socket.write('important data')) {
   *   console.log('Socket is closed, data not sent');
   * }
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
   * Gracefully closes the socket connection.
   *
   * Initiates connection termination by sending a FIN frame to the remote peer.
   * The socket will remain open for receiving data until the remote peer also
   * closes their side of the connection.
   *
   * @example Basic connection close
   * ```javascript
   * // Graceful shutdown
   * socket.end();
   * ```
   *
   * @example HTTP request pattern
   * ```javascript
   * socket.connect('httpbin.org:80', () => {
   *   socket.write('GET /get HTTP/1.1\r\nHost: httpbin.org\r\n\r\n');
   *
   *   // Read response then close
   *   socket.readable.getReader().read().then(({ value }) => {
   *     console.log('Response:', new TextDecoder().decode(value));
   *     socket.end(); // Close after receiving response
   *   });
   * });
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
   * Forcibly terminates the socket connection immediately.
   *
   * Unlike end(), this method immediately closes both sides of the connection
   * without waiting for the remote peer. Use this for error conditions or
   * when immediate cleanup is required.
   *
   * @param error - Optional error message describing the reason for destruction
   *
   * @example Immediate termination
   * ```javascript
   * // Force close without error
   * socket.destroy();
   * ```
   *
   * @example Error-triggered termination
   * ```javascript
   * // Close due to timeout
   * setTimeout(() => {
   *   if (!socket.ended) {
   *     socket.destroy('Connection timeout after 30 seconds');
   *   }
   * }, 30000);
   * ```
   *
   * @example Protocol violation handling
   * ```javascript
   * socket.readable.getReader().read().then(({ value }) => {
   *   const data = new TextDecoder().decode(value);
   *   if (!data.startsWith('EXPECTED_PROTOCOL')) {
   *     socket.destroy('Invalid protocol header received');
   *     return;
   *   }
   *   // Continue processing...
   * });
   * ```
   */
  destroy(error?: string): void {
    if (this.ended && this.remoteEnded) return;
    this.ended = true;
    this.remoteEnded = true;
    // Send RST frame with optional error message payload
    const payload = error ? new TextEncoder().encode(error) : new Uint8Array(0);
    this.net.sendFrame(FLAGS.RST, this.streamId, payload);
    this.net.sockets.delete(this.streamId);
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
  incrementWriteWindow(windowSize: number): void {
    this.writableSink.addCapacity(windowSize);
  }
}

/**
 * TCP server that accepts incoming client connections.
 *
 * NetListener provides server functionality similar to Node.js net.Server,
 * allowing browsers to act as TCP servers through the WebSocket bridge.
 * Each incoming connection triggers the connection listener with a new Socket instance.
 *
 * The server supports both TCP ports and Unix domain sockets, with automatic
 * address binding and client connection management.
 *
 * @example HTTP-like server
 * ```javascript
 * const server = net.createServer((clientSocket) => {
 *   console.log(`Client connected from ${clientSocket.remoteAddress}:${clientSocket.remotePort}`);
 *
 *   // Send HTTP response
 *   const response = [
 *     'HTTP/1.1 200 OK',
 *     'Content-Type: text/plain',
 *     'Content-Length: 13',
 *     '',
 *     'Hello, World!'
 *   ].join('\r\n');
 *
 *   clientSocket.write(response);
 *   clientSocket.end();
 * });
 *
 * server.listen(8080, () => {
 *   console.log('HTTP server listening on port 8080');
 * });
 * ```
 *
 * @example Echo server with streams
 * ```javascript
 * const server = net.createServer((clientSocket) => {
 *   console.log('New client connected');
 *
 *   // Echo all received data back to client
 *   clientSocket.readable.pipeTo(clientSocket.writable)
 *     .catch(err => console.log('Client disconnected:', err.message));
 * });
 *
 * server.listen(9999);
 * ```
 *
 * @example Chat server
 * ```javascript
 * const clients = new Set();
 *
 * const server = net.createServer((clientSocket) => {
 *   clients.add(clientSocket);
 *   console.log(`Client joined. Total clients: ${clients.size}`);
 *
 *   clientSocket.readable.getReader().read().then(function processMessage({ value, done }) {
 *     if (done) {
 *       clients.delete(clientSocket);
 *       return;
 *     }
 *
 *     // Broadcast message to all other clients
 *     const message = new TextDecoder().decode(value);
 *     for (const client of clients) {
 *       if (client !== clientSocket && !client.ended) {
 *         client.write(message);
 *       }
 *     }
 *
 *     return clientSocket.readable.getReader().read().then(processMessage);
 *   });
 * });
 * ```
 */
export class NetListener {
  private net: Net;
  private port: number | string | null = null;
  private listening: boolean = false;
  private listenStreamId: number | null = null;
  private addressInfo: AddressInfo | null = null;
  private listenCallback: (() => void) | null = null;

  /** Callback function invoked for each new client connection */
  public readonly connectionListener: (socket: Socket) => void;
  /**
   * Creates a new NetListener instance for accepting TCP connections.
   *
   * @param net - The Net instance that manages this server's lifecycle
   * @param connectionListener - Callback invoked when clients connect, receiving the client Socket
   *
   * @internal This constructor is typically not called directly. Use Net.createServer() instead.
   */
  constructor(net: Net, connectionListener: (socket: Socket) => void) {
    this.net = net;
    this.connectionListener = connectionListener;
  }

  /**
   * Starts the server listening for client connections.
   *
   * The server will bind to the specified port or Unix socket and begin
   * accepting incoming connections. The optional callback is invoked once
   * the server is successfully bound and ready to accept connections.
   *
   * @param port - Port number (1-65535) or Unix socket path prefixed with 'unix:'
   * @param callback - Optional callback executed when server starts listening successfully
   * @returns This server instance for method chaining
   *
   * @example TCP server on specific port
   * ```javascript
   * server.listen(3000, () => {
   *   const addr = server.address();
   *   console.log(`Server listening on ${addr.address}:${addr.port}`);
   *   console.log(`Address family: ${addr.family}`);
   * });
   * ```
   *
   * @example Unix domain socket server
   * ```javascript
   * server.listen('unix:/tmp/myapp.sock', () => {
   *   console.log('Server listening on Unix socket');
   *   console.log('Connect with: nc -U /tmp/myapp.sock');
   * });
   * ```
   *
   * @example Auto-assigned port
   * ```javascript
   * server.listen(0, () => {
   *   const addr = server.address();
   *   console.log(`Server listening on auto-assigned port ${addr.port}`);
   * });
   * ```
   *
   * @example Method chaining
   * ```javascript
   * const server = net.createServer(handleConnection)
   *   .listen(8080)
   *   .on('error', handleError);
   * ```
   */
  listen(port: number | string, callback?: () => void): this {
    this.port = port;
    this.listening = true;
    this.listenCallback = callback || null;

    let payload: Uint8Array;
    if (typeof port === "string" && port.startsWith("unix:")) {
      payload = new TextEncoder().encode(port);
    } else {
      payload = new TextEncoder().encode(`:${port}`);
    }

    this.listenStreamId = this.net.getNextStreamId();
    this.net.servers.set(this.listenStreamId, this);
    this.net.sendFrame(FLAGS.LISTEN, this.listenStreamId, payload);

    return this;
  }

  /**
   * Internal method to handle server listen acknowledgment.
   * @internal
   */
  handleListenAck(addressInfo: AddressInfo): void {
    this.addressInfo = addressInfo;
    this.listenCallback?.();
    this.listenCallback = null;
  }

  /**
   * Returns the server's bound address information.
   *
   * @returns Server address details or null if server is not currently listening
   * @returns address - IP address the server is bound to
   * @returns port - Port number the server is listening on
   * @returns family - Address family ('IPv4', 'IPv6', or 'Unix')
   *
   * @example Checking server address
   * ```javascript
   * server.listen(0, () => {
   *   const addr = server.address();
   *   if (addr) {
   *     console.log(`Server running on ${addr.address}:${addr.port}`);
   *     console.log(`Protocol: ${addr.family}`);
   *   }
   * });
   * ```
   *
   * @example Using address for client connections
   * ```javascript
   * server.listen(8080, () => {
   *   const addr = server.address();
   *   console.log(`Tell clients to connect to: ${addr.address}:${addr.port}`);
   *
   *   // Create a client to test the server
   *   const testClient = new net.Socket();
   *   testClient.connect(`${addr.address}:${addr.port}`, () => {
   *     console.log('Test client connected successfully');
   *   });
   * });
   * ```
   */
  address(): AddressInfo | null {
    return this.addressInfo;
  }

  /**
   * Stops the server from accepting new connections and closes the listening socket.
   *
   * This method gracefully shuts down the server by stopping it from accepting
   * new connections. Existing client connections are not automatically closed
   * and will remain active until they are explicitly closed or disconnected.
   *
   * @example Graceful server shutdown
   * ```javascript
   * // Stop accepting new connections
   * server.close();
   * console.log('Server stopped accepting new connections');
   * ```
   *
   * @example Shutdown with cleanup
   * ```javascript
   * const activeConnections = new Set();
   *
   * const server = net.createServer((socket) => {
   *   activeConnections.add(socket);
   *   socket.on('close', () => activeConnections.delete(socket));
   * });
   *
   * // Graceful shutdown process
   * function shutdown() {
   *   console.log('Shutting down server...');
   *   server.close();
   *
   *   // Close all active connections
   *   for (const socket of activeConnections) {
   *     socket.end();
   *   }
   *
   *   console.log(`Closed ${activeConnections.size} active connections`);
   * }
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
 * Primary networking interface that provides TCP capabilities over WebSocket transport.
 *
 * The Net class serves as the main entry point for all TCP networking operations in the browser.
 * It manages the WebSocket connection to the bridge server and handles multiplexing of multiple
 * TCP connections through a single WebSocket using a custom binary protocol.
 *
 * This class provides a Node.js-compatible API, making it easy to port existing Node.js
 * networking code to run in the browser environment.
 *
 * @example Complete application setup
 * ```javascript
 * // Initialize WebSocket connection to bridge server
 * const ws = new WebSocket('ws://localhost:8080');
 * const net = new Net(ws);
 *
 * ws.onopen = () => {
 *   console.log('Connected to bridge server');
 *
 *   // Create multiple TCP connections
 *   createRedisClient();
 *   createWebServer();
 *   createTcpClient();
 * };
 *
 * ws.onerror = (error) => {
 *   console.error('WebSocket error:', error);
 * };
 *
 * ws.onclose = () => {
 *   console.log('Disconnected from bridge server');
 * };
 *
 * function createRedisClient() {
 *   const redis = new net.Socket();
 *   redis.connect('redis.example.com:6379', () => {
 *     console.log('Connected to Redis');
 *     redis.write('PING\r\n');
 *
 *     redis.readable.getReader().read().then(({ value }) => {
 *       console.log('Redis response:', new TextDecoder().decode(value));
 *     });
 *   });
 * }
 *
 * function createWebServer() {
 *   const server = net.createServer((clientSocket) => {
 *     const response = 'HTTP/1.1 200 OK\r\n\r\nHello from browser!';
 *     clientSocket.write(response);
 *     clientSocket.end();
 *   });
 *
 *   server.listen(8080, () => {
 *     console.log('Web server listening on port 8080');
 *   });
 * }
 *
 * function createTcpClient() {
 *   const client = new net.Socket();
 *   client.connect('api.example.com:443', () => {
 *     client.write('GET /status HTTP/1.1\r\nHost: api.example.com\r\n\r\n');
 *   });
 * }
 * ```
 *
 * @example Error handling and reconnection
 * ```javascript
 * class NetworkManager {
 *   constructor() {
 *     this.reconnectAttempts = 0;
 *     this.maxReconnectAttempts = 5;
 *     this.connect();
 *   }
 *
 *   connect() {
 *     const ws = new WebSocket('ws://localhost:8080');
 *     this.net = new Net(ws);
 *
 *     ws.onopen = () => {
 *       console.log('Network bridge connected');
 *       this.reconnectAttempts = 0;
 *       this.initializeServices();
 *     };
 *
 *     ws.onclose = () => {
 *       if (this.reconnectAttempts < this.maxReconnectAttempts) {
 *         console.log(`Reconnecting... (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`);
 *         setTimeout(() => {
 *           this.reconnectAttempts++;
 *           this.connect();
 *         }, 1000 * Math.pow(2, this.reconnectAttempts));
 *       }
 *     };
 *   }
 *
 *   initializeServices() {
 *     // Initialize your network services here
 *   }
 * }
 * ```
 */
export class Net {
  private ws: WebSocket;
  /** Map of active socket connections indexed by stream ID */
  public readonly sockets: Map<number, Socket> = new Map();
  /** Map of active server listeners indexed by stream ID */
  public readonly servers: Map<number, NetListener> = new Map();
  /** Next available stream ID for new connections (odd numbers for client-initiated) */
  private nextStreamId: number = 1;
  /** Frame parser for processing incoming WebSocket binary data */
  private frameParser: FrameParser = new FrameParser();
  /** Socket constructor bound to this Net instance */
  public readonly Socket: new () => Socket;

  /**
   * Creates a new Net instance for TCP networking over WebSocket transport.
   *
   * The WebSocket connection should be established to a compatible bridge server
   * that implements the binary wire protocol. This connection will carry all
   * TCP traffic for sockets and servers created through this Net instance.
   *
   * @param ws - WebSocket connection to the bridge server (should be open or opening)
   *
   * @example Basic initialization
   * ```javascript
   * const ws = new WebSocket('ws://bridge.example.com:8080');
   * const net = new Net(ws);
   *
   * ws.onopen = () => {
   *   console.log('Bridge connection established');
   *   // Safe to create sockets and servers now
   * };
   * ```
   *
   * @example With connection management
   * ```javascript
   * function createNetworkInterface(bridgeUrl) {
   *   return new Promise((resolve, reject) => {
   *     const ws = new WebSocket(bridgeUrl);
   *     const net = new Net(ws);
   *
   *     const timeout = setTimeout(() => {
   *       reject(new Error('Bridge connection timeout'));
   *     }, 5000);
   *
   *     ws.onopen = () => {
   *       clearTimeout(timeout);
   *       console.log('Network interface ready');
   *       resolve(net);
   *     };
   *
   *     ws.onerror = (error) => {
   *       clearTimeout(timeout);
   *       reject(new Error(`Bridge connection failed: ${error.message}`));
   *     };
   *   });
   * }
   *
   * // Usage
   * createNetworkInterface('ws://localhost:8080')
   *   .then(net => {
   *     // Use net for TCP operations
   *   })
   *   .catch(console.error);
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
   * Creates a new TCP server for accepting incoming client connections.
   *
   * The server operates through the WebSocket bridge, allowing the browser to act
   * as a TCP server that can accept connections from external clients. Each incoming
   * connection will trigger the connectionListener callback with a new Socket instance.
   *
   * @param connectionListener - Callback function invoked for each new client connection
   * @returns NetListener instance ready to be bound to a port or Unix socket
   *
   * @example Simple HTTP server
   * ```javascript
   * const httpServer = net.createServer((clientSocket) => {
   *   console.log(`HTTP client connected: ${clientSocket.remoteAddress}`);
   *
   *   // Read the HTTP request
   *   clientSocket.readable.getReader().read().then(({ value }) => {
   *     const request = new TextDecoder().decode(value);
   *     console.log('Request:', request.split('\r\n')[0]); // Log first line
   *
   *     // Send HTTP response
   *     const response = [
   *       'HTTP/1.1 200 OK',
   *       'Content-Type: application/json',
   *       'Content-Length: 27',
   *       '',
   *       '{"message":"Hello, World!"}'
   *     ].join('\r\n');
   *
   *     clientSocket.write(response);
   *     clientSocket.end();
   *   });
   * });
   *
   * httpServer.listen(8080, () => {
   *   console.log('HTTP server listening on port 8080');
   * });
   * ```
   *
   * @example WebSocket-like protocol server
   * ```javascript
   * const protocolServer = net.createServer((clientSocket) => {
   *   console.log('Protocol client connected');
   *
   *   // Send welcome message
   *   clientSocket.write(JSON.stringify({
   *     type: 'welcome',
   *     timestamp: Date.now()
   *   }) + '\n');
   *
   *   // Handle incoming messages
   *   const reader = clientSocket.readable.getReader();
   *
   *   function readMessage() {
   *     reader.read().then(({ value, done }) => {
   *       if (done) {
   *         console.log('Client disconnected');
   *         return;
   *       }
   *
   *       try {
   *         const message = JSON.parse(new TextDecoder().decode(value));
   *         console.log('Received:', message);
   *
   *         // Echo back with timestamp
   *         const response = {
   *           type: 'echo',
   *           original: message,
   *           timestamp: Date.now()
   *         };
   *
   *         clientSocket.write(JSON.stringify(response) + '\n');
   *       } catch (error) {
   *         console.error('Invalid JSON received:', error);
   *       }
   *
   *       readMessage(); // Continue reading
   *     });
   *   }
   *
   *   readMessage();
   * });
   * ```
   *
   * @example Multi-protocol server
   * ```javascript
   * const multiServer = net.createServer((clientSocket) => {
   *   let protocol = 'unknown';
   *
   *   // Detect protocol from first message
   *   clientSocket.readable.getReader().read().then(({ value }) => {
   *     const firstData = new TextDecoder().decode(value);
   *
   *     if (firstData.startsWith('GET ') || firstData.startsWith('POST ')) {
   *       protocol = 'http';
   *       handleHttpRequest(clientSocket, firstData);
   *     } else if (firstData.startsWith('{')) {
   *       protocol = 'json';
   *       handleJsonProtocol(clientSocket, firstData);
   *     } else {
   *       protocol = 'raw';
   *       handleRawData(clientSocket, firstData);
   *     }
   *
   *     console.log(`Client using ${protocol} protocol`);
   *   });
   * });
   * ```
   */
  createServer(connectionListener: (socket: Socket) => void): NetListener {
    return new NetListener(this, connectionListener);
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
          // Incoming connection from server - payload is 3-byte listen stream ID + 3-byte window size + 2-byte port + variable length host
          if (payload.length >= 8) {
            const listenStreamId =
              (payload[0] << 16) | (payload[1] << 8) | payload[2];

            const windowSize =
              (payload[3] << 16) | (payload[4] << 8) | payload[5];

            const remotePort = (payload[6] << 8) | payload[7];

            const remoteAddress =
              payload.length > 8
                ? new TextDecoder().decode(payload.slice(8))
                : "";

            const targetServer = this.servers.get(listenStreamId);
            if (targetServer) {
              const initialWindowSize = 65536;
              socket = new Socket(
                this,
                streamId,
                initialWindowSize,
                windowSize
              );
              // Set remote address and port
              socket.remoteAddress = remoteAddress;
              socket.remotePort = remotePort;
              this.sockets.set(streamId, socket);
              // Send ACK to acknowledge the connection
              const payload = new Uint8Array(3);
              payload[0] = (initialWindowSize >> 16) & 0xff;
              payload[1] = (initialWindowSize >> 8) & 0xff;
              payload[2] = initialWindowSize & 0xff;
              this.sendFrame(FLAGS.ACK, streamId, payload);
              targetServer.connectionListener(socket);
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
            try {
              const addressInfo = JSON.parse(new TextDecoder().decode(payload));
              server.handleListenAck(addressInfo);
            } catch (error) {
              this.sockets.delete(streamId);
              this.sendFrame(
                FLAGS.RST,
                streamId,
                new TextEncoder().encode(
                  error instanceof Error ? error.message : String(error)
                )
              );
              // TODO: server.onError
            }
            break;
          }
          // ACK for regular connection
          socket = this.sockets.get(streamId);
          if (!socket) {
            this.sendFrame(
              FLAGS.RST,
              streamId,
              new TextEncoder().encode("Invalid stream id")
            );
            break;
          }
          // Parse address info if present in payload
          try {
            const windowSize =
              (payload[0] << 16) | (payload[1] << 8) | payload[2];
            const addressInfo = JSON.parse(
              new TextDecoder().decode(payload.slice(3))
            );
            socket.incrementWriteWindow(windowSize);
            socket.addressInfo = addressInfo;
            if (addressInfo.remoteAddress)
              socket.remoteAddress = addressInfo.remoteAddress;
            if (addressInfo.remotePort)
              socket.remotePort = addressInfo.remotePort;

            socket.connectCallback?.(socket);
            socket.connectCallback = undefined;
          } catch (error) {
            this.sockets.delete(streamId);
            const err = error instanceof Error ? error.message : String(error);
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
            break;
          }
          break;
        case FLAGS.DATA:
          // Data received
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
            this.sockets.delete(streamId);
            const err = "Data after end";
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
            break;
          }
          if (socket.readableSource.remoteWindowSize < payload.length) {
            this.sockets.delete(streamId);
            const err = "Data exceeding allowed window size";
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
            break;
          }
          socket.readableSource.onData(payload);
          break;

        case FLAGS.FIN:
          // Connection ended
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
          // Connection reset/error - RST can have optional data payload
          socket = this.sockets.get(streamId);
          if (!socket) break;
          if (socket.ended && socket.remoteEnded) break;
          socket.ended = true;
          socket.remoteEnded = true;
          this.sockets.delete(streamId);
          const err =
            payload.length > 0
              ? new TextDecoder().decode(payload)
              : "Connection reset";
          socket.onError(err);
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
            this.sockets.delete(streamId);
            const err = error instanceof Error ? error.message : String(error);
            this.sendFrame(FLAGS.RST, streamId, new TextEncoder().encode(err));
            socket.onError(err);
          }
          break;
      }
    }
  }

  private handleClose(): void {
    for (const socket of this.sockets.values()) {
      if (socket.ended && socket.remoteEnded) continue;
      socket.ended = true;
      socket.remoteEnded = true;
      socket.onError("Connection reset");
    }
    this.sockets.clear();
    this.servers.clear();
  }

  /**
   * Internal method to send binary protocol frames over WebSocket.
   * @internal
   */
  sendFrame(flag: number, streamId: number, payload?: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const frame = encodeFrame(flag, streamId, payload || new Uint8Array(0));
      this.ws.send(frame);
    }
  }

  /**
   * Internal method to generate unique stream IDs for client connections.
   * @internal
   */
  getNextStreamId(): number {
    const id = this.nextStreamId;
    this.nextStreamId += 2; // Skip by 2 to maintain odd numbers
    return id;
  }
}
