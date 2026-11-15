// Chert dry run: measure the caller's video, name the held-up object, and send back a cropped view of it.
import { mkdirSync } from 'node:fs';
import { writeFile, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AutoSubscribe, defineAgent, voice } from '@livekit/agents';
import * as google from '@livekit/agents-plugin-google';
import { GoogleGenAI, Type } from '@google/genai';
import { LocalVideoTrack, RoomEvent, TrackKind, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } from '@livekit/rtc-node';
import sharp from 'sharp';
import { runAgent } from './chert-rooms.mjs';
import { greetOnBridgeReady } from './greet.mjs';

const OUT_W = 640, OUT_H = 360, OUT_FPS = 15;
const VISION_MODEL = process.env.VISION_MODEL || 'gemini-2.5-flash';
// Guess from the 6:15 PM call: the free-tier key returned 429 after ~18 requests in 18 s. 4 s = 15 a minute.
const VISION_MIN_GAP_MS = 4000;
const RUN_DIR = fileURLToPath(new URL(`./runs/${new Date().toISOString().replace(/[:.]/g, '-')}/`, import.meta.url));
mkdirSync(`${RUN_DIR}frames`, { recursive: true });
const log = (event, data = {}) => {
  const line = JSON.stringify({ t: Date.now(), event, ...data });
  console.log(`[dryrun] ${line}`);
  void appendFile(`${RUN_DIR}events.jsonl`, line + '\n');
};
const clock = ms => new Date(ms).toTimeString().slice(0, 8) + '.' + String(ms % 1000).padStart(3, '0');

const instructions = `You are an AI on a FaceTime video call, running a camera test.
A vision system tells you what the caller holds up. When it does, name the object out loud in one short sentence.
Otherwise keep replies to one short sentence. Be clear that you are an AI.`;
const greeting = 'Say in one short sentence that you are an AI camera test and ask the caller to hold up an object.';

const genai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
const visionSchema = {
  type: Type.OBJECT,
  properties: {
    object: { type: Type.STRING, nullable: true, description: 'Short name of the main object the person is holding up or showing, or null if none.' },
    box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER }, nullable: true, description: '[ymin, xmin, ymax, xmax] of that object, each 0-1000.' },
  },
  required: ['object', 'box_2d'],
};

async function toUpright(rgba, width, height, rotation) {
  const image = sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } });
  return rotation ? image.rotate(rotation * 90) : image;
}

