const http = require('http');
const express = require('express');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const fs = require('fs');
// Carrega .env se existir
if (fs.existsSync(path.join(__dirname, '.env'))) {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k && v.length) process.env[k.trim()] = v.join('=').trim();
    });
}

const app = express();
app.use(express.json());
const server = http.createServer(app);
const PORT = 3000;

const RTSP_URL = process.env.RTSP_URL || 'rtsp://admin:SUA_SENHA@SEU_IP:554/onvif1';
const JSMPEG_URL = 'https://cdn.jsdelivr.net/gh/phoboslab/jsmpeg@b5799bf/jsmpeg.min.js';

// Extrai host, usuario e senha do RTSP_URL para ONVIF
const rtspMatch = RTSP_URL.match(/rtsp:\/\/([^:]+):([^@]+)@([^:/]+)/);
const CAM_USER = rtspMatch ? rtspMatch[1] : 'admin';
const CAM_PASS = rtspMatch ? rtspMatch[2] : 'admin';
const CAM_HOST = rtspMatch ? rtspMatch[3] : '192.168.15.17';

// PTZ via SOAP direto
function ptzSoap(body) {
  return new Promise((resolve, reject) => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:ptz="http://www.onvif.org/ver20/ptz/wsdl"><soap:Body>${body}</soap:Body></soap:Envelope>`;
    const auth = 'Basic ' + Buffer.from(`${CAM_USER}:${CAM_PASS}`).toString('base64');
    const req = require('http').request({ hostname: CAM_HOST, port: 5000, path: '/onvif/ptz_service', method: 'POST', headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(xml), 'Authorization': auth } }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(xml);
    req.end();
  });
}

function ptzMove(x, y) {
  const body = `<ptz:ContinuousMove><ptz:ProfileToken>IPCProfilesToken0</ptz:ProfileToken><ptz:Velocity><ptz:PanTilt x="${x}" y="${y}"/><ptz:Zoom x="0"/></ptz:Velocity></ptz:ContinuousMove>`;
  return ptzSoap(body);
}

function ptzStop() {
  const body = `<ptz:Stop><ptz:ProfileToken>IPCProfilesToken0</ptz:ProfileToken><ptz:PanTilt>true</ptz:PanTilt><ptz:Zoom>false</ptz:Zoom></ptz:Stop>`;
  return ptzSoap(body);
}

const wss = new WebSocket.Server({ server, path: '/stream' });
const clients = new Set();
let ffmpegProc = null;
let reconnectTimer = null;

function log(msg) {
  const t = new Date().toLocaleTimeString('pt-BR');
  console.log(`  [${t}] ${msg}`);
}

function broadcast(chunk) {
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
  }
}

function startCapture() {
  if (ffmpegProc) return;
  clearTimeout(reconnectTimer);
  log(`Conectando a camera: ${RTSP_URL}`);

  ffmpegProc = spawn(ffmpegPath, [
    '-rtsp_transport', 'udp',
    '-i', RTSP_URL,
    '-f', 'mpegts',
    '-codec:v', 'mpeg1video',
    '-r', '25',
    '-b:v', '800k',
    '-bf', '0',
    '-an',
    '-',
  ], { windowsHide: true });

  ffmpegProc.stderr.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (
        l.includes('Error') || l.includes('error') ||
        l.includes('Connection') || l.includes('Opening') ||
        l.includes('Video:') || l.includes('fps=') ||
        l.includes('failed') || l.includes('timeout') ||
        l.includes('refused') || l.includes('No such')
      ) log(`[ffmpeg] ${l}`);
    }
  });

  ffmpegProc.stdout.on('data', broadcast);
  ffmpegProc.stdout.on('error', (err) => log(`[ffmpeg] erro saida: ${err.message}`));
  ffmpegProc.on('error', (err) => { log(`[ffmpeg] falha: ${err.message}`); ffmpegProc = null; scheduleReconnect(); });
  ffmpegProc.on('close', (code, signal) => {
    ffmpegProc = null;
    if (signal !== 'SIGTERM') { log(`[ffmpeg] encerrou (${code}). Reconectando...`); scheduleReconnect(); }
  });
}

function stopCapture() {
  clearTimeout(reconnectTimer);
  if (ffmpegProc) { ffmpegProc.kill('SIGTERM'); ffmpegProc = null; }
}

function scheduleReconnect() {
  if (clients.size > 0) reconnectTimer = setTimeout(startCapture, 3000);
}

wss.on('connection', (ws, req) => {
  clients.add(ws);
  log(`Cliente conectado (${clients.size} ativo(s)) | IP: ${req.socket.remoteAddress}`);

  const header = Buffer.alloc(8);
  header.write('jsmp');
  header.writeUInt16BE(0, 4);
  header.writeUInt16BE(0, 6);
  ws.send(header, { binary: true });

  if (clients.size === 1) startCapture();

  ws.on('close', () => { clients.delete(ws); log(`Cliente desconectado (${clients.size} restante(s))`); if (clients.size === 0) stopCapture(); });
  ws.on('error', (err) => { log(`[ws] erro: ${err.message}`); clients.delete(ws); if (clients.size === 0) stopCapture(); });
});

// PTZ: mover
app.post('/ptz/move', (req, res) => {
  const { x = 0, y = 0 } = req.body;
  ptzMove(parseFloat(x), parseFloat(y))
    .then(() => res.json({ ok: true }))
    .catch(err => { log(`[ptz] erro: ${err.message}`); res.status(500).json({ error: err.message }); });
});

// PTZ: parar
app.post('/ptz/stop', (req, res) => {
  ptzStop()
    .then(() => res.json({ ok: true }))
    .catch(err => { log(`[ptz] erro: ${err.message}`); res.status(500).json({ error: err.message }); });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/config', (_req, res) => {
  res.json({ scriptUrl: JSMPEG_URL, wsUrl: `ws://localhost:${PORT}/stream` });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║      CAMERA IP - Visualizador        ║');
  console.log('  ╠══════════════════════════════════════╣');
  console.log(`  ║  Acesse: http://localhost:${PORT}       ║`);
  console.log(`  ║  Camera: ${CAM_HOST}           ║`);
  console.log('  ╚══════════════════════════════════════╝');
  console.log('');
  log('Servidor iniciado. Aguardando conexoes...');
  console.log('');
  const { exec } = require('child_process');
  setTimeout(() => exec(`start http://localhost:${PORT}`), 1500);
});

process.on('SIGINT', () => { log('Encerrando...'); stopCapture(); server.close(() => process.exit(0)); });
process.on('uncaughtException', (err) => { log(`[erro] ${err.message}`); });
process.on('unhandledRejection', (err) => { log(`[erro] ${err}`); });
