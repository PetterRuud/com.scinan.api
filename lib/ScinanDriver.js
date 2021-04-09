'use strict';
const Homey = require('homey');
const fetch = require('node-fetch');
const { getTimestamp, getStatus } = require('./Utils');
const { AUTHORIZATION_URL, LIST_URL, USER_AGENT, CLIENT_ID, REDIRECT_URI } = require('./Constants');

class ScinanDriver extends Homey.Driver {
  onInit() {}

  async getToken(username, password) {
    this.homey.settings.set('username', username);
    this.homey.settings.set('password', password);

    try {
      const response = await fetch(
        `${AUTHORIZATION_URL}?client_id=${CLIENT_ID}&passwd=${password}&redirect_uri=${REDIRECT_URI}&response_type=token&userId=${username}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
          },
        },
      );

      if (response.ok) {
        const html = await response.text();
        const start = html.indexOf('token:');
        const end = html.indexOf('\n', start);
        const token = html.substring(start + 6, end);
        this.homey.settings.set('token', token);
        return token;
      }
      this.log('no_token');
      throw new Error('no_token');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async getDevices() {
    const token = this.homey.settings.get('token');
    const timestamp = getTimestamp(new Date());

    try {
      const response = await fetch(`${LIST_URL}?format=json&timestamp=${timestamp}&token=${token}`, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
        },
      });

      if (response.ok) {
        const result = await response.json();
        let devices = [];
        result.forEach(device => {
          this.log(device);
          const status = getStatus(device.status);
          devices.push({
            name: device.title,
            data: {
              name: device.title,
              id: device.id,
              onoff: status.onoff,
              online: device.online,
              away: status.away,
              measure_temperature: status.measure_temperature,
              target_temperature: status.target_temperature,
              mode: status.mode,
              last_updated: status.time,
            },
          });
        });
        return devices;
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onPair(session) {
    session.setHandler('login', async data => {
      if (data.username === '' || data.password === '') return null;
      await this.getToken(data.username, data.password);
      return true;
    });

    session.setHandler('list_devices', async data => {
      return await this.getDevices();
    });
  }
}

module.exports = ScinanDriver;
