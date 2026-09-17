import { describe, expect, test } from "bun:test";
import {
  createTwilioMediaAdapter,
  type TwilioMediaSocket,
} from "../src/telephony/twilio";

describe("Twilio telephony adapter", () => {
  test("normalizes bidirectional Media Streams and clears carrier playback", () => {
    const socket = new FakeTwilioSocket();
    const audio: ArrayBuffer[] = [];
    const digits: string[] = [];
    const errors: Error[] = [];
    const adapter = createTwilioMediaAdapter(socket, { expectedCallSid: "CA123" });
    adapter.start({
      onAudio: (frame) => audio.push(frame),
      onDtmf: (digit) => digits.push(digit),
      onEnd: () => undefined,
      onError: (error) => errors.push(error),
    });
    socket.message({ event: "dtmf", dtmf: { digit: "7" } });

    socket.message({ event: "start", start: { streamSid: "MZ123", callSid: "CA123" } });
    socket.message({
      event: "media",
      media: { payload: btoa(String.fromCharCode(...new Uint8Array(160).fill(0xff))) },
    });
    adapter.sendSpeech(new ArrayBuffer(960));
    adapter.clearSpeech();

    expect(errors).toEqual([]);
    expect(audio[0]?.byteLength).toBe(640);
    expect(digits).toEqual(["7"]);
    const speech = JSON.parse(socket.sent[0]!) as { media: { payload: string } };
    expect(atob(speech.media.payload)).toHaveLength(160);
    expect(JSON.parse(socket.sent[1]!).event).toBe("mark");
    expect(JSON.parse(socket.sent[2]!)).toEqual({ event: "clear", streamSid: "MZ123" });
  });

  test("rejects a media stream for a different provider call", () => {
    const socket = new FakeTwilioSocket();
    const errors: Error[] = [];
    const adapter = createTwilioMediaAdapter(socket, { expectedCallSid: "CA-expected" });
    adapter.start({
      onAudio: () => undefined,
      onEnd: () => undefined,
      onError: (error) => errors.push(error),
    });
    socket.message({ event: "start", start: { streamSid: "MZ123", callSid: "CA-other" } });
    expect(errors[0]?.message).toContain("identity");
  });
});

class FakeTwilioSocket implements TwilioMediaSocket {
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: { data: unknown }) => void>>();

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    for (const listener of this.listeners.get("close") ?? []) listener({ data: null });
  }

  addEventListener(type: "message" | "close" | "error", listener: (event: { data: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: "message" | "close" | "error", listener: (event: { data: unknown }) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  message(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) {
      listener({ data: JSON.stringify(value) });
    }
  }
}
