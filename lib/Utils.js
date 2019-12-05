module.exports.getTimestamp = function(date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1 <= 9 ? `0${date.getMonth() + 1}` : date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours() <= 9 ? `0${date.getHours()}` : date.getHours();
  const minutes = date.getMinutes() <= 9 ? `0${date.getMinutes()}` : date.getMinutes();
  const seconds = date.getSeconds() <= 9 ? `0${date.getSeconds()}` : date.getSeconds();

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

module.exports.getStatus = function(status) {
  const s = status.split(',');
  // status[0] = 1564834881996 => time
  // status[1] = 1 => is_on
  // status[2] = 26.5 => measure_temperature
  // status[3] = 16.0 => target_temperature
  // status[4] = 0 =>
  // status[5] = 1 => away
  // status[6] = 1 =>
  // status[7] = 0 =>
  // status[8] = 0 =>
  // status[9] = 1 => mode
  // status[10] = 05 =>
  // status[11] = 35 =>

  return {
    time: s[0],
    onoff: s[1] === 1 ? true : false,
    measure_temperature: parseFloat(s[2]),
    target_temperature: parseFloat(s[3]),
    away: s[5] === 1 ? true : false,
    mode: s[9],
  };
};
