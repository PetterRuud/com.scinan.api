'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const {
	getTimestamp,
	createMD5Hash,
	createMD5HashForSign,
	tokenRepair,
	setMD5Password,
} = require('./lib/Utils');
const {
	ERROR_CODES,
	LIST_URL_V2,
	COMPANY_ID,
	APP_KEY,
	USER_AGENT_V2,
	AUTHORIZATION_URL_V2,
} = require('./lib/Constants');

class ScinanApp extends Homey.App {
	async onInit() {
		await tokenRepair(this.homey);
		await setMD5Password(this.homey);

		if (!this.homey.settings.get('macToImeiMD5')) {
			const imei = await this.macToImei();
			const imeiHash = await createMD5Hash(imei, true);
			this.homey.settings.set('macToImeiMD5', imeiHash);
		}
		this.IMEI = this.homey.settings.get('macToImeiMD5');

		if (!this.homey.settings.get('u_interval')) {
			this.homey.settings.set('u_interval', 15);
		}

		if (this.homey.settings.get('firstDeviceAdded')) {
			await this.reauthorizeIfPossible();
			this.APIv2UpdateInterval();
		} else {
			this.log('No devices paired, skipping reauthorization and APIv2 update');
		}

		this.log('Successfully init Scinan version:', Homey.manifest.version);
	}

	async onHashPassword(body) {
		return { hashedPassword: await createMD5Hash(body.password) };
	}

	APIv2UpdateInterval() {
		this.cleanupInterval();
		const intervalMinutes = Math.max(5, Number(this.homey.settings.get('u_interval')) || 15);
		this.interval = setInterval(() => {
			this.APIv2().catch(this.error.bind(this));
		}, intervalMinutes * 60 * 1000);
	}

	cleanupInterval() {
		clearInterval(this.interval);
		clearTimeout(this.longTimeoutId);
		this.interval = null;
		this.longTimeoutId = null;
	}

	firstDeviceAdded() {
		this.homey.settings.set('firstDeviceAdded', true);
		this.reauthorizeIfPossible().catch(this.error.bind(this));
		this.APIv2UpdateInterval();
		this.log('First device added, starting APIv2 update interval');
	}

	async APIv2(retryCount = 0) {
		if (this.homey.settings.get('APIv2 result_code <> 0') === true) {
			this.log('APIv2 result_code is <> 0; skipping API call until repair or reauth clears it');
			return null;
		}

		const token = this.homey.settings.get('tokenv2');
		if (!token) {
			this.log('Missing tokenv2, skipping APIv2 call');
			return null;
		}

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

		try {
			const response = await fetch(LIST_URL_V2, {
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
				throw new Error(`APIv2 returned non-JSON response (${response.status})`);
			}

			if (!response.ok) {
				responseData = { result_code: String(response.status), result_data: [], error: response.statusText };
			}

			if (responseData.result_code !== '0') {
				this.log(`APIv2 result_code ${responseData.result_code}: ${ERROR_CODES[responseData.result_code] || responseData.error || 'Unknown error'}`);
				if (responseData.result_code === '10003' && retryCount < 3 && await this.reauthorizeIfPossible()) {
					return this.APIv2(retryCount + 1);
				}
				this.homey.settings.set('APIv2 result_code <> 0', true);
			}

			this.homey.settings.set('last APIv2 result', responseData);
			return responseData;
		} catch (error) {
			this.error('APIv2 failed:', error);
			if ((error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') && retryCount < 3) {
				await new Promise(resolve => setTimeout(resolve, 5000));
				return this.APIv2(retryCount + 1);
			}
			return null;
		}
	}

	setLongTimeout(callback, duration) {
		const MAX_TIMEOUT = 2147483647;
		const safeDuration = Math.max(60000, Number(duration) || 60000);
		if (safeDuration > MAX_TIMEOUT) {
			this.longTimeoutId = setTimeout(() => {
				this.setLongTimeout(callback, safeDuration - MAX_TIMEOUT);
			}, MAX_TIMEOUT);
		} else {
			this.longTimeoutId = setTimeout(callback, safeDuration);
		}
	}

	async reauthorizeIfPossible() {
		const username = this.homey.settings.get('usernamev2');
		const md5Password = this.homey.settings.get('md5Password');
		if (!username || !md5Password) {
			this.log('Missing v2 credentials, skipping reauthorization');
			return false;
		}
		await this.reauthorize();
		return true;
	}

	async reauthorize(retryCount = 0) {
		const username = this.homey.settings.get('usernamev2');
		const md5Password = this.homey.settings.get('md5Password');
		if (!username || !md5Password) {
			throw new Error('Missing v2 credentials');
		}

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

		try {
			const response = await fetch(AUTHORIZATION_URL_V2, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'User-Agent': USER_AGENT_V2,
				},
				body,
				redirect: 'follow',
			});

			let data;
			try {
				data = await response.json();
			} catch (error) {
				throw new Error(`Reauthorization returned non-JSON response (${response.status})`);
			}

			if (!response.ok || data.result_code !== '0') {
				throw new Error(ERROR_CODES[data.result_code] || `Reauthorization failed with HTTP ${response.status}`);
			}

			const token = data.resultData?.access_token;
			const expiresIn = Number(data.resultData?.expires_in);
			if (!token) throw new Error('Reauthorization response did not include a token');

			this.homey.settings.set('lastTokenRefresh', new Date().toISOString());
			this.homey.settings.set('APIv2 result_code <> 0', false);
			this.homey.settings.set('tokenv2', token);

			clearTimeout(this.longTimeoutId);
			if (Number.isFinite(expiresIn) && expiresIn > 0) {
				this.setLongTimeout(() => {
					this.reauthorizeIfPossible().catch(this.error.bind(this));
				}, Math.max(60, expiresIn - 3600) * 1000);
			}

			this.log('Reauthorized successfully');
			return data.result_code;
		} catch (error) {
			if (retryCount < 3) {
				this.log(`Reauthorization failed, retrying (${retryCount + 1}/3): ${error.message}`);
				await new Promise(resolve => setTimeout(resolve, 5000));
				return this.reauthorize(retryCount + 1);
			}
			this.error('Reauthorization failed:', error);
			throw error;
		}
	}

	async macToImei() {
		let mac = await this.fetchMac();
		let base = mac.replace(/:/g, '').substring(0, 12);
		base += '123';
		const checkDigit = await this.luhnCheckDigit(base);
		return base + checkDigit;
	}

	async fetchMac() {
		try {
			const data = await Homey.system.getInfo();
			if (data?.wifiMac) return data.wifiMac;
		} catch (error) {
			this.error('An error occurred while fetching the MAC:', error);
		}

		const configuredMac = this.homey.settings.get('mac');
		if (configuredMac) return configuredMac;

		const randomMac = Array(6).fill().map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':');
		this.homey.settings.set('randMac', randomMac);
		return randomMac;
	}

	async luhnCheckDigit(number) {
		let sum = 0;
		let alt = true;
		for (let i = number.length - 1; i >= 0; i--) {
			let n = parseInt(number[i], 10);
			if (alt) {
				n *= 2;
				if (n > 9) n -= 9;
			}
			sum += n;
			alt = !alt;
		}
		return sum % 10 === 0 ? 0 : 10 - (sum % 10);
	}
}

module.exports = ScinanApp;
