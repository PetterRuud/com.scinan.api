'use strict';
const Homey = require('homey');
const fetch = require('node-fetch');
const { getTimestamp, getStatus } = require('./Utils');
const { LIST_URL, CONTROL_URL, USER_AGENT, MODES, SENSORS } = require('../constants');
const { ManagerCron } = require('homey');

class ScinanDevice extends Homey.Device {
  onInit() {
    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilitySetTemperature.bind(this));
    this.registerCapabilityListener('mode', this.onCapabilitySetMode.bind(this));
    this.registerCapabilityListener('away', this.onCapabilitySetAway.bind(this));
    this.getDeviceData();

    const updateInterval = this.getSettings().interval;
    const interval = 1000 * 60 * updateInterval;

    ManagerCron.registerTask('refresh_devices', `* * * * ${interval} *`, {}, this.getDeviceData());
  }

  async getDeviceData() {
    const device = this.getData();
    this.log(`[${this.getName()}]`, `Connected to device - ID: ${device.id}`);
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
        const currentDevice = result.find(devices => {
          return devices.id === device.id;
        });
        this.log(currentDevice);
        const status = getStatus(currentDevice.status);
        self.setCapabilityValue('target_temperature', status.target_temperature);
        self.setCapabilityValue('measure_temperature', status.measure_temperature);
        self.setCapabilityValue('onoff', status.onoff);
        self.setCapabilityValue('mode', self.valueToMode(status.mode));
        self.setCapabilityValue('away', status.away);

        return;
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async updateCapabilityValues(capability) {
    // Homey.ManagerSettings.get adds \r for some reason
    const token = Homey.ManagerSettings.get('token').replace(/(\r)/gm, '');
    const device = this.getData();

    try {
      let sensor_id = '';
      let control_data = {};

      switch (capability) {
        case 'onoff':
          sensor_id = SENSORS.ON_OFF;
          control_data = `{%22value%22:%22${this.getCapabilityValue('onoff') === true ? '1' : '0'}%22}`;
          break;
        case 'target_temperature':
          sensor_id = SENSORS.TARGET_TEMPERATURE;
          control_data = `{%22value%22:%22${this.getCapabilityValue('target_temperature').toFixed(1)}%22}`;
          break;
        case 'mode':
          sensor_id = SENSORS.MODE;
          control_data = `{%22value%22:%22${this.modeToValue(this.getCapabilityValue('mode'))}%22}`;
          break;
        case 'away':
          sensor_id = SENSORS.AWAY;
          control_data = `{%22value%22:%22${this.getCapabilityValue('away') === true ? '1' : '0'}%22}`;
          break;
      }

      const timestamp = getTimestamp(new Date());

      const response = await fetch(
        `${CONTROL_URL}?control_data=${control_data}&device_id=${device.id}&format=json&sensor_id=${sensor_id}&sensor_type=1&timestamp=${timestamp}&token=${token}`,
        {
          method: 'POST',
          headers: {
            'User-Agent': USER_AGENT,
          },
        },
      );

      if (response.ok) {
        const result = await response.json();
        this.log(result);
        return result;
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilityOnOff(value, opts) {
    try {
      await this.setCapabilityValue('onoff', value);
      this.updateCapabilityValues('onoff');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilitySetTemperature(value, opts) {
    try {
      await this.setCapabilityValue('target_temperature', value);
      this.updateCapabilityValues('target_temperature');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilitySetMode(value, opts) {
    try {
      await this.setCapabilityValue('mode', value);
      this.updateCapabilityValues('mode');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async onCapabilitySetAway(value, opts) {
    try {
      await this.setCapabilityValue('away', value);
      this.updateCapabilityValues('away');
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  modeToValue(value) {
    let mode;
    if (value === MODES.COMFORT) {
      mode = 0;
    } else if (value === MODES.AUTO) {
      mode = 1;
    } else if (value === MODES.DAY_OR_NIGHT) {
      mode = 2;
    }
    return mode;
  }
  valueToMode(mode) {
    let value;
    if (mode === 0) {
      value = MODES.COMFORT;
    } else if (mode === 1) {
      value = MODES.AUTO;
    } else if (mode === 2) {
      value = MODES.DAY_OR_NIGHT;
    }
    return value;
  }

  // this method is called when the Device is added
  onAdded() {
    this.log('device added');
    this.log('name:', this.getName());
    this.log('class:', this.getClass());
    this.log('data', this.getData());
  }

  onRenamed(name) {
    this.log('new name:', name);
  }
}

module.exports = ScinanDevice;
