'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const { SaswellLanDiscovery, isLocalAddress } = require('../lib/SaswellLanDiscovery');

const MAC_DEVICE_ID = '10382435CC000001';

class FakeClient extends EventEmitter {
	constructor({ host, deviceId }) {
		super();
		this.host = host;
		this.deviceId = deviceId;
	}

	start() { clients.push(this); }

	stop() { this.stopped = true; }
}

class FakeDiscovery extends SaswellLanDiscovery {
	find(deviceId, callback) {
		const request = { deviceId, callback, cancelled: false };
		sweeps.push(request);
		return () => { request.cancelled = true; };
	}

	stop() {}
}

const clients = [];
const sweeps = [];
const originalLoad = Module._load;
let SaswellLanConnection;
let stopLanNetwork;
try {
	Module._load = (name, ...args) => {
		if (name === './SaswellLanDiscovery') return { SaswellLanDiscovery: FakeDiscovery, isLocalAddress };
		if (name === './SaswellLocalClient') return { SaswellLocalClient: FakeClient };
		return originalLoad(name, ...args);
	};
	({ SaswellLanConnection, stopLanNetwork } = require('../lib/SaswellLanConnection'));
} finally {
	Module._load = originalLoad;
}

function network(t, discovery) {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: new Date('2026-01-01') });
	clients.length = 0;
	sweeps.length = 0;
	const homey = { discovery };
	t.after(() => stopLanNetwork(homey));
	const connect = (deviceId, addresses) => {
		const cached = [];
		const states = [];
		const disconnectReasons = [];
		const connection = new SaswellLanConnection({
			homey,
			deviceId,
			addresses,
			onState: (state, _address, reason) => {
				states.push(state);
				if (reason) disconnectReasons.push(reason);
			},
			onStatus() {},
			onAddress: host => { if (cached.at(-1) !== host) cached.push(host); },
		});
		connection.start();
		return { cached, states, disconnectReasons, connection };
	};
	return { connect, stop: () => stopLanNetwork(homey) };
}

test('tries the cached IP before rediscovery and reconnects at the new matched IP', t => {
	const { connect } = network(t);
	const oldAddress = '192.168.1.20';
	const newAddress = '192.168.1.30';
	const id = '1038TEST00000001';
	const { cached, states, disconnectReasons } = connect(id, [oldAddress]);
	const initial = clients.at(-1);
	initial.emit('status', {});
	initial.emit('disconnect', { reason: 'closed' });
	assert.deepEqual(states, ['connecting', 'local', 'fallback']);
	assert.deepEqual(disconnectReasons, ['closed']);
	t.mock.timers.tick(2000);
	assert.equal(clients.at(-1).host, oldAddress);
	clients.at(-1).emit('disconnect', { reason: 'hello_timeout' });
	t.mock.timers.tick(4000);
	assert.equal(clients.at(-1).host, oldAddress);
	clients.at(-1).emit('disconnect', { reason: 'hello_timeout' });
	assert.equal(sweeps[0].deviceId, id);
	sweeps[0].callback(newAddress);
	assert.equal(clients.at(-1).host, newAddress);
	clients.at(-1).emit('status', {});
	assert.deepEqual(cached, [oldAddress, newAddress]);
	assert.equal(states.at(-1), 'local');
});

test('tries the exact MAC match after a cached IP fails and saves it only when TCP becomes ready', t => {
	const oldAddress = '192.168.1.20';
	const newAddress = '192.168.1.30';
	const getStrategy = t.mock.fn(() => ({
		getDiscoveryResults: () => ({
			other: { mac: '24:35:CC:00:00:02', address: '192.168.1.31' },
			match: { mac: '24-35-cc-00-00-01', address: newAddress },
		}),
	}));
	const { connect } = network(t, { getStrategy });
	const { cached } = connect(MAC_DEVICE_ID, [oldAddress]);
	assert.equal(clients.at(-1).host, oldAddress);
	assert.equal(getStrategy.mock.callCount(), 0);
	clients.at(-1).emit('disconnect', { reason: 'connection_error' });
	assert.equal(clients.at(-1).host, newAddress);
	assert.equal(clients.at(-1).deviceId, MAC_DEVICE_ID);
	assert.deepEqual(getStrategy.mock.calls[0].arguments, ['scinan_mac']);
	assert.equal(sweeps.length, 0);
	assert.deepEqual(cached, []);
	clients.at(-1).emit('status', {});
	assert.deepEqual(cached, [newAddress]);
});

test('rejects an incorrect greeting at a MAC candidate and continues with the bounded sweep', t => {
	const oldAddress = '192.168.1.20';
	const staleAddress = '192.168.1.30';
	const { connect } = network(t, {
		getStrategy: () => ({
			getDiscoveryResults: () => ({ '24:35:cc:00:00:01': { address: staleAddress } }),
		}),
	});
	const { cached } = connect(MAC_DEVICE_ID, [oldAddress]);
	clients.at(-1).emit('disconnect', { reason: 'hello_timeout' });
	assert.equal(clients.at(-1).host, staleAddress);
	clients.at(-1).emit('disconnect', { reason: 'wrong_device' });
	assert.equal(sweeps[0].deviceId, MAC_DEVICE_ID);
	assert.deepEqual(cached, []);
	sweeps[0].callback(null);
	t.mock.timers.tick(4000);
	assert.equal(clients.at(-1).host, oldAddress);
	clients.at(-1).emit('disconnect', { reason: 'hello_timeout' });
	assert.deepEqual(clients.map(client => client.host), [oldAddress, staleAddress, oldAddress]);
});

