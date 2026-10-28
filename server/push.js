// Bambu Lab LAN push (experimental): upload a sliced G-code to the printer over FTPS
// and trigger the print over MQTT (local access code). Optional deps are lazy-loaded so
// G-code / 3MF download work even without these installed.
//
// Reference flow (community, works on P/X/P2 series with LAN access code):
//   FTPS  -> ftps://<ip>:990  user "bblp" pass <access_code>  put gcode to /sdcard/
//   MQTT  -> mqtts://<ip>:8883 user "bblp" pass <access_code>  topic device/<id>/printer

import fs from 'fs';

let mqttMod = null;
let ftpMod = null;
async function loadDeps() {
  if (!mqttMod) mqttMod = await import('mqtt');       // optional: LAN push only
  if (!ftpMod) ftpMod = await import('basic-ftp');    // optional: LAN push only
  return { mqtt: mqttMod.default || mqttMod, Client: ftpMod.FTP, FTPError: ftpMod.FTPError };
}

// Bambu device id = last 12 chars of the printer serial number.
export function deviceIdFromSerial(serial) {
  const s = String(serial || '').trim();
  if (s.length >= 12) return s.slice(-12);
  throw new Error('打印机序列号无效（应至少 12 位）');
}

// Bambu uses a self-signed device cert. Verify against a real CA when BAMBU_CA_FILE is set;
// otherwise fall back to trust-on-first-use, which is only acceptable on a trusted LAN.
function tlsOptions() {
  const caFile = process.env.BAMBU_CA_FILE;
  if (caFile && fs.existsSync(caFile)) {
    return { rejectUnauthorized: true, ca: fs.readFileSync(caFile), secure: true };
  }
  return { rejectUnauthorized: false, insecure: true };
}

// Probe the printer over MQTT: connect (validates TLS + LAN access code), request a
// status/version report, and read back model + the physically installed nozzle(s).
export async function testPrinterConnection({ ip, accessCode, serial, onLog, timeoutMs = 12000 }) {
  const { mqtt } = await loadDeps();
  const log = onLog || (() => {});
  if (!ip || !accessCode || !serial) throw new Error('连接测试需要打印机 IP、Access Code 和序列号。');
  const tls = tlsOptions();
  if (tls.insecure) log('警告：未设置 BAMBU_CA_FILE，LAN TLS 采用首次信任模式，请仅在可信本地网络使用。');

  const id = deviceIdFromSerial(serial);
  log(`连接 mqtts://${ip}:8883 (设备 ${id}) ...`);
  let client;
  try {
    client = await mqtt.connectAsync(`mqtts://${ip}:8883`, {
      username: 'bblp',
      password: accessCode,
      clientId: `conntest_${Math.floor(Math.random() * 100000)}`,
      rejectUnauthorized: tls.rejectUnauthorized,
      ca: tls.ca,
      reconnectPeriod: 0,
      connectTimeout: 15000,
    });
  } catch (err) {
    const m = String(err.message || err);
    if (/auth|not authorized|bad user|connack/i.test(m)) throw new Error(`无法连接：IP ${ip} 无响应或 Access Code 不对（确认打印机已开局域网控制、与电脑同网段）。原始：${m}`);
    throw new Error(`无法连接 ${ip}:8883（确认 IP、打印机已开机、已开局域网控制、与电脑同网段）。原始：${m}`);
  }

  try {
    const topic = `device/${id}/printer`;
    const reportTopic = `device/${id}/report`;
    const t = () => new Date().toISOString().replace('T', ' ').substring(0, 19) + '+08:00';
    const seq = () => Date.now();

    const info = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接超时：打印机未在局域网上报状态（检查 IP/是否开机/同网段/已开局域网控制）')), timeoutMs);
      client.on('error', (e) => { clearTimeout(timer); reject(e); });
      client.subscribe(reportTopic, (err) => {
        if (err) { clearTimeout(timer); reject(err); return; }
        client.publish(topic, JSON.stringify({ info: { command: 'get_version', time: t(), sequence_id: seq() } }));
        client.publish(topic, JSON.stringify({ print: { command: 'pushall', version: 1, sequence_id: seq() } }));
      });
      client.on('message', (_topic, payload) => {
        let msg;
        try { msg = JSON.parse(payload.toString()); } catch { return; }
        const p = msg.print || msg.info || msg.tls;
        if (!p || (!p.mc_type && !p.nozzle_diameter && !msg.mtu)) return;
        clearTimeout(timer);
        const upgrade = msg.upgrade || {};
        resolve({
          name: (msg.mtu && msg.mtu.name) || undefined,
          ip: (msg.mtu && msg.mtu.ip) || ip,
          state: (msg.mtu && msg.mtu.state) || p.active_state || undefined,
          mc_type: p.mc_type || undefined,
          nozzle_diameters: Array.isArray(p.nozzle_diameter) ? p.nozzle_diameter : (p.nozzle_diameter != null ? [p.nozzle_diameter] : []),
          nozzle_types: Array.isArray(p.nozzle_type) ? p.nozzle_type : (p.nozzle_type ? [p.nozzle_type] : []),
          series: upgrade.series || upgrade.mc_result?.series || undefined,
          ver: upgrade.firmwares?.[0]?.ver || undefined,
        });
      });
    });

    log(`在线：${info.mc_type || info.name || 'Bambu'} 喷头 ${(info.nozzle_diameters || []).join('/') || '未知'}mm`);
    return { connected: true, deviceId: id, printer: info };
  } finally {
    setTimeout(() => client.end(true), 500);
  }
}

