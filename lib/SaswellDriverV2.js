'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {
	getTimestamp,
	getStatus,
	createMD5Hash,
	createMD5HashForSign,
	sendNotification,
} = require('./Utils');
const {
	AUTHORIZATION_URL_V2,
	LIST_URL_V2,
	COMPANY_ID,
	APP_KEY,
	USER_AGENT_V2,
	ERROR_CODES,
} = require('./Constants');

const LEGACY_PAIRING_MESSAGE = 'Smart-E / Scinan v1 pairing is no longer supported because the v1 servers are unavailable. Use the Saswell v2 thermostat driver if your thermostat is listed there.';

class SaswellDriverV2 extends Homey.Driver {
	onInit() {
		this.IMEI = this.homey.settings.get('macToImeiMD5');
	}

	async onPair(session) {
		session.setHandler('login', async data => {
			try {
				if (this.isLegacyDriver()) return LEGACY_PAIRING_MESSAGE;
				if (!data.username || !data.password) return 'Username and password are required';

				const md5Password = await createMD5Hash(data.password);
				await this.homey.settings.set('md5Password', md5Password);
				await this.getTokenV2(data.username, md5Password);
				await this.homey.settings.set('usernamev2', data.username);
				return true;
			} catch (error) {
				this.error('Pair login failed:', error);
				return error.message || 'Unable to log in';
			}
		});

		session.setHandler('list_devices', async () => {
			try {
				return await this.fetchDevices();
			} catch (error) {
				this.error('Unable to list devices:', error);
				throw new Error(error.message || 'Unable to list devices');
			}
		});

		session.setHandler('showView', async view => {
			if (view !== 'loading') return;
			const { username, password } = await this.retrieveCredentials();
			setTimeout(() => {
				Promise.resolve(session.showView(username && password ? 'list_my_devices' : 'start')).catch(this.error.bind(this));
			}, 500);
		});
	}

	isLegacyDriver() {
		return String(this.constructor.APIVersion) === '1';
	}

	async retrieveCredentials() {
		const username = this.homey.settings.get('usernamev2');
		const password = this.homey.settings.get('md5Password');
		if (!username || !password) return {};
		return { username, password };
	}

	async onRepair(session) {
		this.log('Initiating repair...');
		session.setHandler('login', async data => {
			try {
				if (!data.username || !data.password) return 'Username and password are required';
				const md5Password = await createMD5Hash(data.password);
				await this.homey.settings.set('md5Password', md5Password);
				await this.getTokenV2(data.username, md5Password);
				await this.homey.settings.set('usernamev2', data.username);
				this.resetRepairFlags();
				this.homey.app.APIv2().catch(this.error.bind(this));
				return true;
			} catch (error) {
				this.error('Repair login failed:', error);
				return error.message || 'Unable to repair device';
			}
		});
	}

	resetRepairFlags() {
		for (const key of this.homey.settings.getKeys()) {
			if ((key.startsWith('expToken') || key.endsWith(' need repair')) && this.homey.settings.get(key) === true) {
				this.homey.settings.set(key, false);
			}
		}
		this.homey.settings.set('APIv2 result_code <> 0', false);
	}

	async getToken(username, password, md5Password) {
		if (this.isLegacyDriver()) {
			throw new Error(LEGACY_PAIRING_MESSAGE);
		}
		if (!username || !password) {
			throw new Error('Username and password are required');
		}
		return this.getTokenV2(username, md5Password || await createMD5Hash(password));
	}

	async getTokenV2(username, md5Password) {
		const params = {
			account: username,
			app_key: APP_KEY,
			company_id: COMPANY_ID,
			imei: this.homey.settings.get('macToImeiMD5') || this.IMEI,
			password: md5Password,
			timestamp: getTimestamp(),
		};
		params.sign = await createMD5HashForSign(params);

		const body = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			body.append(key, value);
		}

		const response = await fetch(AUTHORIZATION_URL_V2, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': USER_AGENT_V2,
			},
			body,
			redirect: 'follow',
		});

		let responseData;
		try {
			responseData = await response.json();
		} catch (error) {
			throw new Error(`Authentication returned non-JSON response (${response.status})`);
		}

		if (!response.ok) {
			throw new Error(`Authentication failed with HTTP ${response.status}`);
		}
		if (responseData.result_code !== '0') {
			const message = ERROR_CODES[responseData.result_code] || 'Unknown authentication error';
			await sendNotification(this.homey, `Error fetching token: ${message}`);
			throw new Error(message);
		}

		const token = responseData.resultData?.access_token;
		if (!token) throw new Error('Authentication response did not include a token');

		this.homey.settings.set('tokenv2', token);
		return token;
	}

	async fetchDevices() {
		if (this.isLegacyDriver()) {
			throw new Error(LEGACY_PAIRING_MESSAGE);
		}

		const token = this.homey.settings.get('tokenv2');
		if (!token) throw new Error('Missing Saswell v2 token. Please log in again.');

		const params = {
			app_key: APP_KEY,
			company_id: COMPANY_ID,
			imei: this.homey.settings.get('macToImeiMD5') || this.IMEI,
			timestamp: getTimestamp(),
			token,
		};
		params.sign = await createMD5HashForSign(params);

		const body = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			body.append(key, value);
		}

		const response = await fetch(LIST_URL_V2, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': USER_AGENT_V2,
			},
			body,
			redirect: 'follow',
		});

		let result;
		try {
			result = await response.json();
		} catch (error) {
			throw new Error(`Device list returned non-JSON response (${response.status})`);
		}

		if (!response.ok) throw new Error(`Device list failed with HTTP ${response.status}`);
		if (result.result_code !== '0') {
			throw new Error(ERROR_CODES[result.result_code] || `Device list failed with result_code ${result.result_code}`);
		}

		const devices = [];
		const groups = Array.isArray(result.result_data) ? result.result_data : [];
		for (const group of groups) {
			const apiDevices = Array.isArray(group.devices) ? group.devices : [];
			for (const device of apiDevices) {
				const status = getStatus(device.s00 || device.status);
				devices.push({
					name: device.title || device.id,
					data: { id: device.id },
					store: {
						about: device.about,
						company_id: device.company_id,
						create_time: device.create_time,
						device_module: device.device_module,
						door_type: device.door_type,
						gps_name: device.gps_name,
						mstype: device.mstype,
						public_type: device.public_type,
						type: device.type,
						update_time: device.update_time,
					},
					capabilitiesOptions: {
						target_temperature: {
							min: status.min_temp,
							max: status.max_temp,
						},
					},
				});
				this.homey.settings.set(`APIVersion_${device.id}`, '2');
			}
		}

		return devices;
	}
}

module.exports = SaswellDriverV2;
