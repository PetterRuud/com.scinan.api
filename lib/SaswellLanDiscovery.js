'use strict';

const { isIPv4 } = require('net');
const os = require('os');
const { COMPANY_ID } = require('./Constants');
const { SUPPORTED_TYPES } = require('./SaswellLocalClient');

const DEVICE_ID = /^[A-Za-z0-9]{16}$/;
const CONCURRENT_PROBES = 8;
const MAX_USABLE_ADDRESSES = 254;
const MAC_DISCOVERY_WAIT = 6000;

function isLocalAddress(address) {
	if (!isIPv4(address)) return false;
	const [first, second] = address.split('.').map(Number);
	return first === 10 || (first === 172 && second >= 16 && second <= 31)
		|| (first === 192 && second === 168) || (first === 169 && second === 254);
}

function ipv4Number(address) {
	return address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
}

function ipv4String(address) {
	return [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join('.');
}

async function getCandidates(homey) {
	if (homey.platform === 'cloud') return [];
	const endpoint = await homey.cloud.getLocalAddress();
	if (typeof endpoint !== 'string') return [];
	const [address, port, extra] = endpoint.split(':');
	if (!isLocalAddress(address) || extra !== undefined) return [];
	if (port !== undefined && (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535)) return [];
	const matches = Object.values(os.networkInterfaces()).flat().filter(info => !info.internal
		&& (info.family === 'IPv4' || info.family === 4) && info.address === address);
	if (matches.length !== 1 || !isIPv4(matches[0].netmask)) return [];
	const netmask = ipv4Number(matches[0].netmask);
	const hostMask = (~netmask) >>> 0;
	if (hostMask - 1 < 1 || hostMask - 1 > MAX_USABLE_ADDRESSES || (hostMask & (hostMask + 1)) !== 0) return [];
	const homeyIp = ipv4Number(address);
	const network = (homeyIp & netmask) >>> 0;
	const broadcast = network + hostMask;
	if (homeyIp === network || homeyIp === broadcast) return [];
	const candidates = [];
	for (let ip = network + 1; ip < broadcast; ip += 1) {
		if (ip !== homeyIp) candidates.push(ipv4String(ip));
	}
	return candidates;
}

function createCancellation() {
	const listeners = new Set();
	const signal = {
		aborted: false,
		addEventListener(event, listener) {
			if (event === 'abort') listeners.add(listener);
		},
		removeEventListener(event, listener) {
			if (event === 'abort') listeners.delete(listener);
		},
	};
	return {
		signal,
		abort() {
			signal.aborted = true;
			for (const listener of listeners) listener();
			listeners.clear();
		},
	};
}

class SaswellLanDiscovery {
	constructor({ homey, runProbe, timeoutMs = 30000 }) {
		this.homey = homey;
		this.runProbe = runProbe;
		this.timeoutMs = timeoutMs;
		this.scan = null;
		this.stopped = false;
	}

	getMacStrategy(deviceId) {
		if (this.homey.platform === 'cloud' || typeof deviceId !== 'string' || !deviceId.startsWith(COMPANY_ID)) return null;
		if (!/^[0-9a-f]{12}$/i.test(deviceId.slice(COMPANY_ID.length))) return null;
		try {
			const strategy = this.homey.discovery?.getStrategy('scinan_mac');
			return typeof strategy?.getDiscoveryResults === 'function' ? strategy : null;
		} catch {
			return null;
		}
	}

	getMacCandidate(deviceId) {
		const strategy = this.getMacStrategy(deviceId);
		if (!strategy) return null;
		const deviceMac = deviceId.slice(COMPANY_ID.length).toLowerCase();
		try {
			const results = strategy.getDiscoveryResults();
			for (const [id, result] of Object.entries(results || {})) {
				const mac = result?.mac || result?.id || id;
				if (typeof mac === 'string' && mac.replace(/[:-]/g, '').toLowerCase() === deviceMac
					&& isLocalAddress(result?.address)) return result.address;
			}
		} catch {
			return null;
		}
		return null;
	}

	waitForMacResults(deviceId, callback) {
		if (!this.getMacStrategy(deviceId)) return null;
		const timer = setTimeout(callback, MAC_DISCOVERY_WAIT);
		return () => clearTimeout(timer);
	}

	find(deviceId, callback) {
		const request = { deviceId: String(deviceId), callback, cancelled: false };
		if (this.stopped) return () => {};
		if (!DEVICE_ID.test(request.deviceId)) {
			this.notify(request, null);
			return () => { request.cancelled = true; };
		}
		const scan = this.scan || this.startScan();
		if (scan.observed.has(request.deviceId)) {
			this.notify(request, scan.observed.get(request.deviceId));
		} else {
			scan.requests.add(request);
		}
		return () => {
			request.cancelled = true;
			scan.requests.delete(request);
			if (scan.requests.size === 0) this.finishScan(scan);
		};
	}

	notify(request, address) {
		queueMicrotask(() => {
			if (!request.cancelled && !this.stopped) request.callback(address);
		});
	}

	startScan() {
		const scan = { requests: new Set(), observed: new Map(), ...createCancellation() };
		this.scan = scan;
		scan.timer = setTimeout(() => this.finishScan(scan), this.timeoutMs);
		queueMicrotask(() => this.scanSubnet(scan));
		return scan;
	}

	async scanSubnet(scan) {
		if (this.scan !== scan) return;
		let candidates;
		try {
			candidates = await getCandidates(this.homey);
		} catch (error) {
			this.finishScan(scan);
			return;
		}
		if (this.scan !== scan) return;
		let next = 0;
		const worker = async () => {
			while (this.scan === scan && next < candidates.length) {
				const host = candidates[next];
				next += 1;
				let probe;
				try {
					probe = await this.runProbe(host, scan.signal);
				} catch (error) {
					continue;
				}
				if (this.scan === scan) this.handleProbe(scan, host, probe);
			}
		};
		await Promise.all(Array.from({ length: Math.min(CONCURRENT_PROBES, candidates.length) }, worker));
		this.finishScan(scan);
	}

	handleProbe(scan, host, probe) {
		if (!probe || probe.host !== host || !SUPPORTED_TYPES.has(probe.deviceType)
			|| typeof probe.deviceId !== 'string' || !DEVICE_ID.test(probe.deviceId)) return;
		if (!scan.observed.has(probe.deviceId)) scan.observed.set(probe.deviceId, host);
		for (const request of scan.requests) {
			if (request.deviceId !== probe.deviceId) continue;
			scan.requests.delete(request);
			this.notify(request, host);
		}
		if (scan.requests.size === 0) this.finishScan(scan);
	}

	finishScan(scan) {
		if (this.scan !== scan) return;
		this.scan = null;
		clearTimeout(scan.timer);
		scan.abort();
		for (const request of scan.requests) this.notify(request, null);
		scan.requests.clear();
		scan.observed.clear();
	}

	stop() {
		this.stopped = true;
		if (this.scan) this.finishScan(this.scan);
	}
}

module.exports = { SaswellLanDiscovery, isLocalAddress };
