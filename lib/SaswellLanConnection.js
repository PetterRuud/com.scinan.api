'use strict';

const { SaswellLanDiscovery, isLocalAddress } = require('./SaswellLanDiscovery');
const { SaswellLocalClient, probeThermostat } = require('./SaswellLocalClient');

const networkByHomey = new WeakMap();
const MAX_ATTEMPTS = 8;
const MAX_DISCOVERY_SWEEPS = 2;
const REDISCOVERY_DELAY = 5 * 60 * 1000;

function getLanNetwork(homey) {
	if (!networkByHomey.has(homey)) {
		const network = { connections: new Map(), controllers: new Set(), waiting: [], attempts: 0 };
		network.discovery = new SaswellLanDiscovery({
			homey,
			runProbe: (host, signal) => new Promise(resolve => {
				enqueueAttempt(network, {
					cancelled: () => signal.aborted,
					skip: () => resolve(null),
					run: release => probeThermostat({ host, signal }).then(resolve, () => resolve(null)).finally(release),
				});
			}),
		});
		networkByHomey.set(homey, network);
	}
	return networkByHomey.get(homey);
}

function stopLanNetwork(homey) {
	const network = networkByHomey.get(homey);
	if (!network) return;
	for (const controller of network.controllers) controller.stop();
	network.discovery.stop();
	networkByHomey.delete(homey);
}

function enqueueAttempt(network, attempt) {
	network.waiting.push(attempt);
	drainAttempts(network);
}

function drainAttempts(network) {
	while (network.attempts < MAX_ATTEMPTS && network.waiting.length > 0) {
		const attempt = network.waiting.shift();
		if (attempt.cancelled()) {
			if (attempt.skip) attempt.skip();
			continue;
		}
		network.attempts += 1;
		const release = () => {
			if (attempt.released) return;
			attempt.released = true;
			network.attempts -= 1;
			queueMicrotask(() => drainAttempts(network));
		};
		attempt.run(release);
	}
}

class SaswellLanConnection {
	constructor({ homey, deviceId, addresses, onState, onStatus, onAddress }) {
		this.network = getLanNetwork(homey);
		this.network.controllers.add(this);
		this.deviceId = deviceId;
		this.addresses = [...new Set(addresses.filter(isLocalAddress))];
		this.onState = onState;
		this.onStatus = onStatus;
		this.onAddress = onAddress;
		this.failedAttempts = 0;
		this.addressIndex = 0;
		this.triedMacAddresses = new Set();
		this.discoverySweeps = 0;
		this.lastDiscoveryAt = 0;
		this.stopped = false;
	}

	start(macCandidate) {
		if (this.stopped || this.client || this.retry || this.connecting) return;
		if (!macCandidate && this.addresses.length === 0) {
			this.discover();
			return;
		}
		const owner = this.network.connections.get(this.deviceId);
		if (owner && owner !== this) {
			this.onState('duplicate');
			this.scheduleRetry(30000);
			return;
		}
		this.network.connections.set(this.deviceId, this);
		if (!this.failedAttempts && !this.cancelDiscovery) this.onState('connecting');
		this.connecting = true;
		enqueueAttempt(this.network, {
			cancelled: () => this.stopped,
			run: release => this.connect(release, macCandidate),
		});
	}

	connect(release, macCandidate) {
		this.connecting = false;
		this.releaseAttempt = release;
		const address = macCandidate || this.addresses[this.addressIndex % this.addresses.length];
		if (macCandidate) this.triedMacAddresses.add(macCandidate);
		const client = new SaswellLocalClient({ host: address, deviceId: this.deviceId });
		this.client = client;
		let ready = false;
		client.on('status', (status, awayPending) => {
			if (this.client !== client) return;
			if (!ready) {
				ready = true;
				this.failedAttempts = 0;
				this.addressIndex = 0;
				this.triedMacAddresses.clear();
				this.discoverySweeps = 0;
				this.cancelSweep();
				this.addresses = [address, ...this.addresses.filter(candidate => candidate !== address)];
				this.onAddress(address);
				this.onState('local', address);
				release();
			}
			this.onStatus(status, awayPending);
		});
		client.on('disconnect', ({ reason }) => {
			if (this.client !== client) return;
			this.client = null;
			this.releaseConnection();
			const macCandidateFailed = Boolean(macCandidate && !ready);
			if (!ready && !macCandidateFailed) {
				this.failedAttempts += 1;
				this.addressIndex += 1;
			}
			if (!this.cancelDiscovery) {
				const state = reason === 'wrong_device' ? 'wrongDevice' : 'fallback';
				this.onState(state, undefined, reason);
			}
			release();
			if (!macCandidateFailed && this.tryMacCandidate()) return;
			if (macCandidateFailed || this.failedAttempts >= Math.max(2, this.addresses.length)) this.discover();
			if (this.addresses.length) this.scheduleRetry();
		});
		client.start();
	}

