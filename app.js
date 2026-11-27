'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const { stopLanNetwork } = require('./lib/SaswellLanConnection');
const {
	getErrorMessage,
	getTimestamp,
	createMD5Hash,
	createMD5HashForSign,
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

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_TIMEOUT = 2147483647;
const REQUEST_TIMEOUT = 10000;

class ScinanApp extends Homey.App {
	async onInit() {
		this.cloudFallbackDevices = new Map();
		this.cloudStatusRevision = 0;
		this.cloudStopped = false;
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

		this.cloudSettingsListener = key => {
			if (['u_interval', 'tokenv2', 'usernamev2', 'md5Password'].includes(key)) {
				this.scheduleCloudPoll();
				this.scheduleCloudTokenRefresh();
			}
		};
		this.homey.settings.on('set', this.cloudSettingsListener);

		this.log('Successfully init Scinan version:', Homey.manifest.version);
	}

	async onHashPassword(body) {
		return { hashedPassword: await createMD5Hash(body.password) };
	}

	setDeviceCloudFallback(device, needsCloud) {
		if (this.cloudStopped || this.cloudFallbackDevices.get(device) === needsCloud) return;
		this.cloudFallbackDevices.set(device, needsCloud);
		this.scheduleCloudPoll();
		this.scheduleCloudTokenRefresh();
	}

	removeDeviceCloudFallback(device) {
		if (!this.cloudFallbackDevices.delete(device)) return;
		this.scheduleCloudPoll();
		this.scheduleCloudTokenRefresh();
	}

	getCloudTimestamp(key) {
		const value = Number(this.homey.settings.get(key));
		return Number.isFinite(value) && value > 0 ? value : 0;
	}

	getCloudStatusReceivedAt() {
		return this.getCloudTimestamp('lastCloudStatusReceivedAt');
	}

	getCloudResultReceivedAt() {
		return this.getCloudTimestamp('lastCloudResultReceivedAt');
	}

	getFallbackInterval() {
		const minutes = Number(this.homey.settings.get('u_interval'));
		return (Number.isFinite(minutes) && minutes > 0 ? Math.max(5, minutes) : 15) * MINUTE;
	}

	getCloudPollDueAt() {
		const needsCloud = Array.from(this.cloudFallbackDevices.values()).some(Boolean);
		const interval = needsCloud ? this.getFallbackInterval() : DAY;
		const lastActivityAt = Math.max(this.getCloudStatusReceivedAt(), this.getCloudTimestamp('lastCloudStatusAttemptAt'));
		return Math.max(lastActivityAt ? lastActivityAt + interval : 0, this.getCloudTimestamp('cloudRetryAt'));
	}

	getCloudCredentials() {
		const username = this.homey.settings.get('usernamev2');
		const md5Password = this.homey.settings.get('md5Password');
		return username && md5Password ? { username, md5Password } : null;
	}

	canPollCloud(forPairing = false) {
		return !this.cloudStopped && (forPairing || this.cloudFallbackDevices.size > 0)
			&& Boolean(this.homey.settings.get('tokenv2') || this.getCloudCredentials());
	}

	scheduleCloudPoll() {
		clearTimeout(this.cloudPollTimer);
		this.cloudPollTimer = null;
		if (!this.canPollCloud() || this.cloudPollRequest) return;
		const delay = Math.max(0, this.getCloudPollDueAt() - Date.now());
		this.cloudPollTimer = setTimeout(() => {
			this.APIv2().catch(this.error.bind(this));
		}, Math.min(delay, MAX_TIMEOUT));
	}

	APIv2() {
		return this.runCloudPoll(false);
	}

	refreshCloudAfterRepair() {
		return this.runCloudPoll(true);
	}

	fetchCloudStatusForPairing() {
		return this.runCloudPoll(true, true);
	}

	runCloudPoll(force, forPairing = false) {
		if (!this.canPollCloud(forPairing)) return Promise.resolve(null);
		const token = this.homey.settings.get('tokenv2');
		if (this.cloudPollRequest) {
			if (force && token !== this.cloudPollToken) {
				return this.cloudPollRequest.then(result => result || this.runCloudPoll(force, forPairing));
			}
			return this.cloudPollRequest;
		}
		const dueAt = force ? this.getCloudTimestamp('cloudRetryAt') : this.getCloudPollDueAt();
		if (dueAt > Date.now()) {
			this.scheduleCloudPoll();
			return Promise.resolve(null);
		}
		clearTimeout(this.cloudPollTimer);
		this.cloudPollToken = token;
		const context = this.getCloudStatusContext();
		this.homey.settings.set('lastCloudStatusAttemptAt', Date.now());
		this.cloudPollRequest = this.fetchCloudStatus(token, context, forPairing).catch(error => {
			if (this.isCurrentCloudStatusRequest(this.cloudPollToken, context)) {
				this.homey.settings.set('lastCloudFailureAt', Date.now());
				this.error('Saswell cloud status request failed:', getErrorMessage(error));
			}
			return null;
		}).finally(() => {
			this.cloudPollRequest = null;
			this.cloudPollToken = null;
			this.scheduleCloudPoll();
		});
		return this.cloudPollRequest;
	}

	async fetchCloudStatus(token, context, forPairing) {
		const refreshAt = this.getCloudTimestamp('cloudTokenRefreshAt');
		if (this.cloudTokenRequest || (refreshAt && refreshAt <= Date.now())) {
			await this.reauthorizeIfPossible();
			token = this.homey.settings.get('tokenv2');
		}
		if (!this.canPollCloud(forPairing) || this.getCloudTimestamp('cloudRetryAt') > Date.now()) return null;
		if (!token) {
			if (!await this.reauthorizeIfPossible()) return null;
			token = this.homey.settings.get('tokenv2');
		}
		if (!this.isCurrentCloudStatusRequest(token, context)) return null;
		this.cloudPollToken = token;
		let result = await this.requestCloudStatus(token);
		if (!this.isCurrentCloudStatusRequest(token, context)) return null;
		if (['10002', '10003', '401'].includes(result.result_code) && await this.reauthorizeIfPossible()) {
			token = this.homey.settings.get('tokenv2');
			if (!this.isCurrentCloudStatusRequest(token, context)) return null;
			this.cloudPollToken = token;
			result = await this.requestCloudStatus(token);
		}
		return this.publishCloudStatus(result, token, context);
	}

	getCloudStatusContext() {
		return {
			revision: this.cloudStatusRevision,
			account: this.homey.settings.get('usernamev2'),
		};
	}

	publishCloudStatus(result, token, context = this.getCloudStatusContext()) {
		if (!token || !this.isCurrentCloudStatusRequest(token, context)) return null;
		this.cloudStatusRevision += 1;
		const receivedAt = Date.now();
		if (result.result_code === '0') {
			this.homey.settings.set('lastCloudStatusReceivedAt', receivedAt);
			this.homey.settings.set('APIv2 result_code <> 0', false);
			this.log('[Cloud] Received account device status');
		} else {
			this.log(`Saswell cloud status returned ${result.result_code}: ${ERROR_CODES[result.result_code] || 'Unknown error'}`);
		}
		this.homey.settings.set('lastCloudResultReceivedAt', receivedAt);
		this.homey.settings.set('last APIv2 result', result);
		this.scheduleCloudPoll();
		return result;
	}

	isCurrentCloudStatusRequest(token, { revision, account }) {
		return this.isCurrentCloudToken(token) && revision === this.cloudStatusRevision
			&& account === this.homey.settings.get('usernamev2');
	}

	isCurrentCloudToken(token) {
		return !this.cloudStopped && token === this.homey.settings.get('tokenv2');
	}

	async requestCloudStatus(token) {
		const response = await this.requestCloud(LIST_URL_V2, { token });
		if (response.status === 429) this.deferCloudRequests(response);
		if (!response.ok) return { result_code: String(response.status), result_data: [] };
		const data = await response.json();
		const code = String(data.result_code);
		if (code === '429' && response.status !== 429) this.deferCloudRequests(response);
		return { ...data, result_code: code };
	}

	deferCloudRequests(response) {
		if (this.cloudStopped) return;
		const retryAfter = response.headers.get('retry-after');
		const retrySeconds = retryAfter ? Number(retryAfter) : NaN;
		const retryAt = Number.isFinite(retrySeconds) ? Date.now() + retrySeconds * 1000 : Date.parse(retryAfter);
		const waitUntil = Number.isFinite(retryAt) ? Math.max(Date.now() + this.getFallbackInterval(), retryAt) : Date.now() + DAY;
		this.homey.settings.set('cloudRetryAt', Math.max(waitUntil, this.getCloudTimestamp('cloudRetryAt')));
		this.scheduleCloudTokenRefresh();
	}

	setCloudToken(token, expiresIn) {
		if (this.cloudStopped) return;
		const now = Date.now();
		const lifetime = Number(expiresIn);
		const refreshAt = Number.isFinite(lifetime) && lifetime > 0
			? now + Math.max(60, lifetime - Math.min(3600, lifetime * 0.1)) * 1000
			: 0;
		this.cloudAuthRetryAt = 0;
		this.homey.settings.set('cloudTokenRefreshAt', refreshAt);
		this.homey.settings.set('lastTokenRefresh', new Date(now).toISOString());
		this.homey.settings.set('APIv2 result_code <> 0', false);
		this.homey.settings.set('tokenv2', token);
		this.scheduleCloudTokenRefresh();
	}

	scheduleCloudTokenRefresh() {
		clearTimeout(this.cloudTokenTimer);
		this.cloudTokenTimer = null;
		const refreshAt = this.getCloudTimestamp('cloudTokenRefreshAt');
		if (!this.canPollCloud() || !refreshAt || !this.getCloudCredentials() || this.cloudTokenRequest) return;
		const dueAt = Math.max(refreshAt, this.getCloudTimestamp('cloudRetryAt'), this.cloudAuthRetryAt || 0);
		this.cloudTokenTimer = setTimeout(() => {
			if (dueAt > Date.now()) {
				this.scheduleCloudTokenRefresh();
				return;
			}
			this.reauthorizeIfPossible().catch(this.error.bind(this));
		}, Math.min(Math.max(0, dueAt - Date.now()), MAX_TIMEOUT));
	}

	reauthorizeIfPossible() {
		if (this.cloudTokenRequest) return this.cloudTokenRequest;
		const credentials = this.getCloudCredentials();
		const retryAt = Math.max(this.getCloudTimestamp('cloudRetryAt'), this.cloudAuthRetryAt || 0);
		if (this.cloudStopped || !credentials || retryAt > Date.now()) return Promise.resolve(false);
		const token = this.homey.settings.get('tokenv2');
		this.cloudTokenRequest = this.reauthorize(credentials, token).catch(error => {
			if (!this.cloudStopped) {
				this.cloudAuthRetryAt = Date.now() + this.getFallbackInterval();
				this.error('Saswell cloud reauthorization failed:', getErrorMessage(error));
			}
			return false;
		}).finally(() => {
			this.cloudTokenRequest = null;
			this.scheduleCloudTokenRefresh();
		});
		return this.cloudTokenRequest;
	}

	async reauthorize({ username, md5Password }, previousToken) {
		const response = await this.requestCloud(AUTHORIZATION_URL_V2, { account: username, password: md5Password });
		if (response.status === 429) {
			this.deferCloudRequests(response);
			return false;
		}
		const data = await response.json();
		const current = this.getCloudCredentials();
		if (!this.isCurrentCloudToken(previousToken)
			|| current?.username !== username || current?.md5Password !== md5Password) return false;
		const code = String(data.result_code);
		if (code === '1') this.deferCloudRequests(response);
		if (!response.ok || code !== '0') {
			throw new Error(ERROR_CODES[code] || `Saswell authentication returned HTTP ${response.status}`);
		}
		const result = data.resultData || data.result_data;
		if (!result?.access_token) {
			throw new Error('Saswell authentication response did not include a token');
		}
		this.setCloudToken(result.access_token, result.expires_in);
		this.log('Reauthorized successfully');
		return true;
	}

	async requestCloud(url, values) {
		const params = {
			app_key: APP_KEY,
			company_id: COMPANY_ID,
			imei: this.homey.settings.get('macToImeiMD5') || this.IMEI,
			timestamp: getTimestamp(),
			...values,
		};
		params.sign = await createMD5HashForSign(params);
		return fetch(url, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				'User-Agent': USER_AGENT_V2,
			},
			body: new URLSearchParams(params),
			redirect: 'follow',
			timeout: REQUEST_TIMEOUT,
		});
	}

	onUninit() {
		this.cloudStopped = true;
		stopLanNetwork(this.homey);
		clearTimeout(this.cloudPollTimer);
		clearTimeout(this.cloudTokenTimer);
		this.cloudPollTimer = null;
		this.cloudTokenTimer = null;
		this.cloudFallbackDevices.clear();
		this.homey.settings.removeListener('set', this.cloudSettingsListener);
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
