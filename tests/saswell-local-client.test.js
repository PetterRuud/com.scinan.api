'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const { test } = require('node:test');
const { setTimeout: delay, setImmediate: nextTurn } = require('node:timers/promises');
const { SaswellLocalClient, probeThermostat } = require('../lib/SaswellLocalClient');

const HOST = '127.0.0.1';
const ID = '1038ABCD1234EFGH';
const OTHER_ID = '1038ABCDEFGH1234';
const HELLO = `/${ID}/type/1/9\n`;
const STATUS = `/${ID}/S00/1/1,21.5,22.0,0,0,0,0,0,0,05,35\r\n`;

async function serve(t, onConnection) {
	const sockets = new Set();
	const server = net.createServer(socket => {
		sockets.add(socket);
		socket.on('error', () => {});
		socket.once('close', () => sockets.delete(socket));
		onConnection(socket);
	});
	server.listen(0, HOST);
	await once(server, 'listening');
	t.after(() => {
		for (const socket of sockets) socket.destroy();
		return new Promise(resolve => server.close(resolve));
	});
	return server.address().port;
}

function listenForCommands(socket, onCommand) {
	let partial = '';
	socket.on('data', chunk => {
		const lines = (partial + chunk.toString('ascii')).split('\r\n');
		partial = lines.pop();
		for (const line of lines) onCommand(line);
	});
}

function createClient(t, port, options = {}) {
	const client = new SaswellLocalClient({ host: HOST, deviceId: ID, port, ...options });
	t.after(() => client.stop());
	return client;
}

test('passive probe matches a fragmented hello and sends no bytes', async t => {
	let bytes = 0;
	let peerClosed;
	const closed = new Promise(resolve => { peerClosed = resolve; });
	const port = await serve(t, socket => {
		socket.on('data', chunk => { bytes += chunk.length; });
		socket.once('close', peerClosed);
		socket.write(HELLO.slice(0, 12));
		setTimeout(() => socket.write(HELLO.slice(12) + STATUS), 10);
	});
	assert.deepEqual(await probeThermostat({ host: HOST, port, deviceId: ID }), {
		host: HOST, deviceId: ID, deviceType: '9',
	});
	await closed;
	assert.equal(bytes, 0);
});

test('passive probe rejects unrelated services, incorrect identity, and incomplete frames', async t => {
	for (const [name, reply] of [
		['banner', 'hello\n'],
		['wrong sensor', `/${ID}/type/0/9\n`],
		['unsupported type', `/${ID}/type/1/3\n`],
		['wrong ID', `/${OTHER_ID}/type/1/9\n`],
		['wrong ID case', `/${ID.toLowerCase()}/type/1/9\n`],
		['status first', STATUS],
		['overlong', 'X'.repeat(513)],
		['incomplete hello', HELLO.slice(0, -1)],
		['no greeting', ''],
	]) {
		await t.test(name, async subtest => {
			const port = await serve(subtest, socket => socket.write(reply));
			assert.equal(await probeThermostat({ host: HOST, port, deviceId: ID, timeoutMs: 75 }), null);
		});
	}
});

test('passive probe can be cancelled while waiting for the greeting', async t => {
	let connected;
	const accepted = new Promise(resolve => { connected = resolve; });
	const port = await serve(t, connected);
	const controller = new AbortController();
	const result = probeThermostat({ host: HOST, port, signal: controller.signal });
	await accepted;
	controller.abort();
	assert.equal(await result, null);
});

