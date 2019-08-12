'use strict';

const Homey = require('homey');
const http = require('http.min');
const { getTimestamp } = require('./Utils');

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
    const timestamp = getTimestamp(new Date());
    const token = Homey.ManagerSettings.get('token');

    const options = {
      uri: `${LIST_URL}?format=json&timestamp=${timestamp}&token=${token}`,
      json: true,
      headers: {
        'User-Agent': USER_AGENT,
      },
    };
    http.get(options).then(function(result) {
      if (result.response.statusCode !== 200) return new Error('no_devices');
      console.log(timestamp);
      if (result.data) {
        if (result.data.error) return new Error(result.data.error);
        const currentDevice = result.data.find(function(d) {
          return d.id === device.id;
        });
        const status = currentDevice.status.split(',');
        self.setCapabilityValue('target_temperature', parseFloat(status[3]));
        self.setCapabilityValue('measure_temperature', parseFloat(status[2]));
        self.setCapabilityValue('onoff', status[1] === 1 ? false : true);
        self.setCapabilityValue('mode', self.valueToMode(status[1]));
        self.setCapabilityValue('away', status[5] === 1 ? false : true);
        console.log('*** GET ' + device.name + ' ***');
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

  async updateCapabilityValues(capability) {
    console.log('capability', capability);

    try {
      const token = Homey.ManagerSettings.get('token');
      const device = this.getData();
      let sensorId = 1;
      let control_data = {};

      switch (capability) {
        case 'onoff':
          sensorId = '1';
          control_data = {
            value: this.getCapabilityValue('onoff'),
          };
          break;
        case 'target_temperature':
          sensorId = '2';
          control_data = {
            value: this.getCapabilityValue('target_temperature'),
          };
          break;
        case 'mode':
          sensorId = '12';
          control_data = {
            value: this.getCapabilityValue('mode'),
          };
          break;
        case 'away':
          sensorId = '3';
          control_data = {
            value: this.getCapabilityValue('away'),
          };
          break;
      }
      const timestamp = getTimestamp(new Date());

      console.log('*** SET ' + device.name + ' ***');
      console.log('onoff: ', this.getCapabilityValue('onoff'));
      console.log('target_temperature: ', this.getCapabilityValue('target_temperature'));
      console.log('mode: ', this.getCapabilityValue('mode'));
      console.log('away: ', this.getCapabilityValue('away'));
      const options = {
        uri: `${CONTROL_URL}?control_data=${control_data}&device_id=${
          device.id
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
      this.updateCapabilityValues('onoff');
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetTemperature(value, opts) {
    try {
      console.log('SET TEMPERATURE');
      await this.setCapabilityValue('target_temperature', value);
      this.updateCapabilityValues('target_temperature');
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetMode(value, opts) {
    try {
      console.log('SET MODE');
      await this.setCapabilityValue('mode', value);
      this.updateCapabilityValues('mode');
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetAway(value, opts) {
    try {
      console.log('SET AWAY');
      await this.setCapabilityValue('away', value);
      this.updateCapabilityValues('away');
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