	tryMacCandidate() {
		if (this.cancelDiscovery) return false;
		const address = this.network.discovery.getMacCandidate(this.deviceId);
		if (!address || this.addresses.includes(address) || this.triedMacAddresses.has(address)) return false;
		this.cancelSweep();
		this.start(address);
		return true;
	}

	discover() {
		if (this.stopped || this.cancelDiscovery || this.cancelMacWait || this.discoveryTimer || this.discoverySweeps >= MAX_DISCOVERY_SWEEPS) return;
		const delay = this.lastDiscoveryAt ? this.lastDiscoveryAt + REDISCOVERY_DELAY - Date.now() : 0;
		if (delay > 0) {
			this.discoveryTimer = setTimeout(() => {
				this.discoveryTimer = null;
				this.discover();
			}, delay);
			return;
		}
		if (this.addresses.length === 0) {
			if (this.tryMacCandidate()) return;
			if (!this.waitedForMacResults && this.triedMacAddresses.size === 0) {
				this.waitedForMacResults = true;
				this.cancelMacWait = this.network.discovery.waitForMacResults(this.deviceId, () => {
					this.cancelMacWait = null;
					this.discover();
				});
				if (this.cancelMacWait) {
					this.onState('searching');
					return;
				}
			}
		}
		this.lastDiscoveryAt = Date.now();
		this.discoverySweeps += 1;
		this.onState('searching');
		this.cancelDiscovery = this.network.discovery.find(this.deviceId, address => {
			this.cancelDiscovery = null;
			if (this.stopped) return;
			if (!address) {
				this.onState(this.addresses.length ? 'fallback' : 'manual');
				this.discover();
				return;
			}
			this.addresses = [address, ...this.addresses.filter(candidate => candidate !== address)];
			this.addressIndex = 0;
			this.onAddress(address);
			if (this.client?.host === address) return;
			this.stopClient();
			clearTimeout(this.retry);
			this.retry = null;
			this.start();
		});
	}

	cancelSweep() {
		clearTimeout(this.discoveryTimer);
		this.discoveryTimer = null;
		if (this.cancelMacWait) this.cancelMacWait();
		this.cancelMacWait = null;
		if (this.cancelDiscovery) this.cancelDiscovery();
		this.cancelDiscovery = null;
	}

	scheduleRetry(delay = Math.min(60000, 2000 * (2 ** Math.min(this.failedAttempts, 5)))) {
		this.retry = setTimeout(() => {
			this.retry = null;
			this.start();
		}, delay * (0.8 + Math.random() * 0.2));
	}

	async sendCommand(capability, value) {
		return this.client ? this.client.sendCommand(capability, value) : 'unavailable';
	}

	releaseConnection() {
		if (this.network.connections.get(this.deviceId) === this) this.network.connections.delete(this.deviceId);
	}

	stopClient() {
		const client = this.client;
		if (!client) return;
		this.client = null;
		client.stop();
		if (this.releaseAttempt) this.releaseAttempt();
		this.releaseConnection();
	}

	stop() {
		this.stopped = true;
		this.network.controllers.delete(this);
		clearTimeout(this.retry);
		this.cancelSweep();
		this.stopClient();
		this.releaseConnection();
	}
}

module.exports = { SaswellLanConnection, isLocalAddress, stopLanNetwork };
