// --- 1. SETUP ---
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const { DeepgramClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

const port = 3000;

// --- 2. INITIALIZATION ---
const app = express();
const server = http.createServer(app);

if (!process.env.DEEPGRAM_API_KEY) {
    console.error('FATAL ERROR: DEEPGRAM_API_KEY is not set in your .env file.');
    process.exit(1);
}
const deepgram = new DeepgramClient(process.env.DEEPGRAM_API_KEY);

const wss = new WebSocketServer({ server });
const viewers = new Set();
console.log('Server initialized. Waiting for connections...');

// --- 3. WEBSOCKET CONNECTION HANDLING ---
wss.on('connection', (ws, req) => {
    let deepgramLive;
    let keepAliveInterval;

    if (req.url === '/speak') {
        console.log('A Speaker connected.');

        // --- THE KEY CHANGE: BUFFERING LOGIC ---
        let audioBuffer = [];
        let isDeepgramReady = false;

        try {
            deepgramLive = deepgram.listen.live({
                model: 'nova-2',
                language: 'en-US',
                interim_results: true,
                smart_format: true,
                punctuate: true,
            });
        } catch (e) {
            console.error("FAILED to create Deepgram connection:", e);
            ws.close();
            return;
        }
        
        keepAliveInterval = setInterval(() => {
            if (deepgramLive && deepgramLive.getReadyState() === 1) {
                deepgramLive.keepAlive();
            }
        }, 10 * 1000);

        deepgramLive.on(LiveTranscriptionEvents.Open, () => {
            console.log('[DEEPGRAM] Connection opened. Flushing audio buffer...');
            isDeepgramReady = true;
            // Send any audio that was buffered while waiting for the connection to open.
            for (const chunk of audioBuffer) {
                deepgramLive.send(chunk);
            }
            console.log(`[DEEPGRAM] Flushed ${audioBuffer.length} audio chunks.`);
            audioBuffer = []; // Clear the buffer
        });

        deepgramLive.on(LiveTranscriptionEvents.Close, () => {
            console.log('[DEEPGRAM] Connection closed.');
            clearInterval(keepAliveInterval);
        });
        deepgramLive.on(LiveTranscriptionEvents.Error, (err) => console.error('[DEEPGRAM] Error:', err));
        
        // We no longer need the metadata log for debugging.
        // deepgramLive.on(LiveTranscriptionEvents.Metadata, (data) => console.log('[DEEPGRAM METADATA]', data));

        deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
            const transcript = data.channel.alternatives[0].transcript;
            if (transcript) {
                const payload = JSON.stringify({ text: transcript, isFinal: data.is_final });
                console.log(`[BROADCAST SUCCESS] Sending to viewers: ${payload}`);
                for (const viewer of viewers) {
                    if (viewer.readyState === viewer.OPEN) viewer.send(payload);
                }
            }
        });
        
        ws.on('message', (data) => {
            // If Deepgram is ready, send the audio directly.
            // If not, buffer it to be sent when the connection opens.
            if (isDeepgramReady && deepgramLive.getReadyState() === 1) {
                deepgramLive.send(data);
            } else {
                console.log(`[SERVER] Buffering audio chunk of size: ${data.length} bytes.`);
                audioBuffer.push(data);
            }
        });

        ws.on('close', () => {
            console.log('Speaker disconnected.');
            if (deepgramLive) deepgramLive.finish();
            clearInterval(keepAliveInterval);
        });

    } else if (req.url === '/view') {
        console.log(`A Viewer connected. Total viewers: ${viewers.size + 1}`);
        viewers.add(ws);
        ws.on('close', () => {
            viewers.delete(ws);
            console.log(`Viewer disconnected. Total viewers: ${viewers.size}`);
        });
    }

    ws.on('error', (err) => console.error(`Connection error:`, err));
});

// --- 4. SERVER STARTUP ---
app.use(express.static('public'));
server.listen(port, () => {
    console.log(`LiveSpeak server is listening on http://localhost:${port}`);
    console.log('Access Speaker page at http://localhost:3000/speaker.html');
    console.log('Access Viewer page at http://localhost:3000/viewer.html');
});

