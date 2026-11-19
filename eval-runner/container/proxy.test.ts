import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createServer } from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import { after, test } from 'node:test';

import { isAllowed, startProxy } from './proxy.ts';

test('isAllowed: a listed host on port 443, or a host under a *. entry, and nothing else', () => {
	const allow = ['chatgpt.com', '*.openai.com'];
	assert.equal(isAllowed('chatgpt.com:443', allow), true);
	assert.equal(isAllowed('CHATGPT.com.:443', allow), true);
	assert.equal(isAllowed('api.openai.com:443', allow), true);
	// A *. entry covers the hosts under the domain, not the domain, and not a name that only ends the same way.
	assert.equal(isAllowed('openai.com:443', allow), false);
	assert.equal(isAllowed('evilopenai.com:443', allow), false);
	assert.equal(isAllowed('ab.chatgpt.com:443', allow), false);
	assert.equal(isAllowed('chatgpt.com.evil.net:443', allow), false);
	assert.equal(isAllowed('chatgpt.com:80', allow), false);
	assert.equal(isAllowed('chatgpt.com', allow), false);
	assert.equal(isAllowed('1.1.1.1:443', ['1.1.1.1']), false);
	assert.equal(isAllowed('[::1]:443', ['[::1]']), false);
	assert.equal(isAllowed('chatgpt.com:443', []), false);
});

// CONNECT through the proxy, and return the status code and the socket of the tunnel.
function tunnel(proxyPort: number, target: string): Promise<{ status: number; socket: Socket }> {
	return new Promise((resolve, reject) => {
		const req = request({ port: proxyPort, method: 'CONNECT', path: target });
		req.on('connect', (response, socket) => resolve({ status: response.statusCode ?? 0, socket }));
		req.on('response', (response) => resolve({ status: response.statusCode ?? 0, socket: response.socket }));
		req.on('error', reject);
		req.end();
	});
}

test('the proxy opens a tunnel to a listed host, refuses the others and plain HTTP, and logs each decision', async () => {
	const upstream = createServer((socket) => socket.end('hello from upstream'));
	upstream.listen(0, '127.0.0.1');
	await once(upstream, 'listening');
	after(() => upstream.close());
	const upstreamPort = (upstream.address() as AddressInfo).port;

	const lines: Record<string, unknown>[] = [];
	const proxy = startProxy(['localhost'], { port: 0, ports: [upstreamPort], log: (line) => lines.push(line as Record<string, unknown>) });
	await once(proxy, 'listening');
	after(() => proxy.close());
	const proxyPort = (proxy.address() as AddressInfo).port;

	const open = await tunnel(proxyPort, `localhost:${upstreamPort}`);
	assert.equal(open.status, 200);
	const chunks: Buffer[] = [];
	for await (const chunk of open.socket) chunks.push(chunk as Buffer);
	assert.equal(Buffer.concat(chunks).toString(), 'hello from upstream');

	const refused = await tunnel(proxyPort, 'example.com:443');
	assert.equal(refused.status, 403);
	refused.socket.destroy();

	const plain = await new Promise<number>((resolve, reject) => {
		const req = request({ port: proxyPort, path: 'http://example.com/', headers: { host: 'example.com' } }, (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		req.on('error', reject);
		req.end();
	});
	assert.equal(plain, 403);

	assert.deepEqual(lines[0], { listening: proxyPort, allow: ['localhost'] });
	assert.deepEqual(
		lines.slice(1).map((line) => [line.verdict, line.target]),
		[
			['allow', `localhost:${upstreamPort}`],
			['deny', 'example.com:443'],
			['deny', 'example.com']
		]
	);
});
