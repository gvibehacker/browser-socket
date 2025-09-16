import net from "net";
import { WebSocketServer } from "ws";
import { Transport } from "@gvibehacker/browser-socket-server";
import { error } from "console";

const PORT = 8080;

const wss = new WebSocketServer({ port: PORT, perMessageDeflate: false });

const transport = new Transport(wss);

transport.on("connection", (conn) => {
  console.log("New WebSocket connection established");

  conn.on("connect", (socket, addressInfo) => {
    console.log(`Connect request to ${addressInfo.host}:${addressInfo.port}`);

    // Create TCP connection to the requested address
    const tcpSocket = net.connect(addressInfo.port, addressInfo.host);

    tcpSocket.on("connect", () => {
      console.log(
        `TCP connection established to ${addressInfo.host}:${addressInfo.port}`
      );

      // Send ACK with connection info
      socket.ack({
        ...tcpSocket.address(),
        remoteAddress: tcpSocket.remoteAddress,
        remotePort: tcpSocket.remotePort,
      });

      const writer = socket.writable.getWriter();
      tcpSocket.on("readable", async () => {
        let chunk;
        try {
          while ((chunk = tcpSocket.read()) !== null) {
            await writer.write(chunk);
          }
        } catch (err) {
          writer.abort(String(err.message || err));
        }
      });
      tcpSocket.on("end", () => writer.close());

      // Handle data from WebSocket to TCP using readable stream
      socket.readable
        .pipeTo(
          new WritableStream({
            write(chunk) {
              tcpSocket.write(Buffer.from(chunk));
            },
            close() {
              tcpSocket.end();
            },
            abort() {
              tcpSocket.destroy();
            },
          })
        )
        .catch((e) => {
          socket.destroy(Buffer.from(e.message));
        });
    });

    tcpSocket.on("error", (error) => {
      console.error(`TCP socket error: ${error.message}`);
      socket.destroy(Buffer.from(error.message));
    });
  });

  conn.on("listen", (socket, addressInfo) => {
    console.log(`Listen request on ${addressInfo.host}:${addressInfo.port}`);

    const server = net.createServer((tcpSocket) => {
      console.log(
        `Incoming connection - remoteAddress: "${tcpSocket.remoteAddress}", remotePort: ${tcpSocket.remotePort}`
      );
      // Create new WebSocket stream for this connection
      socket.connect(
        tcpSocket.remoteAddress,
        tcpSocket.remotePort,
        (newSocket) => {
          const writer = newSocket.writable.getWriter();
          tcpSocket.on("readable", async () => {
            let chunk;
            try {
              while ((chunk = tcpSocket.read()) !== null) {
                await writer.write(chunk);
              }
            } catch (err) {
              writer.abort(String(err.message || err));
            }
          });
          tcpSocket.on("end", () => writer.close());

          newSocket.readable
            .pipeTo(
              new WritableStream({
                write(chunk) {
                  tcpSocket.write(chunk);
                },
                close() {
                  tcpSocket.end();
                },
                abort() {
                  tcpSocket.destroy();
                },
              })
            )
            .catch((e) => {
              newSocket.destroy(String(e?.message || e));
            });
        }
      );

      tcpSocket.on("error", (error) => {
        console.error(`TCP socket error: ${error.message}`);
        newSocket.destroy(Buffer.from(error.message));
      });
    });

    server.on("error", (error) => {
      console.error(`Server listen error:`, error.message);
      socket.close();
    });

    server.listen(addressInfo.port, addressInfo.host, () => {
      const addr = server.address();
      const allocatedPort = addr.port;

      console.log(`Server listening on ${addr.address}:${allocatedPort}`);
      socket.ack(addr);
    });

    socket.on("close", () => server.close());
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
