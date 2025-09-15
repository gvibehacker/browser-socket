/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { Connection } from '@gvibehacker/browser-socket-cloudflare-worker';
import { connect } from 'cloudflare:sockets';

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);

			server.accept();
			const conn = new Connection(server);
			conn.addEventListener('connect', (evt) => {
				const [socket, addressInfo] = (evt as CustomEvent).detail;
				const tcpSocket = connect({
					hostname: addressInfo.host,
					port: addressInfo.port,
				});

				socket.ack({
					remoteAddress: addressInfo.host,
					remotePort: addressInfo.port,
				});

				Promise.allSettled([
					// note: cloudflare worker doesn't support half close
					socket.readable.pipeTo(tcpSocket.writable).catch((e: Error) => {
						tcpSocket.close();
						socket.destroy(e);
					}),
					tcpSocket.readable.pipeTo(socket.writable).catch((e: Error) => {
						tcpSocket.close();
						socket.destroy(e);
					}),
				]);
			});
			// Return the client socket to the browser
			return new Response(null, {
				status: 101,
				webSocket: client,
			});
		}
		// If not a WebSocket request, send an error
		return new Response('WebSocket endpoint only', { status: 400 });
	},
} satisfies ExportedHandler<Env>;
