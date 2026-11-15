import {AudioSource} from '@livekit/rtc-node';
import sharp from 'sharp';
const a = new AudioSource(48000,1,100);
console.log('ok', typeof sharp, a.queuedDuration);
await a.close();
