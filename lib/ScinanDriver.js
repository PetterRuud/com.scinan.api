'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const Log = require('homey-log').Log;
const { getTimestamp } = require('./Utils');
const { AUTHORIZATION_URL, LIST_URL, USER_AGENT, CLIENT_ID, REDIRECT_URI } = require('../constants');

class ScinanDriver extends Homey.Driver {
  onInit() {}

  async getToken(username, password) {
    Homey.ManagerSettings.set('username', username);
    Homey.ManagerSettings.set('password', password);

    this._syncTimeout = setTimeout(this.getToken.bind(this), 24 * 3600 * 1000);
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
      return new Error('no_token');
    } catch (error) {
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
        result.forEach(function(device) {
          // "status":"1564834881996,1,26.5,16.0,0,1,1,0,0,1,05,35"}
          const status = device.status.split(',');
          devices.push({
            name: device.title,
            data: {
              name: device.title,
              id: device.id,
              is_on: status[1] === 1 ? true : false,
              online: device.online,
              away: status[5] === 1 ? true : false,
              temperature: parseFloat(status[2]),
              target_temperature: parseFloat(status[3]),
              mode: status[9],
            },
          });
        });
        return callback(devices);
      }
    } catch (error) {
      throw new Error(error);
    }
  }

  async onPair(socket) {
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

    socket.on('add_device', (device, callback) => {});
  }
}

module.exports = ScinanDriver;
