/**
 * @fileoverview Wire Protocol Implementation
 * 
 * This module implements the binary wire protocol used for communication
 * between browser clients and the Node.js server. The protocol uses an
 * 8-byte header followed by variable-length payload data.
 * 
 * Binary format: 8-byte header + payload
 * Header structure:
 * - Length: 24 bits (3 bytes) - payload size
 * - Flag: 8 bits (1 byte) - frame type  
 * - Stream ID: 32 bits (4 bytes) - unique stream identifier
 * 
 * @example
 * ```javascript
 * import { encodeFrame, FLAGS, FrameParser } from './protocol';
 * 
 * // Encode a SYN frame
 * const synFrame = encodeFrame(FLAGS.SYN, 1, new TextEncoder().encode('localhost:3000'));
 * 
 * // Parse incoming frames
 * const parser = new FrameParser();
 * const frames = parser.addData(incomingData);
 * ```
 */

/**
 * Protocol flags for frame types in the binary wire protocol
 * @readonly
 * @enum {number}
 */
export const FLAGS = {
  /** No flag set - data frame */
  DATA: 0, // 0x00
  /** Connection request */
  SYN: 1, // 0x01
  /** Connection acknowledgment */
  ACK: 2, // 0x02
  /** End of connection */
  FIN: 4, // 0x04
  /** Forcibly close connection */
  RST: 8, // 0x08
  /** Open a socket for listening */
  LISTEN: 16, // 0x10
} as const;

/**
 * Union type representing valid protocol flags
 */
export type Flag = typeof FLAGS[keyof typeof FLAGS];

/**
 * Size of the binary frame header in bytes
 * @constant
 */
export const HEADER_SIZE = 8;

/**
 * Represents a parsed frame header from the binary protocol
 */
export interface FrameHeader {
  /** Length of the payload in bytes */
  length: number;
  /** Protocol flag indicating frame type */
  flag: Flag;
  /** Unique stream identifier */
  streamId: number;
  /** Total size of the frame including header */
  totalFrameSize: number;
}

/**
 * Represents a complete frame from the binary protocol
 */
export interface Frame {
  /** Protocol flag indicating frame type */
  flag: Flag;
  /** Unique stream identifier */
  streamId: number;
  /** Frame payload data */
  payload: Uint8Array;
}

/**
 * Network address information for TCP and Unix socket connections
 */
export interface AddressInfo {
  /** Connection type - TCP or Unix socket */
  type: 'tcp' | 'unix';
  /** Hostname, IP address, or Unix socket path */
  host: string;
  /** Port number (required for TCP connections) */
  port?: number;
}

/**
 * Encodes a frame into the binary wire protocol format
 * @param flag - Protocol flag indicating frame type
 * @param streamId - Unique stream identifier
 * @param payload - Frame payload data (Uint8Array or string)
 * @returns Encoded frame as Uint8Array
 * @throws {Error} When payload exceeds 24-bit length limit
 * @example
 * ```javascript
 * // Encode a SYN frame
 * const synFrame = encodeFrame(FLAGS.SYN, 1, 'localhost:3000');
 * 
 * // Encode a data frame
 * const dataFrame = encodeFrame(FLAGS.DATA, 5, new TextEncoder().encode('Hello'));
 * 
 * // Encode an ACK frame with JSON payload
 * const ackFrame = encodeFrame(FLAGS.ACK, 3, JSON.stringify({address: '127.0.0.1', port: 8080}));
 * ```
 */