test('keeps the existing retry when the MAC lookup only has the cached IP or the SDK is unavailable', t => {
	const address = '192.168.1.20';
	let results = { thermostat: { id: '2435CC000001', address } };
	const getStrategy = t.mock.fn(() => ({
		getDiscoveryResults: () => {
			if (!results) throw new Error('unavailable');
			return results;
		},
	}));
	const { connect } = network(t, { getStrategy });
	connect(MAC_DEVICE_ID, [address]);
	clients.at(-1).emit('disconnect', { reason: 'hello_timeout' });
	assert.equal(clients.length, 1);
	assert.equal(sweeps.length, 0);
	t.mock.timers.tick(4000);
	results = null;
	clients.at(-1).emit('disconnect', { reason: 'hello_timeout' });
	assert.equal(clients.length, 2);
	assert.equal(sweeps.length, 1);
});

test('uses MAC matches for thermostats with no saved or manual IP address', t => {
	const results = {
		'24:35:CC:00:00:01': { address: '192.168.1.20' },
		'24:35:CC:00:00:02': { address: '192.168.1.30' },
	};
	const { connect } = network(t, {
		getStrategy: () => ({ getDiscoveryResults: () => results }),
	});
	const first = connect(MAC_DEVICE_ID, []);
	const second = connect('10382435CC000002', []);
	assert.deepEqual(clients.map(client => client.host), ['192.168.1.20', '192.168.1.30']);
	assert.equal(sweeps.length, 0);
	assert.deepEqual(first.cached, []);
	assert.deepEqual(second.cached, []);
	clients[0].emit('status', {});
	clients[1].emit('status', {});
	assert.deepEqual(first.cached, ['192.168.1.20']);
	assert.deepEqual(second.cached, ['192.168.1.30']);
});

test('a duplicate pairing can still use a MAC match after the existing connection is released', t => {
	const address = '192.168.1.20';
	const { connect } = network(t, {
		getStrategy: () => ({ getDiscoveryResults: () => ({ '24:35:CC:00:00:01': { address } }) }),
	});
	const first = connect(MAC_DEVICE_ID, [address]);
	const second = connect(MAC_DEVICE_ID, []);
	assert.equal(clients.length, 1);
	assert.equal(second.states.at(-1), 'duplicate');
	first.connection.stop();
	t.mock.timers.tick(30000);
	assert.equal(clients.length, 2);
	assert.equal(clients.at(-1).host, address);
	clients.at(-1).emit('status', {});
	assert.deepEqual(second.cached, [address]);
	assert.equal(sweeps.length, 0);
});

test('rechecks the initial MAC results once and cancels pending lookups on shutdown', t => {
	const results = {};
	const { connect, stop } = network(t, {
		getStrategy: () => ({ getDiscoveryResults: () => results }),
	});
	const { states } = connect(MAC_DEVICE_ID, []);
	assert.deepEqual(states, ['searching']);
	assert.equal(clients.length, 0);
	assert.equal(sweeps.length, 0);
	results['24:35:CC:00:00:01'] = { address: '192.168.1.20' };
	t.mock.timers.tick(6000);
	assert.equal(clients.at(-1).host, '192.168.1.20');
	assert.equal(sweeps.length, 0);
	connect('10382435CC000002', []);
	stop();
	t.mock.timers.tick(6000);
	assert.equal(clients.length, 1);
	assert.equal(sweeps.length, 0);
});

test('falls through to a bounded sweep when an initial MAC match fails identity validation', t => {
	const { connect } = network(t, {
		getStrategy: () => ({ getDiscoveryResults: () => ({ '24:35:CC:00:00:01': { address: '192.168.1.20' } }) }),
	});
	const { cached, states } = connect(MAC_DEVICE_ID, []);
	clients.at(-1).emit('disconnect', { reason: 'wrong_device' });
	assert.equal(sweeps.length, 1);
	assert.deepEqual(cached, []);
	sweeps[0].callback(null);
	assert.equal(states.at(-1), 'manual');
	t.mock.timers.tick(5 * 60000);
	assert.equal(clients.length, 1);
	assert.equal(sweeps.length, 2);
});

test('uses a new MAC match before the second sweep', t => {
	const results = {};
	const { connect } = network(t, {
		getStrategy: () => ({ getDiscoveryResults: () => results }),
	});
	connect(MAC_DEVICE_ID, []);
	t.mock.timers.tick(6000);
	assert.equal(sweeps.length, 1);
	sweeps[0].callback(null);
	results['24:35:CC:00:00:01'] = { address: '192.168.1.20' };
	t.mock.timers.tick(5 * 60000);
	assert.equal(clients.at(-1).host, '192.168.1.20');
	assert.equal(sweeps.length, 1);
});

test('two unsuccessful sweeps leave the device ready for manual configuration', t => {
	const { connect } = network(t);
	const { states } = connect('1038TEST00000001', []);
	assert.equal(sweeps.length, 1);
	sweeps[0].callback(null);
	assert.equal(states.at(-1), 'manual');
	t.mock.timers.tick(5 * 60000 - 1);
	assert.equal(sweeps.length, 1);
	t.mock.timers.tick(1);
	assert.equal(sweeps.length, 2);
	sweeps[1].callback(null);
	t.mock.timers.tick(24 * 60 * 60000);
	assert.equal(sweeps.length, 2);
	assert.equal(clients.length, 0);
	assert.equal(states.at(-1), 'manual');
});

test('direct connection attempts share the app limit and stop at app shutdown', async t => {
	const { connect, stop } = network(t);
	for (let index = 1; index <= 10; index += 1) {
		connect(String(index), [`192.168.1.${index}`]);
	}
	assert.equal(clients.length, 8);
	clients[0].emit('status', {});
	await Promise.resolve();
	assert.equal(clients.length, 9);
	stop();
	await Promise.resolve();
	assert.equal(clients.length, 9);
	assert.ok(clients.every(client => client.stopped));
});
