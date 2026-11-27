'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {
	getErrorMessage,
	getTimestamp,
	getStatus,
	createMD5Hash,
	createMD5HashForSign,
	sendNotification,
} = require('./Utils');
const {
	AUTHORIZATION_URL_V2,
	COMPANY_ID,
	APP_KEY,
	USER_AGENT_V2,
	ERROR_CODES,
} = require('./Constants');

class SaswellDriverV2 extends Homey.Driver {
	onInit() {
		this.IMEI = this.homey.settings.get('macToImeiMD5');
	}

	async onPair(session) {
		let deviceList;
		session.setHandler('login', async data => {
			try {
				if (!data.username || !data.password) return 'Username and password are required';

				await this.loginV2(data.username, data.password);
				deviceList = null;
				return true;
			} catch (error) {
				this.error('Pair login failed:', getErrorMessage(error));
				return error.message || 'Unable to log in';
			}
		});

		session.setHandler('list_devices', async () => {
			const token = this.homey.settings.get('tokenv2');
			if (!deviceList || deviceList.token !== token) deviceList = { token, request: this.fetchDevices() };
			const list = deviceList;
			try {
				return await list.request;
			} catch (error) {
				if (deviceList === list) deviceList = null;
				this.error('Unable to list devices:', getErrorMessage(error));
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
				await this.loginV2(data.username, data.password);
				this.resetRepairFlags();
				this.homey.app.refreshCloudAfterRepair().catch(this.error.bind(this));
				return true;
			} catch (error) {
				this.error('Repair login failed:', getErrorMessage(error));
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

	async loginV2(username, password) {
		const md5Password = await createMD5Hash(password);
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
		if (String(responseData.result_code) !== '0') {
			const message = ERROR_CODES[responseData.result_code] || 'Unknown authentication error';
			await sendNotification(this.homey, `Error fetching token: ${message}`);
			throw new Error(message);
		}

		const result = responseData.resultData ?? responseData.result_data;
		const token = result?.access_token;
		if (!token) throw new Error('Authentication response did not include a token');

		const expiresIn = Number(result.expires_in);
		this.homey.settings.set('usernamev2', username);
		this.homey.settings.set('md5Password', md5Password);
		this.homey.app.setCloudToken(token, Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined);
	}

	async fetchDevices() {
		const result = await this.homey.app.fetchCloudStatusForPairing();
		if (!result) {
			if (!this.homey.settings.get('tokenv2')) throw new Error('Missing Saswell v2 token. Please log in again.');
			throw new Error('The Saswell device list is temporarily unavailable. Please try again later.');
		}
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
			}
		}

		return devices;
	}
}

module.exports = SaswellDriverV2;
