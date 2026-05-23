const Homey = require('homey');
const crypto = require('crypto');


async function sendNotification(homey, message) {
    const notification = {
      excerpt: message,
    };
    try {
        await homey.notifications.createNotification(notification);
    } catch (error) {
        homey.app?.log?.('Unable to create notification:', error);
    }
  }
  
// Decode the Base64 appSecret
const appSecret = Buffer.from("RTE0OTkwQ0JGNUM3NDBEQjg1MzBBQTZCRTA0REQ5RjM=", 'base64').toString('utf-8');


function getTimestamp(date = new Date()){
    const year = date.getFullYear();
    const month = date.getMonth() + 1 <= 9 ? `0${date.getMonth() + 1}` : date.getMonth() + 1;
    const day = date.getDate() <= 9 ? "0" + date.getDate() : date.getDate();
    const hours = date.getHours() <= 9 ? `0${date.getHours()}` : date.getHours();
    const minutes = date.getMinutes() <= 9 ? `0${date.getMinutes()}` : date.getMinutes();
    const seconds = date.getSeconds() <= 9 ? `0${date.getSeconds()}` : date.getSeconds();

    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

async function createMD5Hash(data, uppercase = false) {
    const hash = crypto.createHash('md5').update(String(data ?? '')).digest("hex");
    return uppercase ? hash.toUpperCase() : hash;
}


function createMD5HashForSign(params) {
    let sign = appSecret;
    const sortedKeys = Object.keys(params).sort();
    
    for (const key of sortedKeys) {
        sign += key + params[key];
    }
    
    sign += appSecret;
    return module.exports.createMD5Hash(sign, true);
}

function getStatus(status) {
    if (typeof status !== 'string') {
        return {
            time: new Date(0),
            onoff: false,
            measure_temperature: 0,
            target_temperature: 0,
            away: false,
            mode: 0,
            min_temp: 5,
            max_temp: 35,
        };
    }

    const [time = '', onOff = '', tempMeasure = '', tempTarget = '', , away = '', , , , mode = '', min_temp = '', max_temp = ''] = status.split(',');
    const parsedTime = Number(time);
    const measureTemperature = parseFloat(tempMeasure);
    const targetTemperature = parseFloat(tempTarget);
    const parsedMode = Number(mode);
    const minTemp = Number(min_temp);
    const maxTemp = Number(max_temp);

    return {
        time: Number.isFinite(parsedTime) ? new Date(parsedTime) : new Date(0),
        onoff: onOff === '1',
        measure_temperature: Number.isFinite(measureTemperature) ? measureTemperature : 0,
        target_temperature: Number.isFinite(targetTemperature) ? targetTemperature : 0,
        away: away === '1',
        mode: Number.isFinite(parsedMode) ? parsedMode : 0,
        min_temp: Number.isFinite(minTemp) ? minTemp : 5,
        max_temp: Number.isFinite(maxTemp) ? maxTemp : 35,
    };
};

async function tokenRepair(homey) {      
    if ((homey.settings.get('token')) && (!(homey.settings.get('tokenv1')))){
    homey.settings.set('tokenv1', homey.settings.get('token'));
    homey.settings.unset('token');
  }
  return
  };

  async function setMD5Password(homey) {      
    if ((homey.settings.get('passwordv2')) && (!(homey.settings.get('md5Password')))){
        let passwordv2 = homey.settings.get('passwordv2');
        homey.settings.set('md5Password', await createMD5Hash(passwordv2));
        homey.settings.unset('passwordv2');
  }
  return
  };

module.exports = {
    sendNotification,
    getStatus,
    createMD5HashForSign,
    createMD5Hash,
    getTimestamp,
    tokenRepair,
    setMD5Password,
};