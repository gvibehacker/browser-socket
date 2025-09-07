import net from "net";
import { WebSocketServer } from "ws";
import { Transport } from "@gvibehacker/browser-socket-server";

const PORT = 8080;

const wss = new WebSocketServer({ port: PORT });

const transport = new Transport(wss);

transport.on("connection", (conn) => {
  console.log("New WebSocket connection established");

  conn.on("connect", (socket, addressInfo) => {
    console.log(`Connect request to ${addressInfo.host}:${addressInfo.port}`);

    // Create TCP connection to the requested address
    const tcpSocket = new net.Socket();

    tcpSocket.connect(addressInfo.port, addressInfo.host, () => {
      console.log(
        `TCP connection established to ${addressInfo.host}:${addressInfo.port}`
      );

      // Send ACK with connection info
      const ackPayload = {
        ...tcpSocket.address(),
        remoteAddress: tcpSocket.remoteAddress,
        remotePort: tcpSocket.remotePort,
      };
      socket.ack(Buffer.from(JSON.stringify(ackPayload)));
    });

    tcpSocket.on("readable", () => {
      let chunk;
      while ((chunk = tcpSocket.read()) !== null) {
        socket.write(chunk);
      }
    });

    tcpSocket.on("end", () => {
      socket.end();
    });

    tcpSocket.on("error", (error) => {
      console.error(`TCP socket error: ${error.message}`);
      socket.destroy(Buffer.from(error.message));
    });

    // Handle data from WebSocket to TCP
    socket.on("data", (data) => {
      tcpSocket.write(data);
    });

    socket.on("end", () => {
      tcpSocket.end();
    });

    socket.on("error", (error) => {
      console.error(`WebSocket stream error: ${error.message}`);
      tcpSocket.destroy();
    });
  });

  conn.on("listen", (socket, addressInfo) => {
    console.log(`Listen request on ${addressInfo.host}:${addressInfo.port}`);

    const server = net.createServer((tcpSocket) => {
      console.log(
        `Incoming connection - remoteAddress: "${tcpSocket.remoteAddress}", remotePort: ${tcpSocket.remotePort}`
      );

      // Create new WebSocket stream for this connection
      const newSocket = socket.connect(
        tcpSocket.remoteAddress,
        tcpSocket.remotePort
      );

      tcpSocket.on("readable", () => {
        let chunk;
        while ((chunk = tcpSocket.read()) !== null) {
          newSocket.write(chunk);
        }
      });

      tcpSocket.on("end", () => {
        newSocket.end();
      });

      tcpSocket.on("error", (error) => {
        console.error(`TCP socket error: ${error.message}`);
        newSocket.destroy(Buffer.from(error.message));
      });

      newSocket.on("data", (data) => {
        tcpSocket.write(data);
      });

      newSocket.on("end", () => {
        tcpSocket.end();
      });

      newSocket.on("error", (error) => {
        console.error(`WebSocket stream error: ${error.message}`);
        tcpSocket.destroy();
      });
    });

    server.on("error", (error) => {
      console.error(`Server listen error:`, error.message);
      socket.destroy(Buffer.from(error.message));
    });

    // Listen on port 0 (let Node.js allocate ephemeral port)
    server.listen(0, addressInfo.host, () => {
      const addr = server.address();
      const allocatedPort = addr.port;

      console.log(`Server listening on ${addr.address}:${allocatedPort}`);
      socket.ack(Buffer.from(JSON.stringify(addr)));
    });
  });

  conn.on("error", (error) => {
    console.error("Connection error:", error);
  });

  conn.on("end", () => {
    console.log("WebSocket connection closed");
  });
});

transport.start();

console.log(`WebSocket server running on ws://localhost:${PORT}`);
