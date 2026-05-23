'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {
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

const LEGACY_API_MESSAGE = 'Smart-E / Scinan v1 is no longer available. Re-pair this thermostat with the Saswell v2 driver if the device is available there.';

class SaswellDeviceV2 extends Homey.Device {
	async onInit() {
		this.device = this.getData();
		this.IMEI = this.homey.settings.get('macToImeiMD5');
		this.summary = { interval: this.homey.settings.get('u_interval') || 15 };

		const apiVersion = await this.resolveApiVersion();
		await this.safeSetSettings({ apiVersion });

		this.log(`[${this.getName()}] Connected to device - ID: ${this.device.id}, API v${apiVersion}`);
		this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
		this.registerCapabilityListener('target_temperature', this.onCapabilitySetTemperature.bind(this));
		this.registerCapabilityListener('mode', this.onCapabilitySetMode.bind(this));
		this.registerCapabilityListener('away', this.onCapabilitySetAway.bind(this));

		if (apiVersion === '1') {
			await this.setLegacyUnavailable();
		} else {
			await this.getDeviceData();
		}

		this.settingsListener = (key, value) => {
			if (key === 'last APIv2 result') {
				this.getDeviceData().catch(this.error.bind(this));
			}
			if (key === 'u_interval') {
				this.summary.interval = value;
			}
		};
		this.homey.settings.on('set', this.settingsListener);
	}

	async resolveApiVersion() {
		const storedVersion = this.homey.settings.get(`APIVersion_${this.getData().id}`);
		const driverVersion = this.constructor.APIVersion || this.driver.constructor.APIVersion;
		const driverName = this.driver.constructor.driverName;

		if (driverName === 'SASWELL_THERMOSTAT') {
			return '2';
		}

		if (driverVersion === '1' && this.homey.settings.get('tokenv2')) {
			this.log(`[${this.getName()}] Legacy Smart-E device has v2 credentials; using API v2.`);
			return '2';
		}

		return String(storedVersion || driverVersion || '2');
	}

	async safeSetSettings(settings) {
		try {
			await this.setSettings(settings);
		} catch (error) {
			this.error('Unable to update device settings:', error);
		}
	}

	async setLegacyUnavailable() {
		try {
			await this.setUnavailable(LEGACY_API_MESSAGE);
		} catch (error) {
			this.error('Unable to mark legacy Smart-E device unavailable:', error);
		}
	}

