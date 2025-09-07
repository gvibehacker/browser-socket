// Client-side WebSocket transport with binary wire protocol

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
  payload: Uint8Array | string = new Uint8Array(0)
): Uint8Array {
  if (typeof payload === "string") {
    payload = new TextEncoder().encode(payload);
  }

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
  private buffer: Uint8Array;
  private frames: Frame[];

  constructor() {
    this.buffer = new Uint8Array(0);
    this.frames = [];
  }

  addData(data: Uint8Array | ArrayBuffer): Frame[] {
    // Ensure data is Uint8Array
    if (data instanceof ArrayBuffer) {
      data = new Uint8Array(data);
    }

    // Concatenate buffers
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer, 0);
    newBuffer.set(data, this.buffer.length);
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

export class Socket {
  public net: Net;
  public streamId: number;
  public connected: boolean;
  public ended: boolean;
  public remoteAddress: string | null;
  public remotePort: number | null;
  public addressInfo: AddressInfo | null;
  private listeners: Record<string, EventListener[]>;

  constructor(net: Net, streamId?: number) {
    this.net = net;
    this.streamId = streamId || net.getNextStreamId();
    this.connected = false;
    this.ended = false;
    this.remoteAddress = null;
    this.remotePort = null;
    this.addressInfo = null;
    this.listeners = {
      data: [],
      end: [],
      error: [],
      connect: [],
    };
  }

  address(): { address: string; port: number; family: string } | null {
    if (!this.addressInfo) return null;
    // Return only address, port, family (not remoteAddress/remotePort)
    const { address, port, family } = this.addressInfo;
    return { address, port, family };
  }

  connect(port: number | string, host?: string, callback?: () => void): this {
    this.net.connections.set(this.streamId, this);

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

  write(data: string | Uint8Array): this {
    if (!this.ended) {
      // Convert string to Uint8Array if needed
      const payload =
        typeof data === "string" ? new TextEncoder().encode(data) : data;
      this.net.sendFrame(FLAGS.DATA, this.streamId, payload);
    }
    return this;
  }

  end(data?: string | Uint8Array): this {
    if (!this.ended) {
      this.ended = true;
      // FIN can have optional data payload
      if (data) {
        const payload =
          typeof data === "string" ? new TextEncoder().encode(data) : data;
        this.net.sendFrame(FLAGS.FIN, this.streamId, payload);
      } else {
        this.net.sendFrame(FLAGS.FIN, this.streamId);
      }
    }

    return this;
  }

  destroy(error?: Error): void {
    if (!this.ended) {
      this.ended = true;
      // Send RST frame with optional error message payload
      const payload = error
        ? new TextEncoder().encode(error.toString())
        : new Uint8Array(0);
      this.net.sendFrame(FLAGS.RST, this.streamId, payload);
      this.net.connections.delete(this.streamId);
    }
  }

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

  handleConnected(): void {
    this.connected = true;
    this.emit("connect");
  }

  handleData(data: Uint8Array): void {
    this.emit("data", data);
  }

  handleEnd(): void {
    this.ended = true;
    this.emit("end");
  }

  handleError(error: string): void {
    this.emit("error", error);
  }
}

export class NetServer {
  private net: Net;
  private connectionListener: ((socket: Socket) => void) | null;
  private port: number | string | null;
  private listening: boolean;
  private listenStreamId: number | null;
  private addressInfo: AddressInfo | null;
  private listenCallback: (() => void) | null;

  constructor(net: Net, connectionListener?: (socket: Socket) => void) {
    this.net = net;
    this.connectionListener = connectionListener || null;
    this.port = null;
    this.listening = false;
    this.listenStreamId = null;
    this.addressInfo = null;
    this.listenCallback = null;
  }

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

  address(): AddressInfo | null {
    return this.addressInfo;
  }

  handleConnection(socket: Socket): void {
    if (this.connectionListener) {
      this.connectionListener(socket);
    }
  }

  close(callback?: () => void): void {
    if (this.listening && this.listenStreamId !== null) {
      this.net.servers.delete(this.listenStreamId);
      this.listening = false;

      // Send RST frame to close server
      const payload = new TextEncoder().encode(
        JSON.stringify({ closeServer: true, port: this.port })
      );
      this.net.sendFrame(FLAGS.RST, this.listenStreamId, payload);
    }

    if (callback) {
      callback();
    }
  }
}

export class Net {
  private ws: WebSocket;
  public connections: Map<number, Socket>;
  public servers: Map<number, NetServer>;
  private nextStreamId: number;
  private frameParser: FrameParser;
  public Socket: new () => Socket;

  constructor(ws: WebSocket) {
    this.ws = ws;
    this.connections = new Map();
    this.servers = new Map();
    this.nextStreamId = 1; // Client uses odd IDs (1, 3, 5...) for outgoing connections
    this.frameParser = new FrameParser();

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
              this.connections.set(streamId, socket);
              // Send ACK to acknowledge the connection
              this.sendFrame(FLAGS.ACK, streamId);
              targetServer.handleConnection(socket);
            } else {
              // Server not found, send RST to reject the connection
              const errorMsg = new TextEncoder().encode(
                "No server listening on this stream"
              );
              this.sendFrame(FLAGS.RST, streamId, errorMsg);
            }
          } else {
            console.error(
              "Invalid SYN payload from server, expected at least 5 bytes"
            );
            // Send RST for invalid payload
            const errorMsg = new TextEncoder().encode(
              "Invalid SYN payload format"
            );
            this.sendFrame(FLAGS.RST, streamId, errorMsg);
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
                console.error("Failed to parse server address info:", error);
              }
            }
          } else {
            // ACK for regular connection
            socket = this.connections.get(streamId);
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
                  console.error("Failed to parse socket address info:", error);
                }
              }
              socket.handleConnected();
            }
          }
          break;

        case FLAGS.DATA:
          // Data received
          socket = this.connections.get(streamId);
          if (socket) {
            socket.handleData(payload);
          }
          break;

        case FLAGS.FIN:
          // Connection ended - FIN can have optional data payload
          socket = this.connections.get(streamId);
          if (socket) {
            if (payload.length > 0) {
              // Process any final data before ending
              socket.handleData(payload);
            }
            socket.handleEnd();
            this.connections.delete(streamId);
          }
          break;

        case FLAGS.RST:
          // Connection reset/error - RST can have optional data payload
          socket = this.connections.get(streamId);
          if (socket) {
            const errorMsg =
              payload.length > 0
                ? new TextDecoder().decode(payload)
                : "Connection reset";
            socket.handleError(errorMsg);
            this.connections.delete(streamId);
          }
          break;
      }
    }
  }

  private handleClose(): void {
    for (const socket of this.connections.values()) {
      socket.handleEnd();
    }
    this.connections.clear();
    this.servers.clear();
  }

  sendFrame(
    flag: number,
    streamId: number,
    payload?: Uint8Array | string
  ): void {
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
