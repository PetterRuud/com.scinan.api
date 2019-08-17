'use strict';

const Homey = require('homey');
const fetch = require('node-fetch');
const Log = require('homey-log').Log;
const { getTimestamp } = require('./Utils');

const { LIST_URL, CONTROL_URL, USER_AGENT } = require('../constants');

class ScinanDevice extends Homey.Device {
  async onAdded() {
    try {
      await this.onInit();
    } catch (error) {
      throw new Error(error);
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

  async getDeviceData(data, callback) {
    const device = this.getData();
    const self = this;
    const timestamp = getTimestamp(new Date());
    const token = Homey.ManagerSettings.get('token');

    try {
      const response = await fetch(`${LIST_URL}?format=json&timestamp=${timestamp}&token=${token}`, {
        method: 'GET',
        headers: {
          'User-Agent': USER_AGENT,
        },
      });

      if (response.ok) {
        const result = await response.json();
        const currentDevice = result.find(function(d) {
          return d.id === device.id;
        });
        const status = currentDevice.status.split(',');
        self.setCapabilityValue('target_temperature', parseFloat(status[3]));
        self.setCapabilityValue('measure_temperature', parseFloat(status[2]));
        self.setCapabilityValue('onoff', status[1] === 1 ? false : true);
        self.setCapabilityValue('mode', self.valueToMode(status[9]));
        self.setCapabilityValue('away', status[5] === 1 ? false : true);
        return;
      }
    } catch (error) {
      throw new Error(error);
    }

    this._cancelTimeout = clearTimeout(this._syncTimeout);
    const updateInterval = this.getSettings().interval;
    const interval = 1000 * 60 * updateInterval;
    this._syncTimeout = setTimeout(this.getDeviceData.bind(this), interval);
  }

  async updateCapabilityValues(capability) {
    // Homey.ManagerSettings.get adds \r for some reason
    const token = Homey.ManagerSettings.get('token').replace(/(\r)/gm, '');
    const device = this.getData();

    try {
      let sensor_id = '01';
      let control_data = {};

      switch (capability) {
        case 'onoff':
          sensor_id = '01';
          control_data = `{%22value%22:%22${this.getCapabilityValue('onoff') === true ? '1' : '0'}%22}`;
          break;
        case 'target_temperature':
          sensor_id = '02';
          control_data = `{%22value%22:%22${this.getCapabilityValue('target_temperature').toFixed(1)}%22}`;
          break;
        case 'mode':
          sensor_id = '12';
          control_data = `{%22value%22:%22${this.modeToValue(this.getCapabilityValue('mode'))}%22}`;
          break;
        case 'away':
          sensor_id = '03';
          control_data = `{%22value%22:%22${this.getCapabilityValue('away') === true ? '1' : '0'}%22}`;
          break;
      }

      const timestamp = getTimestamp(new Date());

      const response = await fetch(
        `${CONTROL_URL}?control_data=${control_data}&device_id=${
          device.id
        }&format=json&sensor_id=${sensor_id}&sensor_type=1&timestamp=${timestamp}&token=${token}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
          },
          
        },
      );
      
      if (response.ok) {
        const result = await response.json();
        console.log(result);
        return result;
      }

      this._syncTimeout = setTimeout(this.getDeviceData.bind(this), 2 * 60 * 1000);
    } catch (error) {
      throw new Error(error);
    }
  }

  async onCapabilityOnOff(value, opts) {
    try {
      await this.setCapabilityValue('onoff', value);
      this.updateCapabilityValues('onoff');
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetTemperature(value, opts) {
    try {
      await this.setCapabilityValue('target_temperature', value);
      this.updateCapabilityValues('target_temperature');
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetMode(value, opts) {
    try {
      await this.setCapabilityValue('mode', value);
      this.updateCapabilityValues('mode');
    } catch (err) {
      throw new Error(err);
    }
  }

  async onCapabilitySetAway(value, opts) {
    try {
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
      mode = 2;
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