export async function pushToPrinter({ ip, accessCode, serial, gcodePath, filename, autoStart = true, onLog }) {
  const { mqtt, Client } = await loadDeps();
  const log = onLog || (() => {});
  if (!ip || !accessCode || !serial) throw new Error('推送需要打印机 IP、Access Code 和序列号。');

  const tls = tlsOptions();
  if (tls.insecure) log('警告：未设置 BAMBU_CA_FILE，LAN TLS 采用首次信任模式，请仅在可信本地网络使用。');

  // 1) Upload gcode to /sdcard/ over FTPS.
  const remoteName = filename || `aiprint_${Date.now()}.gcode`;
  const remotePath = `/sdcard/${remoteName}`;
  const ftp = new Client();
  ftp.timeout = 60000;
  log(`上传 ${remoteName} 到 ${ip} ...`);
  await ftp.use(
    { host: ip, port: 990, secure: true, secureOptions: { rejectUnauthorized: tls.rejectUnauthorized, ca: tls.ca }, user: 'bblp', password: accessCode },
    async (conn) => {
      conn.assumeCharset('utf8');
      await conn.ensureDir('/sdcard/');
      await conn.uploadFrom(gcodePath, remotePath);
    }
  );
  ftp.close();
  log(`已上传：${remotePath}`);

  if (!autoStart) return { remotePath, started: false };

  // 2) Start the print over MQTT.
  const id = deviceIdFromSerial(serial);
  const client = await mqtt.connectAsync(`mqtts://${ip}:8883`, {
    username: 'bblp',
    password: accessCode,
    clientId: `gcodepush_${Math.floor(Math.random() * 100000)}`,
    rejectUnauthorized: tls.rejectUnauthorized,
    ca: tls.ca,
    reconnectPeriod: 0,
    connectTimeout: 15000,
  });
  try {
    const topic = `device/${id}/printer`;
    const t = () => new Date().toISOString().replace('T', ' ').substring(0, 19) + '+08:00';
    const seq = () => Date.now();
    const publish = (obj) => client.publish(topic, JSON.stringify(obj));
    publish({ print: { command: 'pushall', version: 1, sequence_id: seq() } });
    await new Promise((r) => setTimeout(r, 800));
    publish({
      print: { command: 'fileprint', info: { name: remotePath, no_throttle: false }, param: 'null' },
      info: { command: 'fileprint', time: t(), sequence_id: seq() },
    });
    log(`已发送打印指令：${remoteName}`);
    return { remotePath, started: true };
  } finally {
    setTimeout(() => client.end(true), 1500);
  }
}
