'use strict';

const Homey = require('homey');
const { format } = require('date-fns');
const fetch = require('node-fetch');

const {
  AUTHORIZATION_URL, USER_AGENT, CLIENT_ID
} = require('../constants');

module.exports = class Scinan {
  constructor(config) {
    this._config = config;
    this.token = null;
  }

  config() {
    return this._config;
  }

  getId() {
    console.log('test');
  }

  async getToken(username, password) {

    const payload = {
      client_id: CLIENT_ID,
      passwd: password,
      redirect_uri: 'http://localhost.com:8080/testCallBack.action',
      response_type: 'token',
      userId: username,
    }

    const response = await fetch(AUTHORIZATION_URL, {
      method: 'POST',
      headers:{
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: JSON.stringify(payload),
    });

    console.log('response', response);
    const html = await response.text();
    const start = html.indexOf("token:");
    const end = html.indexOf("\n", start);
    return html.substring(start + 6, end);
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