export function encodeFrame(flag: Flag, streamId: number, payload: Uint8Array | string = new Uint8Array(0)): Uint8Array {
  let payloadBuffer: Uint8Array;
  
  if (typeof payload === "string") {
    payloadBuffer = new TextEncoder().encode(payload);
  } else {
    payloadBuffer = payload;
  }

  const length = payloadBuffer.length;
  if (length > 0xffffff) {
    // 24-bit max value
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
  const view = new DataView(header.buffer);
  view.setUint32(4, streamId, false); // false = big-endian

  const result = new Uint8Array(header.length + payloadBuffer.length);
  result.set(header, 0);
  result.set(payloadBuffer, header.length);
  return result;
}

/**
 * Decodes a frame header from binary data
 * @param buffer - Uint8Array containing frame header data
 * @returns Decoded FrameHeader object, or null if insufficient data
 * @example
 * ```javascript
 * const header = decodeFrameHeader(incomingBuffer);
 * if (header) {
 *   console.log(`Frame: flag=${header.flag}, streamId=${header.streamId}, length=${header.length}`);
 * }
 * ```
 */
export function decodeFrameHeader(buffer: Uint8Array): FrameHeader | null {
  if (buffer.length < HEADER_SIZE) {
    return null;
  }

  // Read length (24 bits)
  const length = (buffer[0] << 16) | (buffer[1] << 8) | buffer[2];

  // Read flag (8 bits)
  const flag = buffer[3] as Flag;

  // Read stream ID (32 bits, big-endian)
  const view = new DataView(buffer.buffer, buffer.byteOffset);
  const streamId = view.getUint32(4, false); // false = big-endian

  return {
    length,
    flag,
    streamId,
    totalFrameSize: HEADER_SIZE + length,
  };
}

/**
 * Parser for handling streaming binary frame data
 * 
 * This class accumulates incoming binary data and parses complete frames
 * as they become available. It handles partial frames and frame boundaries
 * automatically.
 * 
 * @example
 * ```javascript
 * const parser = new FrameParser();
 * 
 * // Process incoming data chunks
 * const frames1 = parser.addData(chunk1);
 * const frames2 = parser.addData(chunk2);
 * 
 * // Handle complete frames
 * frames1.forEach(frame => {
 *   console.log(`Received frame: ${frame.flag}, stream ${frame.streamId}`);
 * });
 * ```
 */
export class FrameParser {
  private buffer: Uint8Array = new Uint8Array(0);
  private frames: Frame[] = [];

  /**
   * Adds new binary data to the parser and returns any complete frames
   * @param data - Incoming binary data
   * @returns Array of complete frames parsed from the data
   * @example
   * ```javascript
   * const newFrames = parser.addData(incomingData);
   * newFrames.forEach(frame => processFrame(frame));
   * ```
   */
  addData(data: Uint8Array): Frame[] {
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

/**
 * Parses SYN or LISTEN frame payload to extract address information
 * @param payload - Uint8Array containing address string
 * @returns Parsed AddressInfo object
 * @throws {Error} When payload format is invalid
 * @example
 * ```javascript
 * // Parse different address formats
 * const tcpAddr = parseSynPayload(new TextEncoder().encode('localhost:3000'));
 * // Returns: { type: 'tcp', host: 'localhost', port: 3000 }
 * 
 * const ipv6Addr = parseSynPayload(new TextEncoder().encode('[::1]:8080'));
 * // Returns: { type: 'tcp', host: '::1', port: 8080 }
 * 
 * const unixAddr = parseSynPayload(new TextEncoder().encode('unix:///tmp/my.sock'));
 * // Returns: { type: 'unix', host: '/tmp/my.sock' }
 * 
 * const listenAll = parseSynPayload(new TextEncoder().encode(':9000'));
 * // Returns: { type: 'tcp', host: '0.0.0.0', port: 9000 }
 * ```
 */
export function parseSynPayload(payload: Uint8Array): AddressInfo {
  const addressStr = new TextDecoder().decode(payload);

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

/**
 * Formats address information into SYN payload string format
 * @param type - Connection type ('tcp' or 'unix')
 * @param hostOrPath - Hostname/IP address for TCP, or path for Unix socket
 * @param port - Port number (required for TCP connections)
 * @returns Formatted address string
 * @throws {Error} When port is missing for TCP or type is invalid
 * @example
 * ```javascript
 * // Format TCP addresses
 * const tcpAddr = formatSynPayload('tcp', 'localhost', 3000);
 * // Returns: 'localhost:3000'
 * 
 * const ipv6Addr = formatSynPayload('tcp', '::1', 8080);
 * // Returns: '[::1]:8080'
 * 
 * // Format Unix socket
 * const unixAddr = formatSynPayload('unix', '/tmp/my.sock');
 * // Returns: 'unix:///tmp/my.sock'
 * ```
 */
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