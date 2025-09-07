// Wire Protocol Implementation
// Binary format: 8-byte header + payload
// Header structure:
// - Length: 24 bits (3 bytes) - payload size
// - Flag: 8 bits (1 byte) - frame type
// - Stream ID: 32 bits (4 bytes) - unique stream identifier

export const FLAGS = {
  DATA: 0, // 0x00 - no flag set
  SYN: 1, // 0x01 - connect
  ACK: 2, // 0x02 - connected
  FIN: 4, // 0x04 - end of connection
  RST: 8, // 0x08 - forcibly close connection
  LISTEN: 16, // 0x10 - open a socket for listening
} as const;

export type Flag = typeof FLAGS[keyof typeof FLAGS];

export const HEADER_SIZE = 8;

export interface FrameHeader {
  length: number;
  flag: Flag;
  streamId: number;
  totalFrameSize: number;
}

export interface Frame {
  flag: Flag;
  streamId: number;
  payload: Buffer;
}

export interface AddressInfo {
  type: 'tcp' | 'unix';
  host: string;
  port?: number;
}

export function encodeFrame(flag: Flag, streamId: number, payload: Buffer | string = Buffer.alloc(0)): Buffer {
  let payloadBuffer: Buffer;
  
  if (typeof payload === "string") {
    payloadBuffer = Buffer.from(payload, "utf8");
  } else {
    payloadBuffer = payload;
  }

  const length = payloadBuffer.length;
  if (length > 0xffffff) {
    // 24-bit max value
    throw new Error("Payload too large: exceeds 24-bit length limit");
  }

  const header = Buffer.allocUnsafe(HEADER_SIZE);

  // Write length (24 bits = 3 bytes)
  header[0] = (length >> 16) & 0xff;
  header[1] = (length >> 8) & 0xff;
  header[2] = length & 0xff;

  // Write flag (8 bits = 1 byte)
  header[3] = flag & 0xff;

  // Write stream ID (32 bits = 4 bytes, big-endian)
  header.writeUInt32BE(streamId, 4);

  return Buffer.concat([header, payloadBuffer]);
}

export function decodeFrameHeader(buffer: Buffer): FrameHeader | null {
  if (buffer.length < HEADER_SIZE) {
    return null;
  }

  // Read length (24 bits)
  const length = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];

  // Read flag (8 bits)
  const flag = buffer[3] as Flag;

  // Read stream ID (32 bits, big-endian)
  const streamId = buffer.readUInt32BE(4);

  return {
    length,
    flag,
    streamId,
    totalFrameSize: HEADER_SIZE + length,
  };
}

export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);
  private frames: Frame[] = [];

  addData(data: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, data]);
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

export function parseSynPayload(payload: Buffer): AddressInfo {
  const addressStr = payload.toString("utf8");

  // Unix socket format: unix://my.sock
  if (addressStr.startsWith("unix://")) {
    return {
      type: "unix",
      host: addressStr.substring(7),
    };
  }

  // IPv6 format: [::1]:1111
  const ipv6Match = addressStr.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6Match) {
    return {
      type: "tcp",
      host: ipv6Match[1],
      port: parseInt(ipv6Match[2], 10),
    };
  }

  // IPv4 format: 0.0.0.0:1111 or hostname:1111
  const ipv4Match = addressStr.match(/^([^:]+):(\d+)$/);
  if (ipv4Match) {
    return {
      type: "tcp",
      host: ipv4Match[1],
      port: parseInt(ipv4Match[2], 10),
    };
  }

  // Port only format: :1111 (listen on all interfaces)
  const portOnlyMatch = addressStr.match(/^:(\d+)$/);
  if (portOnlyMatch) {
    return {
      type: "tcp",
      host: "0.0.0.0",
      port: parseInt(portOnlyMatch[1], 10),
    };
  }

  throw new Error(`Invalid SYN payload format: ${addressStr}`);
}

export function formatSynPayload(type: 'tcp' | 'unix', hostOrPath: string, port?: number): string {
  if (type === "unix") {
    return `unix://${hostOrPath}`;
  } else if (type === "tcp") {
    if (port === undefined) {
      throw new Error("Port is required for TCP connections");
    }
    // Handle IPv6 addresses
    if (hostOrPath.includes(":") && !hostOrPath.startsWith("[")) {
      return `[${hostOrPath}]:${port}`;
    }
    // Handle IPv4 or hostname
    return `${hostOrPath}:${port}`;
  }
  throw new Error(`Invalid address type: ${type}`);
}