'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { test } = require('node:test');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { isLocalAddress } = require('../lib/SaswellLanDiscovery');

const DEVICE_ID = '1038TEST00000001';
const requests = [];

class FakeLanConnection {
	constructor({ addresses, onAddress, onState, onStatus }) {
		this.addresses = addresses;
		this.onAddress = onAddress;
		this.onState = onState;
		this.onStatus = onStatus;
		this.commands = [];
		this.outcome = 'confirmed';
	}

	start() {}

	stop() { this.stopped = true; }

	async sendCommand(capability, value) {
		this.commands.push([capability, value]);
		return this.outcome;
	}
}

const originalLoad = Module._load;
let SaswellDevice;
try {
	Module._load = (name, ...args) => {
		if (name === 'homey') return { Device: class {} };
		if (name === './SaswellLanConnection') return { SaswellLanConnection: FakeLanConnection, isLocalAddress };
		if (name === 'node-fetch') {
			return async (_url, options) => {
				requests.push(Object.fromEntries(options.body));
				return { ok: true, json: async () => ({ result_code: '0' }) };
			};
		}
		return originalLoad(name, ...args);
	};
	SaswellDevice = require('../lib/SaswellDeviceV2');
} finally {
	Module._load = originalLoad;
}

async function initDevice(t, deviceSettings = {}, token = 'token') {
	requests.length = 0;
	const values = { tokenv2: token };
	const settings = Object.assign(new EventEmitter(), {
		get: key => values[key],
		set(key, value) {
			values[key] = value;
			this.emit('set', key);
		},
	});
	const store = {};
	const device = new SaswellDevice();
	const state = {};
	const writes = [];
	const consumers = new Map();
	let receivedAt = 0;
	device.homey = {
		settings,
		__: key => key,
		app: {
			getCloudResultReceivedAt: () => receivedAt,
			setDeviceCloudFallback: (consumer, needsCloud) => consumers.set(consumer, needsCloud),
			removeDeviceCloudFallback: consumer => consumers.delete(consumer),
			APIv2: async () => {},
		},
	};
	Object.assign(device, {
		log: t.mock.fn(),
		error: t.mock.fn(),
		getName: () => 'Test Thermostat',
		getData: () => ({ id: DEVICE_ID }),
		getSettings: () => deviceSettings,
		getSetting: key => deviceSettings[key],
		getStoreValue: key => store[key],
		setStoreValue: async (key, value) => { store[key] = value; },
		setSettings: async next => Object.assign(deviceSettings, next),
		registrationCount: 0,
		registerCapabilityListener() { this.registrationCount += 1; },
		hasCapability: () => true,
		getCapabilityValue: key => state[key],
		setCapabilityValue: async (key, value) => {
			writes.push([key, value]);
			state[key] = value;
		},
		available: true,
		getAvailable() { return this.available; },
		async setAvailable() { this.available = true; },
		async setUnavailable() { this.available = false; },
	});
	const cloud = (result, time = Date.now()) => {
		receivedAt = time;
		settings.set('last APIv2 result', result);
		return device.stateQueue;
	};
	t.after(() => {
		device.onUninit();
		assert.equal(device.error.mock.callCount(), 0);
	});
	await device.onInit();
	return { device, state, writes, consumers, store, cloud };
}

function online(temperature, timestamp = Date.now()) {
	const s00 = [timestamp, 1, temperature, 21, 0, 0, 0, 0, 0, 0, '05', '35'].join(',');
	return { result_code: '0', result_data: [{ devices: [{ id: DEVICE_ID, online: '1', s00 }] }] };
}

const LOCAL_STATUS = { onoff: true, measure_temperature: 23, target_temperature: 22, away: false, mode: 0 };

