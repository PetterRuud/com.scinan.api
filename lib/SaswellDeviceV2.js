'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const { SaswellLanConnection, isLocalAddress } = require('./SaswellLanConnection');
const {
	getErrorMessage,
	getTimestamp,
	getStatus,
	createMD5HashForSign,
	sendNotification,
} = require('./Utils');
const {
	ERROR_CODES,
	CONTROL_URL_V2,
	USER_AGENT_V2,
	MODES,
	SENSORS,
	ENERGY_USAGE,
	APP_KEY,
	COMPANY_ID,
} = require('./Constants');

const LOCAL_ADDRESS_KEY = 'saswellLocalAddress';
const LAN_PROGRESS = {
	connecting: 'Trying a LAN connection',
	searching: 'Looking for a verified LAN address',
	manual: 'No verified LAN address found. Using cloud backup.',
	fallback: 'No verified LAN address found. Using cloud backup.',
	duplicate: 'Another Homey pairing is using the LAN connection. Using cloud backup.',
};

class SaswellDeviceV2 extends Homey.Device {
	async onInit() {
		if (this.settingsListener) return;
		this.device = this.getData();
		this.IMEI = this.homey.settings.get('macToImeiMD5');
		this.stateQueue = Promise.resolve();
		this.transportVersion = 0;
		this.localStatus = null;
		this.cloudAfter = 0;
		this.localAddress = this.getStoreValue(LOCAL_ADDRESS_KEY);
		this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
		this.registerCapabilityListener('target_temperature', this.onCapabilitySetTemperature.bind(this));
		this.registerCapabilityListener('mode', this.onCapabilitySetMode.bind(this));
		this.registerCapabilityListener('away', this.onCapabilitySetAway.bind(this));

		this.settingsListener = key => {
			if (['last APIv2 result', 'lastCloudFailureAt', 'tokenv2'].includes(key)) this.getDeviceData();
		};
		this.homey.settings.on('set', this.settingsListener);
		this.configureLan(this.getSettings());
		await this.getDeviceData();
	}

	configureLan(settings, preferManual = false) {
		const previous = this.lanConnection;
		this.lanConnection = null;
		if (previous) previous.stop();
		if (this.localReady || (!previous && this.localAddress && settings.localEnabled === true)) this.cloudAfter = Date.now();
		this.localReady = false;
		this.lastLanProgress = null;
		this.transportVersion += 1;
		this.homey.app.setDeviceCloudFallback(this, true);
		if (this.homey.platform === 'cloud' || typeof settings.localEnabled !== 'boolean') return;
		if (!settings.localEnabled) {
			this.logTransport('LAN', 'Disabled in device settings. Using cloud.');
			this.updateLanLabel('cloud');
			return;
		}

		const manual = typeof settings.localIp === 'string' ? settings.localIp.trim() : '';
		const addresses = preferManual ? [manual, this.localAddress] : [this.localAddress, manual];
		const connection = new SaswellLanConnection({
			homey: this.homey,
			deviceId: String(this.device.id),
			addresses,
			onState: (state, address, reason) => {
				if (this.lanConnection === connection) this.onLanState(state, address, reason);
			},
			onStatus: (status, awayPending) => {
				if (this.lanConnection === connection) this.onLanStatus(status, awayPending);
			},
			onAddress: address => {
				if (this.lanConnection === connection && address !== this.localAddress) {
					this.localAddress = address;
					this.queueState(async () => {
						if (this.settingsListener && this.localAddress === address) await this.setStoreValue(LOCAL_ADDRESS_KEY, address);
					});
				}
			},
		});
		this.lanConnection = connection;
		connection.start();
	}

	onLanState(state, address, reason) {
		const ready = state === 'local';
		if (ready !== this.localReady) {
			this.localReady = ready;
			this.lastLanProgress = null;
			this.transportVersion += 1;
			const detail = reason ? ` (${reason})` : '';
			this.logTransport('LAN', ready ? 'Verified thermostat connection' : `Connection lost${detail}. Falling back to cloud.`);
			if (!ready) this.cloudAfter = Date.now();
			this.homey.app.setDeviceCloudFallback(this, !ready);
			if (!ready) this.getDeviceData();
		} else if (!ready) {
			const progress = reason ? `Connection attempt failed (${reason}).` : LAN_PROGRESS[state];
			if (progress && progress !== this.lastLanProgress) {
				this.lastLanProgress = progress;
				this.logTransport('LAN', progress);
			}
		}
		this.updateLanLabel(state, address);
	}

