'use strict';

const Homey = require('homey');
const http = require('http.min');
const { getTimestamp } = require('./Utils');
const { AUTHORIZATION_URL, LIST_URL, USER_AGENT, CLIENT_ID } = require('../constants');

class ScinanDriver extends Homey.Driver {
  onInit() {}

  getToken(username, password) {
    Homey.ManagerSettings.set('username', username);
    Homey.ManagerSettings.set('password', password);
    let options = {
      headers: {
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      uri: AUTHORIZATION_URL,
      form: {
        client_id: CLIENT_ID,
        passwd: password,
        redirect_uri: 'http://localhost.com:8080/testCallBack.action',
        response_type: 'token',
        userId: username,
      },
    };
    http.post(options).then(function(result) {
      if (result.data) {
        if (result.data.error) return new Error(result.data.error);
        const html = result.data;
        const start = html.indexOf('token:');
        const end = html.indexOf('\n', start);
        const token = html.substring(start + 6, end);
        console.log('token done', token);
        Homey.ManagerSettings.set('token', token);
        return token;
      }
      if (result.response.statusCode !== 200) return new Error('no_token');
    });
    this._syncTimeout = setTimeout(this.getToken.bind(this), 24 * 3600 * 1000);
  }

  getDevices(data, callback) {
    const token = Homey.ManagerSettings.get('token');
    const timestamp = getTimestamp(new Date());
    const options = {
      uri: `${LIST_URL}?format=json&timestamp=${timestamp}&token=${token}`,
      json: true,
      headers: {
        'User-Agent': USER_AGENT,
      },
    };
    http.get(options).then(function(result) {
      if (result.response.statusCode !== 200) return new Error('no_devices');
      if (result.data) {
        if (result.data.error) return new Error(result.data.error);
        let devices = [];
        result.data.forEach(function(device) {
          console.log(device);
          // "status":"1564834881996,1,26.5,16.0,0,1,1,0,0,1,05,35"}
          const status = device.status.split(',');
          devices.push({
            name: device.title,
            data: {
              name: device.title,
              id: device.id,
              is_on: status[1],
              online: device.online,
              away: status[5] === 1 ? true : false,
              temperature: parseFloat(status[2]),
              target_temperature: parseFloat(status[3]),
              mode: 0,
            },
          });
        });

        return callback(devices);
      }
    });
  }

  onPair(socket) {
    socket.on('login', (data, callback) => {
      if (data.username === '' || data.password === '') return callback(null, false);
      this.getToken(data.username, data.password);
      callback(null, true);
    });

    socket.on('list_devices', (data, callback) => {
      this.getDevices('devices', function(devices) {
        callback(null, devices);
      });
    });

    socket.on('add_device', (device, callback) => {
      console.log('pairing', device);
    });
  }
}

module.exports = ScinanDriver;