test('keeps existing pairings on v2 cloud and registers capability handlers once', async t => {
	const { device, state, consumers, cloud } = await initDevice(t);
	await device.onInit();
	await cloud(online(20));
	assert.equal(device.registrationCount, 4);
	assert.equal(device.lanConnection, null);
	assert.equal(consumers.get(device), true);
	assert.equal(state.measure_temperature, 20);
	assert.match(device.log.mock.calls[0].arguments[0], /^\[Cloud\].*Applied thermostat status .*measure_temperature=20/);
	await device.onCapabilitySetTemperature(21.5);
	assert.equal(requests[0].device_id, DEVICE_ID);
	assert.equal(requests[0].sensor_id, '02');
	assert.match(device.log.mock.calls.at(-1).arguments[0], /^\[Cloud\].*Saswell accepted target_temperature command/);
});

test('uses verified LAN state and commands first and deduplicates capability writes', async t => {
	const { device, state, writes, consumers, store, cloud } = await initDevice(t, {
		localEnabled: true, localIp: '192.168.1.15', onOffCapability: true, m2: 3,
	});
	const connection = device.lanConnection;
	assert.deepEqual(connection.addresses, [undefined, '192.168.1.15']);
	connection.onAddress('192.168.1.15');
	connection.onState('local', '192.168.1.15');
	connection.onStatus(LOCAL_STATUS);
	await device.stateQueue;
	assert.equal(store.saswellLocalAddress, '192.168.1.15');
	assert.equal(consumers.get(device), false);
	assert.equal(state.measure_temperature, 23);
	assert.equal(state.measure_power, 180);
	assert.ok(device.log.mock.calls.some(({ arguments: [message] }) => /^\[LAN\].*Applied thermostat status .*measure_temperature=23/.test(message)));
	const before = writes.length;
	const beforeLogs = device.log.mock.callCount();
	connection.onStatus(LOCAL_STATUS);
	await cloud(online(18));
	assert.equal(writes.length, before);
	assert.equal(device.log.mock.callCount(), beforeLogs);
	await device.onCapabilitySetTemperature(21.5);
	assert.match(device.log.mock.calls.at(-1).arguments[0], /^\[LAN\].*Thermostat confirmed target_temperature command/);
	await device.onCapabilityOnOff(false);
	assert.deepEqual(connection.commands, [['target_temperature', '21.5'], ['away', '1']]);
	assert.equal(requests.length, 0);
	connection.outcome = 'unconfirmed';
	await assert.rejects(device.onCapabilitySetMode('auto'), /commandUnconfirmed/);
	assert.equal(requests.length, 0);
	assert.match(device.log.mock.calls.at(-1).arguments[0], /^\[LAN\].*Thermostat did not confirm mode command/);
	connection.outcome = 'unavailable';
	await device.onCapabilitySetAway(true);
	assert.equal(requests[0].sensor_id, '03');
});

test('an away command in progress cannot flip the mirrored switch back on from old LAN status', async t => {
	const { device, state } = await initDevice(t, { localEnabled: true, onOffCapability: true });
	const connection = device.lanConnection;
	connection.onState('local');
	connection.onStatus(LOCAL_STATUS);
	await device.stateQueue;
	assert.equal(state.onoff, true);

	let finish;
	connection.outcome = new Promise(resolve => { finish = resolve; });
	const request = device.onCapabilityOnOff(false);
	state.onoff = false;
	connection.onStatus({ ...LOCAL_STATUS, measure_temperature: 24 }, true);
	await device.stateQueue;
	assert.equal(state.measure_temperature, 24);
	assert.equal(state.onoff, false);
	assert.deepEqual(connection.commands, [['away', '1']]);
	assert.ok(device.log.mock.calls.some(call => call.arguments[0].includes('onoff=false mapped to away=true')));

	connection.onStatus({ ...LOCAL_STATUS, away: true, target_temperature: 5 });
	finish('confirmed');
	await request;
	await device.stateQueue;
	assert.equal(state.onoff, false);
	assert.equal(state.away, true);

	connection.onStatus(LOCAL_STATUS);
	await device.stateQueue;
	assert.equal(state.onoff, true);
	assert.equal(state.away, false);
});

