'use strict';

const EventEmitter = require('events');
const net = require('net');
const { SENSORS } = require('./Constants');

const PORT = 2000;
const MAX_LINE_BYTES = 512;
const SUPPORTED_TYPES = new Set(['9']);
const DEVICE_ID = /^[A-Za-z0-9]{16}$/;
const FRAME = /^\/([A-Za-z0-9]{16})\/(type|S[0-9A-F]{2}|SPOLL)\/1\/([\x20-\x2e\x30-\x7e]+)$/;
const NUMBER = /^-?\d{1,3}(?:\.\d{1,3})?$/;
const INTEGER = /^-?\d+$/;
const MODE = /^[012]$/;
const BIT = /^[01]$/;
const COMMANDS = new Map([
	['target_temperature', `S${SENSORS.TARGET_TEMPERATURE}`],
	['away', `S${SENSORS.AWAY}`],
	['mode', `S${SENSORS.MODE}`],
]);

function readLines(onLine, onOverflow) {
	let partial = '';
	return chunk => {
		let offset = 0;
		while (offset < chunk.length) {
			const newline = chunk.indexOf(10, offset);
			const end = newline === -1 ? chunk.length : newline;
			if (partial.length + end - offset > MAX_LINE_BYTES) {
				onOverflow();
				return;
			}
			partial += chunk.toString('latin1', offset, end);
			if (newline === -1) return;
			const line = partial.endsWith('\r') ? partial.slice(0, -1) : partial;
			partial = '';
			if (!onLine(line)) return;
			offset = end + 1;
		}
	};
}

function parseFrame(line) {
	const match = FRAME.exec(line);
	if (!match || match[0] !== line) return null;
	const [, deviceId, code, data] = match;
	return { deviceId, code, data };
}

function parseNumber(value) {
	return NUMBER.test(value) ? Number(value) : NaN;
}

function parseStatus(data, deviceType) {
	const fields = data.split(',');
	if (![9, 11, 12].includes(fields.length)) return null;
	const [power, current, target, unit, away, program, fan, run, mode, minimum = '5', maximum = '35', modeType = '0'] = fields;
	if (unit !== '0' || ![power, away, program].every(value => BIT.test(value)) || !MODE.test(mode)) return null;
	if (![fan, run, modeType].every(value => INTEGER.test(value))) return null;
	const [measure_temperature, target_temperature, min_temp, max_temp] = [current, target, minimum, maximum].map(parseNumber);
	if (![measure_temperature, target_temperature, min_temp, max_temp].every(Number.isFinite) || min_temp > max_temp) return null;
	return {
		deviceType,
		onoff: power === '1',
		measure_temperature,
		target_temperature,
		away: away === '1',
		mode: Number(mode),
		min_temp,
		max_temp,
	};
}

function prepareCommand(capability, value, status) {
	const requested = String(value);
	const code = COMMANDS.get(capability);
	if (capability === 'target_temperature') {
		const temperature = parseNumber(requested);
		if (!Number.isFinite(temperature)) return null;
		const lowestStep = Math.ceil(status.min_temp * 2);
		const highestStep = Math.floor(status.max_temp * 2);
		if (lowestStep > highestStep) return null;
		const normalized = Math.min(highestStep, Math.max(lowestStep, Math.round(temperature * 2))) / 2;
		return {
			code,
			data: normalized.toFixed(1).padStart(4, '0'),
			matches: updated => updated.target_temperature === normalized && !updated.away,
		};
	}
	if (capability === 'away' && BIT.test(requested)) {
		return { code, data: requested, matches: updated => updated.away === (requested === '1') };
	}
	if (capability === 'mode' && MODE.test(requested)) {
		return { code, data: requested, matches: updated => updated.mode === Number(requested) };
	}
	return null;
}

function probeThermostat({ host, deviceId, port = PORT, timeoutMs = 750, signal }) {
	if (!net.isIPv4(host) || (signal && signal.aborted)) return Promise.resolve(null);
	const expectedId = deviceId === undefined ? undefined : String(deviceId);
	return new Promise(resolve => {
		const socket = new net.Socket();
		let settled = false;
		const finish = result => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal) signal.removeEventListener('abort', cancel);
			socket.destroy();
			resolve(result);
		};
		const cancel = () => finish(null);
		const timer = setTimeout(cancel, timeoutMs);
		if (signal) signal.addEventListener('abort', cancel, { once: true });
		socket.once('error', cancel);
		socket.once('close', cancel);
		socket.on('data', readLines(line => {
			const frame = parseFrame(line);
			if (frame && frame.code === 'type' && SUPPORTED_TYPES.has(frame.data)
				&& (expectedId === undefined || frame.deviceId === expectedId)) {
				finish({ host, deviceId: frame.deviceId, deviceType: frame.data });
			} else {
				finish(null);
			}
			return false;
		}, cancel));
		try {
			socket.connect({ host, port });
		} catch (error) {
			cancel();
		}
	});
}

class SaswellLocalClient extends EventEmitter {
	constructor({ host, deviceId, port = PORT, connectTimeoutMs = 3000, heartbeatMs = 8000,
		statusTimeoutMs = 30000, commandTimeoutMs }) {
		super();
		this.host = host;
		this.deviceId = String(deviceId);
		this.port = port;
		this.connectTimeoutMs = connectTimeoutMs;
		this.heartbeatMs = heartbeatMs;
		this.statusTimeoutMs = statusTimeoutMs;
		this.commandTimeoutMs = commandTimeoutMs;
		this.session = null;
	}

