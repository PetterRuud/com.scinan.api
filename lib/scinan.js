'use strict';

const Homey = require('homey');
const { format } = require('date-fns');
const fetch = require('node-fetch');

const {
  SCINAN_AUTHORIZATION_URL, SCINAN_REDIRECT_URL,
} = require('../constants');

module.exports = class Scinan {
  constructor(config) {
    this._config = config;
    this.token = null;
    this.timeZoneNum = '+02:00';
  }

  config() {
    return this._config;
  }

  getId() {
    console.log('test');
  }

  async getToken(username, password) {

    const payload = {
      client_id: Homey.env.SCINAN_CLIENT_ID,
      passwd: password,
      redirect_uri: SCINAN_REDIRECT_URL,
      response_type: 'token',
      userId: username,
    }

    const response = await fetch(SCINAN_AUTHORIZATION_URL, {
      method: 'POST',
      headers:{
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: JSON.stringify(payload),
    });

    console.log('response', response);
    const data = await response.json();
    return data;
  }

  async getDevices() {

    const token = 'cf0572bf0784400a8652257dd46ee123';
    const timestamp = format(new Date(), 'YYYY-MM-DD HH:mm:ss');
    console.log(timestamp);
    const response = await fetchJSON(`https://api.scinan.com/v1.0/devices/list?format=json&timestamp=${timestamp}&token=${token}`);

    const json = await response.json();

    console.log(json);
  }

}
