'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const { AUTHORIZATION_URL_V2, LIST_URL_V2 } = require('../lib/Constants');

class HomeyApp {
	log() {}

	error() {}
}

const originalLoad = Module._load;
let ScinanApp;
try {
	Module._load = (id, ...args) => id === 'homey' ? { App: HomeyApp, manifest: {} } : originalLoad(id, ...args);
	ScinanApp = require('../app');
} finally {
	Module._load = originalLoad;
}

const NOW = 1800000000000;
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

class Settings extends EventEmitter {
	constructor(initial) {
		super();
		this.values = new Map(Object.entries(initial));
	}

	get(key) {
		return this.values.get(key);
	}

	set(key, value) {
		this.values.set(key, value);
		this.emit('set', key);
	}
}

async function initApp(t, initial = {}) {
	t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW });
	const app = new ScinanApp();
	app.homey = { settings: new Settings({ macToImeiMD5: 'imei', tokenv2: 'token', ...initial }) };
	t.after(() => app.onUninit());
	await app.onInit();
	return app;
}

function response(data, status = 200, retryAfter = null) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: () => retryAfter },
		json: async () => data,
	};
}

test('shares a cloud request across devices and records freshness before notifying them', async t => {
	const app = await initApp(t);
	const receivedAt = [];
	let calls = 0;
	app.homey.settings.on('set', key => {
		if (key === 'last APIv2 result') receivedAt.push(app.getCloudStatusReceivedAt());
	});
	app.requestCloud = async (url, values) => {
		assert.equal(url, LIST_URL_V2);
		assert.deepEqual(values, { token: 'token' });
		calls += 1;
		return response({ result_code: 0, result_data: [] });
	};
	app.setDeviceCloudFallback({}, true);
	app.setDeviceCloudFallback({}, true);
	const first = app.APIv2();
	assert.equal(app.APIv2(), first);
	assert.equal(app.fetchCloudStatusForPairing(), first);
	assert.equal((await first).result_code, '0');
	assert.equal(await app.APIv2(), null);
	assert.equal(calls, 1);
	assert.deepEqual(receivedAt, [NOW]);
	t.mock.timers.tick(15 * MINUTE);
	await app.cloudPollRequest;
	assert.equal(calls, 2);
});

test('publishes the pairing list before device registration and counts it toward the fallback interval', async t => {
	const app = await initApp(t);
	const devices = [{ devices: [{ id: 'thermostat' }] }];
	let calls = 0;
	app.requestCloud = async () => {
		calls += 1;
		return response({ result_code: 0, result_data: devices });
	};
	const pending = app.fetchCloudStatusForPairing();
	assert.equal(app.fetchCloudStatusForPairing(), pending);
	assert.deepEqual((await pending).result_data, devices);
	assert.deepEqual(app.homey.settings.get('last APIv2 result').result_data, devices);
	assert.equal(app.getCloudResultReceivedAt(), NOW);
	app.setDeviceCloudFallback({}, true);
	assert.equal(await app.APIv2(), null);
	assert.equal(calls, 1);
});

test('uses a 24 hour account check with healthy LAN and resumes the configured interval on fallback', async t => {
	const previous = NOW - 10 * MINUTE;
	const app = await initApp(t, { lastCloudStatusReceivedAt: previous, u_interval: 20 });
	const thermostat = {};
	let calls = 0;
	app.requestCloud = async () => {
		calls += 1;
		return response({ result_code: '0' });
	};
	app.setDeviceCloudFallback(thermostat, false);
	t.mock.timers.tick(DAY - 10 * MINUTE - 1);
	assert.equal(calls, 0);
	t.mock.timers.tick(1);
	await app.cloudPollRequest;
	assert.equal(calls, 1);
	t.mock.timers.tick(10 * MINUTE);
	app.setDeviceCloudFallback(thermostat, true);
	t.mock.timers.tick(10 * MINUTE - 1);
	assert.equal(calls, 1);
	t.mock.timers.tick(1);
	await app.cloudPollRequest;
	assert.equal(calls, 2);
	app.removeDeviceCloudFallback(thermostat);
	t.mock.timers.tick(DAY);
	assert.equal(calls, 2);
});

test('renews an expired token once and retries the account status with the replacement token', async t => {
	const app = await initApp(t, { usernamev2: 'user', md5Password: 'hash' });
	const calls = [];
	app.requestCloud = async (url, values) => {
		calls.push([url, values]);
		if (url === AUTHORIZATION_URL_V2) {
			return response({ result_code: 0, result_data: { access_token: 'renewed', expires_in: 7200 } });
		}
		return response({ result_code: values.token === 'renewed' ? '0' : '10003' });
	};
	app.setDeviceCloudFallback({}, true);
	assert.equal((await app.APIv2()).result_code, '0');
	assert.deepEqual(calls, [
		[LIST_URL_V2, { token: 'token' }],
		[AUTHORIZATION_URL_V2, { account: 'user', password: 'hash' }],
		[LIST_URL_V2, { token: 'renewed' }],
	]);
	assert.equal(app.homey.settings.get('cloudTokenRefreshAt'), NOW + 6480000);
	assert.ok(app.cloudTokenTimer);
});