const agent = defineAgent({
  entry: async ctx => {
    await ctx.connect(undefined, AutoSubscribe.SUBSCRIBE_ALL);
    // Newest caller frame, kept as received; converted to RGBA only when something needs pixels.
    let latest = null;
    let seen = { object: null, box: null, at: 0 };
    let stopped = false;

    // Outgoing video: the cropped object (or the full caller view) with the agent's clock stamped on it.
    const source = new VideoSource(OUT_W, OUT_H);
    const track = LocalVideoTrack.createVideoTrack('agent-video', source);
    let outFrame = Buffer.alloc(OUT_W * OUT_H * 4);
    let rendering = false, rendered = 0;
    const render = async () => {
      if (rendering) return;
      rendering = true;
      try {
        const now = Date.now();
        let base;
        let label = 'hold up an object';
        if (latest) {
          const rgba = latest.frame.convert(VideoBufferType.RGBA);
          let img = await toUpright(rgba.data, rgba.width, rgba.height, latest.rotation);
          const upright = await img.raw().toBuffer({ resolveWithObject: true });
          const { width: w, height: h } = upright.info;
          img = sharp(upright.data, { raw: { width: w, height: h, channels: 4 } });
          if (seen.box && now - seen.at < 6000) {
            const [ymin, xmin, ymax, xmax] = seen.box;
            const pad = 40;
            const left = Math.max(0, Math.floor((xmin - pad) * w / 1000)), top = Math.max(0, Math.floor((ymin - pad) * h / 1000));
            const right = Math.min(w, Math.ceil((xmax + pad) * w / 1000)), bottom = Math.min(h, Math.ceil((ymax + pad) * h / 1000));
            if (right - left > 8 && bottom - top > 8) img = img.extract({ left, top, width: right - left, height: bottom - top });
            label = seen.object;
          }
          base = await img.resize(OUT_W, OUT_H - 60, { fit: 'contain', background: '#102834' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        }
        const text = `<svg width="${OUT_W}" height="60"><rect width="100%" height="100%" fill="#102834"/>
          <text x="12" y="40" font-family="Helvetica" font-size="28" font-weight="bold" fill="#8de0c4">${escapeXml(label)}</text>
          <text x="${OUT_W - 12}" y="40" text-anchor="end" font-family="Menlo" font-size="24" fill="#ffc876">${clock(now)}</text></svg>`;
        const canvas = sharp({ create: { width: OUT_W, height: OUT_H, channels: 4, background: '#102834' } });
        const layers = [{ input: Buffer.from(text), top: OUT_H - 60, left: 0 }];
        if (base) layers.unshift({ input: base.data, raw: { width: base.info.width, height: base.info.height, channels: 4 }, top: 0, left: 0 });
        outFrame = await canvas.composite(layers).ensureAlpha().raw().toBuffer();
        rendered++;
      } catch (error) {
        log('render_error', { message: String(error?.message || error) });
      } finally {
        rendering = false;
      }
    };
    const push = () => source.captureFrame(new VideoFrame(new Uint8Array(outFrame), OUT_W, OUT_H, VideoBufferType.RGBA));
    await render(); push();
    await ctx.room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_CAMERA });
    const timer = setInterval(() => { void render(); push(); }, 1000 / OUT_FPS);
    const renderStats = setInterval(() => { log('out_fps', { rendered_per_s: +(rendered / 5).toFixed(1) }); rendered = 0; }, 5000);

    const caller = await ctx.waitForParticipant();
    log('caller_joined', { identity: caller.identity });

    const watchVideo = async track => {
      log('caller_video_subscribed', { sid: track.sid });
      let count = 0, windowStart = Date.now(), lastSnapshot = 0, firstLogged = 0;
      for await (const { frame, timestampUs, rotation } of new VideoStream(track)) {
        if (stopped) break;
        const now = Date.now();
        latest = { frame, rotation, recvMs: now };
        count++;
        if (firstLogged < 3) { firstLogged++; log('caller_frame', { w: frame.width, h: frame.height, type: frame.type, rotation, timestampUs: String(timestampUs) }); }
        if (now - windowStart >= 5000) {
          log('caller_fps', { fps: +(count * 1000 / (now - windowStart)).toFixed(1), w: frame.width, h: frame.height, rotation });
          count = 0; windowStart = now;
        }
        // One snapshot a second, named by receive time, for measuring delay against an on-screen clock.
        if (now - lastSnapshot >= 1000) {
          lastSnapshot = now;
          const rgba = frame.convert(VideoBufferType.RGBA);
          void (await toUpright(rgba.data, rgba.width, rgba.height, rotation)).jpeg({ quality: 85 }).toFile(`${RUN_DIR}frames/${now}.jpg`).catch(() => {});
        }
      }
    };
    const onTrack = (track, _pub, participant) => {
      if (participant.identity === caller.identity && track.kind === TrackKind.KIND_VIDEO) void watchVideo(track);
    };
    ctx.room.on(RoomEvent.TrackSubscribed, onTrack);
    for (const pub of caller.trackPublications.values()) if (pub.track && pub.kind === TrackKind.KIND_VIDEO) void watchVideo(pub.track);

    const session = new voice.AgentSession({ llm: new google.beta.realtime.RealtimeModel({ voice: 'Puck' }) });

    // Vision loop: newest frame to Gemini Flash, one request at a time.
    let lastSpoken = null;
    let lastSentMs = 0;
    const visionLoop = async () => {
      while (!stopped) {
        if (!latest) { await new Promise(r => setTimeout(r, 300)); continue; }
        await new Promise(r => setTimeout(r, Math.max(0, lastSentMs + VISION_MIN_GAP_MS - Date.now())));
        lastSentMs = Date.now();
        const snap = latest;
        try {
          const rgba = snap.frame.convert(VideoBufferType.RGBA);
          const jpeg = await (await toUpright(rgba.data, rgba.width, rgba.height, snap.rotation)).resize({ width: 640, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
          const sent = Date.now();
          const res = await genai.models.generateContent({
            model: VISION_MODEL,
            contents: [{ role: 'user', parts: [
              { inlineData: { mimeType: 'image/jpeg', data: jpeg.toString('base64') } },
              { text: 'What object is the person holding up or showing to the camera? Give its short name and bounding box.' },
            ] }],
            config: { responseMimeType: 'application/json', responseSchema: visionSchema, thinkingConfig: { thinkingLevel: 'MINIMAL' } },
          });
          const done = Date.now();
          const out = JSON.parse(res.text || '{}');
          log('vision', { object: out.object, box: out.box_2d, model_ms: done - sent, frame_age_ms: done - snap.recvMs });
          if (out.object) {
            seen = { object: out.object, box: Array.isArray(out.box_2d) && out.box_2d.length === 4 ? out.box_2d : null, at: done };
            if (out.object.toLowerCase() !== lastSpoken) {
              lastSpoken = out.object.toLowerCase();
              log('speak_object', { object: out.object });
              try { session.generateReply({ instructions: `The vision system now sees the caller holding: ${out.object}. Name it out loud in one short sentence.` }); }
              catch (error) { log('speak_error', { message: String(error?.message || error) }); }
            }
          }
        } catch (error) {
          log('vision_error', { message: String(error?.message || error) });
          await new Promise(r => setTimeout(r, 1000));
        }
      }
    };

    ctx.addShutdownCallback(async () => {
      stopped = true;
      clearInterval(timer); clearInterval(renderStats);
      ctx.room.off(RoomEvent.TrackSubscribed, onTrack);
      await session.close();
      await track.close();
      await source.close();
      log('call_done');
    });
    await session.start({
      room: ctx.room,
      agent: new voice.Agent({ instructions }),
      record: false,
      inputOptions: {
        participantIdentity: caller.identity,
        audioEnabled: true,
        videoEnabled: false,
        textEnabled: false,
        closeOnDisconnect: true,
        deleteRoomOnClose: false,
      },
      outputOptions: { audioEnabled: true, transcriptionEnabled: false },
    });
    const stopGreeting = greetOnBridgeReady(ctx.room, () => { log('greet'); return session.generateReply({ instructions: greeting }); });
    ctx.addShutdownCallback(async () => stopGreeting());
    void visionLoop();
  },
});

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
}

export default agent;

runAgent(agent, { file: fileURLToPath(import.meta.url), agentName: process.env.AGENT_NAME || 'video-agent' });