	updateLanLabel(state, address = '') {
		const label = this.homey.__(`lan.${state}`, { address });
		if (this.localStatus === label) return;
		this.localStatus = label;
		clearImmediate(this.localStatusImmediate);
		this.localStatusImmediate = setImmediate(() => {
			this.localStatusImmediate = null;
			this.queueState(async () => {
				if (this.settingsListener && this.localStatus === label) await this.setSettings({ localStatus: label });
			});
		});
	}

	onLanStatus(status, awayPending) {
		this.lastLocalStatusAt = Date.now();
		const version = this.transportVersion;
		this.queueState(async () => {
			const isCurrent = () => this.settingsListener && this.localReady && version === this.transportVersion;
			if (!isCurrent()) return;
			if (!this.getAvailable()) await this.setAvailable();
			await this.applyStatus(status, isCurrent, 'LAN', awayPending);
		});
	}

	logTransport(transport, message) {
		this.log(`[${transport}] [${this.getName()}] ${message}`);
	}

	queueState(update) {
		this.stateQueue = this.stateQueue.then(update).catch(error => {
			this.error('Unable to synchronize thermostat state:', getErrorMessage(error));
		});
		return this.stateQueue;
	}

	setCloudUnavailable(message) {
		const version = this.transportVersion;
		return this.queueState(async () => {
			if (this.settingsListener && !this.localReady && version === this.transportVersion) {
				await this.setUnavailable(message);
			}
		});
	}

	getParsedApiResult() {
		const result = this.homey.settings.get('last APIv2 result');
		if (!result) return null;
		if (typeof result === 'string') {
			try {
				return JSON.parse(result);
			} catch (error) {
				this.error('Stored APIv2 result is not JSON:', getErrorMessage(error));
				return null;
			}
		}
		return result;
	}

	findDeviceInResult(result) {
		const groups = Array.isArray(result?.result_data) ? result.result_data : [];
		for (const group of groups) {
			const devices = Array.isArray(group?.devices) ? group.devices : [];
			const match = devices.find(dev => String(dev.id) === String(this.device.id));
			if (match) return match;
		}
		return null;
	}

	getApiErrorMessage(resultCode) {
		return ERROR_CODES[resultCode] || `API returned result_code ${resultCode || 'unknown'}`;
	}

	async setCapabilityValueIfPresent(capability, value) {
		if (!this.hasCapability(capability) || this.getCapabilityValue(capability) === value) return false;
		try {
			await this.setCapabilityValue(capability, value);
			return true;
		} catch (error) {
			this.error(`Unable to set capability ${capability}:`, getErrorMessage(error));
			return false;
		}
	}

	getDeviceData() {
		const version = this.transportVersion;
		return this.queueState(async () => {
			const isCurrent = () => this.settingsListener && !this.localReady && version === this.transportVersion;
			if (isCurrent()) await this.applyCloudResult(isCurrent);
		});
	}

