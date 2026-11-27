'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const { test } = require('node:test');
const { setImmediate: advance } = require('node:timers/promises');
const { SaswellLanDiscovery } = require('../lib/SaswellLanDiscovery');

const ID_A = '1038ABCD1234EFGH';
const ID_B = '1038ABCDEFGH1234';
const HOMEY_IP = '192.168.5.3';

function interfaceInfo(overrides = {}) {
	return { address: HOMEY_IP, family: 'IPv4', netmask: '255.255.255.248', internal: false, ...overrides };
}

function createDiscovery(t, runProbe, options = {}) {
	const {
		platform = 'local', endpoint = `${HOMEY_IP}:80`, interfaces = { eth0: [interfaceInfo()] },
		getLocalAddress = t.mock.fn(async () => endpoint), timeoutMs = 1000,
	} = options;
	t.mock.method(os, 'networkInterfaces', () => interfaces);
	const homey = { platform, cloud: { getLocalAddress } };
	const discovery = new SaswellLanDiscovery({ homey, runProbe, timeoutMs });
	t.after(() => discovery.stop());
	return { discovery, getLocalAddress };
}

function lookup(discovery, id) {
	return new Promise(resolve => discovery.find(id, resolve));
}

function match(host, deviceId) {
	return { host, deviceId, deviceType: '9' };
}

test('multiple requests share the sweep, and a late request can use a prior match', { timeout: 2000 }, async t => {
	const attempts = [];
	let completeSecondMatch;
	const { discovery, getLocalAddress } = createDiscovery(t, (host, signal) => {
		attempts.push({ host, signal });
		if (host === '192.168.5.2') return Promise.resolve(match(host, ID_A));
		return new Promise(resolve => {
			if (host === '192.168.5.6') completeSecondMatch = () => resolve(match(host, ID_B));
			signal.addEventListener('abort', () => resolve(null));
		});
	}, { interfaces: { eth0: [interfaceInfo({ family: 4 })] } });
	const first = lookup(discovery, ID_A);
	const second = lookup(discovery, ID_B);
	assert.equal(await first, '192.168.5.2');
	assert.equal(await lookup(discovery, ID_A), '192.168.5.2');
	completeSecondMatch();
	assert.equal(await second, '192.168.5.6');
	assert.deepEqual(attempts.map(attempt => attempt.host), ['192.168.5.1', '192.168.5.2', '192.168.5.4', '192.168.5.5', '192.168.5.6']);
	assert.ok(attempts.every(attempt => attempt.signal.aborted));
	assert.equal(getLocalAddress.mock.callCount(), 1);
});

test('a full sweep visits each eligible address with at most eight probes in flight', { timeout: 2000 }, async t => {
	let inFlight = 0;
	let peak = 0;
	const hosts = [];
	const { discovery } = createDiscovery(t, async host => {
		hosts.push(host);
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await advance();
		inFlight -= 1;
		return null;
	}, { endpoint: HOMEY_IP, interfaces: { eth0: [interfaceInfo({ netmask: '255.255.255.0' })] } });
	assert.equal(await lookup(discovery, ID_A), null);
	assert.equal(peak, 8);
	assert.deepEqual(hosts, Array.from({ length: 254 }, (_, index) => `192.168.5.${index + 1}`).filter(ip => ip !== HOMEY_IP));
});

test('the scan stops scheduling candidates after the final requested thermostat matches', { timeout: 2000 }, async t => {
	const hosts = [];
	const { discovery } = createDiscovery(t, (host, signal) => {
		hosts.push(host);
		if (host === '192.168.5.1') return Promise.resolve(match(host, ID_A));
		return new Promise(resolve => signal.addEventListener('abort', () => resolve(null)));
	}, { interfaces: { eth0: [interfaceInfo({ netmask: '255.255.255.0' })] } });
	assert.equal(await lookup(discovery, ID_A), '192.168.5.1');
	await advance();
	assert.equal(hosts.length, 8);
});

test('an unsafe or indeterminate subnet starts no probes', async t => {
	const cases = [
		['cloud runtime', { platform: 'cloud' }],
		['unmatched interface', { endpoint: '192.168.1.200:80' }],
		['malformed endpoint', { endpoint: '192.168.5.3:abc' }],
		['public network', { endpoint: '1.2.3.4', interfaces: { eth0: [interfaceInfo({ address: '1.2.3.4' })] } }],
		['internal interface', { interfaces: { eth0: [interfaceInfo({ internal: true })] } }],
		['ambiguous interface', { interfaces: { eth0: [interfaceInfo()], wlan0: [interfaceInfo()] } }],
		['unknown netmask', { interfaces: { eth0: [interfaceInfo({ netmask: null })] } }],
		['non-contiguous netmask', { interfaces: { eth0: [interfaceInfo({ netmask: '255.255.255.250' })] } }],
		['oversized subnet', { interfaces: { eth0: [interfaceInfo({ netmask: '255.255.254.0' })] } }],
		['broadcast address', { interfaces: { eth0: [interfaceInfo({ netmask: '255.255.255.252' })] } }],
		['address lookup failed', { getLocalAddress: async () => { throw new Error('unavailable'); } }],
	];
	for (const [name, options] of cases) {
		await t.test(name, async subtest => {
			const runProbe = subtest.mock.fn();
			const { discovery, getLocalAddress } = createDiscovery(subtest, runProbe, options);
			assert.equal(await lookup(discovery, ID_A), null);
			assert.equal(runProbe.mock.callCount(), 0);
			if (options.platform === 'cloud') assert.equal(getLocalAddress.mock.callCount(), 0);
		});
	}
});

test('the sweep ignores inconsistent probe results and failures', async t => {
	const { discovery } = createDiscovery(t, async host => {
		if (host.endsWith('.1')) throw new Error('address unreachable');
		if (host.endsWith('.2')) return match('192.168.5.99', ID_A);
		if (host.endsWith('.4')) return { ...match(host, ID_A), deviceType: '3' };
		if (host.endsWith('.5')) return match(host, ID_B);
		return null;
	});
	assert.equal(await lookup(discovery, ID_A), null);
});

test('find cancellation aborts the remaining probes and prevents late results', { timeout: 2000 }, async t => {
	const attempts = [];
	const { discovery } = createDiscovery(t, (host, signal) => new Promise(resolve => {
		attempts.push({ host, signal, resolve });
	}));
	const callback = t.mock.fn();
	const cancel = discovery.find(ID_A, callback);
	await advance();
	assert.ok(attempts.length > 0);
	cancel();
	assert.ok(attempts.every(attempt => attempt.signal.aborted));
	for (const attempt of attempts) attempt.resolve(match(attempt.host, ID_A));
	await advance();
	assert.equal(callback.mock.callCount(), 0);
});

test('the scan deadline aborts probes and completes pending requests once', { timeout: 2000 }, async t => {
	const signals = [];
	const { discovery } = createDiscovery(t, (host, signal) => new Promise(resolve => {
		signals.push(signal);
		signal.addEventListener('abort', () => resolve(match(host, ID_A)));
	}), { timeoutMs: 50 });
	const addresses = [];
	await new Promise(resolve => discovery.find(ID_A, address => {
		addresses.push(address);
		resolve();
	}));
	await advance();
	assert.ok(signals.length > 0);
	assert.ok(signals.every(signal => signal.aborted));
	assert.deepEqual(addresses, [null]);
});
