'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const { getTimestamp, getStatus } = require('./Utils');
const { AUTHORIZATION_URL, LIST_URL, USER_AGENT, CLIENT_ID, REDIRECT_URI } = require('./Constants');

class ScinanDriver extends Homey.Driver {
  onInit() {}

  async getToken(username, password) {
    Homey.ManagerSettings.set('username', username);
    Homey.ManagerSettings.set('password', password);

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
        Homey.ManagerSettings.set('token', token);
        return token;
      }
      this.log('no_token');
      throw new Error('no_token');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async getDevices(data, callback) {
    const token = Homey.ManagerSettings.get('token');
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
        return callback(devices);
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onPair(socket) {
    console.log('socket', socket);
    socket.on('login', async (data, callback) => {
      if (data.username === '' || data.password === '') return callback(null, false);
      await this.getToken(data.username, data.password);
      callback(null, true);
    });

    socket.on('list_devices', async (data, callback) => {
      await this.getDevices('devices', function(devices) {
        callback(null, devices);
      });
    });
  }
}

module.exports = ScinanDriver;