	async applyCloudResult(isCurrent) {
		if (!this.homey.settings.get('tokenv2')) {
			await this.setUnavailable(this.homey.__('lan.cloudUnavailable'));
			return;
		}
		const receivedAt = this.homey.app.getCloudResultReceivedAt();
		const failedAt = Number(this.homey.settings.get('lastCloudFailureAt')) || 0;
		if (this.lastLocalStatusAt && failedAt > receivedAt && failedAt >= this.cloudAfter) {
			await this.setUnavailable(this.homey.__('lan.cloudUnreachable'));
			return;
		}
		if (receivedAt < this.cloudAfter) return;

		const result = this.getParsedApiResult();
		if (!result) {
			if (!this.lastLocalStatusAt) await this.setUnavailable('Waiting for API data.');
			return;
		}

		if (String(result.result_code) !== '0') {
			const message = this.getApiErrorMessage(result.result_code);
			await this.setUnavailable(message);
			if (isCurrent() && String(result.result_code) === '10003' && !this.notifiedExpiredToken) {
				this.notifiedExpiredToken = true;
				await sendNotification(this.homey, `Your token for device ${this.getName()} has expired. Please re-authenticate.`);
			}
			return;
		}
		this.notifiedExpiredToken = false;
		const currentDevice = this.findDeviceInResult(result);
		if (!currentDevice) {
			await this.setUnavailable(this.homey.__('lan.cloudDeviceMissing'));
			return;
		}

		if (String(currentDevice.online) === '1') {
			await this.setAvailable();
		} else {
			await this.setUnavailable('Device is offline');
		}

		const status = getStatus(currentDevice.s00 || currentDevice.status);
		if (this.lastLocalStatusAt && status.time.getTime() < this.lastLocalStatusAt) return;
		await this.applyStatus(status, isCurrent, 'Cloud');
	}

	async applyStatus(status, isCurrent, transport, awayPending = false) {
		const floorArea = Number(this.getSetting('m2')) || 0;
		const measurePower = status.onoff ? ENERGY_USAGE * floorArea : 0;
		const onOffCapabilityMirrorsAway = Boolean(this.getSetting('onOffCapability'));
		const values = {
			target_temperature: status.target_temperature,
			measure_temperature: status.measure_temperature,
			mode: this.valueToMode(status.mode),
			away: status.away,
			onoff: onOffCapabilityMirrorsAway ? !status.away : status.onoff,
			measure_power: measurePower,
		};
		const changed = [];
		for (const [capability, value] of Object.entries(values)) {
			if (!isCurrent()) break;
			if (awayPending && (capability === 'away' || (onOffCapabilityMirrorsAway && capability === 'onoff'))) continue;
			if (await this.setCapabilityValueIfPresent(capability, value)) changed.push(`${capability}=${value}`);
		}
		if (changed.length) this.logTransport(transport, `Applied thermostat status (${changed.join(', ')})`);
	}

	async updateCapabilityValues(capability, value, request = `${capability}=${value}`) {
		const listener = this.settingsListener;
		const ensureActive = () => {
			if (!listener || this.settingsListener !== listener) throw new Error(this.homey.__('lan.deviceInactive'));
		};
		ensureActive();
		const sensorId = this.getSensorId(capability);
		const controlData = this.getControlData(capability, value);
		if (!sensorId || !controlData) {
			throw new Error(this.homey.__('lan.commandUnsupported'));
		}
		this.logTransport('Homey', `Requested ${request}`);
		if (this.localReady && this.lanConnection) {
			const result = await this.lanConnection.sendCommand(capability, controlData.value);
			ensureActive();
			if (result === 'confirmed') {
				this.logTransport('LAN', `Thermostat confirmed ${capability} command`);
				return;
			}
			if (result === 'unconfirmed') {
				this.logTransport('LAN', `Thermostat did not confirm ${capability} command`);
				throw new Error(this.homey.__('lan.commandUnconfirmed'));
			}
		}

		const params = {
			app_key: APP_KEY,
			company_id: COMPANY_ID,
			control_data: JSON.stringify(controlData),
			device_id: this.device.id,
			imei: this.IMEI || this.homey.settings.get('macToImeiMD5'),
			sensor_id: sensorId,
			sensor_type: 1,
			timestamp: getTimestamp(),
			token: this.homey.settings.get('tokenv2'),
		};

		if (!params.token) {
			const message = this.homey.__('lan.cloudUnavailable');
			await this.setCloudUnavailable(message);
			throw new Error(message);
		}

		params.sign = await createMD5HashForSign(params);
		const body = new URLSearchParams();
		for (const [key, paramValue] of Object.entries(params)) {
			body.append(key, paramValue);
		}
		ensureActive();

		let result;
		this.logTransport('Cloud', `Sending ${capability} command`);
		try {
			const response = await fetch(CONTROL_URL_V2, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent': USER_AGENT_V2,
				},
				body,
				redirect: 'follow',
				timeout: 10000,
			});

