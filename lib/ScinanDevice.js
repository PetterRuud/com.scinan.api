'use strict';
const Homey = require('homey');
const fetch = require('node-fetch');
const { ManagerCron } = require('homey');
const { getTimestamp, getStatus } = require('./Utils');
const { LIST_URL, CONTROL_URL, USER_AGENT, MODES, SENSORS, ENERGY_USAGE } = require('./Constants');

class ScinanDevice extends Homey.Device {
  async onInit() {

    const device = this.getData();
    this.log(`[${this.getName()}]`, `Connected to device - ID: ${device.id}`);
    this.registerCapabilityListener('onoff', this.onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('target_temperature', this.onCapabilitySetTemperature.bind(this));
    this.registerCapabilityListener('mode', this.onCapabilitySetMode.bind(this));
    this.registerCapabilityListener('away', this.onCapabilitySetAway.bind(this));
    await this.getDeviceData();
    await this.createCronTask();
  }

  async createCronTask() {
    const device = this.getData();
    const updateInterval = Number(this.getSetting('interval'));

    this.cronName = `refreshdevices${device.id}`.toLocaleLowerCase();

    let task;
    try {
      task = await Homey.ManagerCron.getTask(this.cronName);
      this.log(`The task exists: ${this.cronName}`);
      // TODO if update interval is changed delete and ad new task
      if (task.when !== `*/${updateInterval} * * * *`) {
        this.log(`update interval has been changed to ${updateInterval}`);
        await Homey.ManagerCron.unregisterTask(this.cronName);
        try {
          task = await Homey.ManagerCron.registerTask(this.cronName, `*/${updateInterval} * * * *`);
          task.on('run', () => this.getDeviceData());
        } catch (error) {
          return this.log(`problem with registering cronjob: ${error.message}`);
        }
      } else {
        task.on('run', () => this.getDeviceData());
      }
    } catch (error) {
      if (error.code !== 404) {
        return this.log(`other cron error: ${error.message}`);
      }
      this.log(`The task has not been registered yet, registering task: ${this.cronName}`);
      try {
        task = await Homey.ManagerCron.registerTask(this.cronName, `*/${updateInterval} * * * *`);
        task.on('run', () => this.getDeviceData());
      } catch (error) {
        return this.log(`problem with registering cronjob: ${error.message}`);
      }
    }
  }

  async getDeviceData() {
    const device = this.getData();
    this.log(`${this.getName()} - Refresh device - ID: ${device.id}`);
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
        // this.log(currentDevice);
        const status = getStatus(currentDevice.status);

        //const measure_power = status.onoff ? ENERGY_USAGE * Number(this.getSetting('m2')) : 0;
        //this.log(`device uses ${measure_power}W`);
        this.setCapabilityValue('target_temperature', status.target_temperature);
        this.setCapabilityValue('measure_temperature', status.measure_temperature);
        this.setCapabilityValue('onoff', status.onoff);
        this.setCapabilityValue('mode', this.valueToMode(status.mode));
        this.setCapabilityValue('away', status.away);
        //this.setCapabilityValue('measure_power', measure_power);

        return;
      }
    } catch (error) {
      this.log(error);
      throw new Error(error);
    }
  }

  async updateCapabilityValues(capability) {
    // Homey.ManagerSettings.get adds \r for some reason
    const token = Homey.ManagerSettings.get('token');
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
    // this.log('data', this.getData());
  }

  onRenamed(name) {
    this.log(`${name} renamed`);
  }

  onDeleted() {
    this.log(`${this.name} deleted`);
    ManagerCron.unregisterTask(this.cronName);
  }
}

module.exports = ScinanDevice;
