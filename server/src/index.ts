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

export interface SocketEvents {
  data: (data: Buffer) => void;
  end: () => void;
  error: (error: Error) => void;
  close: () => void;
  ack: (payload: Buffer) => void;
  connection: (socket: Socket) => void;
}

export interface ConnectionEvents {
  connect: (socket: Socket, addressInfo: AddressInfo) => void;
  listen: (socket: Socket, addressInfo: AddressInfo) => void;
  error: (error: Error) => void;
  end: () => void;
}

export interface TransportEvents {
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

export class Transport extends EventEmitter {
  private wss: WebSocket.Server;

  constructor(wss: WebSocket.Server) {
    super();
    this.wss = wss;
  }

  start(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      const conn = new Connection(ws);
      this.emit("connection", conn);
    });
  }
}

export class Connection extends EventEmitter {
  private ws: WebSocket;
  public sockets: Map<number, Socket> = new Map();
  private frameParser: FrameParser = new FrameParser();
  private nextStreamId: number = 2; // Server uses even IDs (2, 4, 6...) for incoming connections
  private closed: boolean = false;

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

  sendFrame(flag: Flag, streamId: number, payload?: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const frame = encodeFrame(flag, streamId, payload || Buffer.alloc(0));
      this.ws.send(frame);
    }
  }

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

export class Socket extends EventEmitter {
  private connection: Connection;
  private streamId: number;
  private destroyed: boolean = false;
  public remoteAddress: string | null = null;
  public remotePort: number | null = null;

  constructor(connection: Connection, streamId: number) {
    super();
    this.connection = connection;
    this.streamId = streamId;
  }

  ack(payload?: Buffer): void {
    if (this.destroyed) return;
    this.connection.sendFrame(
      FLAGS.ACK,
      this.streamId,
      payload || Buffer.alloc(0)
    );
  }

  write(data: Buffer | string): boolean {
    if (this.destroyed) return false;
    this.connection.sendFrame(FLAGS.DATA, this.streamId, Buffer.from(data));
    return true;
  }

  end(data?: Buffer | string): void {
    if (this.destroyed) return;

    if (data) {
      this.write(data);
    }

    this.connection.sendFrame(FLAGS.FIN, this.streamId);
    this.connection.sockets.delete(this.streamId);
    this.destroyed = true;
  }

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