test('honors an account rate limit without attempting to log in or poll after repair', async t => {
	const app = await initApp(t, { usernamev2: 'user', md5Password: 'hash' });
	const calls = [];
	app.requestCloud = async url => {
		calls.push(url);
		return response(null, 429);
	};
	app.setDeviceCloudFallback({}, true);
	assert.equal((await app.APIv2()).result_code, '429');
	assert.equal(app.homey.settings.get('cloudRetryAt'), NOW + DAY);
	assert.equal(await app.refreshCloudAfterRepair(), null);
	assert.equal(await app.reauthorizeIfPossible(), false);
	t.mock.timers.tick(DAY - 1);
	assert.deepEqual(calls, [LIST_URL_V2]);
});

test('records failed reply time separately from the last successful status', async t => {
	const previous = NOW - 20 * MINUTE;
	const app = await initApp(t, { lastCloudStatusReceivedAt: previous });
	app.requestCloud = async () => response({ result_code: '10003' });
	let resultReceivedAt;
	app.homey.settings.on('set', key => {
		if (key === 'last APIv2 result') resultReceivedAt = app.getCloudResultReceivedAt();
	});
	app.setDeviceCloudFallback({}, true);
	assert.equal((await app.APIv2()).result_code, '10003');
	assert.equal(resultReceivedAt, NOW);
	assert.equal(app.getCloudStatusReceivedAt(), previous);
});

test('reports a cloud network failure on one line and keeps cached status', async t => {
	const result = { result_code: '0', result_data: [] };
	const previous = NOW - 20 * MINUTE;
	const app = await initApp(t, { 'last APIv2 result': result, lastCloudResultReceivedAt: previous });
	const errorLog = t.mock.method(app, 'error');
	app.requestCloud = async () => { throw new Error('network unavailable\nadditional details'); };
	app.setDeviceCloudFallback({}, true);
	assert.equal(await app.APIv2(), null);
	assert.equal(app.homey.settings.get('lastCloudFailureAt'), NOW);
	assert.equal(app.getCloudResultReceivedAt(), previous);
	assert.equal(app.homey.settings.get('last APIv2 result'), result);
	assert.deepEqual(errorLog.mock.calls.map(call => call.arguments), [
		['Saswell cloud status request failed:', 'network unavailable'],
	]);
});

test('ignores a superseded result and refreshes cloud status using repaired credentials', async t => {
	const app = await initApp(t);
	let finishPending;
	app.requestCloud = async (url, { token }) => {
		assert.equal(url, LIST_URL_V2);
		if (token === 'token') return new Promise(resolve => { finishPending = resolve; });
		assert.equal(token, 'repaired');
		return response({ result_code: '0', result_data: ['new'] });
	};
	app.setDeviceCloudFallback({}, true);
	const pending = app.APIv2();
	app.setCloudToken('repaired');
	const repair = app.refreshCloudAfterRepair();
	finishPending(response({ result_code: '0', result_data: ['old'] }));
	assert.equal(await pending, null);
	assert.deepEqual((await repair).result_data, ['new']);
	assert.deepEqual(app.homey.settings.get('last APIv2 result').result_data, ['new']);
});

test('keeps a newer publication ahead of a prior in-flight request for the same token', async t => {
	const app = await initApp(t);
	let finishPending;
	app.requestCloud = async () => new Promise(resolve => { finishPending = resolve; });
	app.setDeviceCloudFallback({}, true);
	const pending = app.APIv2();
	const latest = { result_code: '0', result_data: ['new'] };
	assert.equal(app.publishCloudStatus(latest, 'oldToken'), null);
	assert.equal(app.publishCloudStatus(latest, 'token'), latest);
	finishPending(response({ result_code: '10003' }));
	assert.equal(await pending, null);
	assert.equal(app.homey.settings.get('last APIv2 result'), latest);
});

test('clears timers and ignores request results after app shutdown', async t => {
	const app = await initApp(t, { usernamev2: 'user', md5Password: 'hash' });
	let finishPending;
	app.requestCloud = async () => new Promise(resolve => { finishPending = resolve; });
	app.setCloudToken('token', 7200);
	app.setDeviceCloudFallback({}, true);
	const pending = app.APIv2();
	app.onUninit();
	finishPending(response({ result_code: '0' }));
	assert.equal(await pending, null);
	assert.equal(app.homey.settings.get('last APIv2 result'), undefined);
	assert.equal(app.cloudPollTimer, null);
	assert.equal(app.homey.settings.listenerCount('set'), 0);
});