	getParsedApiResult() {
		const result = this.homey.settings.get('last APIv2 result');
		if (!result) return null;
		if (typeof result === 'string') {
			try {
				return JSON.parse(result);
			} catch (error) {
				this.error('Stored APIv2 result is not JSON:', error);
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
		if (!this.hasCapability(capability)) return;
		try {
			await this.setCapabilityValue(capability, value);
		} catch (error) {
			this.error(`Unable to set capability ${capability}:`, error);
		}
	}

	async setUpdateInterval() {
		clearInterval(this.interval);
		const intervalMinutes = Math.max(5, Number(this.summary.interval || this.homey.settings.get('u_interval') || 15));
		this.interval = setInterval(() => {
			this.getDeviceData().catch(this.error.bind(this));
		}, intervalMinutes * 60 * 1000);
	}

	async getDeviceData() {
		const apiVersion = await this.getSetting('apiVersion');
		if (apiVersion === '1') {
			await this.setLegacyUnavailable();
			return;
		}

		const result = this.getParsedApiResult();
		if (!result) {
			await this.setUnavailable('Waiting for API data.');
			if (this.homey.settings.get('tokenv2')) {
				this.homey.app.APIv2().catch(this.error.bind(this));
			}
			return;
		}

		if (result.result_code !== '0') {
			const message = this.getApiErrorMessage(result.result_code);
			this.log(`APIv2 returned ${result.result_code}: ${message}`);
			await this.setUnavailable(message);
			if (result.result_code === '10003') {
				await sendNotification(this.homey, `Your token for device ${this.getName()} has expired. Please re-authenticate.`);
			}
			return;
		}

		const currentDevice = this.findDeviceInResult(result);
		if (!currentDevice) {
			await this.setUnavailable('Device was not returned by the API.');
			return;
		}

		if (String(currentDevice.online) === '1') {
			await this.setAvailable();
		} else {
			await this.setUnavailable('Device is offline');
		}

		const status = getStatus(currentDevice.s00 || currentDevice.status);
		const floorArea = Number(this.getSetting('m2')) || 0;
		const measurePower = status.onoff ? ENERGY_USAGE * floorArea : 0;
		const onOffCapabilityMirrorsAway = Boolean(this.getSetting('onOffCapability'));

		await this.setCapabilityValueIfPresent('target_temperature', status.target_temperature);
		await this.setCapabilityValueIfPresent('measure_temperature', status.measure_temperature);
		await this.setCapabilityValueIfPresent('mode', this.valueToMode(status.mode));
		await this.setCapabilityValueIfPresent('away', status.away);
		await this.setCapabilityValueIfPresent('onoff', onOffCapabilityMirrorsAway ? !status.away : status.onoff);
		await this.setCapabilityValueIfPresent('measure_power', measurePower);
	}

	async updateCapabilityValues(capability, value) {
		const apiVersion = await this.getSetting('apiVersion');
		if (apiVersion === '1') {
			await this.setLegacyUnavailable();
			return { result_code: 'legacy_disabled', result_message: LEGACY_API_MESSAGE };
		}

		const sensorId = this.getSensorId(capability);
		const controlData = this.getControlData(capability, value);
		if (!sensorId || !controlData) {
			return { result_code: 'unsupported_capability' };
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
			await this.setUnavailable('Missing Saswell v2 token. Please repair the device.');
			return { result_code: 'missing_token' };
		}

		params.sign = await createMD5HashForSign(params);
		const body = new URLSearchParams();
		for (const [key, paramValue] of Object.entries(params)) {
			body.append(key, paramValue);
		}

		try {
			const response = await fetch(CONTROL_URL_V2, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent': USER_AGENT_V2,
				},
				body,
				redirect: 'follow',
			});

			if (!response.ok) {
				throw new Error(`Control API returned HTTP ${response.status}`);
			}

			const result = await response.json();
			if (result.result_code !== '0') {
				const message = this.getApiErrorMessage(result.result_code);
				await this.setUnavailable(message);
				return result;
			}

			if (['away', 'mode', 'onoff'].includes(capability)) {
				this.homey.app.APIv2().catch(this.error.bind(this));
			}

			return result;
		} catch (error) {
			this.error('Unable to update capability:', error);
			await this.setUnavailable(error.message || 'Control API call failed');
			return { result_code: 'request_failed', result_message: error.message };
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
		const onOffCapabilityMirrorsAway = Boolean(this.getSetting('onOffCapability'));
		return this.updateCapabilityValues(onOffCapabilityMirrorsAway ? 'away' : 'onoff', onOffCapabilityMirrorsAway ? !value : value);
	}

	async onCapabilitySetTemperature(value) {
		const result = await this.updateCapabilityValues('target_temperature', value);
		if (result.result_code && result.result_code !== '0') {
			this.log(`Temperature set failed, result_code: ${result.result_code}`);
		}
		return result;
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
		const apiVersion = this.getSetting('apiVersion') || this.constructor.APIVersion || '2';
		this.homey.settings.set(`APIVersion_${this.getData().id}`, String(apiVersion));

		if (!this.homey.settings.get('firstDeviceAdded')) {
			this.homey.app.firstDeviceAdded();
		} else if (apiVersion === '2') {
			this.homey.app.APIv2().catch(this.error.bind(this));
		}

		const counter = Number(this.homey.settings.get('deviceCounter')) || 0;
		this.homey.settings.set('deviceCounter', counter + 1);
	}

	onRenamed(name) {
		this.log(`${name} renamed`);
	}

	async onSettings({ oldSettings, newSettings, changedKeys }) {
		if (changedKeys.includes('interval')) {
			this.log(`Interval changed from ${oldSettings.interval} to ${newSettings.interval}`);
			this.summary.interval = newSettings.interval;
			await this.setUpdateInterval();
		}
	}

	onDeleted() {
		this.log(`${this.getName()} deleted`);
		clearInterval(this.interval);
		if (this.settingsListener && this.homey.settings.removeListener) {
			this.homey.settings.removeListener('set', this.settingsListener);
		}
		const counter = Math.max(0, (Number(this.homey.settings.get('deviceCounter')) || 0) - 1);
		this.homey.settings.set('deviceCounter', counter);
	}
}

module.exports = SaswellDeviceV2;