test('session waits for matching hello and parses only valid, complete status frames', async t => {
	let connected;
	let connections = 0;
	const accepted = new Promise(resolve => { connected = resolve; });
	const port = await serve(t, socket => {
		connections += 1;
		connected(socket);
	});
	const client = createClient(t, port);
	const statuses = [];
	client.on('status', status => statuses.push(status));
	client.start();
	client.start();
	const peer = await accepted;
	assert.equal(client.isReady(), false);
	peer.write(HELLO.replace('\n', '\r\n'));
	await delay(10);
	assert.equal(client.isReady(), false);
	assert.equal(await client.sendCommand('away', '1'), 'unavailable');
	peer.write(STATUS.slice(0, -1));
	await delay(10);
	assert.equal(statuses.length, 0);
	const secondStatus = new Promise(resolve => client.on('status', () => {
		if (statuses.length === 2) resolve();
	}));
	peer.write('\n'
		+ STATUS.replace(ID, OTHER_ID)
		+ STATUS.replace('21.5', '21.5garbage')
		+ STATUS.replace(',22.0,0,', ',22.0,1,')
		+ STATUS.replace('21.5', '21.5\u00a0')
		+ STATUS.replace('21.5', '23.0'));
	await secondStatus;
	assert.equal(connections, 1);
	assert.equal(client.isReady(), true);
	assert.deepEqual(statuses[0], {
		deviceType: '9', onoff: true, measure_temperature: 21.5, target_temperature: 22,
		away: false, mode: 0, min_temp: 5, max_temp: 35,
	});
	assert.equal(statuses[1].measure_temperature, 23);
	let disconnects = 0;
	client.on('disconnect', () => { disconnects += 1; });
	client.stop();
	peer.write(STATUS);
	await delay(10);
	assert.equal(client.isReady(), false);
	assert.equal(disconnects, 0);
	assert.equal(statuses.length, 2);
});

test('session rejects a different thermostat before sending protocol commands', async t => {
	let bytes = 0;
	const port = await serve(t, socket => {
		socket.on('data', chunk => { bytes += chunk.length; });
		socket.write(HELLO.replace(ID, OTHER_ID) + STATUS);
	});
	const client = createClient(t, port);
	const disconnected = once(client, 'disconnect');
	client.start();
	assert.deepEqual(await disconnected, [{ reason: 'wrong_device', identified: false }]);
	assert.equal(client.isReady(), false);
	assert.equal(bytes, 0);
});

test('requests fresh status on the same TCP connection when the thermostat stops pushing it', async t => {
	let connections = 0;
	let statusRequests = 0;
	const port = await serve(t, socket => {
		connections += 1;
		listenForCommands(socket, line => {
			if (line === `/${ID}/S00/1/-1`) {
				statusRequests += 1;
				if (statusRequests === 2) socket.write(STATUS);
			}
		});
		socket.write(HELLO + STATUS);
	});
	const client = createClient(t, port, { heartbeatMs: 30, statusTimeoutMs: 120 });
	const outcome = new Promise(resolve => {
		let statuses = 0;
		client.on('status', () => {
			if (++statuses === 2) resolve('refreshed');
		});
		client.once('disconnect', ({ reason }) => resolve(reason));
	});
	client.start();
	assert.equal(await outcome, 'refreshed');
	assert.equal(statusRequests, 2);
	assert.equal(connections, 1);
	assert.equal(client.isReady(), true);
});

test('heartbeat responses cannot keep a session alive after status stops', async t => {
	let heartbeats = 0;
	let statusRequests = 0;
	const port = await serve(t, socket => {
		listenForCommands(socket, line => {
			if (line === `/${ID}/SPOLL/1/1`) {
				heartbeats += 1;
				socket.write(`/${ID}/SPOLL/1/OK\r\n`);
			}
			if (line === `/${ID}/S00/1/-1`) statusRequests += 1;
		});
		socket.write(HELLO + STATUS);
	});
	const client = createClient(t, port, { heartbeatMs: 20, statusTimeoutMs: 120 });
	const ready = once(client, 'status');
	const disconnected = once(client, 'disconnect');
	client.start();
	await ready;
	assert.equal(client.isReady(), true);
	assert.deepEqual(await disconnected, [{ reason: 'status_timeout', identified: true }]);
	assert.equal(client.isReady(), false);
	assert.ok(heartbeats >= 1);
	assert.equal(statusRequests, 2);
});

