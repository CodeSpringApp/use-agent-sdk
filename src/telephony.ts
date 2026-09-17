import type { AgentSession } from "./client";
import type { VoiceCallConnection, VoiceEndpointingOptions } from "./types";

export interface TelephonyMediaAdapter {
  readonly provider: string;
  start(handlers: {
    onAudio: (pcm16k: ArrayBuffer) => void;
    onEndpoint?: () => void;
    onInterrupt?: () => void;
    onEnd: (reason?: string) => void;
    onError: (error: Error) => void;
  }): void | (() => void);
  /** Receives raw mono signed little-endian PCM16 at 24 kHz. */
  sendSpeech(pcm24k: ArrayBuffer): void;
  clearSpeech(): void;
  close(reason?: string): void;
}

export interface TelephonyBridgeOptions {
  clientCallId?: string;
  endpointing?: VoiceEndpointingOptions;
  signal?: AbortSignal;
  onTranscript?: (text: string) => void;
  onState?: (state: VoiceCallConnection["state"]) => void;
  onError?: (error: Error) => void;
}

export interface TelephonyBridge {
  readonly call: VoiceCallConnection;
  end(reason?: string): void;
}

/**
 * Connects a carrier adapter to the same durable agent session used by chat and
 * browser voice. Carrier credentials and webhook verification remain in the
 * customer's server; only normalized audio reaches CodeSpring.
 */
export async function bridgeTelephonyCall(
  session: AgentSession,
  adapter: TelephonyMediaAdapter,
  options: TelephonyBridgeOptions = {},
): Promise<TelephonyBridge> {
  let dispose: (() => void) | undefined;
  let ended = false;
  const finish = (reason = "carrier_ended") => {
    if (ended) return;
    ended = true;
    dispose?.();
    call.end(reason);
    call.close(1000, reason);
    adapter.close(reason);
  };
  const call = await session.connectVoice({
    transport: "sdk_bridge",
    speechOutputFormat: "pcm",
    ...(options.clientCallId ? { clientCallId: options.clientCallId } : {}),
    ...(options.endpointing ? { endpointing: options.endpointing } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    onState: (state) => options.onState?.(state),
    onTranscript: ({ text, final }) => {
      if (final) options.onTranscript?.(text);
    },
    onAudio: (audio) => adapter.sendSpeech(audio),
    onSpeechEnd: ({ interrupted }) => {
      if (interrupted) adapter.clearSpeech();
    },
    onError: (error) => options.onError?.(error),
    onClose: () => {
      if (!ended) adapter.close("runtime_disconnected");
      ended = true;
      dispose?.();
    },
  });
  dispose = adapter.start({
    onAudio: (audio) => call.sendAudio(audio),
    onEndpoint: () => call.endpoint(),
    onInterrupt: () => call.interrupt(),
    onEnd: finish,
    onError: (error) => {
      options.onError?.(error);
      finish("carrier_error");
    },
  }) ?? undefined;
  if (options.signal) {
    const abort = () => finish("aborted");
    if (options.signal.aborted) abort();
    else options.signal.addEventListener("abort", abort, { once: true });
  }
  return { call, end: finish };
}