			if (!response.ok) {
				throw new Error(`Control API returned HTTP ${response.status}`);
			}

			result = await response.json();
		} catch (error) {
			this.error('Unable to update capability:', getErrorMessage(error));
			await this.setCloudUnavailable(error.message || 'Control API call failed');
			throw error;
		}
		ensureActive();
		if (String(result.result_code) !== '0') {
			const message = this.getApiErrorMessage(result.result_code);
			this.logTransport('Cloud', `Saswell rejected ${capability} command`);
			await this.setCloudUnavailable(message);
			throw new Error(message);
		}
		this.logTransport('Cloud', `Saswell accepted ${capability} command`);
		if (['away', 'mode', 'onoff'].includes(capability)) {
			this.homey.app.APIv2().catch(this.error.bind(this));
		}
	}

	getSensorId(capability) {
		switch (capability) {
			case 'onoff': return SENSORS.ON_OFF;
			case 'target_temperature': return SENSORS.TARGET_TEMPERATURE;
			case 'mode': return SENSORS.MODE;
			case 'away': return SENSORS.AWAY;
			default: return null;
		}
	}

	getControlData(capability, value) {
		switch (capability) {
			case 'onoff':
			case 'away':
				return { value: value ? '1' : '0' };
			case 'target_temperature':
				return { value: Number(value).toFixed(1).padStart(4, '0') };
			case 'mode':
				return { value: String(this.modeToValue(value)) };
			default:
				return null;
		}
	}

	async onCapabilityOnOff(value) {
		if (this.getSetting('onOffCapability')) {
			return this.updateCapabilityValues('away', !value, `onoff=${value} mapped to away=${!value}`);
		}
		return this.updateCapabilityValues('onoff', value);
	}

	async onCapabilitySetTemperature(value) {
		return this.updateCapabilityValues('target_temperature', value);
	}

	async onCapabilitySetMode(value) {
		return this.updateCapabilityValues('mode', value);
	}

	async onCapabilitySetAway(value) {
		return this.updateCapabilityValues('away', value);
	}

	modeToValue(value) {
		if (value === MODES.COMFORT) return 0;
		if (value === MODES.AUTO) return 1;
		if (value === MODES.DAY_OR_NIGHT) return 2;
		return 0;
	}

	valueToMode(mode) {
		if (mode === 0) return MODES.COMFORT;
		if (mode === 1) return MODES.AUTO;
		return MODES.DAY_OR_NIGHT;
	}

	onAdded() {
		this.log('device added');
		const counter = Number(this.homey.settings.get('deviceCounter')) || 0;
		this.homey.settings.set('deviceCounter', counter + 1);
	}

	onRenamed(name) {
		this.log(`${name} renamed`);
	}

	async onSettings({ newSettings, changedKeys }) {
		const ipChanged = changedKeys.includes('localIp');
		const manual = typeof newSettings.localIp === 'string' ? newSettings.localIp.trim() : '';
		if (ipChanged && manual && !isLocalAddress(manual)) {
			throw new Error(this.homey.__('lan.invalidAddress'));
		}
		if (ipChanged || changedKeys.includes('localEnabled')) {
			this.configureLan(newSettings, ipChanged);
			this.getDeviceData();
		}
	}

	onUninit() {
		if (!this.settingsListener) return;
		this.homey.settings.removeListener('set', this.settingsListener);
		this.settingsListener = null;
		clearImmediate(this.localStatusImmediate);
		this.localStatusImmediate = null;
		if (this.lanConnection) this.lanConnection.stop();
		this.lanConnection = null;
		this.localReady = false;
		this.transportVersion += 1;
		this.homey.app.removeDeviceCloudFallback(this);
	}

	onDeleted() {
		this.log(`${this.getName()} deleted`);
		this.onUninit();
		const counter = Math.max(0, (Number(this.homey.settings.get('deviceCounter')) || 0) - 1);
		this.homey.settings.set('deviceCounter', counter);
	}
}

module.exports = SaswellDeviceV2;