test('ignores stale cloud errors and status after LAN loss, then recovers on fresh status', async t => {
	const { device, state, consumers, cloud } = await initDevice(t, { localEnabled: true });
	const connection = device.lanConnection;
	connection.onState('local');
	connection.onStatus(LOCAL_STATUS);
	await cloud({ result_code: '429' }, Date.now() - 1000);
	connection.onState('fallback', undefined, 'status_timeout');
	await device.stateQueue;
	assert.match(device.log.mock.calls.at(-1).arguments[0], /^\[LAN\].*Connection lost \(status_timeout\)\. Falling back to cloud/);
	assert.equal(device.available, true);
	assert.equal(consumers.get(device), true);
	const next = device.cloudAfter + 1000;
	await cloud(online(19, device.lastLocalStatusAt - 1000), next);
	assert.equal(state.measure_temperature, 23);
	device.homey.settings.set('lastCloudFailureAt', next + 1000);
	await device.stateQueue;
	assert.equal(device.available, false);
	await cloud(online(24, next + 2000), next + 2000);
	assert.equal(device.available, true);
	assert.equal(state.measure_temperature, 24);
});

test('rejects an unavailable cloud-only command without disrupting healthy LAN', async t => {
	const { device } = await initDevice(t, { localEnabled: true }, '');
	const connection = device.lanConnection;
	connection.onState('local');
	connection.onStatus(LOCAL_STATUS);
	connection.outcome = 'unsupported';
	await device.stateQueue;
	await assert.rejects(device.onCapabilityOnOff(false), /cloudUnavailable/);
	assert.equal(device.available, true);
});

test('updates the LAN status label after Homey finishes processing device settings', async t => {
	const settings = { localEnabled: true };
	const { device } = await initDevice(t, settings);
	let settingsPending = true;
	device.setSettings = t.mock.fn(async changes => {
		if (settingsPending) throw new Error('Cannot set Settings while this.onSettings is still pending');
		Object.assign(settings, changes);
	});

	await device.onSettings({ newSettings: { localEnabled: false }, changedKeys: ['localEnabled'] });
	assert.equal(device.setSettings.mock.callCount(), 0);
	settingsPending = false;
	await nextTurn();
	await device.stateQueue;
	assert.equal(settings.localStatus, 'lan.cloud');
});

test('logs LAN opt-out and discovery outcomes without logging repeated failures or candidate IPs', async t => {
	const { device } = await initDevice(t, { localEnabled: false });
	assert.equal(device.lanConnection, null);
	await device.onSettings({ newSettings: { localEnabled: true }, changedKeys: ['localEnabled'] });
	const connection = device.lanConnection;
	connection.onState('searching');
	connection.onState('searching');
	connection.onState('connecting', '192.168.1.15');
	connection.onState('fallback', undefined, 'hello_timeout');
	connection.onState('fallback', undefined, 'hello_timeout');
	connection.onState('manual');

	assert.deepEqual(device.log.mock.calls.map(call => call.arguments[0]), [
		'[LAN] [Test Thermostat] Disabled in device settings. Using cloud.',
		'[LAN] [Test Thermostat] Looking for a verified LAN address',
		'[LAN] [Test Thermostat] Trying a LAN connection',
		'[LAN] [Test Thermostat] Connection attempt failed (hello_timeout).',
		'[LAN] [Test Thermostat] No verified LAN address found. Using cloud backup.',
	]);
});

test('device shutdown cancels a pending fallback command and unregisters the consumer', async t => {
	const { device, consumers } = await initDevice(t, { localEnabled: true });
	device.setSettings = t.mock.fn();
	const connection = device.lanConnection;
	connection.onState('local');
	let finish;
	connection.outcome = new Promise(resolve => { finish = resolve; });
	const pending = device.onCapabilitySetTemperature(22);
	device.onUninit();
	finish('unavailable');
	await assert.rejects(pending, /deviceInactive/);
	await nextTurn();
	await device.stateQueue;
	assert.equal(connection.stopped, true);
	assert.equal(consumers.size, 0);
	assert.equal(device.homey.settings.listenerCount('set'), 0);
	assert.equal(requests.length, 0);
	assert.equal(device.setSettings.mock.callCount(), 0);
});
