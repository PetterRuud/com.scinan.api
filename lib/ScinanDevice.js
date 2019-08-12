'use strict';

const Homey = require('homey');
const http = require('http.min');
const { ManagerNotifications } = require('homey');

const { LIST_URL, CONTROL_URL, USER_AGENT } = require('../constants');

class ScinanDevice extends Homey.Device {
  async onAdded() {
    try {
      console.log('adding new device');
      await this.onInit();
    } catch (error) {
      console.log(error);
    }
  }
  // sensor_id
  // 03 = away
  // 02 = target temp

  onInit() {
    const capabilities = this.getCapabilities();
    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilitySetTemperature.bind(this));
    this.registerCapabilityListener('mode', this.onCapabilitySetMode.bind(this));
    this.registerCapabilityListener('away', this.onCapabilitySetAway.bind(this));
    this.getDeviceData(this);
  }

  getDeviceData(data, callback) {
    const device = this.getData();
    const self = this;
    const token = Homey.ManagerSettings.get('token');

    const date = new Date();
    const year = date.getFullYear();
    const month = date.getMonth() + 1 <= 9 ? `0${date.getMonth() + 1}` : date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours() <= 9 ? `0${date.getHours()}` : date.getHours();
    const minutes = date.getMinutes() <= 9 ? `0${date.getMinutes()}` : date.getMinutes();
    const seconds = date.getSeconds() <= 9 ? `0${date.getSeconds()}` : date.getSeconds();

    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;

    console.log(device);
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
        const currentDevice = result.data.find(function(d) {
          return d.id === device.id;
        });

        const status = currentDevice.status.split(',');
        console.log('status', status);
        self.setCapabilityValue('target_temperature', parseFloat(status[3]));
        self.setCapabilityValue('measure_temperature', parseFloat(status[2]));
        self.setCapabilityValue('onoff', status[1] === 1 ? false : true);
        self.setCapabilityValue('mode', self.valueToMode(status[1]));
        self.setCapabilityValue('away', status[5] === 1 ? false : true);
        console.log('************ UPDATE DEVICE FROM CLOUD - ' + device.name + '******************');
        console.log('equip: ', device.name);
        console.log('onoff: ', self.getCapabilityValue('onoff'));
        console.log('target_temperature: ', self.getCapabilityValue('target_temperature'));
        console.log('measure_temperature: ', self.getCapabilityValue('measure_temperature'));
        console.log('mode: ', self.getCapabilityValue('mode'));
        console.log('away: ', self.getCapabilityValue('away'));
        return;
      }
    });

    this._cancelTimeout = clearTimeout(this._syncTimeout);
    const updateInterval = this.getSettings().interval;
    const interval = 1000 * 60 * updateInterval;
    this._syncTimeout = setTimeout(this.getDeviceData.bind(this), interval);
    console.log('Next update for ' + device.name + ' in ... ' + updateInterval + ' min - from UPDATE');
  }

  async updateCapabilityValues(capability, value) {
    /*
     if prop == 'is_on':
                sensor_id = '01'
                data = '1' if value else '0'
            elif prop == 'target_temperature':
                sensor_id = '02'
                data = value
            elif prop == 'away':
                sensor_id = '03'
                data = '1' if value else '0'
            else:
                return False
    */
    try {
      const token = Homey.ManagerSettings.get('token');
      const device = this.getData();
      const sensorId = 1;
      const timestamp = '';
      const control_data = {};
      console.log('************ SET DEVICE TO CLOUD - ' + device.name + '******************');
      console.log('equip: ', device.name);
      console.log('onoff: ', this.getCapabilityValue('onoff'));
      console.log('target_temperature: ', this.getCapabilityValue('target_temperature'));
      console.log('mode: ', this.getCapabilityValue('mode'));
      console.log('away: ', this.getCapabilityValue('away'));
      const options = {
        uri: `${CONTROL_URL}?control_data=${control_data}&device_id=${
          _device.id
        }&format=json&sensor_id${sensorId}=&sensor_type=1&timestamp=${timestamp}&token=${token}`,
        json: true,
        headers: {
          'User-Agent': USER_AGENT,
        },
      };

      await http.post(options).then(function(result) {
        if (result.response.statusCode !== 200) return new Error('no_devices');
        if (result.data) {
          return true;
        }
      });
      this._syncTimeout = setTimeout(this.getDeviceData.bind(this), 2 * 60 * 1000);
      console.log('Update in ... 2 min - FROM SET');
    } catch (error) {
      console.log(error);
    }
  }

  async onCapabilityOnOff(value, opts) {
    try {
      console.log('ON OFF');
      await this.setCapabilityValue('onoff', value);
      this.updateCapabilityValues();
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetTemperature(value, opts) {
    try {
      console.log('SET TEMPERATURE');
      await this.setCapabilityValue('target_temperature', value);
      this.updateCapabilityValues();
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetMode(value, opts) {
    try {
      console.log('SET MODE');
      await this.setCapabilityValue('mode', value);
      this.updateCapabilityValues();
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetAway(value, opts) {
    try {
      console.log('SET AWAY');
      await this.setCapabilityValue('away', value);
      this.updateCapabilityValues();
    } catch (err) {
      throw new Error(err);
    }
  }

  modeToValue(value) {
    let mode;
    if (value == 'comfort') {
      mode = 0;
    } else if (value == 'auto') {
      mode = 1;
    } else if (value == 'auto') {
      mode = 0;
    } else if (value == 'day_or_night') {
    }
    return mode;
  }
  valueToMode(mode) {
    let value;
    if (mode == '0') {
      value = 'comfort';
    } else if (mode == '1') {
      value = 'auto';
    } else if (mode == '2') {
      value = 'day_or_night';
    }
    return value;
  }
}

module.exports = ScinanDevice;