test('commands are serial and confirmed by their expected status fields', async t => {
	const commands = [];
	const port = await serve(t, socket => {
		listenForCommands(socket, line => {
			commands.push(line);
			if (line === `/${ID}/S03/1/1`) {
				socket.write(STATUS + `/${ID}/S00/1/1,21.5,05.0,0,1,0,0,0,0,05,35\r\n`);
			}
			if (line === `/${ID}/S02/1/22.5`) {
				socket.write(`/${ID}/S00/1/1,21.5,22.5,0,0,0,0,0,0,05,35\r\n`);
			}
			if (line === `/${ID}/S12/1/2`) {
				socket.write(`/${ID}/S00/1/1,21.5,22.5,0,0,0,0,0,2,05,35\r\n`);
			}
		});
		socket.write(HELLO + STATUS);
	});
	const client = createClient(t, port);
	const ready = once(client, 'status');
	client.start();
	await ready;
	assert.deepEqual(await Promise.all([
		client.sendCommand('away', '1'),
		client.sendCommand('target_temperature', '22.4'),
		client.sendCommand('mode', '2'),
		client.sendCommand('onoff', '1'),
	]), ['confirmed', 'confirmed', 'confirmed', 'unsupported']);
	assert.deepEqual(commands, [`/${ID}/S00/1/-1`, `/${ID}/S03/1/1`, `/${ID}/S02/1/22.5`, `/${ID}/S12/1/2`]);
});

test('an uncertain write requests status without replaying the command', async t => {
	const commands = [];
	const port = await serve(t, socket => {
		listenForCommands(socket, line => {
			commands.push(line);
			if (line === `/${ID}/S00/1/-1`) socket.write(STATUS);
		});
		socket.write(HELLO + STATUS);
	});
	const client = createClient(t, port, { commandTimeoutMs: 25 });
	const awayPending = [];
	client.on('status', (_status, pending) => awayPending.push(pending === true));
	const ready = once(client, 'status');
	client.start();
	await ready;
	assert.equal(await client.sendCommand('away', '1'), 'unconfirmed');
	assert.deepEqual(commands, [`/${ID}/S00/1/-1`, `/${ID}/S03/1/1`, `/${ID}/S00/1/-1`]);
	assert.deepEqual(awayPending.slice(-2), [true, false]);
});

test('an away command remains pending until a delayed matching status arrives', { timeout: 2000 }, async t => {
	t.mock.timers.enable({ apis: ['setTimeout'] });
	const commands = [];
	let resolveAway;
	let resolveStatusRequest;
	const awayReceived = new Promise(resolve => { resolveAway = resolve; });
	const statusRequested = new Promise(resolve => { resolveStatusRequest = resolve; });
	const port = await serve(t, socket => {
		listenForCommands(socket, line => {
			commands.push(line);
			if (line === `/${ID}/S03/1/1`) resolveAway();
			if (line === `/${ID}/S00/1/-1` && commands.length > 1) resolveStatusRequest(socket);
		});
		socket.write(HELLO + STATUS);
	});
	const client = createClient(t, port);
	const ready = once(client, 'status');
	client.start();
	await ready;

	const completed = t.mock.fn();
	const command = client.sendCommand('away', '1');
	command.then(completed);
	await awayReceived;
	t.mock.timers.tick(1500);
	t.mock.timers.tick(1500);
	await nextTurn();
	assert.equal(completed.mock.callCount(), 0);
	t.mock.timers.tick(2000);
	const peer = await statusRequested;
	const pendingStatus = once(client, 'status');
	peer.write(STATUS);
	const [beforeAway, pending] = await pendingStatus;
	assert.equal(beforeAway.away, false);
	assert.equal(pending, true);
	t.mock.timers.tick(3000);
	peer.write(`/${ID}/S00/1/1,21.5,05.0,0,1,0,0,0,0,05,35\r\n`);

	assert.equal(await command, 'confirmed');
	assert.deepEqual(commands, [`/${ID}/S00/1/-1`, `/${ID}/S03/1/1`, `/${ID}/S00/1/-1`]);
});
