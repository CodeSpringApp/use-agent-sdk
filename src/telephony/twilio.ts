import type { TelephonyMediaAdapter } from "../telephony";

export interface TwilioMediaSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: () => void): void;
  removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: "close", listener: () => void): void;
  removeEventListener(type: "error", listener: () => void): void;
}

export interface TwilioMediaAdapterOptions {
  expectedCallSid?: string;
}

/** Normalizes Twilio bidirectional Media Streams without exposing Twilio types to the agent runtime. */
export function createTwilioMediaAdapter(
  socket: TwilioMediaSocket,
  options: TwilioMediaAdapterOptions = {},
): TelephonyMediaAdapter {
  let streamSid: string | null = null;
  let started = false;
  return {
    provider: "twilio",
    start(handlers) {
      if (started) throw new Error("Twilio media adapter has already started");
      started = true;
      const onMessage = (event: { data: unknown }) => {
        if (typeof event.data !== "string") return;
        try {
          const value = JSON.parse(event.data) as {
            event?: unknown;
            start?: { streamSid?: unknown; callSid?: unknown };
            media?: { payload?: unknown };
          };
          if (value.event === "start") {
            if (
              typeof value.start?.streamSid !== "string" ||
              (options.expectedCallSid && value.start.callSid !== options.expectedCallSid)
            ) throw new Error("Twilio media identity did not match this call");
            streamSid = value.start.streamSid;
          } else if (value.event === "media" && typeof value.media?.payload === "string") {
            handlers.onAudio(upsampleMulaw8kToPcm16(decodeBase64(value.media.payload)).buffer as ArrayBuffer);
          } else if (value.event === "stop") {
            handlers.onEnd("twilio_stopped");
          }
        } catch (reason) {
          handlers.onError(reason instanceof Error ? reason : new Error("Twilio media message was invalid"));
        }
      };
      const onClose = () => handlers.onEnd("twilio_disconnected");
      const onError = () => handlers.onError(new Error("Twilio media socket failed"));
      socket.addEventListener("message", onMessage);
      socket.addEventListener("close", onClose);
      socket.addEventListener("error", onError);
      return () => {
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("close", onClose);
        socket.removeEventListener("error", onError);
      };
    },
    sendSpeech(pcm24k) {
      if (!streamSid) throw new Error("Twilio media stream has not started");
      socket.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: encodeBase64(pcm24kToMulaw8k(new Uint8Array(pcm24k))) },
      }));
    },
    clearSpeech() {
      if (streamSid) socket.send(JSON.stringify({ event: "clear", streamSid }));
    },
    close(reason) {
      socket.close(1000, reason?.slice(0, 123) ?? "bridge closed");
    },
  };
}

function upsampleMulaw8kToPcm16(input: Uint8Array): Uint8Array {
  const output = new Uint8Array(input.length * 4);
  const view = new DataView(output.buffer);
  for (let index = 0; index < input.length; index += 1) {
    const sample = decodeMulaw(input[index]!);
    view.setInt16(index * 4, sample, true);
    view.setInt16(index * 4 + 2, sample, true);
  }
  return output;
}

function pcm24kToMulaw8k(input: Uint8Array): Uint8Array {
  const sampleCount = Math.floor(input.byteLength / 2);
  const output = new Uint8Array(Math.floor(sampleCount / 3));
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  for (let index = 0; index < output.length; index += 1) output[index] = encodeMulaw(view.getInt16(index * 6, true));
  return output;
}

function decodeMulaw(value: number): number {
  const inverted = (~value) & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = ((mantissa << 3) + 0x84) << exponent;
  return sign ? 0x84 - magnitude : magnitude - 0x84;
}

function encodeMulaw(sample: number): number {
  let value = Math.max(-32635, Math.min(32635, sample));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  value += 0x84;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (value & mask) === 0; mask >>= 1) exponent -= 1;
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 0x0f))) & 0xff;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < value.length; index += 0x8000) {
    binary += String.fromCharCode(...value.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