	start() {
		if (this.session) return;
		if (!net.isIPv4(this.host) || !DEVICE_ID.test(this.deviceId)) {
			this.emit('disconnect', { reason: 'invalid_endpoint', identified: false });
			return;
		}
		const socket = new net.Socket();
		const session = { socket, queue: Promise.resolve(), status: null, deviceType: null };
		this.session = session;
		session.helloTimer = setTimeout(() => this.closeSession(session, 'hello_timeout'), this.connectTimeoutMs);
		socket.once('error', () => this.closeSession(session, 'connection_error'));
		socket.once('close', () => this.closeSession(session, 'closed'));
		socket.on('data', readLines(line => this.receiveLine(session, line),
			() => this.closeSession(session, 'frame_too_large')));
		try {
			socket.connect({ host: this.host, port: this.port });
		} catch (error) {
			this.closeSession(session, 'connection_error');
		}
	}

	stop() {
		if (this.session) this.closeSession(this.session);
	}

	isReady() {
		return Boolean(this.session && this.session.status && this.session.socket.writable);
	}

	sendCommand(capability, value) {
		if (!COMMANDS.has(capability)) return Promise.resolve('unsupported');
		const session = this.session;
		if (!this.isReady()) return Promise.resolve('unavailable');
		const result = session.queue.then(() => this.runCommand(session, capability, value));
		session.queue = result;
		return result;
	}

	runCommand(session, capability, value) {
		if (this.session !== session || !this.isReady()) return 'unavailable';
		const command = prepareCommand(capability, value, session.status);
		if (!command) return 'unconfirmed';
		const timeoutMs = this.commandTimeoutMs ?? (capability === 'away' ? 5000 : 1500);
		return new Promise(resolve => {
			let timer;
			const finish = result => {
				clearTimeout(timer);
				const deferredAway = session.command.deferredAway;
				session.command = null;
				resolve(result);
				if (result === 'unconfirmed' && deferredAway && this.session === session) this.emit('status', session.status);
			};
			session.command = { capability, matches: command.matches, finish, deferredAway: false };
			timer = setTimeout(() => {
				timer = setTimeout(() => finish('unconfirmed'), timeoutMs);
				this.write(session, 'S00', '-1');
			}, timeoutMs);
			this.write(session, command.code, command.data);
		});
	}

	receiveLine(session, line) {
		if (this.session !== session) return false;
		const frame = parseFrame(line);
		if (!session.deviceType || (frame && frame.code === 'type')) {
			return this.receiveHello(session, frame);
		}
		if (!frame || frame.deviceId !== this.deviceId || frame.code !== 'S00') return true;
		const status = parseStatus(frame.data, session.deviceType);
		if (!status) return true;
		session.status = status;
		clearTimeout(session.initialStatusRetry);
		this.armStatusDeadline(session);
		if (session.command && session.command.matches(status)) session.command.finish('confirmed');
		const awayPending = session.command?.capability === 'away';
		if (awayPending) session.command.deferredAway = true;
		this.emit('status', status, awayPending);
		return this.session === session;
	}

	receiveHello(session, frame) {
		if (!frame || frame.code !== 'type') return this.closeSession(session, 'invalid_hello');
		if (frame.deviceId !== this.deviceId) return this.closeSession(session, 'wrong_device');
		if (!SUPPORTED_TYPES.has(frame.data)) return this.closeSession(session, 'unsupported_type');
		if (session.deviceType) return true;
		session.deviceType = frame.data;
		clearTimeout(session.helloTimer);
		this.armStatusDeadline(session);
		session.heartbeat = setInterval(() => this.write(session, 'SPOLL', '1'), this.heartbeatMs);
		session.initialStatusRetry = setTimeout(() => this.write(session, 'S00', '-1'), this.heartbeatMs);
		this.write(session, 'S00', '-1');
		return this.session === session;
	}

	armStatusDeadline(session) {
		clearTimeout(session.statusTimer);
		clearTimeout(session.statusRefreshTimer);
		if (session.status) {
			session.statusRefreshTimer = setTimeout(() => this.write(session, 'S00', '-1'), this.statusTimeoutMs * 0.75);
		}
		session.statusTimer = setTimeout(() => this.closeSession(session, 'status_timeout'), this.statusTimeoutMs);
	}

	write(session, code, data) {
		if (this.session !== session) return;
		try {
			session.socket.write(`/${this.deviceId}/${code}/1/${data}\r\n`, 'ascii');
		} catch (error) {
			this.closeSession(session, 'connection_error');
		}
	}

	closeSession(session, reason) {
		if (this.session !== session) return false;
		this.session = null;
		clearTimeout(session.helloTimer);
		clearTimeout(session.statusTimer);
		clearTimeout(session.statusRefreshTimer);
		clearTimeout(session.initialStatusRetry);
		clearInterval(session.heartbeat);
		if (session.command) session.command.finish('unconfirmed');
		session.socket.destroy();
		if (reason) this.emit('disconnect', { reason, identified: Boolean(session.deviceType) });
		return false;
	}
}

module.exports = { SaswellLocalClient, probeThermostat, SUPPORTED_TYPES };
