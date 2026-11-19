// The network filter of a containerized run. It runs in its own container, on the internal network of the run and on
// the outside network. The agent container is on the internal network only, so this proxy is its only way out.
// It accepts HTTP CONNECT to port 443 of a listed host, and refuses everything else. It reads no TLS: it filters on the
// host name that the client asks for.
// Each decision goes to stdout as one JSON line. The runner saves these lines to network.log.
// Usage (in the container): EVAL_PROXY_ALLOW=api.openai.com,*.example.com node proxy.ts [port]
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { connect, isIP } from 'node:net';

export const PROXY_PORT = 3128;

// An entry is a host name, or `*.` and a domain for any host under that domain (not the domain itself).
// `ports` exists for the tests, which cannot listen on 443.
export function isAllowed(target: string, allow: readonly string[], ports: readonly number[] = [443]): boolean {
	const match = /^([^:\s]+):(\d+)$/.exec(target);
	if (!match || !ports.includes(Number(match[2]))) return false;
	const host = match[1].toLowerCase().replace(/\.$/, '');
	// An IP address names no host, so no entry can allow it.
	if (isIP(host) || host.startsWith('[')) return false;
	return allow.some((entry) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry));
}

export function startProxy(allow: readonly string[], { port = PROXY_PORT, ports = [443], log = (line: object) => console.log(JSON.stringify(line)) }: { port?: number; ports?: number[]; log?: (line: object) => void } = {}) {
	const server = createServer((request, response) => {
		// Plain HTTP: never forwarded.
		log({ verdict: 'deny', method: request.method, target: request.headers.host ?? '', reason: 'plain HTTP' });
		response.writeHead(403).end();
	});
	// A CONNECT tunnel stays open as long as the agent streams: no timeout on it.
	server.requestTimeout = 0;
	server.on('connect', (request, client: Socket, head: Buffer) => {
		const target = request.url ?? '';
		client.on('error', () => {});
		if (!isAllowed(target, allow, ports)) {
			log({ verdict: 'deny', method: 'CONNECT', target });
			client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
			return;
		}
		const [host, port] = [target.slice(0, target.lastIndexOf(':')), Number(target.slice(target.lastIndexOf(':') + 1))];
		let open = false;
		const upstream = connect(port, host, () => {
			open = true;
			log({ verdict: 'allow', method: 'CONNECT', target });
			client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
			if (head.length) upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on('error', (error) => {
			log({ verdict: 'error', method: 'CONNECT', target, reason: error.message });
			// Once the tunnel is open, the client reads TLS: a status line would only corrupt it.
			if (open) client.destroy();
			else if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
		});
		client.on('close', () => upstream.destroy());
		upstream.on('close', () => client.destroy());
	});
	server.listen(port, () => log({ listening: (server.address() as { port: number }).port, allow }));
	return server;
}

if (import.meta.main) {
	const allow = (process.env.EVAL_PROXY_ALLOW ?? '').split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
	startProxy(allow, { port: Number(process.argv[2] ?? PROXY_PORT) });
}
